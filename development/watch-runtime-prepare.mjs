import {readFileSync,writeFileSync} from 'node:fs';
import {join,relative} from 'node:path';
import {pathToFileURL} from 'node:url';
const [runtime,input,output,clones,workflow]=process.argv.slice(2);
if(!['default','simple','private-agent-child-issue'].includes(workflow))throw Error('workflow_not_allowed');
const mod=p=>import(pathToFileURL(join(runtime,'node_modules',p)).href);
const {parse,stringify}=await mod('yaml/dist/index.js');
const {GlobalConfigSchema}=await mod('takt/dist/core/models/config-schemas.js');
const {RuntimeProviderFileSchema}=await mod('takt/dist/infra/config/runtime-provider/schema.js');
const config=parse(readFileSync(join(input,'config.yaml'),'utf8')),routing=parse(readFileSync(join(input,'runtime.yaml'),'utf8'));
GlobalConfigSchema.parse(config);RuntimeProviderFileSchema.parse(routing);
if(Object.keys(config).some(k=>!['language','branch_name_strategy','auto_pr','concurrency','observability','assistant'].includes(k)))throw Error('global_override_not_verified');
if(Object.keys(routing).some(k=>!['version','provider'].includes(k))||routing.version!==1||!routing.provider)throw Error('unsupported_runtime_policy');
const p=routing.provider;
if(Object.keys(p).some(k=>!['defaults','profiles','targets'].includes(k)))throw Error('unsupported_routing_policy');
for(const a of [p.defaults,...Object.values(p.targets??{}).flatMap(g=>Object.values(g))])if(!a?.profile||Object.keys(a).some(k=>k!=='profile')||!p.profiles[a.profile])throw Error('fixed_profile_required');
for(const v of Object.values(p.profiles))if(v.extends)throw Error('profile_inheritance_not_verified');
const effective={...config,auto_pr:false,branch_name_strategy:'romaji',concurrency:1,auto_requeue_max_attempts:0,task_poll_interval_ms:100,worktree_dir:clones};
GlobalConfigSchema.parse(effective);
writeFileSync(join(output,'config.yaml'),stringify(effective),{mode:0o600,flag:'wx'});
writeFileSync(join(output,'runtime.yaml'),stringify({...routing,companion:{enabled:false}}),{mode:0o600,flag:'wx'});
if(workflow==='private-agent-child-issue'){
 if(config.language!=='ja')throw Error('review_language_not_supported');
 const {installReviewResources}=await import('../review/prepare.mjs');
 installReviewResources(output);
}
process.env.TAKT_CONFIG_DIR=output;
const {loadWorkflow,resolveWorkflowCallTarget}=await mod('takt/dist/infra/config/loaders/workflowLoader.js');
const {getWorkflowReference}=await mod('takt/dist/core/workflow/workflow-reference.js');
const {getWorkflowSourcePath,getAttachedWorkflowTrustInfo,buildOpaqueWorkflowRef}=await mod('takt/dist/shared/workflowConfigMetadata.js');
// 公式opaque refは内容ではなく絶対source pathのhash。実行namespace内のruntime配置で照合する。
const runtimeReference=w=>{
 const source=getWorkflowSourcePath(w);
 return source?.startsWith(runtime+'/')?buildOpaqueWorkflowRef(join('/opt/takt-runtime',relative(runtime,source)),getAttachedWorkflowTrustInfo(w)):getWorkflowReference(w);
};
const w=loadWorkflow(workflow,output);if(!w)throw Error('builtin_missing');
const {compileRuntimeProviderEnvironment}=await mod('takt/dist/infra/config/runtime-provider/environment.js');
const {OptionsBuilder}=await mod('takt/dist/core/workflow/engine/OptionsBuilder.js');
const {resolveLoopMonitorJudgeProviderModel}=await mod('takt/dist/core/workflow/provider-resolution.js');
const {LOOP_JUDGE_ROUTING_KEY,loopJudgeStepName,loopJudgeProviderFields}=await mod('takt/dist/core/workflow/loop-judge-step.js');
const environment=compileRuntimeProviderEnvironment(p),candidates=[];
const check=(info,target)=>{
 const effort=info.providerOptions?.codex?.reasoningEffort;
 if(info.provider!=='codex'||!['gpt-6-sol:medium','gpt-6-sol:xhigh','gpt-6-luna:xhigh','gpt-6.1-sol:xhigh'].includes(info.model+':'+effort))throw Error('provider_or_model_not_verified');
 candidates.push({target,provider:info.provider,model:info.model,effort,executed:false});
};
function visit(w,prefix=''){
 const options={...environment,providerRouting:{...environment.providerRouting,workflowName:w.name},providerOptionsProviderSource:environment.providerSource,providerPermissionMode:environment.permissionMode,providerRoutingTagConflictPolicy:environment.tagConflictPolicy,internalAgentSeats:environment.internalAgents};
 const builder=new OptionsBuilder(options,()=>output,()=>output,()=>undefined,()=>'',()=>config.language,()=>w.steps,()=>w.name,()=>w.description);
 for(const step of w.steps){
  if(step.type==='workflow-call'||step.workflow||step.call){const child=resolveWorkflowCallTarget(w,step,output);if(!child)throw Error('child_workflow_missing');visit(child,prefix+step.name+'/');}
  else if(step.parallel){
   const children=step.parallel.kind==='dynamic'?[...step.parallel.fixed,...step.parallel.pool]:step.parallel;
   if(!Array.isArray(children)||!children.length)throw Error('parallel_shape_not_verified');
   for(const child of children)check(builder.resolveStepProviderModel(child),prefix+step.name+'/'+child.name);
  }else check(builder.resolveStepProviderModel(step),prefix+step.name);
 }
 for(const monitor of w.loopMonitors??[]){
  const trigger=w.steps.find(s=>s.name===monitor.cycle.at(-1));if(!trigger||trigger.type==='workflow-call'||trigger.parallel)throw Error('loop_trigger_not_verified');
  const judge={name:loopJudgeStepName(monitor.cycle),engineSynthesized:true,internalFreshSession:true,persona:monitor.judge.persona,personaPath:monitor.judge.personaPath,personaDisplayName:LOOP_JUDGE_ROUTING_KEY,providerRoutingPersonaKey:LOOP_JUDGE_ROUTING_KEY,...loopJudgeProviderFields(environment.internalAgents),edit:false,instruction:'',rules:monitor.judge.rules,passPreviousResponse:true};
  const providerInfo=resolveLoopMonitorJudgeProviderModel({judgeProviderInfo:builder.resolveStepProviderModelBeforeAutoRouting(judge),triggeringProviderInfo:builder.resolveStepProviderModel(trigger)});
  check(builder.resolveStepProviderModel(judge,{providerInfo}),prefix+judge.name);
 }
}
visit(w);
// D1のtakt-watch契約はplan系列Solのjob一枠。異なる系列はclaimを流用しない。
const plan=candidates.filter(c=>c.target==='plan'||c.target.endsWith('/plan'));
if(!plan.length||plan.some(c=>!['gpt-6-sol','gpt-6.1-sol'].includes(c.model)))throw Error('plan_job_family_mismatch');
// selector等の内部呼出しも固定profileを検証し、実行時は全呼出しを同じ物理ゲートへ通す。
for(const seat of ['assistant','selector','review-completion-judge']){
 const a=p.targets?.internal_agents?.[seat]??p.defaults,v=p.profiles[a.profile];
 check({provider:v.provider,model:v.model,providerOptions:{codex:{reasoningEffort:v.options?.reasoning_effort}}},'internal_agents.'+seat);
}
// 必須call stepの欠落は参照先を辿る前に診断する。
const callee=(parent,name)=>{
 const step=parent?.steps.find(s=>s.name===name);
 const child=step&&resolveWorkflowCallTarget(parent,step,output);
 if(!child)throw Error('child_workflow_missing: '+name);
 return child;
};
let references={};
if(workflow==='default'){
 const core=callee(w,'develop'),peer=callee(core,'peer-review');
 references={default:runtimeReference(w),core:runtimeReference(core),peer:runtimeReference(peer)};
}
if(workflow==='private-agent-child-issue'){
 const fix=callee(w,'quality-review-fix'),peer=callee(fix,'reviewers'),quality=callee(peer,'initial-reviewers');
 references={child:runtimeReference(w),fix:runtimeReference(fix),peer:runtimeReference(peer),quality:runtimeReference(quality)};
}
writeFileSync(join(output,'watch-compiled.json'),JSON.stringify({workflow,references,candidates,jobResources:{'codex-sol':1},maxProviderProcesses:60,maxProviderCalls:60,providerCallMs:300000,conditionalReviewers:true}),{mode:0o600,flag:'wx'});
