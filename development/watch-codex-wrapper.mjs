#!/usr/bin/node
import {readFileSync,realpathSync,lstatSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {codexArgs} from './takt-codex-wrapper.mjs';
import {parallelRun} from './watch-provider-budget.mjs';

/** cwdはSDKの--cdから取得する。wrapper自身のcwdをtask所有権と誤認しない。 */
export function ownedClone(argv,policy,tasks){
 const positions=argv.flatMap((x,i)=>x==='--cd'?[i]:[]);if(positions.length!==1)throw Error('watch_cwd_required');
 const cwd=argv[positions[0]+1];
 if(typeof cwd!=='string'||!cwd.startsWith(policy.clones+'/')||realpathSync(cwd)!==cwd||!lstatSync(cwd).isDirectory())throw Error('watch_clone_denied');
 if(tasks.length!==1)throw Error('watch_task_ambiguous');const task=tasks[0];
 if(task.status!=='running'||task.name!==policy.taskName||task.summary!==policy.marker||task.worktreePath!==cwd||!task.runSlug||task.workflow!==policy.workflow)throw Error('watch_task_identity_changed');
 const mapped=[...argv];mapped[positions[0]+1]='/workspace';return {cwd,task,mapped};
}
/** modelからwatch root、他task、git metadata、provider policyを見せない内側namespace。 */
export function watchProviderArgs(cwd,args,policy){
 const out=['--die-with-parent','--unshare-user','--unshare-pid','--new-session','--unshare-ipc','--unshare-uts','--cap-drop','ALL','--clearenv',
 '--ro-bind','/usr','/usr','--symlink','usr/bin','/bin','--symlink','usr/lib','/lib','--symlink','usr/lib64','/lib64','--proc','/proc','--dev','/dev','--tmpfs','/tmp',
 '--ro-bind','/opt/codex','/opt/codex','--bind',cwd,'/workspace','--ro-bind','/empty-git','/workspace/.git','--ro-bind','/dependencies','/workspace/node_modules',
 '--bind','/codex-state','/home/runner/.codex','--ro-bind','/codex-auth','/home/runner/.codex/auth.json',
 '--ro-bind','/etc/ssl','/etc/ssl','--ro-bind','/etc/resolv.conf','/etc/resolv.conf','--ro-bind','/etc/hosts','/etc/hosts'];
 const takt=join(cwd,'.takt');if(lstatSync(takt).isDirectory()&&realpathSync(takt)===takt)out.push('--ro-bind',takt,'/workspace/.takt');else throw Error('watch_clone_control_denied');
 const schema=args.indexOf('--output-schema');if(schema>=0){const p=args[schema+1],s=lstatSync(p);if(realpathSync(p)!==p||!s.isFile()||s.size>1048576)throw Error('schema_denied');out.push('--dir',dirname(p),'--ro-bind',p,p);}
 return [...out,'--setenv','HOME','/home/runner','--setenv','CODEX_HOME','/home/runner/.codex','--setenv','PATH','/usr/bin:/bin','--setenv','LANG','C.UTF-8','--chdir','/workspace','--','/usr/bin/node','/opt/codex/bin/codex.js',...args];
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{
  if(process.env.OPENAI_API_KEY||process.env.CODEX_API_KEY)throw Error('api_key_denied');
  const policy=JSON.parse(readFileSync('/run-private/provider-policy.json','utf8'));
  const {TaskRunner}=await import('/opt/takt-runtime/node_modules/takt/dist/infra/task/runner.js');
  const {assertTaskStateWorktreeOwnership}=await import('/opt/takt-runtime/node_modules/takt/dist/features/tasks/taskStateWorktreeOwnership.js');
  const bound=ownedClone(process.argv.slice(2),policy,new TaskRunner(policy.root).listTaskStateItems());assertTaskStateWorktreeOwnership(policy.root,bound.task);
  const {args,model,effort}=codexArgs(bound.mapped,true);
  await parallelRun({file:'/usr/bin/bwrap',args:watchProviderArgs(bound.cwd,args,policy),directory:'/run-private',maxCalls:policy.maxCalls,profile:{model,effort,taskName:bound.task.name,runSlug:bound.task.runSlug},env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8'}});
 }catch(e){process.stderr.write(String(e.message)+'\n');process.exitCode=1;}
}
