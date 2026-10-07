import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,unlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {verifyCommitRange} from '../development/commit-range.ts';

test('real Git range validates every intermediate commit, rejects hidden paths and secrets',async()=>{
 const root=await mkdtemp(join(tmpdir(),'commit-range-'));
 const git=(args:string[])=>execFileSync('/usr/bin/git',['-c','core.hooksPath=/dev/null','-c','commit.gpgsign=false','-c','user.name=Synthetic','-c','user.email=fixture@example.test',...args],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']});
 const commit=()=>{git(['add','.']);git(['commit','--allow-empty','-m','fixture']);return git(['rev-parse','HEAD']).trim();};
 try{
  git(['init','-b','master']);const base=commit();await mkdir(join(root,'browser'));const path=join(root,'browser/playback-ack.mjs');
  await writeFile(path,'export const fixture=1;');const first=commit();await writeFile(path,'export const fixture=2;');const head=commit();
  const proof=await verifyCommitRange(async a=>git(a),'local-GPT-live',base,head);assert.deepEqual(proof.commits,[first,head]);assert.match(proof.digest,/^[a-f0-9]{64}$/);
  await writeFile(join(root,'forbidden.txt'),'fixture');commit();await unlink(join(root,'forbidden.txt'));const hidden=commit();
  await assert.rejects(verifyCommitRange(async a=>git(a),'local-GPT-live',base,hidden),/path_denied/);
  git(['reset','--hard',head]);await writeFile(path,'sk-'+'x'.repeat(24));commit();await writeFile(path,'export const fixture=3;');const secret=commit();
  await assert.rejects(verifyCommitRange(async a=>git(a),'local-GPT-live',base,secret),/secret_detected/);
  await assert.rejects(verifyCommitRange(async a=>git(a),'local-GPT-live',head,base),/commit_limit/);
  git(['reset','--hard',head]);git(['checkout','-b','side',base]);await mkdir(join(root,'browser'),{recursive:true});await writeFile(join(root,'browser/README.md'),'fixture');commit();git(['checkout','master']);git(['merge','--no-ff','side','-m','merge']);
  await assert.rejects(verifyCommitRange(async a=>git(a),'local-GPT-live',base,git(['rev-parse','HEAD']).trim()),/nonlinear_commit_range/);
 }finally{await rm(root,{recursive:true,force:true});}
});
