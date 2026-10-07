import {verifyCommitRange,type CommitRangeProof} from './commit-range.ts';
import {readFile,lstat,realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {publicationInput,publicationArtifact,uuid,type PublicationInput} from '../shared/publication.ts';
import {repositoryPolicy,allowedRepositoryPath} from '../shared/repositories.ts';
import {selectRepository,preflightRepository,type RepositoryBinding} from './repositories.ts';
import {fingerprint,operation,type Ledger} from './operations.ts';
import {verifyRepositoryMetadata} from './publisher.ts';
import {processOutput} from './process.ts';

export interface ApprovedPublicationRemote{
 verify():Promise<void>;
 baseSha():Promise<string|undefined>;
 branchSha():Promise<string|undefined>;
 push():Promise<void>;
 findPullRequest():Promise<{url:string}|undefined>;
 createPullRequest():Promise<{url:string}>;
}
/** A new approval owns two single-use reservations; retries only reconcile remote effects. */
export async function publishApproved(input:PublicationInput,expiresAt:number,ledger:Ledger,remote:ApprovedPublicationRemote,now=Date.now){
 const verify=async()=>{await remote.verify();if(await remote.baseSha()!==input.remoteBaseSha)throw Error('remote_base_changed');};
 const canWrite=()=>{if(now()>=expiresAt)throw Error('publication_expired');};
 const branch=async()=>{const head=await remote.branchSha();if(head&&head!==input.headSha)throw Error('remote_head_conflict');return head;};
 await verify();await branch();await remote.findPullRequest();
 await operation(ledger,'push',input,async()=>{
  await verify();if(await branch()===input.headSha)return {sha:input.headSha};
  canWrite();await remote.push();if(await branch()!==input.headSha)throw Error('push_unconfirmed');return {sha:input.headSha};
 },async()=>{await verify();return await branch()===input.headSha?{sha:input.headSha}:undefined;});
 // Completed ledger entries are not evidence that remote refs still match now.
 await verify();if(await branch()!==input.headSha)throw Error('remote_head_missing');
 const result=await operation(ledger,'pull-request',input,async()=>{
  await verify();if(await branch()!==input.headSha)throw Error('remote_head_missing');
  const old=await remote.findPullRequest();if(old)return old;
  canWrite();await remote.createPullRequest();const found=await remote.findPullRequest();if(!found)throw Error('pull_request_unconfirmed');return found;
 },async()=>{await verify();if(await branch()!==input.headSha)throw Error('remote_head_missing');return remote.findPullRequest();});
 await verify();if(await branch()!==input.headSha)throw Error('remote_head_missing');
 const current=await remote.findPullRequest();if(!current||current.url!==result.url)throw Error('pull_request_changed');return result;
}

/** 保存済みcommitの内容・モード・親・作業領域を読取検証する。外部接続や検証コード実行はない。 */
export async function verifyPublicationSource(binding:RepositoryBinding,input:PublicationInput,artifact:{contentHash:string;commitRange?:CommitRangeProof},signal:AbortSignal,deadline:bigint){
 const directory=join(binding.worktrees,input.taskId),policy=repositoryPolicy(input.repoId),remote='https://github.com/'+policy.github+'.git';
 if(await realpath(directory)!==directory)throw Error('untrusted_task_path');
 const env={PATH:'/usr/bin:/bin',HOME:process.env.HOME,LANG:'C.UTF-8',GIT_TERMINAL_PROMPT:'0'};
 const git=(args:string[],cwd=directory)=>processOutput('/usr/bin/git',['-c','core.hooksPath=/dev/null','-c','commit.gpgsign=false',...args],cwd,'',signal,deadline,env);

  if((await git(['rev-parse','--show-toplevel'],binding.root)).trim()!==binding.root||(await git(['rev-parse','--show-toplevel'])).trim()!==directory)throw Error('repository_root_mismatch');
  if(![remote,'git@github.com:'+policy.github+'.git'].includes((await git(['remote','get-url','origin'])).trim()))throw Error('repository_remote_mismatch');
  if((await git(['rev-parse','HEAD'])).trim()!==input.headSha||(await git(['status','--porcelain'])).trim())throw Error('artifact_head_changed');
  if(artifact.commitRange){
   const verified=await verifyCommitRange(git,input.repoId,input.baseSha,input.headSha);
   if(JSON.stringify(verified)!==JSON.stringify(artifact.commitRange))throw Error('artifact_range_changed');
  }else if((await git(['rev-parse','HEAD^'])).trim()!==input.baseSha)throw Error('artifact_head_changed');
  const files=(await git(['diff','--name-only','-z',input.baseSha,input.headSha])).split('\0').filter(Boolean).sort();
  if(!files.length||files.length>20)throw Error('change_limit');let bytes=0;const snapshot:unknown[]=[];
  for(const path of files){
   if(!allowedRepositoryPath(input.repoId,path))throw Error('path_denied');
   const tree=await git(['ls-tree','-z',input.headSha,'--',path]);
   if(!tree){snapshot.push([path,null]);continue;}
   const match=tree.match(/^(100644|100755) blob [a-f0-9]{40}\t([^\0]+)\0$/);if(!match||match[2]!==path)throw Error('invalid_artifact_file');
   const content=await git(['show',input.headSha+':'+path]);bytes+=Buffer.byteLength(content);if(bytes>262144)throw Error('change_limit');
   if(/(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_|sk-[A-Za-z0-9]{20,}|eyJ[A-Za-z0-9_-]{20,}\.|BEGIN [A-Z ]*PRIVATE KEY)/.test(content))throw Error('secret_detected');
   const localPath=join(directory,path),stat=await lstat(localPath);
   if(!stat.isFile()||stat.nlink!==1||await realpath(localPath)!==localPath||((stat.mode&0o111)!==0)!==(match[1]==='100755')||await readFile(localPath,'utf8')!==content)throw Error('artifact_worktree_changed');
   // 既存artifactはlstat.mode全体を記録している。Git blob内容と実ファイル双方を照合する。
   snapshot.push([path,stat.mode,content]);
  }
  if(fingerprint(snapshot)!==artifact.contentHash)throw Error('artifact_content_changed');

}

/** Trusted host-only publisher: exact artifact, fixed repo/argv, existing GitHub login, no model. */
export async function executePublication(id:string,api:(path:string,body?:unknown)=>Promise<any>,bindings:RepositoryBinding[],signal:AbortSignal){
 uuid(id);const endpoint='/api/development/publications/'+id;
 const approval=await api(endpoint) as any,input=publicationInput(approval.spec),owner=approval.owner;
 const binding=selectRepository(bindings,input.repoId,owner);
 if(binding.approvedPublicationAllowed!==true)throw Error('approved_publication_not_enabled');
 const root=await preflightRepository(binding),policy=repositoryPolicy(input.repoId);
 const manifestPath=join(root,input.artifactId+'.json'),stat=await lstat(manifestPath);
 if(!stat.isFile()||stat.nlink!==1||stat.size>16384||(stat.mode&0o077)!==0||await realpath(manifestPath)!==manifestPath)throw Error('untrusted_artifact_path');
 const artifact=await publicationArtifact(JSON.parse(await readFile(manifestPath,'utf8')),owner,input);
 await publicationArtifact(approval.artifact,owner,input);
 const directory=join(binding.worktrees,input.taskId);if(await realpath(directory)!==directory)throw Error('untrusted_task_path');
 const deadline=process.hrtime.bigint()+600000000000n;
 const env={PATH:'/usr/bin:/bin',HOME:process.env.HOME,LANG:'C.UTF-8',GIT_TERMINAL_PROMPT:'0',GH_PROMPT_DISABLED:'1'};
 const command=(file:string,args:string[],cwd=directory,data='')=>processOutput(file,args,cwd,data,signal,deadline,env);
 const git=(args:string[],cwd=directory)=>command('/usr/bin/git',['-c','core.hooksPath=/dev/null','-c','commit.gpgsign=false',...args],cwd);
 const gh=(args:string[],data='')=>command('/usr/bin/gh',args,binding.root,data);
 const remote='https://github.com/'+policy.github+'.git',branch=artifact.branch;
 const verifyLocal=()=>verifyPublicationSource(binding,input,artifact,signal,deadline);
 await verifyLocal();
 const findPullRequest=async()=>{
  const query='repos/'+policy.github+'/pulls?state=all&head='+encodeURIComponent(policy.github.split('/')[0]+':'+branch)+'&per_page=100';
  const list=JSON.parse(await gh(['api',query]));if(!Array.isArray(list)||list.length>1)throw Error('pull_request_conflict');
  if(!list.length)return undefined;const pr=list[0];
  if(pr.state!=='open'||pr.draft!==true||pr.head?.sha!==input.headSha||pr.head?.ref!==branch||pr.head?.repo?.id!==policy.githubId||pr.base?.ref!==input.baseRef||pr.base?.repo?.id!==policy.githubId||pr.title!==input.title||pr.body!==input.body)throw Error('pull_request_conflict');
  if(!new RegExp('^https://github\\.com/'+policy.github+'/pull/[0-9]+$').test(pr.html_url))throw Error('invalid_pr_response');return {url:pr.html_url};
 };
 let mergeChecked=false;
 const github:ApprovedPublicationRemote={
  async verify(){
   const current=await api(endpoint) as any;
   if(JSON.stringify(current.spec)!==JSON.stringify(input)||current.owner!==owner||current.expires_at!==approval.expires_at)throw Error('publication_approval_changed');
   await verifyLocal();verifyRepositoryMetadata(JSON.parse(await gh(['api','repos/'+policy.github])),binding.visibility,policy.githubId,true);
   if(!mergeChecked){
    await git(['fetch','--no-tags',remote,input.remoteBaseSha],binding.root);
    await git(['merge-tree','--write-tree',input.remoteBaseSha,input.headSha],binding.root);
    mergeChecked=true;
   }
  },
  async baseSha(){return (await git(['ls-remote',remote,'refs/heads/'+input.baseRef])).trim().split(/\s/)[0]||undefined;},
  async branchSha(){return (await git(['ls-remote',remote,'refs/heads/'+branch])).trim().split(/\s/)[0]||undefined;},
  async push(){await git(['push','--force-with-lease=refs/heads/'+branch+':',remote,input.headSha+':refs/heads/'+branch]);},
  findPullRequest,
  async createPullRequest(){
   await gh(['api','repos/'+policy.github+'/pulls','--method','POST','--input','-'],JSON.stringify({head:branch,base:input.baseRef,title:input.title,body:input.body,draft:true}));
   const found=await findPullRequest();if(!found)throw Error('pull_request_unconfirmed');return found;
  }
 };
 const ledger:Ledger=(name,_fingerprint,result)=>api(endpoint+'/operation',{name,...(result===undefined?{}:{result:JSON.parse(result)})}) as ReturnType<Ledger>;
 return publishApproved(input,approval.expires_at,ledger,github);
}
