import {mkdir,readFile,writeFile,lstat,realpath,readdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {processOutput} from './process.ts';
import {WatchSupervisor} from './watch-supervisor.ts';
import {TaktWatchClient,verifyWatchRuntime} from './takt-watch-client.ts';
import {watchOrder,orderText,orderMarker,type WatchOrder} from './watch-contract.ts';
import {verifyCommitRange} from './commit-range.ts';
import {acceptedResult,hash} from './takt-contract.ts';
import {acceptedChildReviewResult} from './watch-review-acceptance.ts';
import {acceptedDefaultResult} from './watch-acceptance.ts';
// @ts-ignore dependency-free provider budget boundary
import {verifyProviderSettlement} from './watch-provider-budget.mjs';
import type {TaktConfig} from './takt-adapter.ts';

/** 一つのD1 leaseに一つのwatch namespace。外部公開は行わず、停止・履歴検証後だけ成果物を返す。 */
export function validateWatchStorage(clones:string){
 // 公式0.68.0は絶対cloneパスをfile名へ符号化し、atomic保存時にPID/UUIDを追加する。
 // clone名80byteとsuffix57byteを予約し、NAME_MAX=255をモデル開始前に守る。
 if(Buffer.byteLength(clones,'utf8')+1+80+57>255)throw Error('watch_storage_path_too_long');
}

export {executeWatch} from './watch-execution.ts';
export async function runWatchExecution(config:TaktConfig,worktree:string,baseSha:string,owner:string,order:WatchOrder,signal:AbortSignal,deadline?:bigint){
 order=watchOrder(order);
 for(const p of [config.taktRuntime,config.taktInputs,config.taktRuns,config.codexPackage,config.authFile,config.dependencies])if(resolve(p)!==p||await realpath(p)!==p)throw Error('untrusted_watch_path');
 const runRoot=join(config.taktRuns,order.id),root=join(runRoot,'repo'),clones=join(runRoot,'clones'),configDir=join(runRoot,'config'),privateDir=join(runRoot,'private');
 validateWatchStorage(clones);
 await mkdir(runRoot,{mode:0o700});for(const p of [root,clones,configDir,privateDir,join(runRoot,'empty-git'),join(runRoot,'codex-state')])await mkdir(p,{mode:0o700});
 await verifyWatchRuntime(config.taktRuntime,root,configDir);
 const env={PATH:'/usr/bin:/bin',HOME:configDir,LANG:'C.UTF-8',GIT_CONFIG_NOSYSTEM:'1',GIT_TERMINAL_PROMPT:'0'};
 const commandDeadline=()=>deadline??process.hrtime.bigint()+60000000000n;
 const git=(args:string[],cwd=root)=>processOutput('/usr/bin/git',['-c','core.hooksPath=/dev/null','-c','commit.gpgsign=false',...args],cwd,'',signal,commandDeadline(),env);
 await git(['init','--initial-branch='+order.baseRef]);await git(['fetch','--no-tags',worktree,baseSha]);await git(['reset','--hard',baseSha]);
 await git(['config','user.name','PrivateAgent watch']);await git(['config','user.email','watch@localhost']);
 const origin=(await git(['remote','get-url','origin'],worktree)).trim();await git(['remote','add','origin',origin]);
 await processOutput(process.execPath,[fileURLToPath(new URL('./watch-runtime-prepare.mjs',import.meta.url)),config.taktRuntime,config.taktInputs,configDir,clones,order.workflow],root,'',signal,commandDeadline(),env);
 const compiled=JSON.parse(await readFile(join(configDir,'watch-compiled.json'),'utf8'));
 if(order.workflow==='private-agent-child-issue'){
  // モデルへ実worktreeのGit管理領域を渡さず、固定baseの読取専用index/objectsを渡す。
  const snapshot=join(runRoot,'empty-git');
  await git(['init','--bare',snapshot]);
  await git(['--git-dir='+snapshot,'fetch','--no-tags',root,baseSha]);
  await git(['--git-dir='+snapshot,'config','core.bare','false']);
  await git(['--git-dir='+snapshot,'update-ref','refs/heads/review-base',baseSha]);
  await git(['--git-dir='+snapshot,'symbolic-ref','HEAD','refs/heads/review-base']);
  await git(['--git-dir='+snapshot,'read-tree',baseSha]);
 }
 const task=orderText(order)+`\n\nReview base SHA: ${baseSha}\nレビューはこのbaseからの作業ツリー差分全体と未追跡ファイルを対象とする。ホストが固定テストを再実行し、管理設定で公開が許可済みならEpic宛draft PRを作成する。`;let client=await TaktWatchClient.connect(config.taktRuntime,root,configDir);
 const supervisor=new WatchSupervisor(join(runRoot,'supervisor.db'));let started=false,stopped=false,completedSlug:string|undefined;
 let cancellation:Promise<void>|undefined,timer:ReturnType<typeof setTimeout>|undefined;
 const cancelNow=()=>{if(started&&!stopped&&!cancellation)cancellation=supervisor.cancel(owner,root).then(()=>{stopped=true;}).catch(()=>{throw Error('watch_stop_unconfirmed');});cancellation?.catch(()=>{});};
 try{
  const queued=await client.enqueue({task,workflow:order.workflow,worktree:true,autoPr:false,taskContext:{baseBranch:order.baseRef}});
  const policy={root,clones,taskName:queued.taskName,marker:orderMarker(order),workflow:order.workflow,maxCalls:config.maxProviderCalls??null,callMs:config.watchLimits?.callMs??null};
  if(policy.maxCalls!==null&&(!Number.isSafeInteger(policy.maxCalls)||policy.maxCalls<1))throw Error('invalid_provider_call_limit');
  await writeFile(join(privateDir,'provider-policy.json'),JSON.stringify(policy),{mode:0o600,flag:'wx'});
  const here=fileURLToPath(new URL('.',import.meta.url));
  const args=['--unshare-user','--unshare-pid','--die-with-parent','--new-session','--unshare-ipc','--unshare-uts','--cap-drop','ALL','--clearenv',
   '--ro-bind','/usr','/usr','--symlink','usr/bin','/bin','--symlink','usr/lib','/lib','--symlink','usr/lib64','/lib64','--proc','/proc','--dev','/dev','--tmpfs','/tmp',
   '--bind',runRoot,runRoot,'--ro-bind',config.taktRuntime,'/opt/takt-runtime','--ro-bind',config.codexPackage,'/opt/codex','--ro-bind',config.dependencies,'/dependencies',
   '--ro-bind',config.authFile,'/codex-auth','--bind',join(runRoot,'codex-state'),'/codex-state','--ro-bind',join(runRoot,'empty-git'),'/empty-git','--bind',privateDir,'/run-private',
   '--ro-bind',join(privateDir,'provider-policy.json'),'/run-private/provider-policy.json',
   '--ro-bind',join(here,'watch-provider-budget.mjs'),'/opt/private-agent/watch-provider-budget.mjs',
   '--ro-bind',join(here,'watch-codex-wrapper.mjs'),'/opt/private-agent/watch-codex-wrapper.mjs','--ro-bind',join(here,'takt-codex-wrapper.mjs'),'/opt/private-agent/takt-codex-wrapper.mjs',
   '--ro-bind','/etc/ssl','/etc/ssl','--ro-bind','/etc/resolv.conf','/etc/resolv.conf','--ro-bind','/etc/hosts','/etc/hosts',
   '--setenv','HOME',configDir,'--setenv','TAKT_CONFIG_DIR',configDir,'--setenv','TAKT_CODEX_CLI_PATH','/opt/private-agent/watch-codex-wrapper.mjs',
   '--setenv','PATH','/usr/bin:/bin','--setenv','LANG','C.UTF-8','--setenv','TAKT_NO_TTY','1','--setenv','NO_UPDATE_NOTIFIER','1','--chdir',root,
   '--','/usr/bin/node','/opt/takt-runtime/node_modules/takt/dist/app/cli/index.js','watch'];
  for(const name of ['config.yaml','runtime.yaml',...(order.workflow==='private-agent-child-issue'?['workflows','facets']:[])])args.splice(args.indexOf('--chdir'),0,'--ro-bind',join(configDir,name),join(configDir,name));
  if(signal.aborted||(deadline!==undefined&&process.hrtime.bigint()>=deadline))throw Error('cancelled_or_deadline');
  await supervisor.start(owner,{file:'/usr/bin/bwrap',args,cwd:root,env});started=true;
  signal.addEventListener('abort',cancelNow,{once:true});if(deadline!==undefined)timer=setTimeout(cancelNow,Math.max(0,Number(deadline-process.hrtime.bigint())/1e6));if(signal.aborted)cancelNow();
  for(;;){
   if(signal.aborted||(deadline!==undefined&&process.hrtime.bigint()>=deadline))throw Error('cancelled_or_deadline');
   if(supervisor.status(owner,root)?.observed!=='alive')throw Error('watch_exited_before_completion');
   let tasks;
   try{tasks=await client.list();}catch{
    // MCPだけを再接続する。応答不明なenqueueを再送したりwatchを止めたりしない。
    await client.close().catch(()=>{});await new Promise(r=>setTimeout(r,250));
    try{client=await TaktWatchClient.connect(config.taktRuntime,root,configDir);}catch{}
    continue;
   }
   if(tasks.length!==1||tasks[0].name!==queued.taskName||tasks[0].summary!==policy.marker)throw Error('watch_task_identity_changed');
   if(tasks[0].status==='completed'){if(!tasks[0].runSlug)throw Error('watch_completion_mismatch');completedSlug=tasks[0].runSlug;break;}
   if(!['pending','running'].includes(tasks[0].status))throw Error('watch_task_failed');
   await new Promise(r=>setTimeout(r,250));
  }
  await supervisor.stop(owner,root,10000);stopped=true;
  const binding=JSON.parse(await processOutput(process.execPath,[fileURLToPath(new URL('./watch-run-binding.mjs',import.meta.url)),config.taktRuntime,root,configDir,clones,queued.taskName,completedSlug,order.workflow],root,task,signal,commandDeadline(),env));
  const expectedTask=binding.executionTask;
  const clone=binding.clone,headSha=(await git(['rev-parse','HEAD'],clone)).trim();
  if((await git(['rev-parse','refs/heads/'+binding.branch])).trim()!==headSha||(await git(['status','--porcelain'],clone)).trim())throw Error('watch_head_mismatch');
  const commitRange=await verifyCommitRange(a=>git(a,clone),order.repoId,baseSha,headSha);
  const files:string[]=[];
  async function scan(dir:string){for(const name of await readdir(dir)){const p=join(dir,name),s=await lstat(p);if(s.isSymbolicLink())throw Error('artifact_symlink');if(s.isDirectory())await scan(p);else if(name==='meta.json'||name.endsWith('.jsonl')){if(s.size>16*1024*1024||files.length>=256)throw Error('artifact_limit');files.push(p);}}}
  await scan(join(clone,'.takt','runs',binding.runSlug));
  const metas=files.filter(p=>p.endsWith('/meta.json'));if(metas.length!==1)throw Error('ambiguous_takt_result');const meta=JSON.parse(await readFile(metas[0],'utf8'));
  const sessions=[];for(const p of files.filter(p=>p.endsWith('.jsonl')&&p.includes('/logs/')&&!p.includes('/shadow/'))){const events=(await readFile(p,'utf8')).split('\n').filter(Boolean).map(x=>JSON.parse(x));if(events[0]?.type==='workflow_start'&&events[0].task===expectedTask&&events[0].workflowName===order.workflow&&events[0].startTime===meta.startTime)sessions.push(events);}
  if(sessions.length!==1||meta.runSlug!==binding.runSlug)throw Error('ambiguous_takt_session');
  const result=order.workflow==='private-agent-child-issue'?acceptedChildReviewResult(meta,sessions[0],{task:expectedTask,references:compiled.references}):order.workflow==='default'?acceptedDefaultResult(meta,sessions[0],{task:expectedTask,workflow:'default',references:compiled.references}):acceptedResult(meta,sessions[0],{task:expectedTask,workflow:'simple'});
  const activity=(await readFile(join(privateDir,'activity.ndjson'),'utf8')).trim().split('\n').map(x=>JSON.parse(x));
  verifyProviderSettlement(activity,policy.maxCalls);
  await git(['fetch','--no-tags',clone,headSha],worktree);await git(['merge','--ff-only',headSha],worktree);
  if((await git(['rev-parse','HEAD'],worktree)).trim()!==headSha)throw Error('watch_import_mismatch');
  return {...result,headSha,commitRange,manifestHash:hash(JSON.stringify({baseSha,headSha,commitRange,compiled,activity,taskHash:hash(task)}))};
 }finally{
  clearTimeout(timer);signal.removeEventListener('abort',cancelNow);let unconfirmed=false;
  if(cancellation){try{await cancellation;}catch{unconfirmed=true;}}
  if(started&&!stopped){try{await supervisor.cancel(owner,root);stopped=true;}catch{unconfirmed=true;}}
  // MCPの終了はwatch namespaceの停止証明とは独立。
  await client.close().catch(()=>{});try{supervisor.close();}catch{unconfirmed=true;}
  if(unconfirmed)throw Error('watch_stop_unconfirmed');
 }
}
