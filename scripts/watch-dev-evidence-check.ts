// 受入プロセス終了後、永続証跡を別プロセスから照合する。認証・モデル呼出・D1変更は行わない。
import {readFile,readdir,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import assert from 'node:assert/strict';
import {WatchSupervisor} from '../development/watch-supervisor.ts';
import {verifyAcceptanceRuntime} from '../development/watch-dev-preflight.ts';
import {fingerprint} from '../development/operations.ts';
// @ts-ignore dependency-free provider settlement boundary
import {verifyProviderSettlement} from '../development/watch-provider-budget.mjs';

const tag=process.env.WATCH_ACCEPTANCE_ID;
assert.match(tag||'',/^[a-z0-9-]{1,60}$/);
const root=resolve('.local/watch-acceptance',tag!);
const json=async(path:string)=>JSON.parse(await readFile(path,'utf8'));
const settlement=await json(join(root,'settlement.json')),request=await json(join(root,'request.json'));
assert.equal(settlement.task,request.id);
assert.equal(settlement.runs,(await json(join(root,'run-location.json'))).runs);
const owned=join(settlement.runs,request.id);
const events=(await readFile(join(owned,'private/activity.ndjson'),'utf8')).split('\n').filter(Boolean).map(x=>JSON.parse(x));
verifyProviderSettlement(events,request.maxCli);
assert.equal(settlement.provider.starts,events.filter(x=>x.event==='started').length);
assert.equal(settlement.provider.closed,settlement.provider.starts);
assert.equal(settlement.provider.settled,true);
assert.equal(settlement.inputUnchanged,true);
assert.equal(verifyAcceptanceRuntime(await readFile(join(root,'inputs/runtime.yaml'))),request.inputHash);
const supervisor=new WatchSupervisor(join(owned,'supervisor.db'));
try{assert.equal(supervisor.status('local',join(owned,'repo'))?.observed,'exited');}finally{supervisor.close();}
const d1=join(root,'d1/v3/d1');
const databases=(await readdir(d1,{recursive:true})).filter(x=>/(?:^|\/)[a-f0-9]{64}\.sqlite$/.test(x));
assert.equal(databases.length,1);
const db=new DatabaseSync(join(d1,databases[0]),{readOnly:true});
let row;
try{row=db.prepare('SELECT state,hold_until FROM runs WHERE job_id=?').get(request.id);}finally{db.close();}
assert.ok(row);assert.equal(row.hold_until,0);
if(process.argv.includes('--expect-stub-failure')){
 assert.equal(request.stub,true);assert.equal(settlement.stub,true);assert.equal(row.state,'failed');
 assert.equal((await json(join(root,'failure.json'))).error,'watch_task_failed');
 assert.deepEqual(await readdir(join(root,'artifacts')),[]);
}else{
 assert.equal(request.stub,false);assert.equal(row.state,'succeeded');
 const evidence=await json(join(root,'evidence.json'));
 assert.equal(evidence.task,request.id);assert.equal(evidence.state,'succeeded');
 assert.equal(evidence.publication,false);assert.equal(evidence.independentAssertions,5);
 for(const name of ['takt','test','artifact'])assert.ok(evidence.operations.some((x:any)=>x.name===name&&x.state==='completed'));
 assert.match(evidence.artifactId,/^[a-f0-9]{64}$/);
 const {artifactId,...artifact}=await json(join(root,'artifacts',evidence.artifactId+'.json'));
 assert.equal(artifactId,evidence.artifactId);assert.equal(fingerprint(artifact),artifactId);
 assert.equal(artifact.taskId,request.id);assert.equal(artifact.headSha,evidence.headSha);
 assert.equal(artifact.mode,'local_only');
}
const summary={task:request.id,stub:request.stub,fullAcceptanceSucceeded:!request.stub,d1State:row.state,holdUntil:row.hold_until,providerStarts:events.filter(x=>x.event==='started').length,providerClosed:events.filter(x=>x.event==='closed').length,watchStopped:true,durableEvidenceVerified:true,publication:false};
await writeFile(join(root,'verified-summary.json'),JSON.stringify(summary,null,2),{flag:'wx',mode:0o600});
console.log(JSON.stringify(summary));
