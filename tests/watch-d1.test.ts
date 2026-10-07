import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { Store, type Database, type Statement } from '../control-plane/store.ts';
import { DevelopmentStore } from '../control-plane/development-store.ts';
import { developmentInput } from '../shared/development.ts';
class DB implements Database {
 db=new DatabaseSync(':memory:');
 constructor(){for(const file of ['0001_initial.sql','0002_capacity.sql','0003_development.sql','0004_takt_resources.sql'])this.db.exec(readFileSync('control-plane/migrations/'+file,'utf8'));}
 prepare(sql:string):Statement {const stmt=this.db.prepare(sql);let args:any[]=[];return {bind(...v){args=v;return this;},async first<T>(){return stmt.get(...args) as T??null;},async all<T>(){return {results:stmt.all(...args) as T[]};},async run(){return stmt.run(...args);}};}
 async batch(list:Statement[]){this.db.exec('BEGIN');try{for(const s of list)await s.run();this.db.exec('COMMIT');}catch(e){this.db.exec('ROLLBACK');throw e;}}
}
const input={repoId:'private-agent',baseRef:'epic/development-runner',goal:'synthetic',acceptanceCriteria:['pass'],executionProfileId:'takt-watch',watch:{issue:1,validation:['Check expected behavior']}};
const limits={models:{'codex-luna':1,'codex-sol':1,'pi-swe2':0},groups:{shared:1}};
function setup(){const db=new DB();let now=1000000;const store=new Store(db,()=>now),dev=new DevelopmentStore(store);return {db,store,dev,advance:(ms:number)=>now+=ms,claim:(owner='a',worker='w',caps=limits)=>store.claim(owner,worker,'codex-luna','shared',caps,'development','takt-watch')};}
test('watch is explicit, bounded and programmatic; defaults and local repo remain compatible',()=>{
 const parsed=developmentInput(input);assert.deepEqual(parsed.watch,{issue:1,workflow:'default',validation:['Check expected behavior'],dependencies:[]});assert.equal(parsed.orchestratorProfileId,'programmatic');
 assert.equal(developmentInput({...input,executionProfileId:undefined,watch:undefined}).executionProfileId,'takt-simple');
 assert.equal(developmentInput({...input,repoId:'local-GPT-live',baseRef:'epic/transport-playback'}).executionProfileId,'takt-watch');
 for(const override of [{issue:0},{issue:1.5},{issue:Number.MAX_SAFE_INTEGER+1},{workflow:'review'},{workflow:null},{dependencies:null},{dependencies:['x']},{dependencies:Array(17).fill('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')},{validation:[]},{validation:Array(21).fill('x')},{validation:['x'.repeat(2049)]},{command:'sh'}])assert.throws(()=>developmentInput({...input,watch:{...input.watch,...override}}));
 for(const override of [{watch:undefined},{orchestratorProfileId:'plan-codex-luna'},{executionProfileId:'takt-simple'}])assert.throws(()=>developmentInput({...input,...override}));
});
test('dependency submission refuses unknown, foreign owner and foreign repository tasks without inserts',async()=>{
 const {db,dev}=setup();try{
  const foreign=await dev.submit('b','other',input),repo=await dev.submit('a','repo',{...input,repoId:'local-GPT-live',baseRef:'epic/transport-playback'});
  for(const dependency of [crypto.randomUUID(),foreign,repo])await assert.rejects(dev.submit('a','blocked',{...input,watch:{...input.watch,dependencies:[dependency]}}),/invalid_watch_dependency/);
  assert.equal(db.db.prepare('SELECT COUNT(*) n FROM development_tasks').get()!.n,2);
  const own=await dev.submit('a','own',input),spec={...input,watch:{...input.watch,dependencies:[own]}};
  const dependent=await dev.submit('a','next',spec);assert.equal(await dev.submit('a','next',spec),dependent);
  await assert.rejects(dev.status('b',dependent),/not_found/);
 }finally{db.db.close();}
});
test('atomic claim waits for every successful dependency with completed artifact and released hold',async()=>{
 const {db,dev,store,claim}=setup();try{
  const dependency=await dev.submit('a','first',input),second=await dev.submit('a','second',input);
  const id=await dev.submit('a','dependent',{...input,watch:{...input.watch,dependencies:[dependency,second]}});
  // 不完全な永続状態を直接作り、claimのSQL境界を個別に検証する。
  db.db.prepare("UPDATE runs SET state='failed'").run();db.db.prepare("UPDATE runs SET state='queued' WHERE job_id=?").run(id);
  assert.equal(await claim(),null);
  db.db.prepare("UPDATE runs SET state='succeeded',hold_until=0 WHERE job_id IN (?,?)").run(dependency,second);assert.equal(await claim(),null);
  db.db.prepare("INSERT INTO development_operations VALUES(?, 'artifact','fp','completed','{}')").run(dependency);assert.equal(await claim(),null);
  db.db.prepare("INSERT INTO development_operations VALUES(?, 'artifact','fp','reserved',NULL)").run(second);assert.equal(await claim(),null);
  db.db.prepare("UPDATE development_operations SET state='completed',result='{}' WHERE task_id=?").run(second);
  db.db.prepare('UPDATE runs SET hold_until=1 WHERE job_id=?').run(second);assert.equal(await claim(),null);
  db.db.prepare('UPDATE runs SET hold_until=0 WHERE job_id=?').run(second);
  assert.equal(await store.claim('a','old','codex-luna','shared',limits,'development','takt-simple'),null);
  assert.equal(await claim('b'),null);
  const claims=await Promise.all([claim('a','w1'),claim('a','w2')]);assert.equal(claims.filter(Boolean).length,1);assert.equal(claims.find(Boolean)!.job_id,id);
 }finally{db.db.close();}
});
test('watch announces its own profile and reserves one Sol plan job and one group slot regardless of internal models',async()=>{
 const {db,dev,claim}=setup();try{
  await dev.announce('a','w',true,'takt-watch');assert.deepEqual(JSON.parse(db.db.prepare('SELECT capabilities FROM development_workers').get()!.capabilities as string),['programmatic','takt-watch']);
  await dev.submit('a','one',input);await dev.submit('b','two',input);
  for(const key of ['codex-sol'] as const)assert.equal(await claim('a','w',{...limits,models:{...limits.models,[key]:0}}),null);
  assert.equal(await claim('a','w',{...limits,groups:{shared:0}}),null);
  const run=(await claim('a','w',{...limits,models:{...limits.models,'codex-luna':0}}))!;assert.ok(run);assert.deepEqual(JSON.parse(db.db.prepare('SELECT resources_json FROM jobs WHERE id=?').get(run.job_id)!.resources_json as string),{'codex-sol':1});
  assert.equal(await claim('b','w2',{models:{'codex-luna':10,'codex-sol':10,'pi-swe2':0},groups:{shared:1}}),null);
 }finally{db.db.close();}
});
test('watch cancellation and deadline expiry retain reservations until original runner stop ACK',async()=>{
 for(const cancel of [true,false]){
  const {db,dev,store,claim,advance}=setup();try{
   await dev.submit('a','first',{...input,budgetMs:60000});await dev.submit('b','next',input);const run=(await claim())!;
   if(cancel)await store.cancel('a',run.id);else{advance(64000);await store.reap('a');}
   assert.equal(await claim('b','other'),null);await assert.rejects(store.finish('a','wrong',run.id,run.token!,null,'stopped'),/lease_lost/);
   await store.finish('a','w',run.id,run.token!,null,'stopped');assert.ok(await claim('b','other'));
   assert.equal((await dev.status('a',run.job_id)).state,cancel?'cancelled':'failed');
  }finally{db.db.close();}
 }
});

