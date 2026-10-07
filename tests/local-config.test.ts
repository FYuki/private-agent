import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, statSync, copyFileSync, chmodSync, mkdirSync, existsSync, readdirSync, symlinkSync, lstatSync, readlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { resolveConfig } from '../control-plane/local.ts';
import { SqliteDatabase } from '../control-plane/sqlite.ts';
import { migrate } from '../control-plane/migrations.ts';
import { temporaryDirectory, migrationsDirectory, job } from './fixtures/local-control.ts';
import { Store } from '../control-plane/store.ts';

const setupScript=resolve('scripts/dev-setup.mjs');
function integrationDirectoryFixture() {
  const f=temporaryDirectory(),parent=join(f.directory,'.local'),child=join(parent,'integration-01234567');
  mkdirSync(join(f.directory,'scripts'));
  copyFileSync(setupScript,join(f.directory,'scripts/dev-setup.mjs'));
  const credential=join(f.directory,'.dev.vars');
  writeFileSync(credential,'synthetic existing credential',{mode:0o600});
  const preload=join(f.directory,'uuid.mjs');
  writeFileSync(preload,"process.umask(0);globalThis.crypto.randomUUID=()=> '01234567-89ab-4cde-8f01-23456789abcd';\n");
  return {...f,parent,child,credential,run:()=>spawnSync(process.execPath,['--import',resolve('node_modules/tsx/dist/loader.mjs'),'--import',preload,resolve('scripts/local-integration-run.ts')],{cwd:f.directory,encoding:'utf8',timeout:10000})};
}
function savedOperationalFiles(directory:string) {
  mkdirSync(join(directory,'evidence'),{mode:0o700});
  return ['control.sqlite','control.json','tokens.json','evidence/measurement.json'].map(name=>{
    const path=join(directory,name);
    writeFileSync(path,'synthetic saved '+name,{mode:0o600});
    return {path,bytes:readFileSync(path),mode:statSync(path).mode};
  });
}
function assertSavedFiles(files:ReturnType<typeof savedOperationalFiles>) {
  for(const file of files){assert.deepEqual(readFileSync(file.path),file.bytes);assert.equal(statSync(file.path).mode,file.mode);}
}
test('integration entry prepares a missing private parent before setup',()=>{
  const f=integrationDirectoryFixture();
  try {
    assert.equal(existsSync(f.parent),false);
    const result=f.run();assert.equal(result.error,undefined);assert.equal(result.status,1);
    assert.equal(statSync(f.parent).mode&0o777,0o700,result.stderr);
    assert.equal(statSync(f.child).mode&0o777,0o700);
    assert.deepEqual(readdirSync(f.child),[]);
    assert.match(result.stderr,/dev-setup\.mjs/);
    assert.equal(readFileSync(f.credential,'utf8'),'synthetic existing credential');
    assert.equal(statSync(f.credential).mode&0o777,0o600);
  }finally{f.cleanup();}
});
test('integration entry retains a safe existing parent and operational files',()=>{
  const f=integrationDirectoryFixture();
  try {
    mkdirSync(f.parent,{mode:0o755});chmodSync(f.parent,0o755);
    const saved=savedOperationalFiles(f.parent),mode=statSync(f.parent).mode;
    const result=f.run();assert.equal(result.error,undefined);assert.equal(result.status,1);
    assert.equal(statSync(f.parent).mode,mode);assert.equal(statSync(f.child).mode&0o777,0o700);
    assert.deepEqual(readdirSync(f.child),[]);assert.match(result.stderr,/dev-setup\.mjs/);assertSavedFiles(saved);
  }finally{f.cleanup();}
});
test('integration entry rejects a writable parent without changing it',()=>{
  const f=integrationDirectoryFixture();
  try {
    mkdirSync(f.parent);chmodSync(f.parent,0o777);
    const saved=savedOperationalFiles(f.parent),mode=statSync(f.parent).mode;
    const result=f.run();assert.equal(result.error,undefined);assert.equal(result.status,1);
    assert.equal(existsSync(f.child),false);assert.equal(statSync(f.parent).mode,mode);assertSavedFiles(saved);
  }finally{f.cleanup();}
});
test('integration entry rejects a file in place of the parent without replacing it',()=>{
  const f=integrationDirectoryFixture();
  try {
    writeFileSync(f.parent,'synthetic existing file',{mode:0o600});
    const before=readFileSync(f.parent),mode=statSync(f.parent).mode;
    const result=f.run();assert.equal(result.error,undefined);assert.equal(result.status,1);
    assert.ok(lstatSync(f.parent).isFile());assert.deepEqual(readFileSync(f.parent),before);assert.equal(statSync(f.parent).mode,mode);
  }finally{f.cleanup();}
});
test('integration entry rejects a symlink parent without changing the target',()=>{
  const f=integrationDirectoryFixture();
  try {
    const target=join(f.directory,'saved');mkdirSync(target,{mode:0o700});
    const saved=savedOperationalFiles(target),mode=statSync(target).mode;
    symlinkSync(target,f.parent);
    const result=f.run();assert.equal(result.error,undefined);assert.equal(result.status,1);
    assert.ok(lstatSync(f.parent).isSymbolicLink());assert.equal(readlinkSync(f.parent),target);
    assert.equal(existsSync(f.child),false);assert.equal(statSync(target).mode,mode);assertSavedFiles(saved);
  }finally{f.cleanup();}
});
test('integration entry rejects a colliding child and preserves its saved data',()=>{
  const f=integrationDirectoryFixture();
  try {
    mkdirSync(f.parent,{mode:0o700});mkdirSync(f.child,{mode:0o700});
    const saved=savedOperationalFiles(f.child),entries=readdirSync(f.child),mode=statSync(f.child).mode;
    const result=f.run();assert.equal(result.error,undefined);assert.equal(result.status,1);
    assert.deepEqual(readdirSync(f.child),entries);assert.equal(statSync(f.child).mode,mode);assertSavedFiles(saved);
    assert.doesNotMatch(result.stderr,/dev-setup\.mjs/);
  }finally{f.cleanup();}
});
test('integration evidence directory remains private with a permissive inherited umask',()=>{
  const f=temporaryDirectory();
  try {
    execFileSync(process.execPath,[setupScript,'--directory',f.directory],{cwd:f.directory,stdio:'pipe'});
    const evidence=join(f.directory,'evidence');
    const script=`process.umask(0); const {integrationConfig}=await import(${JSON.stringify(pathToFileURL(resolve('scripts/local-integration.ts')).href)});const {SqliteDatabase}=await import(${JSON.stringify(pathToFileURL(resolve('control-plane/sqlite.ts')).href)});const config=await integrationConfig();new SqliteDatabase(config.evidence+'/agent.sqlite').close();`;
    execFileSync(process.execPath,['--import',resolve('node_modules/tsx/dist/loader.mjs'),'--input-type=module','-e',script],{cwd:f.directory,stdio:'pipe',env:{...process.env,CONTROL_CONFIG:join(f.directory,'control.json'),CONTROL_TOKENS:join(f.directory,'tokens.json'),CONTROL_EVIDENCE_DIR:evidence}});
    assert.equal(statSync(evidence).mode&0o777,0o700);
    assert.equal(statSync(join(evidence,'agent.sqlite')).mode&0o777,0o600);
  }finally{f.cleanup();}
});
test('local config resolves explicit paths and refuses invalid flags without legacy fallback',()=>{
  const f=temporaryDirectory();
  try {
    execFileSync(process.execPath,[setupScript,'--directory',f.directory],{cwd:f.directory,stdio:'pipe'});
    const path=join(f.directory,'control.json');
    const config=resolveConfig(['--config',path]);
    assert.equal(config.dbPath,f.path);assert.equal(config.scheduleEnabled,false);assert.equal(config.watchAcceptanceEnabled,false);
    assert.equal(statSync(path).mode&0o777,0o600);assert.equal(statSync(join(f.directory,'tokens.json')).mode&0o777,0o600);
    const overridden=resolveConfig(['--config',path,'--db',join(f.directory,'other.sqlite'),'--port','0']);
    assert.equal(overridden.dbPath,join(f.directory,'other.sqlite'));assert.equal(overridden.port,0);
    const raw=JSON.parse(readFileSync(path,'utf8'));raw.scheduleEnabled='true';writeFileSync(path,JSON.stringify(raw));
    assert.throws(()=>resolveConfig(['--config',path]));
    for(const args of [['--unknown','x'],['--port'],['--config',join(f.directory,'missing')]])assert.throws(()=>resolveConfig(args));
  } finally {f.cleanup();}
});

