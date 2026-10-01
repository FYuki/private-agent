import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,isAbsolute} from 'node:path';
import {LIMITS,provider,str,type Provider} from '../shared/contracts.ts';

// Provider auth, protocol, streaming and model catalog belong to maintained CLIs.
// These trusted deployment paths can never be supplied by a job or model output.
export type CliConfig={codex:string;pi:string;devinExtension:string};
export const configFromEnv=():CliConfig=>({codex:process.env.CODEX_BIN||'codex',pi:process.env.PI_BIN||'pi',devinExtension:process.env.PI_DEVIN_EXTENSION||''});
export function command(which:Provider,config:CliConfig):{file:string;args:string[]} {
  provider(which);
  if(which==='codex-luna')return {file:config.codex,args:['exec','--ignore-user-config','--ignore-rules','--skip-git-repo-check','--ephemeral','--sandbox','read-only','--model','gpt-6-luna','--json',
    '-c','forced_login_method="chatgpt"','-c','approval_policy="never"','-c','project_doc_max_bytes=0','-c','web_search="disabled"',
    '-c','features.shell_tool=false','-c','features.unified_exec=false','-c','features.apply_patch_freeform=false','-c','features.multi_agent=false','-c','features.apps=false','-c','features.skills=false','-c','features.hooks=false','-c','model_reasoning_effort="low"','-']};
  if(!isAbsolute(config.devinExtension))throw new Error('pi_devin_extension_required');
  return {file:config.pi,args:['--no-extensions','--no-skills','--no-context-files','--no-prompt-templates','--no-themes','--no-tools','--no-session','--no-approve','--offline','-e',config.devinExtension,'--provider','devin','--model','swe-2-medium','--mode','json','--print','--system-prompt','Answer the supplied text only. No tools, files, external actions or delegation. Model output is not approval.']};
}
export function cleanEnv():NodeJS.ProcessEnv {
  // Do not pass API keys, worker bearer token, Github auth, or endpoint overrides.
  const env:NodeJS.ProcessEnv={PI_TELEMETRY:'0',NO_COLOR:'1'};
  for(const k of ['PATH','HOME','USER','LANG','CODEX_HOME','PI_CODING_AGENT_DIR'])if(process.env[k])env[k]=process.env[k];
  return env;
}
export function runProcess(file:string,args:string[],input:string,cwd:string,signal:AbortSignal, timeoutMs:number=LIMITS.timeoutMs):Promise<string>{
  return new Promise((resolve,reject)=>{
    if(signal.aborted){reject(new Error('cancelled'));return;}
    // GNU timeout remains alive if the polling worker is killed; no orphan CLI can run forever.
    const child=spawn(process.platform==='linux'?'/usr/bin/timeout':file,process.platform==='linux'?['--signal=KILL',String(timeoutMs/1000)+'s',file,...args]:args,{cwd,env:cleanEnv(),shell:false,detached:process.platform!=='win32',stdio:['pipe','pipe','pipe']});
    let output='',bytes=0,failure:string|undefined;
    const kill=(why:string)=>{failure??=why;try{if(process.platform!=='win32'&&child.pid)process.kill(-child.pid,'SIGKILL');else child.kill('SIGKILL');}catch{}};
    const abort=()=>kill('cancelled');signal.addEventListener('abort',abort,{once:true});
    const timer=setTimeout(()=>kill('timeout'),timeoutMs);
    const collect=(chunk:Buffer,stdout:boolean)=>{bytes+=chunk.length;if(bytes>LIMITS.processBytes)kill('output_limit');else if(stdout)output+=Buffer.from(chunk).toString('utf8');};
    child.stdout.on('data',(c:Buffer)=>collect(c,true));child.stderr.on('data',(c:Buffer)=>collect(c,false));
    // stderr may contain credentials or private CLI diagnostics; never persist it.
    child.stdin.on('error',()=>{});child.stdin.end(input);
    child.on('error',()=>{failure='cli_unavailable';});
    child.on('close',code=>{clearTimeout(timer);signal.removeEventListener('abort',abort);if(failure||code!==0)reject(new Error(failure||(code===137||code===124?'timeout':'provider_failed')));else resolve(output);});
  });
}
export function resultFromEvents(which:Provider,raw:string):string{
  let result='';let complete=false;
  for(const line of raw.split('\n')){
    if(!line.trim())continue;
    let e:any;try{e=JSON.parse(line);}catch{throw new Error('invalid_provider_output');}
    if(which==='codex-luna'){
      if(e.type==='item.completed'&&e.item?.type==='agent_message')result=e.item.text;
      if(e.type==='turn.completed')complete=true;
      if(e.type==='turn.failed'||e.type==='error')throw new Error('provider_failed');
      if(e.item && ['command_execution','mcp_tool_call','web_search','file_change'].includes(e.item.type))throw new Error('unexpected_tool_use');
    }else{
      if(e.type==='message_end'&&e.message?.role==='assistant'){
        if(e.message.stopReason==='error'||e.message.stopReason==='aborted')throw new Error('provider_failed');
        if(e.message.content?.some((c:any)=>c.type==='toolCall'))throw new Error('unexpected_tool_use');
        result=(e.message.content||[]).filter((c:any)=>c.type==='text').map((c:any)=>c.text).join('\n');
      }
      if(e.type==='agent_end')complete=true;
      if(e.type==='tool_execution_start')throw new Error('unexpected_tool_use');
    }
  }
  if(!complete)throw new Error('incomplete_provider_output');
  return str(result,LIMITS.outputBytes);
}
export async function invoke(which:Provider,prompt:string,signal:AbortSignal,config=configFromEnv()):Promise<string>{
  str(prompt,LIMITS.promptBytes);const cmd=command(which,config);
  const dir=await mkdtemp(join(tmpdir(),'private-agent-'));
  try{return resultFromEvents(which,await runProcess(cmd.file,cmd.args,'Respond concisely using only the supplied text. No tools or external actions.\n'+prompt,dir,signal));}
  finally{await rm(dir,{recursive:true,force:true});}
}
