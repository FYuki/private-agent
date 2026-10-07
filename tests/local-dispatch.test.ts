import test from 'node:test';
import assert from 'node:assert/strict';
import { type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import type { Run } from '../shared/contracts.ts';
import { Store } from '../control-plane/store.ts';
import { recoverStarting } from '../control-plane/dispatch.ts';
import { DevelopmentStore } from '../control-plane/development-store.ts';
import { withCleanup, startProcess } from '../scripts/resources.ts';
import { job, limits, localDispatch, migrate, migrationsDirectory, observeRecovery, openDatabase, savedStarts, temporaryDirectory, type LocalDatabase } from './fixtures/local-control.ts';

for(const count of [0,1,100,101,201])test('recovery consumes bounded SQLite pages for '+count+' saved starts',async()=>{
  const f=temporaryDirectory();let db;
  try {
    db=await openDatabase(f.path);await migrate(db,migrationsDirectory);const saved=await savedStarts(db,count);
    const observed=observeRecovery(db),store=new Store(observed.db,()=>1000000);
    const ids=await recoverStarting(store);
    let outstanding=0,total=0;
    for(const event of observed.events){
      if(event.kind==='read'){assert.equal(outstanding,0,'consume each page before reading the next');assert.ok(event.rows<=100,'SQLite must limit each result');outstanding=event.rows;total+=event.rows;}
      else outstanding--;
    }
    assert.equal(outstanding,0);assert.equal(total,count);
    assert.deepEqual(ids,[]);
    const rows=(await store.q('SELECT id,owner,state,attempt FROM runs ORDER BY id').all<{id:string;owner:string;state:string;attempt:number}>()).results;
    assert.deepEqual(rows.map(run=>({...run})),saved.map(run=>({...run,state:'queued',attempt:0})));
  } finally {db?.close();f.cleanup();}
});

for(const disabled of [100,101])test('recovery advances past '+disabled+' ineligible starts',async()=>{
  const f=temporaryDirectory();let db;
  try {
    db=await openDatabase(f.path);await migrate(db,migrationsDirectory);const saved=await savedStarts(db,101);
    for(const run of saved.slice(0,disabled))await db.prepare('UPDATE jobs SET enabled=0 WHERE id=(SELECT job_id FROM runs WHERE id=?)').bind(run.id).run();
    await recoverStarting(new Store(db));
    const rows=(await db.prepare('SELECT id,state,attempt FROM runs ORDER BY id').all<{id:string;state:string;attempt:number}>()).results.map(run=>({...run}));
    assert.deepEqual(rows,saved.map((run,i)=>({id:run.id,state:i<disabled?'starting':'queued',attempt:0})));
  } finally {db?.close();f.cleanup();}
});

test('later page SQL failure propagates and subsequent dispatch recovers the remaining identifiers',async()=>{
  const f=temporaryDirectory();let db;
  try {
    db=await openDatabase(f.path);await migrate(db,migrationsDirectory);const saved=await savedStarts(db,201),failed=saved[100].id;
    await db.prepare(`CREATE TRIGGER fail_later_activation BEFORE UPDATE OF state ON runs WHEN NEW.state='queued' AND NEW.id='${failed}' BEGIN SELECT RAISE(ABORT,'fixture'); END`).run();
    const observed=observeRecovery(db),store=new Store(observed.db,()=>1000000);
    await assert.rejects(localDispatch(store,1000000));
    assert.deepEqual(observed.pendingQueries,[]);
    const rows=(await store.q('SELECT id,state,attempt FROM runs ORDER BY id').all<{id:string;state:string;attempt:number}>()).results.map(run=>({...run}));
    assert.deepEqual(rows,saved.map((run,i)=>({id:run.id,state:i<100?'queued':'starting',attempt:0})));
    await db.prepare('DROP TRIGGER fail_later_activation').run();
    assert.deepEqual(await localDispatch(store,1000000),{enqueued:0,skipped:0,ids:[]});
    assert.deepEqual((await store.q('SELECT id,state,attempt FROM runs ORDER BY id').all<{id:string;state:string;attempt:number}>()).results.map(run=>({...run})),saved.map(run=>({id:run.id,state:'queued',attempt:0})));
  } finally {db?.close();f.cleanup();}
});

test('direct tick retains pending by default and can omit its query without changing admission',async()=>{
  const f=temporaryDirectory();let db;
  try {
    db=await openDatabase(f.path);await migrate(db,migrationsDirectory);const store=new Store(db,()=>1000000),id=await store.create('a','one',job);
    const observed=observeRecovery(db),measured=new Store(observed.db,()=>1000000);
    assert.deepEqual(await measured.tick(1000000,'a',false),{enqueued:1,skipped:0,pending:[]});
    assert.deepEqual(observed.pendingQueries,[]);
    const result=await measured.tick(1000000,'a');
    assert.deepEqual({...result,pending:result.pending.map(run=>({...run}))},{enqueued:0,skipped:0,pending:[{id:id+':0',owner:'a'}]});
    assert.equal(observed.pendingQueries.length,1);
  } finally {db?.close();f.cleanup();}
});

test('parallel local ticks queue exactly one run for the same scheduled slot',async()=>{
  const f=temporaryDirectory();let db;
  try {
    db=await openDatabase(f.path);await migrate(db,migrationsDirectory);const store=new Store(db,()=>1000000);
    const id=await store.create('a','one',job);
    await Promise.all([localDispatch(store,1000000,'a'),localDispatch(store,1000000,'a')]);
    const runs=(await store.list('a')).runs;
    assert.equal(runs.length,1);assert.equal(runs[0].id,id+':0');assert.equal(runs[0].state,'queued');assert.equal(runs[0].attempt,0);
    const run=await store.claim('a','worker');assert.ok(run);
    await store.finish('a','worker',run.id,run.token!,'5',null);
    assert.equal((await store.list('a')).runs[0].state,'succeeded');
  } finally {db?.close();f.cleanup();}
});

test('saved starting run is recovered without a new identifier or attempt after reopen',async()=>{
  const f=temporaryDirectory();let db;
  try {
    db=await openDatabase(f.path);await migrate(db,migrationsDirectory);let store=new Store(db,()=>1000000);
    const id=await store.create('a','one',job);await store.tick(1000000,'a');
    assert.equal((await store.list('a')).runs[0].state,'starting');
    db.close();db=await openDatabase(f.path);store=new Store(db,()=>1000000);
    await Promise.all([localDispatch(store,1000000,'a'),localDispatch(store,1000000,'a')]);
    const runs=(await store.list('a')).runs;
    assert.equal(runs.length,1);assert.equal(runs[0].id,id+':0');assert.equal(runs[0].attempt,0);assert.equal(runs[0].state,'queued');
    assert.deepEqual((await db.prepare('SELECT token FROM attempts').all()).results,[]);
  } finally {db?.close();f.cleanup();}
});

test('activation does not resurrect cancelled runs or admit disabled jobs',async()=>{
  const f=temporaryDirectory();let db;
  try {
    db=await openDatabase(f.path);await migrate(db,migrationsDirectory);const store=new Store(db,()=>1000000);
    const cancelled=await store.create('a','cancel',job),disabled=await store.create('a','disabled',job);
    await store.tick(1000000,'a');await store.cancel('a',cancelled+':0');
    // A disable decision can commit after outbox selection and before activation.
    await store.q('UPDATE jobs SET enabled=0 WHERE id=?',disabled).run();
    await store.activate(cancelled+':0');await store.activate(disabled+':0');
    assert.deepEqual(await localDispatch(store,1000000,'a'),{enqueued:0,skipped:0,ids:[disabled+':0']});
    assert.equal((await store.list('a')).runs.find(r=>r.job_id===cancelled)!.state,'cancelled');
    assert.equal((await store.list('a')).runs.find(r=>r.job_id===disabled)!.state,'starting');
    assert.equal(await store.claim('a','worker'),null);
  } finally {db?.close();f.cleanup();}
});

test('owner tick never releases another owners pending run',async()=>{
  const f=temporaryDirectory();let db;
  try {
    db=await openDatabase(f.path);await migrate(db,migrationsDirectory);const store=new Store(db,()=>1000000);
    await store.create('a','one',job);await store.create('b','one',job);await store.tick();
    await localDispatch(store,1000000,'a');
    assert.equal((await store.list('a')).runs[0].state,'queued');assert.equal((await store.list('b')).runs[0].state,'starting');
    assert.equal(await store.claim('b','worker'),null);
  } finally {db?.close();f.cleanup();}
});

test('activation failure preserves durable starting state for the next local dispatch',async()=>{
  const f=temporaryDirectory();let db;
  try {
    db=await openDatabase(f.path);await migrate(db,migrationsDirectory);const store=new Store(db,()=>1000000);
    await store.create('a','one',job);
    await db.prepare("CREATE TRIGGER fail_activation BEFORE UPDATE OF state ON runs WHEN NEW.state='queued' BEGIN SELECT RAISE(ABORT,'fixture'); END").run();
    await assert.rejects(localDispatch(store,1000000,'a'));
    assert.equal((await store.list('a')).runs[0].state,'starting');
    await db.prepare('DROP TRIGGER fail_activation').run();await localDispatch(store,1000000,'a');
    const runs=(await store.list('a')).runs;assert.equal(runs.length,1);assert.equal(runs[0].state,'queued');
  } finally {db?.close();f.cleanup();}
});

function message(child:ChildProcess):Promise<{ready?:boolean;run?:unknown;error?:string;id?:string;runs?:Run[]}> {
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{cleanup();reject(Error('claim_process_timeout'));},10000);
    const onMessage=(value:unknown)=>{cleanup();resolve(value as {ready?:boolean;run?:unknown;error?:string;id?:string;runs?:Run[]});};
    const onExit=()=>{cleanup();reject(Error('claim_process_exited_without_result'));};
    const onError=(error:Error)=>{cleanup();reject(error);};
    function cleanup(){clearTimeout(timer);child.off('message',onMessage);child.off('exit',onExit);child.off('error',onError);}
    child.once('message',onMessage);child.once('exit',onExit);child.once('error',onError);
  });
}

