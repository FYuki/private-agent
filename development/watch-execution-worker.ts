// 独立した実行所有者。監視MCP/HTTP接続の寿命を引き継がず、明示取消と明示試験予算のみを適用する。
import {readFile,writeFile,rename,access} from 'node:fs/promises';
import {join} from 'node:path';
import {runWatchExecution} from './watch-adapter.ts';
import type {WatchExecutionRequest} from './watch-execution.ts';
import {watchProcessIdentity} from './watch-supervisor.ts';

const directory=process.argv[2];
const request:WatchExecutionRequest=JSON.parse(await readFile(join(directory,'request.json'),'utf8'));
await writeFile(join(directory,'process.json'),JSON.stringify({pid:process.pid,identity:watchProcessIdentity(process.pid)}),{flag:'wx',mode:0o600});
const stop=new AbortController();
const poll=setInterval(()=>{void access(join(directory,'cancel.json')).then(()=>stop.abort()).catch(()=>{});},100);
process.once('SIGTERM',()=>stop.abort());process.once('SIGINT',()=>stop.abort());
let result;
try{
 const wall=request.config.watchLimits?.wallMs;
 const deadline=wall===undefined?undefined:process.hrtime.bigint()+BigInt(wall)*1000000n;
 result={ok:true,value:await runWatchExecution(request.config,request.worktree,request.baseSha,request.owner,request.order,stop.signal,deadline)};
}catch(e){result={ok:false,error:(e as Error).message};}
finally{clearInterval(poll);}
await writeFile(join(directory,'result.tmp'),JSON.stringify(result),{flag:'wx',mode:0o600});
await rename(join(directory,'result.tmp'),join(directory,'result.json'));