test('setup refuses existing credentials and leaves database and credential bytes unchanged',()=>{
  const f=temporaryDirectory();
  try {
    execFileSync(process.execPath,[setupScript,'--directory',f.directory],{cwd:f.directory,stdio:'pipe'});
    writeFileSync(f.path,'synthetic operational data',{mode:0o600});
    const paths=[f.path,join(f.directory,'control.json'),join(f.directory,'tokens.json')],before=paths.map(path=>readFileSync(path));
    const result=spawnSync(process.execPath,[setupScript,'--directory',f.directory],{cwd:f.directory,stdio:'pipe'});
    assert.notEqual(result.status,0);paths.forEach((path,index)=>assert.deepEqual(readFileSync(path),before[index]));
  } finally {f.cleanup();}
});

test('migration rejects an existing schema without changing operational data',async()=>{
  const f=temporaryDirectory();
  try {
    const old=new SqliteDatabase(f.path);await old.prepare('CREATE TABLE operational(value TEXT)').run();await old.prepare("INSERT INTO operational VALUES('keep')").run();old.close();
    const before=readFileSync(f.path),db=new SqliteDatabase(f.path);
    try{await assert.rejects(migrate(db,migrationsDirectory));}finally{db.close();}
    assert.deepEqual(readFileSync(f.path),before);
  } finally {f.cleanup();}
});