test('delegated watch survives six hours without observer heartbeat and resumes the same token without a second attempt',async()=>{
 const {db,dev,store,claim,advance}=setup();try{
  await dev.submit('a','long',{...input,budgetMs:60000});const run=(await claim())!;
  await dev.operation('a','w',run.job_id,run.token!,'takt','a'.repeat(64));
  advance(6*60*60*1000);await store.reap('a');
  assert.equal((await dev.status('a',run.job_id)).state,'running');
  assert.equal(await claim('a','other'),null);
  const resumed=(await claim())!;assert.equal(resumed.id,run.id);assert.equal(resumed.token,run.token);assert.equal(resumed.attempt,1);
  assert.equal(db.db.prepare('SELECT COUNT(*) n FROM attempts').get()!.n,1);
  await store.heartbeat('a','w',run.id,run.token!);
  await dev.operation('a','w',run.job_id,run.token!,'takt','a'.repeat(64),'{}');
  await store.finish('a','w',run.id,run.token!,'local-only-result',null);
  assert.equal((await dev.status('a',run.job_id)).state,'succeeded');
 }finally{db.db.close();}
});

test('delegated cancellation is explicit and retains hold until the original execution acknowledges stop',async()=>{
 const {db,dev,store,claim,advance}=setup();try{
  await dev.submit('a','long',input);const run=(await claim())!;
  await dev.operation('a','w',run.job_id,run.token!,'takt','a'.repeat(64));
  advance(6*60*60*1000);await store.cancel('a',run.id);
  assert.equal((await store.heartbeat('a','w',run.id,run.token!)).cancelRequested,true);
  assert.equal((await claim())!.state,'cancelled');
  await assert.rejects(store.heartbeat('a','foreign',run.id,run.token!),/lease_lost/);
  await store.finish('a','w',run.id,run.token!,null,'stopped');assert.equal(await claim(),null);
 }finally{db.db.close();}
});
