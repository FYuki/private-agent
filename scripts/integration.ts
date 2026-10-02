import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {client,once,cliRunner} from '../wsl-worker/main.ts';
const tokens=JSON.parse(await readFile('.local/tokens.json','utf8'));
const base=process.env.CONTROL_URL||'http://127.0.0.1:8787/';
const live=process.argv.includes('--live');
const started=performance.now();
const measured={requests:0,requestBytes:0,responseBytes:0,statements:0,rowsRead:0,rowsWritten:0,apiWallMs:0};
const originalFetch=globalThis.fetch;
globalThis.fetch=async(...args:Parameters<typeof fetch>)=>{
 const response=await originalFetch(...args);measured.requests++;
 if(typeof args[1]?.body==='string')measured.requestBytes+=Buffer.byteLength(args[1].body);
 measured.responseBytes+=Buffer.byteLength(await response.clone().text());
 const meta=response.headers.get('x-local-measurement');if(meta){const m=JSON.parse(meta);measured.statements+=m.statements;measured.rowsRead+=m.rowsRead;measured.rowsWritten+=m.rowsWritten;measured.apiWallMs+=m.wallMs;}
 return response;
};
async function api(path:string,body?:unknown,token=tokens.viewer,key?:string){
 const res=await fetch(new URL(path,base),{method:body?'POST':'GET',headers:{authorization:'Bearer '+token,'content-type':'application/json',...(key?{'idempotency-key':key}:{})},...(body?{body:JSON.stringify(body)}:{})});
 return {status:res.status,body:await res.json() as any};
}
assert.equal((await fetch(base+'api/state')).status,401);
assert.equal((await api('api/claim',{})).status,403);
const at=Date.now()-60000;
const ids:string[]=[];
for(const provider of ['codex-luna','pi-swe2']){
 const key=crypto.randomUUID(),body={name:(live?'Live':'Fixture')+' '+provider,provider,prompt:'Synthetic scheduled task. Calculate 2 + 3. Answer with the number only.',startAt:at,intervalSeconds:60,maxRuns:2,enabled:true};
 const created=await api('api/jobs',body,tokens.viewer,key);assert.equal(created.status,201);ids.push(created.body.id);
 assert.equal((await api('api/jobs',body,tokens.viewer,key)).body.id,created.body.id);
}
const workflowIds:string[]=[];const workflowMeasurements:any[]=[];
const worker=client(base,tokens.worker);
// Two scheduler occurrences, each deliberately delivered twice. Drain before the next occurrence.
for(const time of [at,at+60000]){
for(let duplicate=0;duplicate<2;duplicate++){
 const tick=await api('api/tick',{at:time});assert.equal(tick.status,202);
 for(const id of tick.body.ids){if(workflowIds.includes(id))continue;workflowIds.push(id);
 for(let n=0;n<60;n++){
  const state=await api('api/ticks/'+id);if(state.body.status==='complete'){workflowMeasurements.push(state.body.output?.measurement);break;}
  if(n===59)throw Error('workflow_not_completed');await new Promise(r=>setTimeout(r,100));
 }}
}
assert.equal(await client(base,tokens.other)('/api/claim',{protocol:'absolute-deadline-v1'}),null);
for(let n=0;n<2;n++)assert(await once(worker,live?cliRunner:async()=> '5'));
}
assert.equal(await once(worker,live?cliRunner:async()=> 'unexpected'),false);
const state=(await api('api/state')).body;
const runs=state.runs.filter((r:any)=>ids.includes(r.job_id));assert.equal(runs.length,4);
for(const r of runs){assert.equal(r.state,'succeeded',JSON.stringify(r));assert.equal(r.result.trim(),'5');}
for(const id of ids)await api('api/jobs/'+id+'/disable',{});
const report={at:new Date().toISOString(),mode:live?'LIVE providers':'fixture provider',workflowInstances:workflowIds.length,scheduledOccurrences:2,successfulRuns:runs.length,wallMs:performance.now()-started,measured,workflowMeasurements,resultBytes:runs.reduce((n:number,r:any)=>n+Buffer.byteLength(r.result),0),results:runs.map((r:any)=>({id:r.id,state:r.state,result:r.result}))};
await mkdir('.local/evidence',{recursive:true});await writeFile('.local/evidence/'+(live?'live':'fixture')+'-measurement.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
