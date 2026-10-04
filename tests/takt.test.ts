import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,access,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable,Writable} from 'node:stream';
import {resolveProfile,resourcePlan,acceptedResult,TAKT_BUDGET,type Runtime} from '../development/takt-contract.ts';
// @ts-ignore CLI wrapper deliberately has no runtime dependencies.
import {codexArgs,guardedRun} from '../development/takt-codex-wrapper.mjs';
const runtime:Runtime={version:1,provider:{defaults:{profile:'luna'},profiles:{luna:{provider:'codex',model:'gpt-6-luna',options:{reasoning_effort:'xhigh'}},sol:{provider:'codex',model:'gpt-6-sol',options:{reasoning_effort:'medium'}}},targets:{tags:{coding:{profile:'sol'},review:{profile:'sol'}}}}};
test('TAKT reserves both physical models and internal default, rejects conflicting tags and unavailable provider',()=>{
 assert.deepEqual(resourcePlan(runtime,[{name:'write_tests',tags:['coding','test-planning']}]).models,{'codex-sol':1,'codex-luna':1});
 const x=structuredClone(runtime);x.provider!.targets!.tags['test-planning']={profile:'luna'};
 assert.throws(()=>resolveProfile(x,{name:'write_tests',tags:['coding','test-planning']}),/conflict/);
 x.provider!.profiles.sol.provider='claude';assert.throws(()=>resolveProfile(x,{name:'review',tags:['review']}),/not_verified/);
 assert.throws(()=>resolveProfile(runtime,{name:'review',parallel:[]}),/parallel/);
 assert.ok(TAKT_BUDGET.totalMs>3600000&&Number.isFinite(TAKT_BUDGET.maxMs));
});
test('Codex argv keeps exact model and effort while denying arbitrary overrides',()=>{
 const x=codexArgs(['exec','--experimental-json','--model','gpt-6-sol','-c','model_reasoning_effort="xhigh"','--sandbox','read-only']);
 assert.equal(x.effort,'xhigh');assert.equal(x.model,'gpt-6-sol');assert.ok(x.args.includes('features.multi_agent=false'));
 assert.ok(x.args.some((a:string)=>a.includes('"/home/runner/.codex"="deny"')));
 assert.ok(codexArgs(['exec','--model','gpt-6-luna','-c','model_reasoning_effort="xhigh"']).args.some((a:string)=>a.includes('"/workspace"="read"')));
 for(const argv of [['--config','openai_base_url="https://evil"'],['--add-dir','/'],['--model','unapproved']])assert.throws(()=>codexArgs(['exec','--model','gpt-6-luna','-c','model_reasoning_effort="xhigh"',...argv]));
});
test('provider call ceiling and TERM-resistant descendants cannot bypass closure fencing',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'takt-descendant-')),lock=join(dir,'lock'),activity=join(dir,'events'),output=join(dir,'writes');
 const child=`process.on('SIGINT',()=>{});setInterval(()=>require('fs').appendFileSync(${JSON.stringify(output)},'x'),10)`;
 const code=`process.on('SIGINT',()=>{});require('child_process').spawn(process.execPath,['-e',${JSON.stringify(child)}],{stdio:'inherit'});setInterval(()=>{},1000)`;
 await assert.rejects(guardedRun({file:process.execPath,args:['-e',code],lock,activity,callMs:200,idleMs:5000,stdin:Readable.from([]),stdout:new Writable({write(_c,_e,cb){cb();}}),env:{}}),/provider_/);
 const before=await readFile(output,'utf8');await new Promise(r=>setTimeout(r,100));assert.equal(await readFile(output,'utf8'),before);
 const limited=join(dir,'limited');await writeFile(limited,Array.from({length:120},()=>JSON.stringify({event:'started'})).join('\n'));
 await assert.rejects(guardedRun({file:process.execPath,args:['-e','process.exit(0)'],lock:join(dir,'limit-lock'),activity:limited,env:{}}),/call_limit/);
 const smaller=join(dir,'smaller');await writeFile(smaller,Array.from({length:20},()=>JSON.stringify({event:'started'})).join('\n'));
 await assert.rejects(guardedRun({file:process.execPath,args:['-e','process.exit(0)'],lock:join(dir,'small-lock'),activity:smaller,maxCalls:20,env:{}}),/call_limit/);
});
test('exit0/completed and question-only COMPLETE never imply approval',()=>{
 const meta={status:'completed',task:'x',workflow:'simple',endTime:'now',runSlug:'s',iterations:6};
 const end={type:'workflow_complete'};
 assert.throws(()=>acceptedResult(meta,[end],{task:'x',workflow:'simple'}));
 const event=(step:string,iteration:number,matchedRuleIndex:number)=>({type:'step_complete',step,iteration,status:'done',matchedRuleIndex,workflow:'simple',stack:[{workflow:'simple',step,kind:'agent'}]});
 const events:any[]=[event('review',4,0),event('supervise',5,1),end];
 assert.equal(acceptedResult(meta,events,{task:'x',workflow:'simple'}).status,'approved');
 events[1].matchedRuleIndex=2;assert.throws(()=>acceptedResult(meta,events,{task:'x',workflow:'simple'}));
 assert.throws(()=>acceptedResult(meta,events,{task:'other',workflow:'simple'}));
});
test('provider lock rejects overlap, waits for close and times out a silent process',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'takt-lock-'));const lock=join(dir,'lock'),activity=join(dir,'events');
 const run=(code:string,callMs=500)=>guardedRun({file:process.execPath,args:['-e',code],lock,activity,callMs,idleMs:500,stdin:Readable.from([]),stdout:new Writable({write(_c,_e,cb){cb();}}),env:{}});
 const first=run('setTimeout(()=>{},200)');
 await assert.rejects(run(''),/stop_unconfirmed/);await first;await assert.rejects(access(lock));
 await assert.rejects(run('setInterval(()=>{},1000)',30),/provider_failed/);await assert.rejects(access(lock));
 assert.match(await readFile(activity,'utf8'),/closed/);
});
