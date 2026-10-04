import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { Store, type Database, type Statement } from '../control-plane/store.ts';
import { DevelopmentStore } from '../control-plane/development-store.ts';
import { DEVELOPMENT_BUDGET_MS, developmentInput } from '../shared/development.ts';
import { executionDeadline } from '../wsl-worker/main.ts';
class DB implements Database {
  db=new DatabaseSync(':memory:');
  constructor(){ for(const name of ['0001_initial.sql','0002_capacity.sql','0003_development.sql','0004_takt_resources.sql'])this.db.exec(readFileSync('control-plane/migrations/'+name,'utf8')); }
  prepare(sql:string):Statement { const statement=this.db.prepare(sql);let args:any[]=[];return {bind(...values){args=values;return this;},async first<T>(){return statement.get(...args) as T??null;},async all<T>(){return {results:statement.all(...args) as T[]};},async run(){return statement.run(...args);}}; }
  async batch(list:Statement[]){this.db.exec('BEGIN');try{for(const s of list)await s.run();this.db.exec('COMMIT');}catch(e){this.db.exec('ROLLBACK');throw e;}}
}
const input={repoId:'private-agent',goal:'Synthetic change',baseRef:'epic/development-runner',acceptanceCriteria:['tests pass'],orchestratorProfileId:'plan-codex-luna',executionProfileId:'edit-codex-luna'};
const capacity={models:{'codex-luna':1,'pi-swe2':1},groups:{shared:1}};
test('TAKT completes after 75 minutes and releases both model reservations only after completion',async()=>{
 const {db,store,dev,advance}=setup();try{
  const spec={...input,orchestratorProfileId:'programmatic',executionProfileId:'takt-simple',budgetMs:7200000};
  const id=await dev.submit('a','long-success',spec);await dev.submit('b','waiting',spec);
  for(const models of [{'codex-luna':0,'codex-sol':1},{'codex-luna':1,'codex-sol':0}])assert.equal(await store.claim('a','w','codex-luna','shared',{models:{'pi-swe2':0,...models},groups:{shared:2}},'development','takt-simple'),null);
  const caps={models:{'pi-swe2':0,'codex-luna':1,'codex-sol':1},groups:{shared:2}};
  const run=(await store.claim('a','w','codex-luna','shared',caps,'development','takt-simple'))!;
  for(let i=0;i<300;i++){advance(15000);await store.heartbeat('a','w',run.id,run.token!);}
  assert.equal((await dev.status('a',id)).state,'running');
  assert.equal(await store.claim('b','w2','codex-luna','shared',caps,'development','takt-simple'),null);
  await store.finish('a','w',run.id,run.token!,JSON.stringify({synthetic:true}),null);
  assert.equal((await dev.status('a',id)).state,'succeeded');
  assert.ok(await store.claim('b','w2','codex-luna','shared',caps,'development','takt-simple'));
 }finally{db.db.close();}
});
function setup(){const db=new DB();let now=1000000;const store=new Store(db,()=>now);return {db,store,dev:new DevelopmentStore(store),advance:(ms:number)=>now+=ms};}
test('voice local-only results and artifact ledger remain owner-scoped',async()=>{
 const {db,store,dev}=setup();try{
  const id=await dev.submit('a','voice',{repoId:'local-GPT-live',baseRef:'epic/transport-playback',goal:'synthetic',acceptanceCriteria:['pass']});
  const run=(await store.claim('a','w','codex-luna','shared',{models:{...capacity.models,'codex-sol':1},groups:{shared:1}},'development','takt-simple'))!;
  await dev.operation('a','w',id,run.token!,'artifact','a'.repeat(64),JSON.stringify({headSha:'b'.repeat(40)}));
  await assert.rejects(dev.operation('b','w',id,run.token!,'artifact','a'.repeat(64)),/lease_lost/);
  await store.finish('a','w',run.id,run.token!,JSON.stringify({outcome:'local_only',artifactId:'a'.repeat(64)}),null);
  assert.equal((await dev.status('a',id)).state,'succeeded');await assert.rejects(dev.status('b',id),/not_found/);
 }finally{db.db.close();}
});
test('five TAKT reservations share the Sol model cap across owners and profiles',async()=>{
 const {db,store,dev}=setup();try{
  const limits={models:{'codex-sol':5,'codex-luna':30,'pi-swe2':0},groups:{shared:35}};
  for(let i=0;i<6;i++)await dev.submit('owner'+i,'takt',{...input,orchestratorProfileId:'programmatic',executionProfileId:'takt-simple'});
  const claims=await Promise.all(Array.from({length:6},(_,i)=>store.claim('owner'+i,'worker'+i,'codex-luna','shared',limits,'development','takt-simple')));
  assert.equal(claims.filter(Boolean).length,5);
  const first=claims.find(Boolean)!;await store.finish(first.owner,first.worker!,first.id,first.token!,'synthetic',null);
  const blocked=claims.findIndex(x=>!x);assert.ok(await store.claim('owner'+blocked,'replacement','codex-luna','shared',limits,'development','takt-simple'));
 }finally{db.db.close();}
});
test('TAKT atomically reserves Sol plus Luna and shared quota; crash never releases by TTL alone',async()=>{
 const {db,store,dev,advance}=setup();try{
  const spec={...input,orchestratorProfileId:'programmatic',executionProfileId:'takt-simple',budgetMs:7200000};
  await dev.submit('a','takt',spec);await dev.submit('b','takt',spec);
  assert.equal(await store.claim('a','w1','codex-luna','shared',capacity,'development','takt-simple'),null);
  const caps={models:{...capacity.models,'codex-sol':1},groups:{shared:2}};
  const run=await store.claim('a','w1','codex-luna','shared',caps,'development','takt-simple');assert.ok(run);
  await dev.progress('a','w1',run.job_id,run.token!,'plan',1);
  await assert.rejects(dev.progress('b','w1',run.job_id,run.token!,'plan',1),/lease_lost/);
  await assert.rejects(dev.progress('a','w1',run.job_id,run.token!,'../../evil',1),/invalid_progress/);
  assert.equal(run.budget_ms,7200000);assert.equal(executionDeadline(0n,run),7200000000000n);
  assert.equal(await store.claim('b','w2','codex-luna','shared',caps,'development','takt-simple'),null);
  for(let i=0;i<300;i++){advance(15000);await store.heartbeat('a','w1',run.id,run.token!);}
  assert.equal((await dev.status('a',run.job_id)).state,'running');
  advance(2704000);await store.reap('a');
  assert.equal(await store.claim('b','w2','codex-luna','shared',caps,'development','takt-simple'),null);
  assert.equal((await dev.status('a',run.job_id)).state,'failed');
  await assert.rejects(store.finish('a','other',run.id,run.token!,null,'cancelled'),/lease_lost/);
  await store.finish('a','w1',run.id,run.token!,null,'cancelled');
  assert.ok(await store.claim('b','w2','codex-luna','shared',caps,'development','takt-simple'));
  assert.equal((await dev.status('a',run.job_id)).error,'lease_expired');
 }finally{db.db.close();}
});
test('development submit normalizes defaults, deduplicates and isolates owners',async()=>{
 const defaults=developmentInput({...input,orchestratorProfileId:undefined,executionProfileId:undefined});assert.equal(defaults.orchestratorProfileId,'programmatic');assert.equal(defaults.executionProfileId,'takt-simple');assert.equal(defaults.budgetMs,14400000);
 const {db,dev}=setup();try{
  const id=await dev.submit('a','same',input);assert.equal(await dev.submit('a','same',input),id);
  await assert.rejects(dev.submit('a','same',{...input,goal:'different'}),/idempotency_conflict/);
  const other=await dev.submit('b','same',input);assert.notEqual(other,id);await assert.rejects(dev.status('b',id),/not_found/);
  assert.equal((await dev.status('a',id)).spec.orchestratorProfileId,'plan-codex-luna');
  for(const extra of [{repoId:'other'},{baseRef:'main'},{orchestratorProfileId:'plan-claude'},{executionProfileId:'edit-claude'},{endpoint:'http://evil'},{path:'../../x'}])assert.throws(()=>developmentInput({...input,...extra}));
 }finally{db.db.close();}
});
test('development budget aligns deadline, lease, attempt timestamp and existing capacity',async()=>{
 const {db,dev,store,advance}=setup();try{
  await dev.submit('a','one',input);await dev.submit('b','two',input);
  assert.equal(await store.claim('a','old'),null);
  const run=await store.claim('a','w','codex-luna','shared',capacity,'development');assert(run);
  assert.equal(run.deadline!-run.issued_at,DEVELOPMENT_BUDGET_MS);
  assert.equal(db.db.prepare('SELECT started_at FROM attempts').get()!.started_at,1000000);
  assert.equal(executionDeadline(0n,run),BigInt(DEVELOPMENT_BUDGET_MS)*1000000n);
  assert.equal(await store.claim('b','other','codex-luna','shared',capacity,'development'),null);
  advance(60001);assert.equal(await store.claim('a','replacement','codex-luna','shared',capacity,'development'),null);
  advance(DEVELOPMENT_BUDGET_MS);assert.equal(await store.claim('a','replacement','codex-luna','shared',capacity,'development'),null);
  assert.equal((await dev.status('a',run.job_id)).state,'failed');
 }finally{db.db.close();}
});
test('operation reservation never grants a duplicate write and cancel fences operations',async()=>{
 const {db,dev,store}=setup();try{
  const id=await dev.submit('a','one',input);const run=(await store.claim('a','w','codex-luna','shared',capacity,'development'))!;
  assert.equal((await dev.operation('a','w',id,run.token!,'push','f')).fresh,true);
  assert.equal((await dev.operation('a','w',id,run.token!,'push','f')).fresh,false);
  await assert.rejects(dev.operation('a','w',id,run.token!,'push','different'),/operation_conflict/);
  await assert.rejects(dev.operation('b','w',id,run.token!,'push','f'),/lease/);
  await dev.operation('a','w',id,run.token!,'push','f','verified-sha');
  assert.equal((await dev.operation('a','w',id,run.token!,'push','f')).result,'verified-sha');
  await store.cancel('a',run.id);await assert.rejects(dev.operation('a','w',id,run.token!,'pull-request','f'),/cancelled/);
  assert.equal(await store.claim('b','other','codex-luna','shared',capacity,'development'),null);
 }finally{db.db.close();}
});

test('cancel between heartbeat and reservation is fenced by the mutation itself',async()=>{
 const {db,dev,store}=setup();try{const id=await dev.submit('a','race',input),run=(await store.claim('a','w','codex-luna','shared',capacity,'development'))!;
 const heartbeat=store.heartbeat.bind(store);store.heartbeat=async(...args)=>{const result=await heartbeat(...args);await store.cancel('a',run.id);return result;};
 await assert.rejects(dev.operation('a','w',id,run.token!,'push','f'),/lease_lost/);assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM development_operations').get()!.n,0);
 }finally{db.db.close();}
});
test('concurrent different operation outcomes cannot overwrite each other',async()=>{
 const {db,dev,store}=setup();try{const id=await dev.submit('a','race',input),run=(await store.claim('a','w','codex-luna','shared',capacity,'development'))!;
 await dev.operation('a','w',id,run.token!,'push','f');const results=await Promise.allSettled(['a','b'].map(result=>dev.operation('a','w',id,run.token!,'push','f',result)));
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.filter(r=>r.status==='rejected').length,1);
 }finally{db.db.close();}
});
