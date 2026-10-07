import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, linkSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../control-plane/store.ts';
import { DevelopmentStore } from '../control-plane/development-store.ts';
import { MeasuredDatabase } from '../control-plane/measurement.ts';
import { job, limits, migrate, migrationsDirectory, openDatabase, temporaryDirectory, type LocalDatabase } from './fixtures/local-control.ts';

test('local migrations are repeatable and completed state survives closing and reopening',async()=>{
  const f=temporaryDirectory();let db;
  try {
    db=await openDatabase(f.path);await migrate(db,migrationsDirectory);
    const store=new Store(db,()=>1000000),id=await store.create('a','same',job);
    await store.tick();await store.activate(id+':0');const run=await store.claim('a','w');assert.ok(run);
    await store.finish('a','w',run.id,run.token!,'5',null);
    const before=await store.list('a');db.close();db=await openDatabase(f.path);
    await migrate(db,migrationsDirectory);await migrate(db,migrationsDirectory);
    const restored=new Store(db,()=>1000000);
    assert.deepEqual(await restored.list('a'),before);
    assert.equal(await restored.create('a','same',job),id);
    assert.ok(await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='publication_operations'").first());
    assert.equal(statSync(f.path).mode&0o777,0o600);
  } finally {db?.close();f.cleanup();}
});

test('failed migration rolls back schema and history and can be retried after correcting SQL',async()=>{
  const f=temporaryDirectory();let db;
  try {
    const directory=join(f.directory,'migrations');mkdirSync(directory);
    writeFileSync(join(directory,'0001_fixture.sql'),'CREATE TABLE durable(value TEXT);');
    db=await openDatabase(f.path);await migrate(db,directory);
    await db.prepare('INSERT INTO durable VALUES(?)').bind('keep').run();
    const second=join(directory,'0002_fixture.sql');
    writeFileSync(second,'CREATE TABLE transient(value TEXT); INSERT INTO missing VALUES(1);');
    await assert.rejects(migrate(db,directory));
    assert.equal(await db.prepare("SELECT name FROM sqlite_master WHERE name='transient'").first(),null);
    assert.deepEqual((await db.prepare('SELECT value FROM durable').all<{value:string}>()).results.map(row=>row.value),['keep']);
    writeFileSync(second,'CREATE TABLE transient(value TEXT);');
    await migrate(db,directory);await migrate(db,directory);
    assert.ok(await db.prepare("SELECT name FROM sqlite_master WHERE name='transient'").first());
  } finally {db?.close();f.cleanup();}
});

test('batch rolls back every statement while an independent write remains committed',async()=>{
  const f=temporaryDirectory();let db;
  try {
    db=await openDatabase(f.path);await db.prepare('CREATE TABLE values_test(value TEXT PRIMARY KEY)').run();
    const failed=db.batch([
      db.prepare('INSERT INTO values_test VALUES(?)').bind('batch'),
      db.prepare('INSERT INTO values_test VALUES(?)').bind('batch'),
    ]);
    const rejected=assert.rejects(failed);
    const independent=db.prepare('INSERT INTO values_test VALUES(?)').bind('independent').run();
    await Promise.all([rejected,independent]);
    assert.deepEqual((await db.prepare('SELECT value FROM values_test').all<{value:string}>()).results.map(row=>row.value),['independent']);
  } finally {db?.close();f.cleanup();}
});

test('development submission and disable keep their batch changes atomic',async()=>{
  const f=temporaryDirectory();let db:LocalDatabase|undefined;
  try {
    db=await openDatabase(f.path);await migrate(db,migrationsDirectory);
    const store=new Store(db,()=>1000000),dev=new DevelopmentStore(store);
    await db.prepare("CREATE TRIGGER reject_task BEFORE INSERT ON development_tasks BEGIN SELECT RAISE(ABORT,'fixture'); END").run();
    await assert.rejects(dev.submit('a','failed',{repoId:'private-agent',baseRef:'epic/development-runner',goal:'Synthetic',acceptanceCriteria:['pass']}));
    assert.deepEqual(await store.list('a'),{jobs:[],runs:[]});
    await db.prepare('DROP TRIGGER reject_task').run();
    const id=await store.create('a','job',job);await store.tick();
    await db.prepare("CREATE TRIGGER reject_cancel BEFORE UPDATE OF state ON runs WHEN NEW.state='cancelled' BEGIN SELECT RAISE(ABORT,'fixture'); END").run();
    await assert.rejects(store.disable('a',id));
    assert.equal((await store.q('SELECT enabled FROM jobs WHERE id=?',id).first<{enabled:number}>())!.enabled,1);
    assert.equal((await store.list('a')).runs[0].state,'starting');
    await db.prepare('DROP TRIGGER reject_cancel').run();await store.disable('a',id);
    assert.equal((await store.q('SELECT enabled FROM jobs WHERE id=?',id).first<{enabled:number}>())!.enabled,0);
    assert.equal((await store.list('a')).runs[0].state,'cancelled');
  } finally {db?.close();f.cleanup();}
});

test('separate SQLite connections enforce one shared model and group reservation',async()=>{
  const f=temporaryDirectory();let first,second;
  try {
    first=await openDatabase(f.path);await migrate(first,migrationsDirectory);second=await openDatabase(f.path);
    const a=new Store(first,()=>1000000),b=new Store(second,()=>1000000);
    await a.create('a','one',job);await b.create('b','two',job);
    for(const run of (await a.tick()).pending)await a.activate(run.id);
    const claims=await Promise.all([a.claim('a','one','codex-luna','shared',limits),b.claim('b','two','codex-luna','shared',limits)]);
    assert.equal(claims.filter(Boolean).length,1);
    const run=claims.find(value=>value!==null)!;
    await new Store(first,()=>1000000).finish(run.owner,run.worker!,run.id,run.token!,'5',null);
    const blocked=claims[0]===null?a:b,owner=claims[0]===null?'a':'b';
    assert.ok(await blocked.claim(owner,'replacement','codex-luna','shared',limits));
  } finally {second?.close();first?.close();f.cleanup();}
});

test('measured SQLite batch preserves rollback and omits unmeasured D1 row counts',async()=>{
  const f=temporaryDirectory();let db;
  try {
    db=await openDatabase(f.path);
    const measured=new MeasuredDatabase(db);
    await measured.prepare('CREATE TABLE measured(value TEXT UNIQUE)').run();
    await assert.rejects(measured.batch([measured.prepare("INSERT INTO measured VALUES('same')"),measured.prepare("INSERT INTO measured VALUES('same')")]));
    assert.deepEqual((await measured.prepare('SELECT value FROM measured').all()).results,[]);
    assert.equal(Object.hasOwn(measured.metrics,'rowsRead'),false);
    assert.equal(Object.hasOwn(measured.metrics,'rowsWritten'),false);
  } finally {db?.close();f.cleanup();}
});

test('local metrics count executed SQL statements rather than prepared statements',async()=>{
  const f=temporaryDirectory();let db;
  try {
    db=await openDatabase(f.path);await db.prepare('CREATE TABLE counted(value TEXT)').run();
    const measured=new MeasuredDatabase(db);
    const first=measured.prepare('INSERT INTO counted VALUES(?)').bind('one');
    assert.equal(measured.metrics.statements,0);
    await first.run();assert.equal(measured.metrics.statements,1);
    assert.equal((await measured.prepare('SELECT value FROM counted').first<{value:string}>())!.value,'one');
    assert.equal(measured.metrics.statements,2);
    await measured.batch([measured.prepare("INSERT INTO counted VALUES('two')"),measured.prepare("INSERT INTO counted VALUES('three')")]);
    assert.equal(measured.metrics.statements,4);
    assert.deepEqual((await measured.prepare('SELECT value FROM counted ORDER BY value').all<{value:string}>()).results.map(row=>row.value),['one','three','two']);
    assert.equal(measured.metrics.statements,5);
  } finally {db?.close();f.cleanup();}
});

test('local database refuses unsafe files and directories without modifying them',async()=>{
  const f=temporaryDirectory();
  try {
    const safe=await openDatabase(join(f.directory,'safe.sqlite'));safe.close();
    writeFileSync(f.path,'unchanged',{mode:0o600});chmodSync(f.path,0o644);
    await assert.rejects(openDatabase(f.path));
    assert.equal(statSync(f.path).mode&0o777,0o644);assert.equal(readFileSync(f.path,'utf8'),'unchanged');
    chmodSync(f.path,0o600);symlinkSync(f.path,join(f.directory,'symbolic'));linkSync(f.path,join(f.directory,'hard'));
    for(const name of ['symbolic','hard'])await assert.rejects(openDatabase(join(f.directory,name)));
    const alias=f.directory+'-alias';symlinkSync(f.directory,alias);
    try {await assert.rejects(openDatabase(join(alias,'new.sqlite')));}finally{(await import('node:fs')).unlinkSync(alias);}
    chmodSync(f.directory,0o777);await assert.rejects(openDatabase(join(f.directory,'new.sqlite')));
    assert.equal(readFileSync(f.path,'utf8'),'unchanged');
  } finally {f.cleanup();}
});