test('another process recovers starting after the writing process crashes',{timeout:30000},async()=>{
  const f=temporaryDirectory();let db;
  try {
    db=await openDatabase(f.path);await migrate(db,migrationsDirectory);db.close();db=undefined;
    await withCleanup(async scope=>{
      const seed=await startProcess(scope,process.execPath,['--import','tsx','tests/fixtures/local-outbox.ts',f.path,'seed'],{stdio:['ignore','ignore','pipe','ipc']});seed.stderr!.resume();
      const saved=await message(seed);assert.ok(saved.id);
      const closed=once(seed,'close');seed.kill('SIGKILL');await closed;
      const recovery=await startProcess(scope,process.execPath,['--import','tsx','tests/fixtures/local-outbox.ts',f.path,'recover'],{stdio:['ignore','ignore','pipe','ipc']});recovery.stderr!.resume();
      const restored=await message(recovery);assert.ok(restored.runs);assert.equal(restored.runs.length,1);
      assert.equal(restored.runs[0].id,saved.id+':0');assert.equal(restored.runs[0].state,'queued');assert.equal(restored.runs[0].attempt,0);
    });
  } finally {db?.close();f.cleanup();}
});

test('separate processes racing on SQLite cannot exceed the shared claim capacity',{timeout:30000},async()=>{
  const f=temporaryDirectory();let db:LocalDatabase|undefined;
  try {
    db=await openDatabase(f.path);await migrate(db,migrationsDirectory);const store=new Store(db,()=>1000000);
    for(const owner of ['a','b'])await store.create(owner,'one',job);
    for(const run of (await store.tick()).pending)await store.activate(run.id);
    await withCleanup(async scope=>{
      const children=await Promise.all(['a','b'].map(owner=>startProcess(scope,process.execPath,['--import','tsx','tests/fixtures/local-claim.ts',f.path,owner,'worker-'+owner],{stdio:['ignore','ignore','pipe','ipc']})));
      for(const child of children)child.stderr!.resume();
      const ready=await Promise.all(children.map(message));assert.ok(ready.every(value=>value.ready));
      const pending=children.map(message);for(const child of children)child.send('claim');
      const results=await Promise.all(pending);
      assert.ok(results.every(value=>!value.error));assert.equal(results.filter(value=>value.run).length,1);
      assert.equal((await db!.prepare('SELECT COUNT(*) AS n FROM attempts').first<{n:number}>())!.n,1);
    });
  } finally {db?.close();f.cleanup();}
});

