import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {readFile,writeFile,mkdir,chmod} from 'node:fs/promises';
import {resolve} from 'node:path';
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
const base=process.env.CONTROL_URL||'http://127.0.0.1:8787/';
const tokens=JSON.parse(await readFile('.local/tokens.json','utf8'));
async function api(path:string,body?:unknown,key?:string){
 const r=await fetch(new URL(path,base),{method:body?'POST':'GET',headers:{authorization:'Bearer '+tokens.viewer,'content-type':'application/json',...(key?{'idempotency-key':key}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(4000)});
 if(!r.ok)throw Error('control_'+r.status);return r.json() as Promise<any>;
}
await mkdir('.local/evidence',{recursive:true});
const fixture=resolve('.local/fixture-cli.mjs');
await writeFile(fixture,'#!/usr/bin/env node\nprocess.stdin.resume();process.stdin.on("end",()=>{console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"5"}}));console.log(JSON.stringify({type:"turn.completed"}));});\n');
await chmod(fixture,0o700);
const startAt=Date.now()+1000;
const job=await api('/api/jobs',{name:'Real-time finite fixture',provider:'codex-luna',prompt:'Synthetic 2+3',startAt,intervalSeconds:60,maxRuns:2,enabled:true,overlapPolicy:'skip'},crypto.randomUUID());
const poller=spawn(process.execPath,['--import','tsx','wsl-worker/main.ts'],{stdio:'ignore',env:{...process.env,CONTROL_URL:base,WORKER_TOKEN:tokens.worker,WORKER_PROVIDER:'codex-luna',POLL_INTERVAL_MS:'1000',CODEX_BIN:fixture}});
const ticks:number[]=[];
try{
 // Wall-clock timer drives two real occurrences. No once() call and no past/future tick injection.
 for(let slot=0;slot<2;slot++){
  const target=startAt+slot*60000+50;
  while(Date.now()<target)await sleep(Math.min(1000,target-Date.now()));
  const at=Date.now();const admitted=await api('/api/tick',{at});assert.equal(admitted.enqueued,1,JSON.stringify({slot,at,startAt,admitted}));ticks.push(at);
  const until=Date.now()+10000;let succeeded=false;
  while(Date.now()<until){const state=await api('/api/state');const run=state.runs.find((r:any)=>r.job_id===job.id&&r.slot===slot);if(run?.state==='succeeded'){assert.equal(run.result,'5');succeeded=true;break;}await sleep(250);}
  assert(succeeded,'actual polling process did not store scheduled result');
 }
 assert(ticks[1]-ticks[0]>=59000);
 const report={mode:'real-time timer + real polling process + fixture CLI (no live inference)',at:new Date().toISOString(),scheduledIntervalMs:60000,ticks,observedIntervalMs:ticks[1]-ticks[0],successfulRuns:2};
 await writeFile('.local/evidence/realtime-measurement.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{
 await api('/api/jobs/'+job.id+'/disable',{});
 poller.kill('SIGTERM');await Promise.race([new Promise(r=>poller.once('close',r)),sleep(3000)]);if(poller.exitCode===null)poller.kill('SIGKILL');
}
