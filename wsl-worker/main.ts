import {pathToFileURL} from 'node:url';
import {invoke} from './providers.ts';
import {LIMITS,provider,str,integer,type Run} from '../shared/contracts.ts';
export type Runner=(p:Run['provider'],prompt:string,signal:AbortSignal)=>Promise<string>;
export function client(base:string,token:string){
 const url=new URL(base);if(url.protocol!=='https:'&&!(url.protocol==='http:'&&['127.0.0.1','localhost'].includes(url.hostname)))throw new Error('https_or_localhost_required');
 if(url.username||url.password||url.search||url.hash||url.pathname!=='/')throw new Error('invalid_control_url');
 return async(path:string,body:unknown)=>{
  const r=await fetch(new URL(path,url),{method:'POST',redirect:'error',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(4000)});
  if(!r.ok)throw new Error('control_'+r.status);return r.json();
 };
}
export async function once(api:ReturnType<typeof client>,runner:Runner=invoke,profile?:Run['provider']):Promise<boolean>{
 const run=await api('/api/claim',profile?{provider:profile}:{}) as Run|null;if(!run)return false;
 provider(run.provider);str(run.prompt,LIMITS.promptBytes);
 const abort=new AbortController();let heartbeating=false;
 const timer=setInterval(async()=>{if(heartbeating)return;heartbeating=true;try{await api('/api/runs/'+run.id+'/heartbeat',{token:run.token});}catch{abort.abort();}finally{heartbeating=false;}},LIMITS.heartbeatMs);
 let timedOut=false;const hardTimeout=setTimeout(()=>{timedOut=true;abort.abort();},LIMITS.timeoutMs);
 let result:string|null=null,error:string|null=null;
 try{result=str(await runner(run.provider,run.prompt,abort.signal),LIMITS.outputBytes);}catch(e){
  const code=timedOut?'timeout':(e as Error).message;error=['provider_failed','timeout','output_limit','cancelled','cli_unavailable','invalid_provider_output','incomplete_provider_output','unexpected_tool_use','pi_devin_extension_required','invalid_text'].includes(code)?code:'provider_failed';
 }finally{clearInterval(timer);clearTimeout(hardTimeout);}
 // Same token + same payload is idempotent; network loss never reruns the provider here.
 for(let n=0;n<2;n++){try{await api('/api/runs/'+run.id+'/complete',{token:run.token,result,error});break;}catch(e){if(n===1)throw e;}}
 return true;
}
async function main(){
 const api=client(process.env.CONTROL_URL||'http://127.0.0.1:8787/',str(process.env.WORKER_TOKEN,128));
 const stop=new AbortController();process.once('SIGINT',()=>stop.abort());process.once('SIGTERM',()=>stop.abort());
 // Serial polling, never a parallel/unbounded agent reasoning loop.
 const runner:Runner=(p,prompt,signal)=>invoke(p,prompt,AbortSignal.any([signal,stop.signal]));
 const profile=process.env.WORKER_PROVIDER?provider(process.env.WORKER_PROVIDER):undefined;
 const pollMs=integer(Number(process.env.POLL_INTERVAL_MS||30000),1000,600000);
 do{try{await once(api,runner,profile);}catch(e){console.error((e as Error).message);}if(process.argv.includes('--once')||stop.signal.aborted)break;
 await new Promise<void>(resolve=>{const done=()=>{clearTimeout(timer);stop.signal.removeEventListener('abort',done);resolve();};const timer=setTimeout(done,pollMs);stop.signal.addEventListener('abort',done,{once:true});});
 }while(!stop.signal.aborted);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await main();
