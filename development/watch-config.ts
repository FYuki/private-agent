import {mkdir,writeFile,readFile,lstat,realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {verifyWatchRuntime} from './takt-watch-client.ts';
import type {WatchProcess} from './watch-supervisor.ts';

/** 原本設定を変更せず、管理専用の有効設定を新規作成する。 */
export async function prepareWatchConfig(dir:string){
 await mkdir(dir,{mode:0o700});
 await writeFile(join(dir,'config.yaml'),'language: en\nbranch_name_strategy: romaji\nauto_pr: false\nconcurrency: 1\nauto_requeue_max_attempts: 0\ntask_poll_interval_ms: 100\n',{mode:0o600,flag:'wx'});
}
export async function verifyWatchConfig(runtime:string,root:string,dir:string){
 await verifyWatchRuntime(runtime,root,dir);
 const yaml=await import(pathToFileURL(join(runtime,'node_modules/yaml/dist/index.js')).href);
 const config=yaml.parse(await readFile(join(dir,'config.yaml'),'utf8'));
 if(config.branch_name_strategy!=='romaji'||config.auto_pr!==false||config.concurrency!==1||config.auto_requeue_max_attempts!==0)throw Error('unsafe_watch_config');
 for(const name of ['.takt','.takt/tasks','.takt/runs']){const p=join(root,name);try{if(!(await lstat(p)).isDirectory()||await realpath(p)!==p)throw Error('untrusted_watch_directory');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}}
 for(const name of ['config.yaml','runtime.yaml']){try{await lstat(join(root,'.takt',name));throw Error('project_watch_override_denied');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}}
}
/** 初期契約試験専用。認証情報・providerをmountせず、空queueの公式watchだけを起動する。 */
export async function contractWatchProcess(runtime:string,root:string,dir:string):Promise<WatchProcess>{
 await verifyWatchConfig(runtime,root,dir);
 return {file:'/usr/bin/bwrap',cwd:root,env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8'},args:[
  '--unshare-user','--unshare-pid','--unshare-net','--die-with-parent','--new-session',
  '--ro-bind','/usr','/usr','--ro-bind','/lib','/lib','--ro-bind','/lib64','/lib64',
  '--proc','/proc','--dev','/dev','--tmpfs','/tmp','--bind',root,'/workspace','--ro-bind',runtime,'/opt/takt-runtime','--bind',dir,'/takt-config',
  '--setenv','HOME','/takt-config','--setenv','TAKT_CONFIG_DIR','/takt-config','--setenv','TAKT_NO_TTY','1','--setenv','NO_UPDATE_NOTIFIER','1','--chdir','/workspace',
  '--','/usr/bin/node','/opt/takt-runtime/node_modules/takt/dist/app/cli/index.js','watch']};
}
