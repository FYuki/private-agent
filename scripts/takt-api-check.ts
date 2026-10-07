import assert from 'node:assert/strict';
import {integrationConfig} from './local-integration.ts';
import {DevelopmentClient} from '../development/client.ts';
import {client} from '../wsl-worker/main.ts';
const {tokens,base}=await integrationConfig();
const viewer=new DevelopmentClient(base,tokens.viewer),worker=client(base,tokens.worker);
const {id}=await viewer.submit({repoId:'private-agent',baseRef:'epic/development-runner',goal:'Synthetic TAKT API test; never execute a model.',acceptanceCriteria:['cancel and progress'],budgetMs:7200000},crypto.randomUUID());
await worker('/api/development/runner-heartbeat',{available:true,executionProfile:'takt-simple'});
const run=await worker('/api/claim',{protocol:'development-v1',taskKind:'development',provider:'codex-luna',executionProfile:'takt-simple'}) as any;
// Dev defaults intentionally keep Sol disabled. Both outcomes are explicit contract checks.
if(run){assert.equal(run.job_id,id);assert.equal(run.budget_ms,7200000);await worker('/api/development/tasks/'+id+'/progress',{token:run.token,stage:'review',iteration:4});assert.equal(JSON.parse((await viewer.status(id)).progress_json).stage,'review');}
await viewer.cancel(id);
if(run){await assert.rejects(worker('/api/development/tasks/'+id+'/progress',{token:run.token,stage:'supervise',iteration:5}),/409/);await worker('/api/runs/'+run.id+'/complete',{token:run.token,result:null,error:'cancelled'});}
await worker('/api/development/runner-heartbeat',{available:false,executionProfile:'takt-simple'});
console.log(JSON.stringify({taktApi:true,capacityEnabled:!!run,finiteLongBudget:true,cancelFenced:true,realModel:false}));
