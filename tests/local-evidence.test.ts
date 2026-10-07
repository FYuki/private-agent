import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../control-plane/store.ts';
import { prepareDatabaseFile } from '../agent/store.ts';
import { verifyAcceptanceRuntime } from '../development/watch-dev-preflight.ts';
import { job, migrate, migrationsDirectory, openDatabase, temporaryDirectory } from './fixtures/local-control.ts';

async function evidenceFixture() {
  const f=temporaryDirectory(),tag='synthetic',root=join(f.directory,'.local/watch-acceptance',tag),runs=join(f.directory,'runs');
  let db;
  try {
    db=await openDatabase(f.path);await migrate(db,migrationsDirectory);
    const store=new Store(db,()=>1000000),id=await store.create('local','one',job);await store.tick();await store.activate(id+':0');
    const run=await store.claim('local','worker');assert.ok(run);await store.finish('local','worker',run.id,run.token!,null,'provider_failed');db.close();db=undefined;
    const owned=join(runs,id),repo=join(owned,'repo');
    for(const path of [root,join(root,'inputs'),join(root,'artifacts'),join(owned,'private'),repo])mkdirSync(path,{recursive:true,mode:0o700});
    const runtime=readFileSync(new URL('./fixtures/live-isolated-runtime.yaml',import.meta.url)),inputHash=verifyAcceptanceRuntime(runtime);
    writeFileSync(join(root,'inputs/runtime.yaml'),runtime);
    const json=(name:string,value:unknown)=>writeFileSync(join(root,name),JSON.stringify(value),{mode:0o600});
    json('request.json',{id,stub:true,maxCli:2,inputHash,dbPath:f.path});json('run-location.json',{runs,dbPath:f.path});
    json('settlement.json',{task:id,runs,dbPath:f.path,stub:true,provider:{starts:1,closed:1,settled:true},inputUnchanged:true});
    json('failure.json',{error:'watch_task_failed'});
    writeFileSync(join(owned,'private/activity.ndjson'),[{id:'synthetic-call',event:'started'},{id:'synthetic-call',event:'closed'}].map(event=>JSON.stringify(event)).join('\n')+'\n');
    prepareDatabaseFile(join(owned,'supervisor.db'));
    const supervisor=new DatabaseSync(join(owned,'supervisor.db'));
    try {
      supervisor.exec('CREATE TABLE watch_supervisors(root TEXT PRIMARY KEY,owner TEXT NOT NULL,token TEXT NOT NULL,state TEXT NOT NULL,pid INTEGER,identity TEXT,contained INTEGER NOT NULL DEFAULT 0)');
      supervisor.prepare("INSERT INTO watch_supervisors VALUES(?,'local','fixture','exited',NULL,NULL,1)").run(repo);
    } finally {supervisor.close();}
    const script=resolve('scripts/watch-dev-evidence-check.ts');
    const command=()=>execFileSync(process.execPath,['--import',resolve('node_modules/tsx/dist/loader.mjs'),script,'--expect-stub-failure'],{cwd:f.directory,env:{...process.env,WATCH_ACCEPTANCE_ID:tag},timeout:10000,stdio:'pipe',encoding:'utf8'});
    const rejected=()=>spawnSync(process.execPath,['--import',resolve('node_modules/tsx/dist/loader.mjs'),script,'--expect-stub-failure'],{cwd:f.directory,env:{...process.env,WATCH_ACCEPTANCE_ID:tag},timeout:10000,stdio:'pipe'});
    return {...f,id,root,command,rejected};
  } catch(error) {db?.close();f.cleanup();throw error;}
}

test('separate evidence checker reads explicit SQLite path without a Wrangler directory',{timeout:15000},async()=>{
  const f=await evidenceFixture();
  try {
    const before=readFileSync(f.path);f.command();
    const summary=JSON.parse(readFileSync(join(f.root,'verified-summary.json'),'utf8'));
    assert.equal(summary.task,f.id);assert.equal(summary.durableEvidenceVerified,true);assert.equal(summary.holdUntil,0);
    assert.equal(summary.providerStarts,1);assert.equal(summary.providerClosed,1);assert.equal(summary.watchStopped,true);
    assert.equal(summary.stub,true);assert.equal(summary.fullAcceptanceSucceeded,false);assert.equal(summary.publication,false);
    assert.deepEqual(readFileSync(f.path),before);
  } finally {f.cleanup();}
});

test('missing explicit evidence database is rejected without creating or discovering a replacement',{timeout:15000},async()=>{
  const f=await evidenceFixture();
  try {
    f.command();unlinkSync(join(f.root,'verified-summary.json'));
    const decoy=join(f.root,'d1/v3/d1');mkdirSync(decoy,{recursive:true});writeFileSync(join(decoy,'a'.repeat(64)+'.sqlite'),readFileSync(f.path));unlinkSync(f.path);
    const result=f.rejected();assert.equal(result.error,undefined);assert.notEqual(result.status,0);
    assert.equal(existsSync(f.path),false);assert.equal(existsSync(join(f.root,'verified-summary.json')),false);
  } finally {f.cleanup();}
});

test('evidence checker rejects a terminal task that still holds capacity',{timeout:15000},async()=>{
  const f=await evidenceFixture();
  try {
    f.command();unlinkSync(join(f.root,'verified-summary.json'));
    const db=new DatabaseSync(f.path);try{db.prepare('UPDATE runs SET hold_until=1 WHERE job_id=?').run(f.id);}finally{db.close();}
    const result=f.rejected();assert.equal(result.error,undefined);assert.notEqual(result.status,0);
    assert.equal(existsSync(join(f.root,'verified-summary.json')),false);
  } finally {f.cleanup();}
});