test('manual legacy backup and migration preserve the original and apply only missing SQL to an explicit copy',async()=>{
  const f=temporaryDirectory();
  try {
    const oldPath=join(f.directory,'old.sqlite'),old=new SqliteDatabase(oldPath);
    const files=['0001_initial.sql','0002_capacity.sql','0003_development.sql','0004_takt_resources.sql'];
    for(const file of files)old.connection.exec(readFileSync(join(migrationsDirectory,file),'utf8'));
    old.connection.exec('CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY,name TEXT NOT NULL)');
    files.forEach((file,index)=>old.connection.prepare('INSERT INTO d1_migrations VALUES(?,?)').run(index+1,file));
    const store=new Store(old,()=>1000000);
    const id=await store.create('a','saved',job);await store.tick(1000000,'a');
    const saved=await store.list('a');old.close();
    const before=readFileSync(oldPath),originalMode=statSync(oldPath).mode;
    const backupPath=join(f.directory,'backup.sqlite'),source=new DatabaseSync(oldPath,{readOnly:true});
    try {await backup(source,backupPath);}finally{source.close();}
    const snapshot=new DatabaseSync(backupPath,{readOnly:true});
    try {
      assert.equal(snapshot.prepare('PRAGMA integrity_check').get()!.integrity_check,'ok');
      assert.equal(snapshot.prepare('SELECT COUNT(*) AS n FROM jobs').get()!.n,1);
      assert.equal(snapshot.prepare('SELECT COUNT(*) AS n FROM runs').get()!.n,1);
      assert.deepEqual(snapshot.prepare('SELECT name FROM d1_migrations ORDER BY id').all().map(row=>row.name),files);
    }finally{snapshot.close();}
    assert.deepEqual(readFileSync(oldPath),before);assert.equal(statSync(oldPath).mode,originalMode);
    const backupBytes=readFileSync(backupPath);copyFileSync(backupPath,f.path);chmodSync(f.path,0o600);
    const copy=new DatabaseSync(f.path);
    try {
      assert.deepEqual(copy.prepare('SELECT name FROM d1_migrations ORDER BY id').all().map(row=>row.name),files);
      copy.exec('BEGIN IMMEDIATE; CREATE TABLE local_migrations(name TEXT PRIMARY KEY,hash TEXT NOT NULL)');
      for(const name of files)copy.prepare('INSERT INTO local_migrations VALUES(?,?)').run(name,createHash('sha256').update(readFileSync(join(migrationsDirectory,name))).digest('hex'));
      copy.exec('COMMIT');
    }finally{copy.close();}
    const db=new SqliteDatabase(f.path);
    try {
      await migrate(db,migrationsDirectory);await migrate(db,migrationsDirectory);
      const restored=await new Store(db,()=>1000000).list('a');
      assert.equal((restored.jobs as {id:string}[])[0].id,id);assert.deepEqual(restored,saved);
      assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM local_migrations').first<{n:number}>())!.n,5);
      assert.ok(await db.prepare("SELECT name FROM sqlite_master WHERE name='publication_operations'").first());
    }finally{db.close();}
    assert.deepEqual(readFileSync(oldPath),before);
    assert.equal(statSync(oldPath).mode,originalMode);assert.deepEqual(readFileSync(backupPath),backupBytes);
  } finally {f.cleanup();}
});
