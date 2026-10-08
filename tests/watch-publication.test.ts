import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {executeDevelopment} from '../development/runner.ts';
import {processOutput} from '../development/process.ts';
import {verifyCommitRange} from '../development/commit-range.ts';
import type {Run} from '../shared/contracts.ts';

// 実Git/worktree/artifactを使い、providerとGitHub transportだけを置換する。
// namespace/公式Engineは別の統合試験で検証する。
for(const scenario of ['success','local-only','review-failed','validation-failed','cancelled','base-changed','base-changed-before-push','base-changed-before-pr'] as const)test(`watch→artifact→Epic draft PR: ${scenario}`,async()=>{
 const root=await mkdtemp(join(tmpdir(),'watch-publish-'));
 const repo=join(root,'repo'),remote=join(root,'remote.git'),worktrees=join(root,'worktrees');
 const git=(args:string[],cwd=repo)=>execFileSync('/usr/bin/git',['-c','core.hooksPath=/dev/null','-c','user.name=Fixture','-c','user.email=fixture@localhost',...args],{cwd,encoding:'utf8'}).trim();
 try{
  await mkdir(repo);await mkdir(worktrees);await mkdir(join(repo,'shared'));
  git(['init','-q','--initial-branch=epic/development-runner']);
  await writeFile(join(repo,'package.json'),JSON.stringify({scripts:{check:'true',test:'true'}}));
  await writeFile(join(repo,'.gitignore'),'node_modules/\n');await writeFile(join(repo,'shared/example.js'),'export const value=1;\n');
  git(['add','.']);git(['commit','-qm','fixture']);git(['clone','--bare',repo,remote]);git(['remote','add','origin','https://github.com/FYuki/private-agent.git']);
  const id=crypto.randomUUID(),base=git(['rev-parse','HEAD']);
  const run={id:id+':0',job_id:id,owner:'fixture',token:'fixture',development:{repoId:'private-agent',baseRef:'epic/development-runner',goal:'fixture',acceptanceCriteria:['value is 2'],orchestratorProfileId:'programmatic',executionProfileId:'takt-watch',watch:{issue:1,workflow:'private-agent-child-issue',validation:['test'],dependencies:[]}}} as unknown as Run;
  const config={repository:repo,worktrees,codexPackage:repo,authFile:join(repo,'package.json'),dependencies:repo,publishAuthorized:scenario!=='local-only',watchEnabled:true,watchAcceptanceEnabled:true,takt:{taktRuntime:repo,taktInputs:repo,taktRuns:repo,codexPackage:repo,authFile:join(repo,'package.json'),dependencies:repo}};
  const operations=new Map<string,{fingerprint:string;state:string;result:string|null}>();let watches=0,pushes=0,prs=0,checks=0,baseReads=0;
  const api=async(path:string,body:any)=>{
   if(path.endsWith('/heartbeat'))return {ok:true,cancelRequested:scenario==='cancelled'&&watches>0};
   assert.ok(path.endsWith('/operation'));const old=operations.get(body.name);
   if(old){assert.equal(old.fingerprint,body.fingerprint);if(body.result!==undefined){old.state='completed';old.result=body.result;}return {...old,fresh:false};}
   const row={fingerprint:body.fingerprint,state:'reserved',result:null};operations.set(body.name,row);return {...row,fresh:true};
  };
  const services={
   command:async(...args:Parameters<typeof processOutput>)=>{
    const [file,argv,cwd]=args;
    if(file==='/usr/bin/gh'){
     if(argv[0]==='api')return JSON.stringify({id:1400010158,private:true,permissions:{push:true}});
     if(argv[1]==='list')return JSON.stringify(prs?[{headRefOid:git(['rev-parse','HEAD'],join(worktrees,id)),isDraft:true,url:'https://github.com/FYuki/private-agent/pull/999'}]:[]);
     assert.equal(argv[1],'create');assert.ok(argv.includes('--draft'));assert.equal(argv[argv.indexOf('--base')+1],'epic/development-runner');prs++;return 'https://github.com/FYuki/private-agent/pull/999';
    }
    if(file==='/usr/bin/bwrap'){checks++;if(scenario==='validation-failed'&&checks>1)throw Error('test_failed');return 'fixture validation passed';}
    if(argv.includes('push'))pushes++;
    if(argv.includes('ls-remote')&&argv.some(x=>x.includes('epic/development-runner')))baseReads++;
    if(argv.includes('ls-remote')&&(scenario==='base-changed'||scenario==='base-changed-before-push'&&baseReads>=2||scenario==='base-changed-before-pr'&&baseReads>=3))return 'c'.repeat(40)+'\trefs/heads/epic/development-runner';
    return processOutput(file,['-c','user.name=Fixture','-c','user.email=fixture@localhost',...argv.map(x=>x==='https://github.com/FYuki/private-agent.git'?remote:x)],cwd,args[3],args[4],args[5],args[6]);
   },
   watch:async(_c:any,cwd:string,baseSha:string,..._args:any[])=>{
    watches++;if(scenario==='review-failed')throw Error('watch_quality_review_not_approved');
    await writeFile(join(cwd,'shared/example.js'),'export const value=2;\n');git(['add','.'],cwd);git(['commit','-qm','feat: fixture'],cwd);
    const headSha=git(['rev-parse','HEAD'],cwd);
    return {status:'approved' as const,manifestHash:'a'.repeat(64),headSha,commitRange:await verifyCommitRange(async a=>git(a,cwd),'private-agent',baseSha,headSha),runSlug:'fixture',iterations:9};
   },
  };
  const execute=()=>executeDevelopment(run,api,config,new AbortController().signal,process.hrtime.bigint()+60000000000n,services);
  if(scenario==='success'){
   const first=JSON.parse(await execute()),second=JSON.parse(await execute());assert.deepEqual(second,first);
   const artifact=JSON.parse(await readFile(join(worktrees,'.artifacts',first.artifactId+'.json'),'utf8'));assert.equal(artifact.baseSha,base);assert.equal(artifact.headSha,first.headSha);assert.equal(artifact.execution.manifestHash,'a'.repeat(64));
   assert.equal(first.review,'approved');assert.equal(first.prUrl,'https://github.com/FYuki/private-agent/pull/999');
   assert.equal(watches,1);assert.equal(pushes,1);assert.equal(prs,1);assert.equal(checks,3);
   assert.equal(git(['--git-dir='+remote,'rev-parse','refs/heads/'+('feature/development-task-'+id)]),git(['rev-parse','HEAD'],join(worktrees,id)));
  }else if(scenario==='local-only'){const result=JSON.parse(await execute());assert.equal(result.outcome,'local_only');assert.equal(result.review,'approved');assert.equal(pushes,0);assert.equal(prs,0);}
  else{if(scenario.startsWith('base-changed'))await assert.rejects(execute,scenario==='base-changed'?/publication_base_changed/:/operation_blocked/);else await assert.rejects(execute);assert.equal(pushes,scenario==='base-changed-before-pr'?1:0);assert.equal(prs,0);}
  assert.equal(git(['--git-dir='+remote,'rev-parse','refs/heads/epic/development-runner']),base);
 }finally{await rm(root,{recursive:true,force:true});}
});