test('delegated watch token and hold survive database reopen until original execution stop acknowledgement',async()=>{
  const f=temporaryDirectory();let db;
  try {
    db=await openDatabase(f.path);await migrate(db,migrationsDirectory);let now=1000000;
    let store=new Store(db,()=>now),dev=new DevelopmentStore(store,{allowWatchTest:true});
    const input={repoId:'private-agent',baseRef:'epic/development-runner',goal:'Synthetic',acceptanceCriteria:['pass'],executionProfileId:'takt-watch',watch:{issue:1,validation:['Check expected behavior']}};
    const id=await dev.submit('a','one',input);await dev.submit('b','two',input);
    const run=await store.claim('a','worker','codex-luna','shared',limits,'development','takt-watch');assert.ok(run);
    await dev.operation('a','worker',id,run.token!,'takt','a'.repeat(64));
    db.close();now+=6*60*60*1000;db=await openDatabase(f.path);store=new Store(db,()=>now);dev=new DevelopmentStore(store,{allowWatchTest:true});
    const resumed=await store.claim('a','worker','codex-luna','shared',limits,'development','takt-watch');assert.ok(resumed);
    assert.equal(resumed.id,run.id);assert.equal(resumed.token,run.token);assert.equal(resumed.attempt,1);
    await store.cancel('a',run.id);
    assert.equal((await store.heartbeat('a','worker',run.id,run.token!)).cancelRequested,true);
    assert.equal(await store.claim('b','other','codex-luna','shared',limits,'development','takt-watch'),null);
    await store.finish('a','worker',run.id,run.token!,null,'stopped');
    assert.equal((await dev.status('a',id)).state,'cancelled');
    assert.ok(await store.claim('b','other','codex-luna','shared',limits,'development','takt-watch'));
  } finally {db?.close();f.cleanup();}
});
