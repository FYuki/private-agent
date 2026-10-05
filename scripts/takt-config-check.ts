import {mkdtemp,readFile,writeFile,mkdir} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {resolve,join} from 'node:path';
import assert from 'node:assert/strict';
import {processOutput} from '../development/process.ts';
import {resourcePlan} from '../development/takt-contract.ts';
const root=resolve(process.env.TAKT_RUNTIME||'runtime/takt'),inputs=resolve('examples/takt'),out=await mkdtemp('/tmp/private-agent-takt-');
await processOutput(process.execPath,['development/takt-prepare.mjs',root,inputs,out],process.cwd(),'',new AbortController().signal,process.hrtime.bigint()+60000000000n,{PATH:'/usr/bin:/bin'});
const x=JSON.parse(await readFile(join(out,'compiled.json'),'utf8')),plan=resourcePlan(x.runtime,x.steps,x.conditionalCalls);
assert.deepEqual(plan.models,{'codex-sol':1,'codex-luna':1});assert.equal(plan.maxProviderProcesses,1);
assert.equal(plan.resolved.find(p=>p.target==='plan')?.profile,'sol-xhigh');
assert.equal(plan.resolved.find(p=>p.target==='write_tests')?.profile,'sol-medium');
assert.equal(plan.resolved.find(p=>p.target==='internal_agents.selector')?.profile,'luna-xhigh');
assert.equal(plan.resolved.find(p=>p.target==='remediation/fix')?.profile,'sol-medium');
assert.notEqual(x.requested.config,x.effective.config);
assert.ok((await readFile(join(inputs,'config.yaml'),'utf8')).includes('auto_pr: true'));
assert.ok((await readFile(join(out,'config.yaml'),'utf8')).includes('auto_pr: false'));
console.log(JSON.stringify({officialSchema:true,expandedSteps:x.steps.length,models:plan.models,originalPreserved:true,providerExecuted:false}));
const yaml=await import(pathToFileURL(join(root,'node_modules/yaml/dist/index.js')).href);
async function overridden(key:string,profile:string,target='steps',ladder=false){
 const dir=await mkdtemp('/tmp/private-agent-routing-'),output=join(dir,'resolved');await mkdir(output);
 await writeFile(join(dir,'config.yaml'),await readFile(join(inputs,'config.yaml')));
 const runtime=yaml.parse(await readFile(join(inputs,'runtime.yaml'),'utf8'));(runtime.provider.targets[target]??={})[key]=ladder?{ladder:[profile]}:{profile};
 await writeFile(join(dir,'runtime.yaml'),yaml.stringify(runtime));
 await processOutput(process.execPath,['development/takt-prepare.mjs',root,dir,output],process.cwd(),'',new AbortController().signal,process.hrtime.bigint()+60000000000n,{PATH:'/usr/bin:/bin'});
 return JSON.parse(await readFile(join(output,'compiled.json'),'utf8'));
}
const changed=await overridden('simple/plan','luna-xhigh'),changedPlan=resourcePlan(changed.runtime,changed.steps,changed.conditionalCalls);
assert.equal(changedPlan.resolved.find(p=>p.target==='plan')?.model,'gpt-6-luna');
assert.equal(changed.steps.find((s:any)=>s.name==='plan').official.model,'gpt-6-luna');
const denied=await overridden('simple/plan','opus5');assert.throws(()=>resourcePlan(denied.runtime,denied.steps,denied.conditionalCalls),/provider_or_model_not_verified/);
const nested=await overridden('review-remediation/fix','luna-xhigh');assert.equal(resourcePlan(nested.runtime,nested.steps,nested.conditionalCalls).resolved.find(p=>p.target==='remediation/fix')?.profile,'luna-xhigh');
const bare=await overridden('plan','luna-xhigh');assert.equal(resourcePlan(bare.runtime,bare.steps,bare.conditionalCalls).resolved.find(p=>p.target==='plan')?.profile,'luna-xhigh');
const mismatch=structuredClone(changed);mismatch.steps[0].official.model='gpt-6-sol';assert.throws(()=>resourcePlan(mismatch.runtime,mismatch.steps,mismatch.conditionalCalls),/resolution_mismatch/);
console.log(JSON.stringify({qualifiedOverrideMatchesOfficial:true,unsupportedQualifiedOverrideRejected:true,leafWorkflowRouting:true,bareFallback:true,manifestMismatchRejected:true,providerExecuted:false}));

// 公式の実行経路で作る条件付き judge。未実行を実績に数えない。
assert.equal(x.modelPlanVersion,2);
assert.equal(plan.resolved.some(p=>p.target==='internal_agents.loop-judge'),false);
assert.equal(plan.conditional.length,2);
assert.ok(plan.conditional.every(p=>p.model==='gpt-6-sol'&&p.effort==='medium'&&p.executed===false&&p.threshold===4));
const inherited=await overridden('review-remediation/fix','sol-xhigh');
assert.equal(resourcePlan(inherited.runtime,inherited.steps,inherited.conditionalCalls).conditional.find(p=>p.trigger==='remediation/fix')?.effort,'xhigh');
const explicit=await overridden('loop-judge','luna-xhigh','internal_agents');
assert.ok(resourcePlan(explicit.runtime,explicit.steps,explicit.conditionalCalls).conditional.every(p=>p.model==='gpt-6-luna'&&p.effort==='xhigh'&&p.providerSource==='step'));
const persona=await overridden('loop-judge','sol-xhigh','personas');
assert.ok(resourcePlan(persona.runtime,persona.steps,persona.conditionalCalls).conditional.every(p=>p.effort==='xhigh'&&p.providerSource==='persona_providers'));
const qualified=await overridden('review-remediation/_loop_judge_fix-replan_fix','luna-xhigh');
assert.equal(resourcePlan(qualified.runtime,qualified.steps,qualified.conditionalCalls).conditional.find(p=>p.trigger==='remediation/fix')?.model,'gpt-6-luna');
const unsupportedJudge=await overridden('loop-judge','opus5','internal_agents');
assert.throws(()=>resourcePlan(unsupportedJudge.runtime,unsupportedJudge.steps,unsupportedJudge.conditionalCalls),/conditional_provider_or_model_not_verified/);
const tampered=structuredClone(x);tampered.conditionalCalls[0].executed=true;
assert.throws(()=>resourcePlan(tampered.runtime,tampered.steps,tampered.conditionalCalls),/invalid_conditional_call/);
console.log(JSON.stringify({loopJudgeTriggerFallback:true,effortInherited:true,explicitSeat:true,personaRouting:true,qualifiedJudgeRouting:true,unsupportedJudgeRejected:true,conditionalOnly:true,providerExecuted:false}));

for(const [target,key] of [['internal_agents','loop-judge'],['steps','review-remediation/_loop_judge_fix-replan_fix'],['personas','loop-judge']]) {
 const ladder=await overridden(key,'sol-medium',target,true);
 assert.throws(()=>resourcePlan(ladder.runtime,ladder.steps,ladder.conditionalCalls),/fixed_profile_required/);
}
const inheritedJudge=structuredClone(explicit);inheritedJudge.runtime.provider.profiles['luna-xhigh'].extends='sol-medium';
assert.throws(()=>resourcePlan(inheritedJudge.runtime,inheritedJudge.steps,inheritedJudge.conditionalCalls),/unsupported_profile_inheritance/);
console.log(JSON.stringify({judgeLadderRejected:true,assignedInheritanceRejected:true,providerExecuted:false}));
