import {mkdir,readFile,writeFile,readdir,lstat,realpath,access,copyFile} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {appendFileSync} from 'node:fs';
import {sandboxArgs,type SandboxConfig} from './sandbox.ts';
import {processOutput} from './process.ts';
import {hash,resourcePlan,acceptedResult,TAKT_PIN,type Runtime} from './takt-contract.ts';

export type TaktConfig=SandboxConfig&{taktRuntime:string;taktInputs:string;taktRuns:string;maxProviderCalls?:number;watchLimits?:{callMs?:number;wallMs?:number}};
const env={PATH:'/usr/bin:/bin',LANG:'C.UTF-8'};
/** 同一runの再実行はしない。中断時のTAKT保存ファイルは保持し、人による新規taskを待つ。 */
export async function executeTakt(config:TaktConfig,worktree:string,task:string,baseSha:string,id:string,signal:AbortSignal,deadline:bigint,onProgress?:(stage:string,iteration:number)=>Promise<unknown>){
 for(const p of [config.taktRuntime,config.taktInputs,config.taktRuns])if(resolve(p)!==p||await realpath(p)!==p)throw Error('untrusted_takt_path');
 if(!/^[a-f0-9-]{36}$/.test(id)||!/^[a-f0-9]{40}$/.test(baseSha))throw Error('invalid_takt_identity');
 const root=join(config.taktRuns,id);await mkdir(root,{mode:0o700});
 const configDir=join(root,'config'),projectDir=join(root,'project'),privateDir=join(root,'private');
 for(const p of [configDir,projectDir,privateDir])await mkdir(p,{mode:0o700});
 const maxCalls=config.maxProviderCalls??120;
 if(!Number.isSafeInteger(maxCalls)||maxCalls<1||maxCalls>120)throw Error('invalid_provider_call_limit');
 await writeFile(join(privateDir,'provider-policy.json'),JSON.stringify({maxCalls}),{mode:0o600});
 const seed=join(root,'git-snapshot');await mkdir(seed,{mode:0o700});
 const git=(args:string[],cwd:string)=>processOutput('/usr/bin/git',['-c','core.hooksPath=/dev/null','-c','commit.gpgsign=false','-c','user.name=PrivateAgent snapshot','-c','user.email=snapshot@localhost',...args],cwd,'',signal,deadline,env);
 const tracked=(await git(['ls-files','-z'],worktree)).split('\0').filter(Boolean);
 for(const file of tracked){if(file.split('/').some(p=>p==='..'||p==='.git')||file.startsWith('/'))throw Error('snapshot_path_denied');const source=join(worktree,file);if(!(await lstat(source)).isFile()||await realpath(source)!==source)throw Error('snapshot_symlink_denied');await mkdir(dirname(join(seed,file)),{recursive:true});await copyFile(source,join(seed,file));}
 await git(['init','--initial-branch=snapshot'],seed);await git(['add','--all'],seed);await git(['commit','--allow-empty','-m','PrivateAgent input snapshot'],seed);
 const snapshotHead=(await git(['rev-parse','HEAD'],seed)).trim();
 const gitPointer=join(root,'git-pointer');await writeFile(gitPointer,'gitdir: /snapshot-git\n',{mode:0o600});
 // project設定を起動時に拒否し、run中も空のproject設定をreadonly mountする。
 for(const name of ['config.yaml','runtime.yaml']){try{await access(join(worktree,'.takt',name));throw Error('project_takt_override_denied');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}await writeFile(join(projectDir,name),'',{mode:0o600});}
 await processOutput(process.execPath,[fileURLToPath(new URL('./takt-prepare.mjs',import.meta.url)),config.taktRuntime,config.taktInputs,configDir],worktree,'',signal,deadline,env);
 const compiled=JSON.parse(await readFile(join(configDir,'compiled.json'),'utf8'));
 if(compiled.modelPlanVersion!==2||!Array.isArray(compiled.conditionalCalls))throw Error('official_conditional_plan_required');
 const resources={...resourcePlan(compiled.runtime as Runtime,compiled.steps,compiled.conditionalCalls),maxProviderCalls:maxCalls};
 if(!compiled.steps.every((s:any)=>s.official?.provider&&s.official?.model&&s.official?.effort))throw Error('official_resolution_required');
 if(JSON.stringify(Object.keys(resources.models).sort())!==JSON.stringify(['codex-luna','codex-sol']))throw Error('resource_contract_changed');
 const manifest={...TAKT_PIN,id,baseSha,snapshotHead,taskHash:hash(task),wrapperHash:hash(await readFile(fileURLToPath(new URL('./takt-codex-wrapper.mjs',import.meta.url)))),requested:compiled.requested,effective:compiled.effective,workflowHash:compiled.workflowHash,promptBundleHash:compiled.promptBundleHash,resources,overrides:compiled.overrides,permissions:'isolated-chatgpt-no-publish-no-subagents',state:'running'};
 await writeFile(join(root,'manifest.json'),JSON.stringify(manifest,null,2),{mode:0o600});
 const args=await taktSandboxArgs(config,worktree,root,['/usr/bin/node','/opt/takt-runtime/node_modules/takt/dist/app/cli/index.js','--pipeline','--skip-git','--workflow','simple','--task',task]);
 let reporting=false;
 const progress=setInterval(()=>{if(!onProgress||reporting)return;reporting=true;void (async()=>{try{for(const slug of await readdir(join(projectDir,'runs'))){if(!/^[a-zA-Z0-9_-]+$/.test(slug))continue;const path=join(projectDir,'runs',slug,'meta.json');if((await lstat(path)).size>65536)continue;const meta=JSON.parse(await readFile(path,'utf8'));if(meta.status==='running'&&typeof meta.currentStep==='string')await onProgress(meta.currentStep,meta.currentIteration);}}catch{}finally{reporting=false;}})();},5000);
 try {
  await processOutput('/usr/bin/bwrap',args,worktree,'',signal,deadline,env,{interruptFirst:true,outputBytes:16*1024*1024,idleMs:600000,log:b=>appendFileSync(join(root,'process.log'),b,{mode:0o600})});
  const paths:string[]=[];
  async function scan(dir:string){for(const name of await readdir(dir)){const p=join(dir,name),s=await lstat(p);if(s.isSymbolicLink())throw Error('artifact_symlink');if(s.isDirectory())await scan(p);else if(name==='meta.json'||name.endsWith('.jsonl'))paths.push(p);}}
  await scan(projectDir);
  const metas=paths.filter(p=>p.endsWith('/meta.json'));
  if(metas.length!==1)throw Error('ambiguous_takt_result');
  const meta=JSON.parse(await readFile(metas[0],'utf8'));
  const sessions=[];for(const p of paths.filter(p=>p.endsWith('.jsonl')&&p.includes('/logs/')&&!p.includes('/shadow/'))){const stat=await lstat(p);if(stat.size>16*1024*1024)throw Error('artifact_limit');const events=(await readFile(p,'utf8')).split('\n').filter(x=>x.trim()).map(x=>JSON.parse(x));const first=events[0];if(first?.type==='workflow_start'&&first.task===task&&first.workflowName==='simple'&&first.startTime===meta.startTime)sessions.push(events);}
  if(sessions.length!==1)throw Error('ambiguous_takt_session');const events=sessions[0];
  const result=acceptedResult(meta,events,{task,workflow:'simple'});
  const completed=JSON.stringify({...manifest,state:'completed',result},null,2);
  await writeFile(join(root,'manifest.json'),completed);
  return {manifestHash:hash(completed),...result};
 }catch(e){await writeFile(join(root,'manifest.json'),JSON.stringify({...manifest,state:'interrupted',restart:'human_new_task_required'},null,2));throw e;}finally{clearInterval(progress);}
}

