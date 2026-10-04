import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {Store,type Database,type Statement} from '../control-plane/store.ts';
import {LIMITS,jobInput,capacity} from '../shared/contracts.ts';
import {dispatch} from '../control-plane/dispatch.ts';
class Sqlite implements Database{
 db=new DatabaseSync(':memory:');
 constructor(){for(const file of ['0001_initial.sql','0002_capacity.sql','0003_development.sql'])this.db.exec(readFileSync('control-plane/migrations/'+file,'utf8'));}
 prepare(sql:string):Statement{
  const s=this.db.prepare(sql);let args:any[]=[];
  return {bind(...v){args=v;return this;},async first<T>(){return (s.get(...args)??null) as T|null;},async all<T>(){return {results:s.all(...args) as T[]};},async run(){return s.run(...args);}};
 }
 async batch(statements:Statement[]){this.db.exec('BEGIN');try{for(const s of statements)await s.run();this.db.exec('COMMIT');}catch(e){this.db.exec('ROLLBACK');throw e;}}
}
const input={name:'Synthetic',provider:'codex-luna',prompt:'2+3?',startAt:1000000,intervalSeconds:60,maxRuns:2,enabled:true};
test('generic fixture requires explicit profile, capacity and validated character',async()=>{
 const {s}=setup();const generic={...input,provider:'agent-fixture',agent:{characterId:'alice',toolset:'fixture-v1'}};
 await assert.rejects(s.create('a','bad',{...generic,agent:{characterId:'alice',toolset:'shell'}}));
 await s.create('a','generic',generic);await s.tick();
 assert.equal(await s.claim('a','old'),null);
 assert.equal(await s.claim('a','new','agent-fixture'),null);
 const limits={models:{'codex-luna':1,'pi-swe2':1,'agent-fixture':1},groups:{a:1}};
 const run=await s.claim('a','new','agent-fixture','a',limits);assert.equal(run?.agent?.characterId,'alice');
 assert.equal(await s.claim('b','other','agent-fixture','a',limits),null);
 await s.finish('a','new',run!.id,run!.token!,'alice: 5',null);
 assert.equal((await s.list('a')).runs[0].result,'alice: 5');
});
function setup(){let now=1000000;const db=new Sqlite(),s=new Store(db,()=>now);const admission=s.tick.bind(s);s.tick=async(...args)=>{const r=await admission(...args);for(const p of r.pending)await s.activate(p.id);return r;};return {s,db,advance:(ms:number)=>now+=ms};}
test('finite schedules, duplicate create and ticks, immutable idempotency payload',async()=>{
 const {s,advance}=setup();const id=await s.create('a','key',input);assert.equal(await s.create('a','key',input),id);
 await assert.rejects(s.create('a','key',{...input,prompt:'changed'}),/conflict/);
 await s.tick();await s.tick();assert.equal((await s.list('a')).runs.length,1);
 advance(60000);await s.tick();advance(999999);await s.tick();assert.equal((await s.list('a')).runs.length,2);
});
test('lease exclusivity, owner isolation, heartbeat and duplicate completion',async()=>{
 const {s}=setup();await s.create('a','key',input);await s.tick();
 const [a,b]=await Promise.all([s.claim('a','w1'),s.claim('a','w2')]);const r=a||b;assert(r);assert.equal([a,b].filter(Boolean).length,1);
 assert.equal(await s.claim('b','w1'),null);
 await assert.rejects(s.heartbeat('b',r.worker!,r.id,r.token!),/lease/);
 await assert.rejects(s.finish('a','wrong',r.id,r.token!,'5',null),/lease/);
 await s.heartbeat('a',r.worker!,r.id,r.token!);
 assert.equal((await s.finish('a',r.worker!,r.id,r.token!,'5',null)).duplicate,false);
 assert.equal((await s.finish('a',r.worker!,r.id,r.token!,'5',null)).duplicate,true);
 await assert.rejects(s.finish('a',r.worker!,r.id,r.token!,'6',null),/conflicting/);
});
test('killed worker lease expires; fencing old attempt; retry ceiling',async()=>{
 const {s,advance}=setup();await s.create('a','key',input);await s.tick();const first=(await s.claim('a','old'))!;
 advance(LIMITS.leaseMs+1);assert.equal(await s.claim('a','restart'),null);advance(LIMITS.timeoutMs);const second=(await s.claim('a','restart'))!;assert.equal(second.attempt,2);assert.notEqual(first.token,second.token);
 await assert.rejects(s.finish('a','old',first.id,first.token!,'stale',null),/lease/);
 advance(LIMITS.timeoutMs+3001);assert.equal(await s.claim('a','third'),null);assert.equal((await s.list('a')).runs[0]!.state,'failed');
});
test('deadline cannot be extended by heartbeat',async()=>{
 const {s,advance}=setup();await s.create('a','key',input);await s.tick();const r=(await s.claim('a','w'))!;
 for(let n=0;n<5;n++){advance(10000);await s.heartbeat('a','w',r.id,r.token!);}
 advance(10001);await assert.rejects(s.heartbeat('a','w',r.id,r.token!),/lease/);
 await assert.rejects(s.finish('a','w',r.id,r.token!,'late',null),/lease/);
 await s.finish('a','w',r.id,r.token!,null,'timeout');assert.equal((await s.list('a')).runs[0].error,'timeout');
});
test('cancel propagates through heartbeat; disabled job never requeues',async()=>{
 const {s,advance}=setup();const id=await s.create('a','key',input);await s.tick();const r=(await s.claim('a','w'))!;
 await assert.rejects(s.cancel('b',r.id),/not_found/);await s.cancel('a',r.id);
 await assert.rejects(s.heartbeat('a','w',r.id,r.token!),/cancelled/);
 await s.finish('a','w',r.id,r.token!,'late',null);assert.equal((await s.list('a')).runs[0]!.state,'cancelled');
 await s.disable('a',id);advance(60000);await s.tick();assert.equal((await s.list('a')).runs.length,1);
});
test('provider failure is recorded; no automatic paid retry',async()=>{
 const {s}=setup();await s.create('a','key',input);await s.tick();const r=(await s.claim('a','w'))!;
 await s.finish('a','w',r.id,r.token!,null,'provider_failed');assert.equal(await s.claim('a','w'),null);assert.equal((await s.list('a')).runs[0]!.error,'provider_failed');
});
test('disabled defaults, input allowlist, arbitrary command and path rejection',async()=>{
 const {s}=setup();await s.create('a','key',{...input,enabled:false});await s.tick();assert.equal((await s.list('a')).runs.length,0);
 for(const bad of [{provider:'digital-souls'},{command:'rm -rf /'},{cwd:'../../'},{maxRuns:999},{intervalSeconds:1},{prompt:'x'.repeat(5000)},{startAt:Infinity}])assert.throws(()=>jobInput({...input,...bad}));
});
test('per-owner job and daily attempt budgets',async()=>{
 const {s,advance}=setup();for(let j=0;j<LIMITS.maxJobs;j++)await s.create('a','key'+j,{...input,maxRuns:10});
 await assert.rejects(s.create('a','extra',input),/job_limit/);
 for(let n=0;n<LIMITS.dailyAttempts;n++){if(n%10===0){await s.tick();}const r=(await s.claim('a','w'))!;assert(r);await s.finish('a','w',r.id,r.token!,'ok',null);if(n%10===9)advance(60000);}
 await s.tick();
 assert.equal(await s.claim('a','w'),null);
});
test('overlap skip before workflow admission, concurrent ticks, no catchup, outbox recovery',async()=>{
 let now=1000000;const s=new Store(new Sqlite(),()=>now);await s.create('a','key',{...input,maxRuns:5});
 const races=await Promise.all([s.tick(),s.tick()]);assert.equal(races.reduce((n,r)=>n+r.enqueued,0),1);
 const id=races[0].pending[0].id;assert.equal((await s.tick()).pending[0].id,id,'outbox can be retried');
 now+=60000;assert.equal((await s.tick()).skipped,1,'starting is active');await s.activate(id);
 now+=60000;assert.equal((await s.tick()).skipped,1,'queued is active');
 const r=(await s.claim('a','w'))!;now+=60000;assert.equal((await s.tick()).skipped,1,'unknown or expired running is still active until reaped');
 await s.cancel('a',r.id);now+=1;assert.equal((await s.tick()).enqueued,0,'duplicate skipped slot remains skipped');
 assert.equal((await s.list('a')).runs.length,4);now+=600000;await s.tick();assert.equal((await s.list('a')).runs.length,4,'missed/future end slots do not catch up');
});
test('terminal failed workflow releases unclaimed start without retrying external work',async()=>{
 let now=1000000;const s=new Store(new Sqlite(),()=>now);await s.create('a','key',{...input,maxRuns:3});
 let creates=0;const workflows={async create(){creates++;throw Error('existing');},async get(){return {async status(){return {status:'errored'};}};}};
 const first=await dispatch(workflows,s,now,'a');assert.equal(first.failedStarts.length,1);
 assert.equal((await s.list('a')).runs[0].error,'workflow_failed');
 await dispatch(workflows,s,now,'a');assert.equal(creates,1,'terminal start is not retried forever');
 now+=60000;const next=await s.tick();assert.equal(next.enqueued,1,'next occurrence is not permanently skipped');
 await s.activate(next.pending[0].id);const running=(await s.claim('a','w'))!;
 await s.failStarting(running.id);assert.equal((await s.list('a')).runs.find(r=>r.id===running.id)!.state,'running');
});
test('unknown workflow status preserves outbox and raises rather than silently succeeding',async()=>{
 const s=new Store(new Sqlite(),()=>1000000);await s.create('a','key',input);
 await assert.rejects(dispatch({async create(){throw Error('create unavailable');},async get(){return {async status(){return {status:'unknown'};}};}},s,1000000,'a'),/unavailable/);
 assert.equal((await s.list('a')).runs[0].state,'starting');
});
test('global per-model and shared auth limits, competing workers never exceed either',async()=>{
 const {s}=setup();for(const owner of ['a','b'])for(const p of ['codex-luna','pi-swe2'])await s.create(owner,p,{...input,provider:p});await s.tick();
 const limits=capacity({models:{'codex-luna':1,'pi-swe2':1},groups:{shared:1,separate:2}});
 const contenders=await Promise.all(Array.from({length:20},(_,i)=>s.claim('a','worker'+i,'codex-luna','shared',limits)));
 const r=contenders.find(Boolean)!;assert.equal(contenders.filter(Boolean).length,1);
 assert.equal(await s.claim('b','b1','codex-luna','separate',limits),null,'global model budget spans owners');
 assert.equal(await s.claim('b','b2','pi-swe2','shared',limits),null,'auth group budget spans models/owners');
 assert(await s.claim('b','b3','pi-swe2','separate',limits));
 await s.finish('a',r.worker!,r.id,r.token!,'ok',null);
 assert(await s.claim('b','b4','codex-luna','shared',limits));
});
test('zero pauses a model/group; negative is invalid; cancel reserves until worker acknowledgement',async()=>{
 const {s,advance}=setup();for(let i=0;i<2;i++)await s.create('a','j'+i,input);await s.tick();
 const limits=capacity({models:{'codex-luna':0,'pi-swe2':1},groups:{a:2}});assert.equal(await s.claim('a','w',undefined,'a',limits),null);
 limits.models['codex-luna']=1;limits.groups.a=0;assert.equal(await s.claim('a','w',undefined,'a',limits),null);
 assert.throws(()=>capacity({models:{'codex-luna':-1,'pi-swe2':1},groups:{a:1}}));
 limits.groups.a=2;const r=(await s.claim('a','w',undefined,'a',limits))!;await s.cancel('a',r.id);
 assert.equal(await s.claim('a','w2',undefined,'a',limits),null,'cancel is not proof of process termination');
 await s.finish('a','w',r.id,r.token!,null,'cancelled');assert(await s.claim('a','w2',undefined,'a',limits));
 advance(LIMITS.timeoutMs+3001);assert(await s.claim('a','restarted',undefined,'a',limits));
});
