import {mkdir,readFile,writeFile,realpath,rename} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {fingerprint} from './operations.ts';
import {watchOrder,orderMarker,type WatchOrder} from './watch-contract.ts';
import type {TaktConfig} from './takt-adapter.ts';
import type {runWatchExecution} from './watch-adapter.ts';
import {watchProcessIdentity} from './watch-supervisor.ts';
import {TaktWatchClient} from './takt-watch-client.ts';

export type WatchExecutionRequest={config:TaktConfig;worktree:string;baseSha:string;owner:string;order:WatchOrder};
type Result=Awaited<ReturnType<typeof runWatchExecution>>;
export const executionDirectory=(config:TaktConfig,id:string)=>{
 if(!/^[a-f0-9-]{36}$/.test(id))throw Error('invalid_task_id');
 return join(config.taktRuns,id+'.execution');
};

/** 観測の期限/切断は実行への取消命令ではない。再接続は同じ永続結果を読む。 */
export async function observeWatchExecution(directory:string,signal:AbortSignal,deadline:bigint):Promise<Result>{
 for(;;){
  if(signal.aborted||process.hrtime.bigint()>=deadline)throw Error('watch_observation_detached');
  let result;
  try{result=JSON.parse(await readFile(join(directory,'result.json'),'utf8'));}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  if(result){if(!result.ok)throw Error(result.error);return result.value;}
  try{const process=JSON.parse(await readFile(join(directory,'process.json'),'utf8'));if(watchProcessIdentity(process.pid)!==process.identity){
   // resultのatomic rename直後にworkerが終了した場合も終端結果を優先する。
   let terminal;try{terminal=JSON.parse(await readFile(join(directory,'result.json'),'utf8'));}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
   if(terminal){if(!terminal.ok)throw Error(terminal.error);return terminal.value;}
   throw Error('watch_execution_unconfirmed');
  }}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  await new Promise(r=>setTimeout(r,50));
 }
}

/** 同じtaskの予約を再利用するが起動は再送しない。親observerと別sessionの実行所有者を立てる。 */
export async function executeWatch(config:TaktConfig,worktree:string,baseSha:string,owner:string,value:WatchOrder,signal:AbortSignal,deadline:bigint){
 const order=watchOrder(value),request:WatchExecutionRequest={config,worktree,baseSha,owner,order};
 for(const limit of [config.watchLimits?.callMs,config.watchLimits?.wallMs])if(limit!==undefined&&(!Number.isSafeInteger(limit)||limit<1||limit>2147483647))throw Error('invalid_watch_test_timeout');
 if(config.maxProviderCalls!==undefined&&(!Number.isSafeInteger(config.maxProviderCalls)||config.maxProviderCalls<1))throw Error('invalid_provider_call_limit');
 for(const path of [config.taktRuns,worktree])if(resolve(path)!==path||await realpath(path)!==path)throw Error('untrusted_watch_path');
 if(signal.aborted||process.hrtime.bigint()>=deadline)throw Error('watch_observation_detached');
 const directory=executionDirectory(config,order.id);let fresh=false;
 try{await mkdir(directory,{mode:0o700});fresh=true;}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}
 if(fresh){
  await writeFile(join(directory,'request.json'),JSON.stringify(request),{flag:'wx',mode:0o600});
  const here=dirname(fileURLToPath(import.meta.url));
  const child=spawn(process.execPath,['--import','tsx',join(here,'watch-execution-worker.ts'),directory],{cwd:resolve(here,'..'),detached:true,stdio:'ignore',env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8',PK_MEMORY_HOOKS:'0'}});
  await new Promise<void>((ok,no)=>{child.once('spawn',ok);child.once('error',()=>no(Error('watch_execution_start_unconfirmed')));});child.unref();
 }else{
  let saved;try{saved=JSON.parse(await readFile(join(directory,'request.json'),'utf8'));}catch{throw Error('watch_execution_start_unconfirmed');}
  if(fingerprint(saved)!==fingerprint(request))throw Error('watch_execution_identity_conflict');
 }
 return observeWatchExecution(directory,signal,deadline);
}

/** 明示取消のみが実行所有者へ伝わる。通信失敗のcatchから呼ばない。 */
export async function cancelWatchExecution(config:TaktConfig,id:string,owner:string){
 const directory=executionDirectory(config,id),request:WatchExecutionRequest=JSON.parse(await readFile(join(directory,'request.json'),'utf8'));
 if(request.owner!==owner||request.order.id!==id)throw Error('watch_execution_identity_conflict');
 try{await writeFile(join(directory,'cancel.json'),JSON.stringify({owner,id}),{flag:'wx',mode:0o600});}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}
}

/** D1枠の解放前に独立実行所有者の終端を確認する。observer例外だけでは停止証明にならない。 */
export async function watchExecutionSettled(config:TaktConfig,id:string,owner:string){
 try{
  const directory=executionDirectory(config,id),request:WatchExecutionRequest=JSON.parse(await readFile(join(directory,'request.json'),'utf8'));
  if(request.owner!==owner||request.order.id!==id)return false;
  const result=JSON.parse(await readFile(join(directory,'result.json'),'utf8'));
  return result.ok===true||result.ok===false&&typeof result.error==='string'&&!['watch_stop_unconfirmed','provider_stop_unconfirmed'].includes(result.error);
 }catch{return false;}
}

/** 同じ実行へMCPで追加指示する。応答喪失したwriteは再送しない。 */
export async function tellWatchExecution(config:TaktConfig,id:string,owner:string,key:string,content:string){
 if(typeof key!=='string'||!/^[a-zA-Z0-9_-]{1,64}$/.test(key)||typeof content!=='string'||!content.trim()||Buffer.byteLength(content)>8192)throw Error('invalid_run_instruction');
 const directory=executionDirectory(config,id),request:WatchExecutionRequest=JSON.parse(await readFile(join(directory,'request.json'),'utf8'));
 if(request.owner!==owner||request.order.id!==id)throw Error('watch_execution_identity_conflict');
 const instructions=join(directory,'instructions');await mkdir(instructions,{recursive:true,mode:0o700});
 const file=join(instructions,key+'.json'),hash=fingerprint(content);
 try{const old=JSON.parse(await readFile(file,'utf8'));if(old.hash!==hash)throw Error('instruction_idempotency_conflict');if(!old.delivered)throw Error('instruction_delivery_unconfirmed');return old.receipt;}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
 const owned=join(config.taktRuns,id),client=await TaktWatchClient.connect(request.config.taktRuntime,join(owned,'repo'),join(owned,'config'));
 try{
  const tasks=await client.list();
  const policy=JSON.parse(await readFile(join(owned,'private/provider-policy.json'),'utf8'));
  if(policy.root!==join(owned,'repo')||tasks.length!==1||tasks[0].name!==policy.taskName||tasks[0].summary!==orderMarker(request.order)||tasks[0].workflow!==request.order.workflow||tasks[0].status!=='running'||!tasks[0].runSlug)throw Error('instruction_run_not_ready');
  await writeFile(file,JSON.stringify({hash,runSlug:tasks[0].runSlug,delivered:false}),{flag:'wx',mode:0o600});
  const receipt=await client.tell(tasks[0].runSlug,content);
  await writeFile(file+'.tmp',JSON.stringify({hash,runSlug:tasks[0].runSlug,delivered:true,receipt}),{flag:'wx',mode:0o600});
  await rename(file+'.tmp',file);
  return receipt;
 }finally{await client.close();}
}
