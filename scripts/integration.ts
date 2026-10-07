import assert from 'node:assert/strict';
import {writeFile,mkdir} from 'node:fs/promises';
import {client,once,cliRunner} from '../wsl-worker/main.ts';
import {integrationConfig} from './local-integration.ts';
const {tokens,base,evidence,dbPath}=await integrationConfig();
const live=process.argv.includes('--live');
const started=performance.now();
const measured={requests:0,requestBytes:0,responseBytes:0,statements:0,apiWallMs:0};
const originalFetch=globalThis.fetch;
globalThis.fetch=async(...args:Parameters<typeof fetch>)=>{
 const response=await originalFetch(...args);measured.requests++;
 if(typeof args[1]?.body==='string')measured.requestBytes+=Buffer.byteLength(args[1].body);
 measured.responseBytes+=Buffer.byteLength(await response.clone().text());
 const meta=response.headers.get('x-local-measurement');if(meta){const m=JSON.parse(meta);assert.equal(Object.hasOwn(m,'rowsRead'),false);assert.equal(Object.hasOwn(m,'rowsWritten'),false);assert.ok(Number.isSafeInteger(m.statements)&&m.statements>=0);measured.statements+=m.statements;measured.apiWallMs+=m.wallMs;}
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
const runIds:string[]=[];
const worker=client(base,tokens.worker);
// Two scheduler occurrences, each deliberately delivered twice. Drain before the next occurrence.
for(const time of [at,at+60000]){
for(let duplicate=0;duplicate<2;duplicate++){
 const tick=await api('api/tick',{at:time});assert.equal(tick.status,202);
 for(const id of tick.body.ids){if(runIds.includes(id))continue;runIds.push(id);
  const state=await api('api/ticks/'+id);assert.equal(state.status,200);assert.equal(state.body.id,id);assert.equal(state.body.state,'queued');
  assert.equal((await api('api/ticks/'+id,undefined,tokens.other)).status,403);
 }
}
assert.equal(await client(base,tokens.other)('/api/claim',{protocol:'absolute-deadline-v1'}),null);
for(let n=0;n<2;n++)assert(await once(worker,live?cliRunner:async()=> '5'));
}
assert.equal(await once(worker,live?cliRunner:async()=> 'unexpected'),false);
const state=(await api('api/state')).body;
const runs=state.runs.filter((r:any)=>ids.includes(r.job_id));assert.equal(runs.length,4);
for(const r of runs){assert.equal(r.state,'succeeded',JSON.stringify(r));assert.equal(r.result.trim(),'5');}
for(const id of ids)await api('api/jobs/'+id+'/disable',{});
const report={at:new Date().toISOString(),dbPath,mode:live?'LIVE providers':'fixture provider',activatedRuns:runIds.length,scheduledOccurrences:2,successfulRuns:runs.length,wallMs:performance.now()-started,measured,resultBytes:runs.reduce((n:number,r:any)=>n+Buffer.byteLength(r.result),0),results:runs.map((r:any)=>({id:r.id,state:r.state,result:r.result}))};
await mkdir(evidence,{recursive:true});await writeFile(evidence+'/'+(live?'live':'fixture')+'-measurement.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
