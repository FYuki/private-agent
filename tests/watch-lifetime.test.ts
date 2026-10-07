import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {observeWatchExecution} from '../development/watch-execution.ts';

test('observer timeout neither cancels execution nor consumes its durable terminal result',async()=>{
 const root=await mkdtemp(join(tmpdir(),'watch-observer-'));
 await assert.rejects(observeWatchExecution(root,new AbortController().signal,process.hrtime.bigint()+20000000n),/watch_observation_detached/);
 await assert.rejects(readFile(join(root,'cancel.json')),/ENOENT/);
 await writeFile(join(root,'result.json'),JSON.stringify({ok:true,value:{headSha:'a'.repeat(40)}}));
 const value=await observeWatchExecution(root,new AbortController().signal,process.hrtime.bigint()+1000000000n);
 assert.equal(value.headSha,'a'.repeat(40));
});

test('observer disconnection leaves an independent execution pending; terminal failure remains distinguishable',async()=>{
 const root=await mkdtemp(join(tmpdir(),'watch-observer-')),stop=new AbortController();stop.abort();
 await assert.rejects(observeWatchExecution(root,stop.signal,process.hrtime.bigint()+1000000000n),/watch_observation_detached/);
 await writeFile(join(root,'result.json'),JSON.stringify({ok:false,error:'watch_task_failed'}));
 await assert.rejects(observeWatchExecution(root,new AbortController().signal,process.hrtime.bigint()+1000000000n),/watch_task_failed/);
});
