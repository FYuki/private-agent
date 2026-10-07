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

test('cancelled delegated claim sends cancellation before operations and waits for durable stop ACK',async()=>{
 const {processClaimedDevelopment}=await import('../development/runner.ts');
 const root=await mkdtemp(join(tmpdir(),'watch-cancelled-')),id=crypto.randomUUID();
 const {mkdir}=await import('node:fs/promises');const directory=join(root,id+'.execution');await mkdir(directory);
 await writeFile(join(directory,'request.json'),JSON.stringify({owner:'local',order:{id}}));
 const calls:string[]=[];
 const api=async(path:string,body:any)=>{calls.push(path);assert.equal(body.error,'cancelled');assert.equal(JSON.parse(await readFile(join(directory,'result.json'),'utf8')).error,'cancelled_or_deadline');return {};};
 const pending=processClaimedDevelopment({id:'run',job_id:id,owner:'local',state:'cancelled',token:'token',budget_ms:2000,development:{executionProfileId:'takt-watch'}} as any,api as any,{takt:{taktRuns:root}} as any,new AbortController().signal,process.hrtime.bigint());
 for(let i=0;;i++){try{await readFile(join(directory,'cancel.json'));break;}catch{if(i>100)throw Error('cancel_not_sent');await new Promise(r=>setTimeout(r,10));}}
 assert.deepEqual(calls,[]);
 await writeFile(join(directory,'result.json'),JSON.stringify({ok:false,error:'cancelled_or_deadline'}));
 assert.equal(await pending,true);assert.deepEqual(calls,['/api/runs/run/complete']);
});

test('observer recovers terminal result published between result lookup and process exit check',async()=>{
 const {execFileSync}=await import('node:child_process');const {open}=await import('node:fs/promises');
 const root=await mkdtemp(join(tmpdir(),'watch-result-race-'));
 execFileSync('/usr/bin/mkfifo',[join(root,'process.json')]);
 const pending=observeWatchExecution(root,new AbortController().signal,process.hrtime.bigint()+2000000000n);
 // Writer open only completes once observer has missed result.json and opened process.json.
 const pipe=await open(join(root,'process.json'),'w');
 await writeFile(join(root,'result.json'),JSON.stringify({ok:true,value:{headSha:'b'.repeat(40)}}));
 await pipe.writeFile(JSON.stringify({pid:2147483647,identity:'exited-worker'}));await pipe.close();
 assert.equal((await pending).headSha,'b'.repeat(40));
});

test('cancelled claim cannot release D1 hold when namespace stop is unconfirmed',async()=>{
 const {processClaimedDevelopment}=await import('../development/runner.ts');const {mkdir}=await import('node:fs/promises');
 const root=await mkdtemp(join(tmpdir(),'watch-unconfirmed-')),id=crypto.randomUUID(),directory=join(root,id+'.execution');await mkdir(directory);
 await writeFile(join(directory,'request.json'),JSON.stringify({owner:'local',order:{id}}));
 await writeFile(join(directory,'result.json'),JSON.stringify({ok:false,error:'watch_stop_unconfirmed'}));
 const calls:string[]=[];
 await assert.rejects(processClaimedDevelopment({id:'run',job_id:id,owner:'local',state:'cancelled',token:'token',budget_ms:50,development:{executionProfileId:'takt-watch'}} as any,(async(path:string)=>{calls.push(path);return {};}) as any,{takt:{taktRuns:root}} as any,new AbortController().signal,process.hrtime.bigint()),/watch_observation_detached/);
 assert.deepEqual(calls,[]);
});