/** ホスト内部用。HTTP/MCPから任意commandは受け付けない。 */
export async function taktSandboxArgs(config:TaktConfig,worktree:string,root:string,command:string[]){
 const seed=join(root,'git-snapshot'),configDir=join(root,'config'),projectDir=join(root,'project'),privateDir=join(root,'private');
 const args=sandboxArgs(config,worktree,'edit',[]);args.pop();
 const masked=args.indexOf('/workspace/.git');args[masked-1]=(await lstat(join(worktree,'.git'))).isDirectory()?join(seed,'.git'):join(root,'git-pointer');
 args.push('--ro-bind',join(seed,'.git'),'/snapshot-git');
 args.push('--ro-bind',config.taktRuntime,'/opt/takt-runtime','--ro-bind',fileURLToPath(new URL('./takt-codex-wrapper.mjs',import.meta.url)),'/opt/private-agent/codex-wrapper.mjs',
  '--bind',privateDir,'/run-private','--bind',configDir,'/takt-config','--bind',projectDir,'/workspace/.takt');
 args.push('--ro-bind',join(privateDir,'provider-policy.json'),'/run-private/provider-policy.json');
 for(const name of ['config.yaml','runtime.yaml'])args.push('--ro-bind',join(configDir,name),'/takt-config/'+name,'--ro-bind',join(projectDir,name),'/workspace/.takt/'+name);
 return [...args,'--setenv','TAKT_CONFIG_DIR','/takt-config','--setenv','TAKT_CODEX_CLI_PATH','/opt/private-agent/codex-wrapper.mjs','--setenv','GIT_OPTIONAL_LOCKS','0','--setenv','NO_UPDATE_NOTIFIER','1','--',...command];
}
