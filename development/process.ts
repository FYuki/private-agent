import { spawn } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { fileURLToPath } from 'node:url';

/** supervisor専用固定argv。期限guardは親強制終了後も生存し、process群を期限内に停止する。 */
export function processOutput(file:string,args:string[],cwd:string,input:string,signal:AbortSignal,deadlineNs:bigint,env:NodeJS.ProcessEnv,options:{outputBytes?:number;idleMs?:number;interruptFirst?:boolean;log?:(bytes:Buffer)=>void}={}):Promise<string>{
 return new Promise((resolve,reject)=>{
  if(signal.aborted||process.hrtime.bigint()>=deadlineNs){reject(new Error('cancelled_or_deadline'));return;}
  const child=spawn(process.execPath,[fileURLToPath(new URL('../wsl-worker/deadline-guard.mjs',import.meta.url)),String(deadlineNs),file,...args],{cwd,env,shell:false,detached:true,stdio:['pipe','pipe','pipe']});
  let text='',size=0,failed:string|undefined;const decoder=new TextDecoder();
  let escalation:ReturnType<typeof setTimeout>|undefined;
  const kill=(reason:string)=>{if(failed)return;failed=reason;try{if(child.pid){process.kill(-child.pid,options.interruptFirst&&reason!=='deadline'?'SIGINT':'SIGKILL');if(options.interruptFirst)escalation=setTimeout(()=>{try{process.kill(-child.pid!,'SIGKILL');}catch{}},2000);}}catch{}};
  const abort=()=>kill('cancelled');signal.addEventListener('abort',abort,{once:true});
  const timer=setTimeout(()=>kill('deadline'),Math.max(0,Number(deadlineNs-process.hrtime.bigint())/1e6));
  let idle:ReturnType<typeof setTimeout>|undefined;
  const activity=(b:Buffer)=>{clearTimeout(idle);if(options.idleMs)idle=setTimeout(()=>kill('idle_timeout'),options.idleMs);options.log?.(b);};
  if(options.idleMs)idle=setTimeout(()=>kill('idle_timeout'),options.idleMs);
  child.stdout.on('data',(b:Buffer)=>{size+=b.length;if(size>(options.outputBytes??1048576))kill('output_limit');else {activity(b);text+=decoder.decode(b,{stream:true});}});
  child.stderr.on('data',(b:Buffer)=>{size+=b.length;if(size>(options.outputBytes??1048576))kill('output_limit');else activity(b);});
  child.stdin.on('error',()=>{});child.stdin.end(input);child.on('error',()=>{failed='process_unavailable';});
  child.on('close',code=>{clearTimeout(timer);clearTimeout(idle);clearTimeout(escalation);signal.removeEventListener('abort',abort);if(failed||code!==0)reject(new Error(failed??'process_failed'));else resolve(text);});
 });
}
/** raw event/logを保存せず最終短文のみ採用する。編集操作の許可は別の差分検証が担う。 */
export function finalMessage(raw:string):string{
 let complete=false,result='';for(const line of raw.split('\n')){if(!line.trim())continue;const event=JSON.parse(line);if(event.type==='item.completed'&&event.item?.type==='agent_message')result=event.item.text;if(event.type==='turn.completed')complete=true;if(['error','turn.failed'].includes(event.type))throw new Error('model_failed');}
 if(!complete||typeof result!=='string'||!result.trim()||Buffer.byteLength(result)>8192)throw new Error('invalid_model_output');return result;
}
