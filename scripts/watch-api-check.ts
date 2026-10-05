import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {DevelopmentClient} from '../development/client.ts';
import {client} from '../wsl-worker/main.ts';
const tokens=JSON.parse(await readFile('.local/tokens.json','utf8')),base=process.env.CONTROL_URL||'http://127.0.0.1:8787/';
const viewer=new DevelopmentClient(base,tokens.viewer),worker=client(base,tokens.worker),other=new DevelopmentClient(base,tokens.other);
const spec={repoId:'private-agent',baseRef:'epic/development-runner',goal:'Synthetic watch D1 lifecycle',acceptanceCriteria:['No provider call'],executionProfileId:'takt-watch',watch:{issue:1,validation:['Synthetic host proof']}};
const first=await viewer.submit(spec,crypto.randomUUID()),dependent=await viewer.submit({...spec,watch:{...spec.watch,dependencies:[first.id]}},crypto.randomUUID());
await assert.rejects(other.status(first.id),/403/);
await worker('/api/development/runner-heartbeat',{available:true,executionProfile:'takt-simple'});
await assert.rejects(worker('/api/claim',{protocol:'development-v1',taskKind:'development',provider:'codex-luna',executionProfile:'takt-watch'}),/409/);
await worker('/api/development/runner-heartbeat',{available:true,executionProfile:'takt-watch'});
const run=await worker('/api/claim',{protocol:'development-v1',taskKind:'development',provider:'codex-luna',executionProfile:'takt-watch'}) as any;
if(run){assert.equal(run.job_id,first.id);await viewer.cancel(first.id);await assert.rejects(worker('/api/runs/'+run.id+'/heartbeat',{token:run.token}),/409/);await worker('/api/runs/'+run.id+'/complete',{token:run.token,result:null,error:'cancelled'});}
else await viewer.cancel(first.id);
assert.equal(await worker('/api/claim',{protocol:'development-v1',taskKind:'development',provider:'codex-luna',executionProfile:'takt-watch'}),null);
assert.equal((await viewer.status(dependent.id)).state,'queued');await viewer.cancel(dependent.id);
await worker('/api/development/runner-heartbeat',{available:false,executionProfile:'takt-watch'});
console.log(JSON.stringify({localD1Watch:true,capacityEnabled:!!run,profileFenced:true,dependencyWait:true,cancelFenced:true,providerExecuted:false}));
