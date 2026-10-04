import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,symlink,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {repositoryBindings,selectRepository,preflightRepository} from '../development/repositories.ts';
import {developmentInput} from '../shared/development.ts';
import {allowedRepositoryPath,validationCommands} from '../shared/repositories.ts';
import {saveArtifact,finishArtifact,type LocalArtifact} from '../development/artifacts.ts';
import {verifyRepositoryMetadata} from '../development/publisher.ts';
import {capacity} from '../shared/contracts.ts';

const binding={repoId:'local-GPT-live',root:'/srv/voice',worktrees:'/srv/tasks',owners:['local'],visibility:'public',publishAuthorized:false};
const input={repoId:'local-GPT-live',baseRef:'epic/transport-playback',goal:'synthetic',acceptanceCriteria:['pass']};
test('capacity admits the approved finite limits and rejects non-integers, negatives and excess',()=>{
 const approved={models:{'codex-sol':5,'codex-luna':30,'pi-swe2':0},groups:{local:35}};
 assert.deepEqual(capacity(approved),approved);
 for(const key of ['codex-sol','codex-luna'] as const)for(const value of [-1,0.5,Infinity,NaN,approved.models[key]+1,'1'])assert.throws(()=>capacity({...approved,models:{...approved.models,[key]:value}}));
 for(const value of [-1,0.5,36,Infinity,'35'])assert.throws(()=>capacity({...approved,groups:{local:value}}));
 assert.doesNotThrow(()=>capacity({models:{'codex-sol':0,'codex-luna':0,'pi-swe2':0},groups:{local:0}}));
});
test('registry accepts only known contracts and explicit owner bindings, never task supplied roots or argv',()=>{
  const bindings=repositoryBindings([binding]);assert.equal(selectRepository(bindings,'local-GPT-live','local').root,'/srv/voice');
  assert.throws(()=>selectRepository(bindings,'local-GPT-live','other'),/owner/);
  assert.throws(()=>selectRepository(bindings,'private-agent','local'),/owner/);
  for(const extra of [{repoId:'other'},{root:'/srv/../escape'},{owners:['*']},{validation:['sh','-c','x']},{paths:['**']},{publishAuthorized:'true'}])assert.throws(()=>repositoryBindings([{...binding,...extra}]));
  assert.throws(()=>repositoryBindings([binding,binding]),/duplicate/);
  assert.equal(developmentInput(input).executionProfileId,'takt-simple');
  assert.throws(()=>developmentInput({...input,executionProfileId:'edit-codex-luna',orchestratorProfileId:'plan-codex-luna'}),/requires_takt/);
  for(const extra of [{baseRef:'main'},{root:'/tmp/x'},{argv:['sh']},{publishAuthorized:true},{repoId:'__proto__'}])assert.throws(()=>developmentInput({...input,...extra}));
  assert.doesNotThrow(()=>verifyRepositoryMetadata({id:1402876013,private:false,permissions:{push:false}},'public',1402876013,false));
  assert.throws(()=>verifyRepositoryMetadata({id:1400010158,private:false,permissions:{push:true}},'public',1402876013,false));
});
test('voice policy excludes backend, other evidence, hidden paths and traversal',()=>{
  for(const path of ['browser/playback-ack.mjs','browser/tests/playback-ack.test.mjs','browser/README.md','.github/workflows/browser-ack.yml','docs/evidence/browser-playback-ack.md'])assert.ok(allowedRepositoryPath('local-GPT-live',path));
  for(const path of ['tests/test_playback_ack.py','docs/evidence/2026-10-04-ack-failure-regression.md','browser/../src/x.mjs','browser//playback-ack.mjs','browser/other.mjs','.github/workflows/ci.yml','/browser/playback-ack.mjs','browser\\playback-ack.mjs'])assert.equal(allowedRepositoryPath('local-GPT-live',path),false);
  assert.equal(allowedRepositoryPath('private-agent','tests/.hidden/x.ts'),false);
  assert.equal(allowedRepositoryPath('private-agent','tests/development.test.ts'),true);
});
test('preflight rejects symlinked roots and artifact directories before execution',async()=>{
  const root=await mkdtemp(join(tmpdir(),'registry-boundary-')),repo=join(root,'repo'),worktrees=join(root,'tasks');await mkdir(repo);await mkdir(worktrees);
  const b=repositoryBindings([{...binding,root:repo,worktrees}])[0];assert.equal(await preflightRepository(b),join(worktrees,'.artifacts'));
  const alias=join(root,'alias');await symlink(repo,alias);await assert.rejects(preflightRepository({...b,root:alias}),/untrusted/);
  const second=join(root,'second');await mkdir(second);await symlink(repo,join(second,'.artifacts'));await assert.rejects(preflightRepository({...b,worktrees:second}),/untrusted/);
});
test('local-only artifacts succeed without publication and cannot be promoted or altered by replay',async()=>{
  const root=await mkdtemp(join(tmpdir(),'registry-artifact-'));
  const manifest:LocalArtifact={version:1,taskId:'a',owner:'local',repoId:'local-GPT-live',baseRef:input.baseRef,baseSha:'a'.repeat(40),headSha:'b'.repeat(40),branch:'feature/browser-playback-ack-client',contentHash:'c'.repeat(64),validation:'browser-ack-v1',checks:[],mode:'local_only'};
  const saved=await saveArtifact(root,manifest);let calls=0;const publish=async()=>{calls++;return {url:'https://github.com/FYuki/local-GPT-live/pull/3'};};
  const result=await finishArtifact(saved,'local_only',publish);assert.equal(result.outcome,'local_only');assert.equal(calls,0);assert.ok(!('prUrl' in result));
  assert.deepEqual(await saveArtifact(root,manifest),saved);
  await assert.rejects(finishArtifact(saved,'published',publish),/mismatch/);
  await assert.rejects(finishArtifact({...saved,headSha:'d'.repeat(40)},'local_only',publish),/mismatch/);
  const approved=await saveArtifact(root,{...manifest,mode:'published'});assert.equal((await finishArtifact(approved,'published',publish)).outcome,'published');assert.equal(calls,1);
  const path=join(root,saved.artifactId+'.json');assert.equal(JSON.parse(await readFile(path,'utf8')).headSha,manifest.headSha);
  await writeFile(path,'{}');await assert.rejects(saveArtifact(root,manifest),/conflict/);
});
test('fixed browser validation runs real Node syntax and standard tests without npm or backend tools',async()=>{
  const root=await mkdtemp(join(tmpdir(),'registry-validation-'));await mkdir(join(root,'browser/tests'),{recursive:true});
  await writeFile(join(root,'browser/playback-ack.mjs'),'export const value = 3;');
  await writeFile(join(root,'browser/tests/playback-ack.test.mjs'),"import test from 'node:test';import assert from 'node:assert/strict';import {value} from '../playback-ack.mjs';test('fixture',()=>assert.equal(value,3));");
  const options={cwd:root,env:{PATH:'/usr/bin:/bin'}};
  // CIのsetup-nodeは/usr/binへ配置しない。固定policyを照合し、同じargvを検証用Nodeで実行する。
  for(const [file,...args] of validationCommands('local-GPT-live')){assert.equal(file,'/usr/bin/node');assert.equal(spawnSync(process.execPath,[...args],options).status,0);}
  await writeFile(join(root,'browser/playback-ack.mjs'),'export const value = 4;');
  const [file,...args]=validationCommands('local-GPT-live')[1];assert.equal(file,'/usr/bin/node');assert.notEqual(spawnSync(process.execPath,[...args],options).status,0);
});
