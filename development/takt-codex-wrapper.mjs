#!/usr/bin/node
import { openSync, closeSync, unlinkSync, appendFileSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

// 各providerのPID namespaceを閉じるまで次の呼出へ進まない。setsidした子孫も同じnamespaceに残る。
export const providerSandboxArgs=command=>['--die-with-parent','--unshare-user','--unshare-pid','--new-session','--bind','/','/','--proc','/proc','--dev','/dev','--',...command];

// TAKT SDKのcleanupはkill後のcloseを待たないため、この境界で重複起動を拒否する。
// 異常終了で残ったlockは自動解除しない。新しいrunには新しいprivate directoryを使う。
export function codexArgs(argv) {
 if (argv[0] !== 'exec') throw Error('exec_required');
 const args = ['exec','--ignore-user-config','--ignore-rules','--skip-git-repo-check'];
 let model, effort, role='plan', resume;
 const configs = [];
 for (let i=1;i<argv.length;i++) {
  const key=argv[i];
  if (key==='--experimental-json'||key==='--json'||key==='--skip-git-repo-check') continue;
  if (key==='--model') { model=argv[++i]; continue; }
  if (key==='--sandbox') { const v=argv[++i];if(!['read-only','workspace-write'].includes(v))throw Error('sandbox_denied');role=v==='read-only'?'plan':'edit';continue; }
  if (key==='--cd') {if(argv[++i]!=='/workspace')throw Error('cwd_denied');continue;}
  if (key==='--output-schema') {const path=argv[++i];if(!/^\/tmp\/[a-zA-Z0-9_./-]+$/.test(path)||path.split('/').includes('..'))throw Error('schema_denied');args.push(key,path);continue;}
  if (key==='resume') {resume=argv[++i];if(!/^[a-f0-9-]{36}$/.test(resume))throw Error('resume_denied');continue;}
  if (key==='--config'||key==='-c') {
   const v=argv[++i],name=v?.split('=')[0];
   if (name==='model_reasoning_effort') {effort=v.slice(name.length+1).replaceAll('"','');continue;}
   if (name==='model_reasoning_summary') {if(!/^model_reasoning_summary="(auto|concise|detailed|none)"$/.test(v))throw Error('summary_option_denied');configs.push(v);continue;}
   if (['approval_policy','sandbox_workspace_write.network_access','web_search','shell_environment_policy.inherit','shell_environment_policy.set.PATH','features.skills','features.apps'].includes(name) || /^skills\./.test(name)) continue;
   throw Error('config_override_denied');
  }
  throw Error('cli_argument_denied');
 }
 if(!['gpt-6-sol:medium','gpt-6-sol:xhigh','gpt-6-luna:xhigh'].includes(model+':'+effort))throw Error('profile_denied');
 args.push('--model',model,'--json','--cd','/workspace');
 configs.push(`model_reasoning_effort="${effort}"`,'default_permissions="development"',
  `permissions.development.filesystem={"/"="read","/workspace"="${role==='edit'?'write':'read'}","/tmp"="write","/home/runner/.codex"="deny","/proc"="deny","/run-private"="deny","/workspace/.takt"="read","/takt-config"="deny"}`,
  'permissions.development.network.enabled=false','forced_login_method="chatgpt"','approval_policy="never"','project_doc_max_bytes=0',
  'web_search="disabled"','sandbox_workspace_write.network_access=false','features.apps=false','features.skills=false','features.hooks=false','features.multi_agent=false');
 for(const c of configs)args.push('-c',c);
 if(resume)args.push('resume',resume);
 return {args,model,effort};
}

export async function guardedRun({file,args,lock,activity,env,profile,maxCalls=120,callMs=1200000,idleMs=600000,signal,stdin=process.stdin,stdout=process.stdout,stderr}) {
 if(!Number.isSafeInteger(maxCalls)||maxCalls<1||maxCalls>120)throw Error('invalid_provider_call_limit');
 let fd;
 try {fd=openSync(lock,'wx',0o600);}catch{throw Error('previous_provider_stop_unconfirmed');}
 closeSync(fd);
 let count=0;try{count=readFileSync(activity,'utf8').split('\n').filter(l=>l&&JSON.parse(l).event==='started').length;}catch(e){if(e.code!=='ENOENT')throw e;}
 if(count>=maxCalls)throw Error('provider_call_limit');
 return new Promise((resolve,reject)=>{
  let failed=false,bytes=0,idle;
  const child=spawn(file,args,{env,shell:false,detached:true,stdio:['pipe','pipe','pipe']});
  const mark=event=>appendFileSync(activity,JSON.stringify({event,at:Date.now(),...(profile?{profile}:{})})+'\n',{mode:0o600});
  const kill=sig=>{try{if(child.pid)process.kill(-child.pid,sig);}catch{}};
  let escalation;
  const stop=()=>{if(failed)return;failed=true;kill('SIGINT');escalation=setTimeout(()=>kill('SIGKILL'),2000);};
  const touch=()=>{clearTimeout(idle);idle=setTimeout(stop,idleMs);};
  const hard=setTimeout(stop,callMs);touch();mark('started');
  signal?.addEventListener('abort',stop,{once:true});if(signal?.aborted)stop();
  const sig=()=>stop();process.on('SIGINT',sig);process.on('SIGTERM',sig);
  child.stdin.on('error',()=>{});stdin.pipe(child.stdin);
  for(const stream of [child.stdout,child.stderr])stream.on('data',b=>{bytes+=b.length;touch();if(bytes>4*1024*1024)stop();else if(stream===child.stdout)stdout.write(b);else stderr?.write(b);});
  child.on('error',()=>{failed=true;});
  child.on('close',code=>{
   clearTimeout(hard);clearTimeout(idle);clearTimeout(escalation);stdin.unpipe(child.stdin);
   signal?.removeEventListener('abort',stop);process.removeListener('SIGINT',sig);process.removeListener('SIGTERM',sig);
   // close後も残る子孫を止める。存在する間はlockを残してfail closed。
   kill('SIGKILL');let alive=false;try{if(child.pid){process.kill(-child.pid,0);alive=true;}}catch{}
   if(!alive)unlinkSync(lock);mark(alive?'stop_unconfirmed':'closed');
   if(failed||code!==0||alive)reject(Error(alive?'provider_stop_unconfirmed':'provider_failed'));else resolve();
  });
 });
}

if(process.argv[1]&&import.meta.url===new URL('file://'+process.argv[1]).href){
 try {
  if(process.env.OPENAI_API_KEY||process.env.CODEX_API_KEY)throw Error('api_key_denied');
  const {args,model,effort}=codexArgs(process.argv.slice(2));
  const {maxCalls}=JSON.parse(readFileSync('/run-private/provider-policy.json','utf8'));
  if(!Number.isSafeInteger(maxCalls)||maxCalls<1||maxCalls>120)throw Error('invalid_provider_call_limit');
  await guardedRun({file:'/usr/bin/bwrap',args:providerSandboxArgs(['/usr/bin/node','/opt/codex/bin/codex.js',...args]),lock:'/run-private/codex.lock',activity:'/run-private/activity.ndjson',profile:{model,effort},maxCalls,env:{PATH:'/usr/bin:/bin',HOME:'/home/runner',CODEX_HOME:'/home/runner/.codex',LANG:'C.UTF-8'}});
 }catch(e){process.stderr.write(String(e.message)+'\n');process.exitCode=1;}
}
