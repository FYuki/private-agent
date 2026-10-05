import { readFileSync, writeFileSync, readdirSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

// 別processで実行し、TAKTのglobal config cacheをrun間で共有しない。
const [root,input,output]=process.argv.slice(2);
const mod=p=>import(pathToFileURL(join(root,'node_modules',p)).href);
const {parse,stringify}=await mod('yaml/dist/index.js');
const {GlobalConfigSchema}=await mod('takt/dist/core/models/config-schemas.js');
const {RuntimeProviderFileSchema}=await mod('takt/dist/infra/config/runtime-provider/schema.js');
const pkg=JSON.parse(readFileSync(join(root,'node_modules/takt/package.json'),'utf8'));
if(pkg.version!=='0.68.0')throw Error('takt_version_mismatch');
const lock=JSON.parse(readFileSync(join(root,'package-lock.json'),'utf8')).packages?.['node_modules/takt'];
if(lock?.version!=='0.68.0'||lock.integrity!=='sha512-92yoikSQ6kyj/PYMrefONIOKkNW9CdiJrAl2REPdsmdKp3M3XUMZnxDOjCtf1mAnOMadJpVGlGa5sYuaI1hjcw==')throw Error('takt_integrity_pin_mismatch');
const configBytes=readFileSync(join(input,'config.yaml')),runtimeBytes=readFileSync(join(input,'runtime.yaml'));
const config=parse(configBytes.toString()),runtime=parse(runtimeBytes.toString());
GlobalConfigSchema.parse(config);RuntimeProviderFileSchema.parse(runtime);
if(Object.keys(config).some(k=>!['language','branch_name_strategy','auto_pr','concurrency','observability','assistant'].includes(k)))throw Error('global_override_not_verified');
if(Object.keys(runtime).some(k=>!['version','provider'].includes(k)))throw Error('runtime_override_not_verified');
if(Object.keys(runtime.provider).some(k=>!['defaults','profiles','targets'].includes(k)))throw Error('routing_policy_not_verified');
// 元設定のprovider/model/effortと未使用profileを維持する。公開担当だけPrivateAgentに移す。
const effectiveConfig={...config,auto_pr:false};
const effectiveRuntime={...runtime,companion:{enabled:false}};
writeFileSync(join(output,'config.yaml'),stringify(effectiveConfig),{mode:0o600});
writeFileSync(join(output,'runtime.yaml'),stringify(effectiveRuntime),{mode:0o600});
process.env.TAKT_CONFIG_DIR=output;
const {getBuiltinWorkflow,resolveWorkflowCallTarget}=await mod('takt/dist/infra/config/loaders/workflowLoader.js');
const {compileRuntimeProviderEnvironment}=await mod('takt/dist/infra/config/runtime-provider/environment.js');
const {resolveLoopMonitorJudgeProviderModel}=await mod('takt/dist/core/workflow/provider-resolution.js');
const {OptionsBuilder}=await mod('takt/dist/core/workflow/engine/OptionsBuilder.js');
const {LOOP_JUDGE_ROUTING_KEY,loopJudgeStepName,loopJudgeProviderFields}=await mod('takt/dist/core/workflow/loop-judge-step.js');
const environment=compileRuntimeProviderEnvironment(effectiveRuntime.provider);
const workflow=getBuiltinWorkflow('simple',output);
if(!workflow)throw Error('builtin_missing');
const steps=[],conditionalCalls=[];
const identity=info=>({provider:info.provider,model:info.model,effort:info.providerOptions?.codex?.reasoningEffort});
// 実行側と同じ options 合成を使う。計画では provider を呼び出さない。
function optionsBuilder(w) {
 const options={...environment,providerRouting:{...environment.providerRouting,workflowName:w.name},providerOptionsProviderSource:environment.providerSource,providerPermissionMode:environment.permissionMode,providerRoutingTagConflictPolicy:environment.tagConflictPolicy,internalAgentSeats:environment.internalAgents};
 return new OptionsBuilder(options,()=>output,()=>output,()=>undefined,()=>'',()=>config.language,()=>w.steps,()=>w.name,()=>w.description);
}
function visit(w,prefix='') {
 const builder=optionsBuilder(w);
 for(const step of w.steps) {
  if(step.parallel)throw Error('parallel_not_verified');
  if(step.type==='workflow-call'||step.workflow||step.call) {
   const child=resolveWorkflowCallTarget(w,step,output);
   if(!child)throw Error('child_workflow_missing');
   visit(child,prefix+step.name+'/');
  } else {
   const info=builder.resolveStepProviderModel(step);
   steps.push({...step,name:prefix+step.name,localName:step.name,workflowName:w.name,official:identity(info)});
  }
 }
 for(const monitor of w.loopMonitors??[]) {
  const trigger=w.steps.find(s=>s.name===monitor.cycle.at(-1));
  if(!trigger||trigger.type==='workflow-call'||trigger.parallel)throw Error('loop_trigger_not_verified');
  const judge={name:loopJudgeStepName(monitor.cycle),engineSynthesized:true,internalFreshSession:true,persona:monitor.judge.persona,personaPath:monitor.judge.personaPath,personaDisplayName:LOOP_JUDGE_ROUTING_KEY,providerRoutingPersonaKey:LOOP_JUDGE_ROUTING_KEY,...loopJudgeProviderFields(environment.internalAgents),edit:false,instruction:'',rules:monitor.judge.rules,passPreviousResponse:true};
  const providerInfo=resolveLoopMonitorJudgeProviderModel({judgeProviderInfo:builder.resolveStepProviderModelBeforeAutoRouting(judge),triggeringProviderInfo:builder.resolveStepProviderModel(trigger)});
  const info=builder.resolveStepProviderModel(judge,{providerInfo});
  conditionalCalls.push({target:prefix+judge.name,kind:'loop-judge',workflowName:w.name,cycle:monitor.cycle,threshold:monitor.threshold,trigger:prefix+trigger.name,official:identity(info),providerSource:info.providerSource,modelSource:info.modelSource,executed:false});
 }
}
visit(workflow);
const sha=x=>createHash('sha256').update(x).digest('hex');
const digest=[];
function tree(dir,rel='') {for(const name of readdirSync(dir).sort()){const p=join(dir,name),r=rel+'/'+name,s=lstatSync(p);if(s.isSymbolicLink())throw Error('runtime_symlink');if(s.isDirectory())tree(p,r);else digest.push([r,sha(readFileSync(p))]);}}
tree(join(root,'node_modules/takt/builtins'));
const result={requested:{config:sha(configBytes),runtime:sha(runtimeBytes)},effective:{config:sha(readFileSync(join(output,'config.yaml'))),runtime:sha(readFileSync(join(output,'runtime.yaml')))},runtime:effectiveRuntime,steps,modelPlanVersion:2,conditionalCalls,workflowHash:sha(JSON.stringify(workflow)),promptBundleHash:sha(JSON.stringify(digest)),overrides:{auto_pr:false,companion:false},workflow};
writeFileSync(join(output,'compiled.json'),JSON.stringify(result),{mode:0o600});
console.log(JSON.stringify({ok:true,steps:steps.map(s=>({name:s.name,tags:s.tags,type:s.type}))}));
