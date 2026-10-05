import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable,Writable} from 'node:stream';
// @ts-ignore dependency-free CLI boundary
import {parallelRun,verifyProviderSettlement} from '../development/watch-provider-budget.mjs';
// @ts-ignore dependency-free CLI boundary
import {codexArgs} from '../development/takt-codex-wrapper.mjs';
test('parallel CLI admission preserves overlap, caps total starts and requires every settlement',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'watch-budget-'));
 const launch=()=>parallelRun({directory,maxCalls:4,file:process.execPath,args:['-e','setTimeout(()=>{},300)'],env:{},profile:{model:'fixture'},stdin:Readable.from([]),stdout:new Writable({write(_c,_e,done){done();}})});
 await Promise.all(Array.from({length:4},launch));
 await assert.rejects(launch(),/provider_call_limit/);
 const events=(await readFile(join(directory,'activity.ndjson'),'utf8')).trim().split('\n').map(x=>JSON.parse(x));
 verifyProviderSettlement(events,4);let active=0,peak=0;for(const e of events){active+=e.event==='started'?1:-1;peak=Math.max(peak,active);}assert.ok(peak>1);assert.equal(active,0);
 assert.throws(()=>verifyProviderSettlement(events.filter((x:any)=>x!==events.find((e:any)=>e.event==='closed')),4),/stop_unconfirmed/);
});
test('watch alone accepts verified Sol 6.1 xhigh without changing legacy profiles',()=>{
 const args=['exec','--model','gpt-6.1-sol','-c','model_reasoning_effort="xhigh"'];
 assert.equal(codexArgs(args,true).model,'gpt-6.1-sol');assert.throws(()=>codexArgs(args),/profile_denied/);
 assert.throws(()=>codexArgs([...args,'-c','model_reasoning_effort="medium"'],true),/profile_denied/);
});

import {validateWatchStorage} from '../development/watch-adapter.ts';
test('official session file NAME_MAX is checked before provider execution',()=>{
 assert.doesNotThrow(()=>validateWatchStorage('/tmp/paw-fixture/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/clones'));
 assert.throws(()=>validateWatchStorage('/home/'+ 'x'.repeat(150)),/watch_storage_path_too_long/);
});
