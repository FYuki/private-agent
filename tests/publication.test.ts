import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {Store,type Database,type Statement} from '../control-plane/store.ts';
import {DevelopmentStore} from '../control-plane/development-store.ts';
import {PublicationStore} from '../control-plane/publication-store.ts';
import {publicationInput,publicationArtifact,digest} from '../shared/publication.ts';
import {validationCommands} from '../shared/repositories.ts';
import {publishApproved,type ApprovedPublicationRemote} from '../development/publication.ts';
import {type Ledger} from '../development/operations.ts';
import {fingerprint} from '../development/operations.ts';
import {mkdtemp,mkdir,writeFile,chmod,lstat,symlink,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {verifyPublicationSource,executePublication} from '../development/publication.ts';
import {repositoryBindings} from '../development/repositories.ts';

class DB implements Database{
 db=new DatabaseSync(':memory:');
 constructor(){for(const name of readdirSync('control-plane/migrations').sort())this.db.exec(readFileSync('control-plane/migrations/'+name,'utf8'));}
 prepare(sql:string):Statement{const statement=this.db.prepare(sql);let args:any[]=[];return {bind(...values){args=values;return this;},async first<T>(){return statement.get(...args) as T??null;},async all<T>(){return {results:statement.all(...args) as T[]};},async run(){return statement.run(...args);}};}
 async batch(list:Statement[]){this.db.exec('BEGIN');try{for(const s of list)await s.run();this.db.exec('COMMIT');}catch(e){this.db.exec('ROLLBACK');throw e;}}
}
async function setup(){
 const db=new DB();let now=1000000;const store=new Store(db,()=>now),dev=new DevelopmentStore(store),pub=new PublicationStore(store);
 const taskId=await dev.submit('local','fixture',{repoId:'local-GPT-live',baseRef:'epic/transport-playback',goal:'Synthetic publication fixture',acceptanceCriteria:['pass']});
 const run=(await store.claim('local','worker','codex-luna','local',{models:{'codex-luna':1,'codex-sol':1,'pi-swe2':0},groups:{local:1}},'development','takt-simple'))!;
 const manifest={version:1,taskId,owner:'local',repoId:'local-GPT-live',baseRef:'epic/transport-playback',baseSha:'a'.repeat(40),headSha:'b'.repeat(40),branch:'feature/browser-playback-ack-client',contentHash:'c'.repeat(64),validation:'browser-ack-v1',checks:validationCommands('local-GPT-live'),mode:'local_only'};
 const artifact={...manifest,artifactId:await digest(manifest)};
 await dev.operation('local','worker',taskId,run.token!,'artifact','f'.repeat(64),JSON.stringify(artifact));
 await store.finish('local','worker',run.id,run.token!,JSON.stringify({...artifact,outcome:'local_only',review:'pending'}),null);
 const input=publicationInput({taskId,artifactId:artifact.artifactId,repoId:'local-GPT-live',headSha:manifest.headSha,baseRef:manifest.baseRef,baseSha:manifest.baseSha,remoteBaseSha:'d'.repeat(40),title:'Synthetic publication',body:'Only synthetic evidence.',approved:true});
 const approve=()=>pub.approve('local','viewer','approval',input);
 return {db,store,dev,pub,run,input,artifact,approve,now:()=>now,advance:(ms:number)=>now+=ms};
}
function remote(input:ReturnType<typeof publicationInput>){
 let head:string|undefined,base=input.remoteBaseSha,pr:{url:string}|undefined,pushes=0,creates=0,denied=false;
 const api:ApprovedPublicationRemote={async verify(){if(denied)throw Error('denied');},async baseSha(){return base;},async branchSha(){return head;},async push(){pushes++;head=input.headSha;},async findPullRequest(){return pr;},async createPullRequest(){creates++;return pr={url:'https://github.com/FYuki/local-GPT-live/pull/3'};}};
 return {api,get pushes(){return pushes;},get creates(){return creates;},setHead:(v:string|undefined)=>head=v,setBase:(v:string)=>base=v,setPR:(v:typeof pr)=>pr=v,deny:()=>denied=true};
}
test('publication input and artifact bind exact owner/repo/base/head/text with strict input keys',async()=>{
 const s=await setup();try{
  for(const extra of [{approved:false},{repoId:'__proto__'},{baseRef:'main'},{headSha:'--help'},{taskId:'../x'},{argv:['sh']},{root:'/tmp'},{owner:'other'},{title:'line\nbreak'}])assert.throws(()=>publicationInput({...s.input,...extra}));
  for(const extra of [{headSha:'e'.repeat(40)},{baseSha:'e'.repeat(40)},{artifactId:'e'.repeat(64)}])await assert.rejects(s.pub.approve('local','viewer',crypto.randomUUID(),{...s.input,...extra}),/mismatch/);
  await assert.rejects(s.pub.approve('other','viewer','approval',s.input),/not_found/);
  await assert.rejects(publicationArtifact({...s.artifact,contentHash:'e'.repeat(64)},'local',s.input),/mismatch/);
 }finally{s.db.db.close();}
});
test('approval is idempotent, conflicts serialize across keys, and original run is unchanged',async()=>{
 const s=await setup();try{
  const before=s.db.db.prepare('SELECT * FROM runs').get();
  const id=await s.approve();assert.equal(await s.approve(),id);
  await assert.rejects(s.pub.approve('local','viewer','approval',{...s.input,title:'different'}),/idempotency_conflict/);
  await assert.rejects(s.pub.approve('local','viewer','other',s.input),/publication_conflict/);
  await assert.rejects(s.pub.status('other',id),/not_found/);
  await assert.rejects(s.pub.operation('other','worker',id,'push'),/not_found/);
  await assert.rejects(s.pub.operation('local','worker',id,'push',{sha:s.input.headSha}),/unreserved/);
  await assert.rejects(s.pub.operation('local','worker',id,'pull-request'),/push_not_confirmed/);
  assert.deepEqual(s.db.db.prepare('SELECT * FROM runs').get(),before);
 }finally{s.db.db.close();}
});
test('separate publication completes and replays without renewing run or duplicating remote writes',async()=>{
 const s=await setup();try{
  const before=s.db.db.prepare('SELECT * FROM runs').get(),id=await s.approve(),r=remote(s.input);
  const ledger:Ledger=(name,_hash,result)=>s.pub.operation('local','worker',id,name,result===undefined?undefined:JSON.parse(result));
  assert.deepEqual(await publishApproved(s.input,s.now()+3600000,ledger,r.api,s.now),{url:'https://github.com/FYuki/local-GPT-live/pull/3'});
  await publishApproved(s.input,s.now()+3600000,ledger,r.api,s.now);assert.equal(r.pushes,1);assert.equal(r.creates,1);
  assert.equal((await s.pub.status('local',id)).state,'published');assert.deepEqual(s.db.db.prepare('SELECT * FROM runs').get(),before);
  assert.equal(s.db.db.prepare('SELECT COUNT(*) AS n FROM development_operations').get()!.n,1);
  r.setHead('e'.repeat(40));await assert.rejects(publishApproved(s.input,s.now()+3600000,ledger,r.api,s.now),/remote_head_conflict/);
 }finally{s.db.db.close();}
});
test('remote drift and revoked GitHub permission prevent writes even with approval',async()=>{
 for(const kind of ['base','head','permission']){
  const s=await setup();try{
   const id=await s.approve(),r=remote(s.input),ledger:Ledger=(name,_hash,result)=>s.pub.operation('local','worker',id,name,result===undefined?undefined:JSON.parse(result));
   if(kind==='base')r.setBase('e'.repeat(40));if(kind==='head')r.setHead('e'.repeat(40));if(kind==='permission')r.deny();
   await assert.rejects(publishApproved(s.input,s.now()+3600000,ledger,r.api,s.now));assert.equal(r.pushes,0);assert.equal(r.creates,0);
  }finally{s.db.db.close();}
 }
});
test('lost push completion reconciles exact remote head; unknown effects never resend',async()=>{
 const s=await setup();try{
  const id=await s.approve(),r=remote(s.input);let fail=true;
  const ledger:Ledger=async(name,_hash,result)=>{if(name==='push'&&result&&fail){fail=false;throw Error('response_lost');}return s.pub.operation('local','worker',id,name,result===undefined?undefined:JSON.parse(result));};
  await assert.rejects(publishApproved(s.input,s.now()+3600000,ledger,r.api,s.now),/response_lost/);assert.equal(r.pushes,1);
  await publishApproved(s.input,s.now()+3600000,ledger,r.api,s.now);assert.equal(r.pushes,1);assert.equal(r.creates,1);
 }finally{s.db.db.close();}
 const s2=await setup();try{
  const id=await s2.approve(),r=remote(s2.input),ledger:Ledger=(name,_hash,result)=>s2.pub.operation('local','worker',id,name,result===undefined?undefined:JSON.parse(result));
  await s2.pub.operation('local','worker',id,'push');
  await assert.rejects(publishApproved(s2.input,s2.now()+3600000,ledger,r.api,s2.now),/operation_blocked/);assert.equal(r.pushes,0);assert.equal(r.creates,0);
 }finally{s2.db.db.close();}
});
test('lost PR completion reconciles, conflicting reports reject, expired approvals cannot write',async()=>{
 const s=await setup();try{
  const id=await s.approve(),r=remote(s.input);let fail=true;
  const ledger:Ledger=async(name,_hash,result)=>{if(name==='pull-request'&&result&&fail){fail=false;throw Error('lost');}return s.pub.operation('local','worker',id,name,result===undefined?undefined:JSON.parse(result));};
  await assert.rejects(publishApproved(s.input,s.now()+3600000,ledger,r.api,s.now),/lost/);
  await publishApproved(s.input,s.now()+3600000,ledger,r.api,s.now);assert.equal(r.creates,1);
  await assert.rejects(s.pub.operation('local','worker',id,'pull-request',{url:'https://github.com/FYuki/local-GPT-live/pull/4'}),/operation_conflict/);
  await assert.rejects(s.pub.operation('local','worker',id,'push',{sha:'e'.repeat(40)}),/mismatch/);
  await assert.rejects(s.pub.operation('local','worker',id,'pull-request',{url:'https://evil.test/3'}),/mismatch/);
 }finally{s.db.db.close();}
 const s2=await setup();try{
  const id=await s2.approve(),r=remote(s2.input);s2.advance(3600001);
  const ledger:Ledger=(name,_hash,result)=>s2.pub.operation('local','worker',id,name,result===undefined?undefined:JSON.parse(result));
  await assert.rejects(publishApproved(s2.input,4600000,ledger,r.api,s2.now),/expired/);assert.equal(r.pushes,0);
 }finally{s2.db.db.close();}
});
test('two concurrent workers receive only one fresh reservation and cannot duplicate a write',async()=>{
 const s=await setup();try{
  const id=await s.approve(),r=remote(s.input);let release!:()=>void,entered!:()=>void;
  const blocked=new Promise<void>(resolve=>release=resolve),started=new Promise<void>(resolve=>entered=resolve),push=r.api.push;
  r.api.push=async()=>{entered();await blocked;await push();};
  const ledger=(worker:string):Ledger=>(name,_hash,result)=>s.pub.operation('local',worker,id,name,result===undefined?undefined:JSON.parse(result));
  const first=publishApproved(s.input,s.now()+3600000,ledger('one'),r.api,s.now);await started;
  await assert.rejects(publishApproved(s.input,s.now()+3600000,ledger('two'),r.api,s.now),/operation_blocked/);
  release();await first;assert.equal(r.pushes,1);assert.equal(r.creates,1);
 }finally{s.db.db.close();}
});
test('only unreserved expired grants can be explicitly reapproved; old audit rows survive',async()=>{
 const s=await setup();try{
  const old=await s.approve();s.advance(3600001);
  assert.equal(await s.approve(),old);
  const renewed=await s.pub.approve('local','viewer','new-approval',{...s.input,remoteBaseSha:'e'.repeat(40)});
  assert.notEqual(renewed,old);assert.equal((await s.pub.status('local',old)).state,'superseded');
  await assert.rejects(s.pub.operation('local','worker',old,'push'),/expired/);
  assert.equal((await s.pub.operation('local','worker',renewed,'push')).fresh,true);
  s.advance(3600001);await assert.rejects(s.pub.approve('local','viewer','third',s.input),/publication_conflict/);
 }finally{s.db.db.close();}
});
test('incomplete, failed and unreleased tasks cannot receive approval',async()=>{
 const s=await setup();try{
  for(const [state,lease,hold] of [['running',1,1],['failed',null,0],['succeeded',null,1],['succeeded',1,0]] as const){
   s.db.db.prepare('UPDATE runs SET state=?,lease_until=?,hold_until=?').run(state,lease,hold);
   await assert.rejects(s.approve(),/task_not_released/);
  }
 }finally{s.db.db.close();}
});
test('post-run worker requires separate administrator permission before reading files or GitHub',async()=>{
 const s=await setup();try{
  const id=await s.approve(),approval=await s.pub.status('local',id);
  const bindings=repositoryBindings([{repoId:'local-GPT-live',root:'/nonexistent/repo',worktrees:'/nonexistent/tasks',owners:['local'],visibility:'public',publishAuthorized:false}]);
  await assert.rejects(executePublication(id,async()=>approval,bindings,new AbortController().signal),/approved_publication_not_enabled/);
 }finally{s.db.db.close();}
});
test('real Git verifies original full-mode hashes for 0600 and executable source; detects edits and symlinks',async()=>{
 const root=await mkdtemp(join(tmpdir(),'publication-git-')),repo=join(root,'repo'),tasks=join(root,'tasks');await mkdir(repo);await mkdir(tasks);
 const taskId=crypto.randomUUID(),directory=join(tasks,taskId),git=(args:string[],cwd=repo)=>execFileSync('/usr/bin/git',['-c','core.hooksPath=/dev/null','-c','commit.gpgsign=false','-c','user.name=Synthetic','-c','user.email=synthetic@example.test',...args],{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
 git(['init']);git(['remote','add','origin','https://github.com/FYuki/local-GPT-live.git']);git(['commit','--allow-empty','-m','synthetic base']);const baseSha=git(['rev-parse','HEAD']);
 git(['worktree','add','-b','feature/browser-playback-ack-client',directory]);await mkdir(join(directory,'browser'));
 const path=join(directory,'browser/playback-ack.mjs'),content='export const synthetic = 1;\n';await writeFile(path,content,{mode:0o600});
 git(['add','.'],directory);git(['commit','-m','synthetic fixture'],directory);
 const input=publicationInput({taskId,artifactId:'a'.repeat(64),repoId:'local-GPT-live',baseSha,headSha:git(['rev-parse','HEAD'],directory),baseRef:'epic/transport-playback',remoteBaseSha:baseSha,title:'synthetic',body:'synthetic',approved:true});
 const binding=repositoryBindings([{repoId:'local-GPT-live',root:repo,worktrees:tasks,owners:['local'],visibility:'public',publishAuthorized:false}])[0];
 const signal=new AbortController().signal,deadline=()=>process.hrtime.bigint()+60000000000n;
 const original={contentHash:fingerprint([['browser/playback-ack.mjs',(await lstat(path)).mode,content]])};
 await verifyPublicationSource(binding,input,original,signal,deadline());
 await chmod(path,0o700);git(['add','.'],directory);git(['commit','--amend','--no-edit'],directory);input.headSha=git(['rev-parse','HEAD'],directory);
 const executable={contentHash:fingerprint([['browser/playback-ack.mjs',(await lstat(path)).mode,content]])};await verifyPublicationSource(binding,input,executable,signal,deadline());
 await assert.rejects(verifyPublicationSource(binding,input,original,signal,deadline()),/content_changed/);
 await writeFile(path,'export const changed = 2;');await assert.rejects(verifyPublicationSource(binding,input,executable,signal,deadline()),/head_changed/);
 await unlink(path);await writeFile(join(root,'external.mjs'),content);await symlink(join(root,'external.mjs'),path);
 await assert.rejects(verifyPublicationSource(binding,input,executable,signal,deadline()),/head_changed/);
});
