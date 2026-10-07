import {openSync,closeSync,unlinkSync,appendFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {guardedRun} from './takt-codex-wrapper.mjs';

/** CLI起動予算のみを原子的に予約する。公式parallel reviewは直列化しない。 */
export async function parallelRun({directory,maxCalls=null,callMs=null,...options}) {
 if(maxCalls!==null&&(!Number.isSafeInteger(maxCalls)||maxCalls<1))throw Error('invalid_provider_call_limit');
 if(callMs!==null&&(!Number.isSafeInteger(callMs)||callMs<1||callMs>2147483647))throw Error('invalid_provider_call_timeout');
 const lock=join(directory,'admission.lock'),activity=join(directory,'activity.ndjson'),until=Date.now()+2000;
 for(;;){try{closeSync(openSync(lock,'wx',0o600));break;}catch(e){if(e.code!=='EEXIST'||Date.now()>=until)throw Error('provider_admission_unconfirmed');await new Promise(r=>setTimeout(r,10));}}
 const id=randomUUID();
 const mark=event=>appendFileSync(activity,JSON.stringify({id,event,at:Date.now(),profile:options.profile})+'\n',{mode:0o600});
 try{
  let events=[];try{events=readFileSync(activity,'utf8').trim().split('\n').filter(Boolean).map(x=>JSON.parse(x));}catch(e){if(e.code!=='ENOENT')throw e;}
  if(maxCalls!==null&&events.filter(e=>e.event==='started').length>=maxCalls)throw Error('provider_call_limit');
  mark('started'); // 失敗しても予算を返さない。spawn前の不確定終了も未精算として残す。
 }finally{unlinkSync(lock);}
 const local=join(directory,id+'.ndjson');
 try{
  await guardedRun({...options,lock:join(directory,id+'.lock'),activity:local,maxCalls:1,callMs,idleMs:null,queueMs:0});
 }finally{
  let closed=false;try{const events=readFileSync(local,'utf8').trim().split('\n').map(x=>JSON.parse(x));closed=events.at(-1)?.event==='closed';}catch{}
  mark(closed?'closed':'stop_unconfirmed');
 }
}

/** 最後の一件だけでなく、予約した全CLIの終了を要求する。 */
export function verifyProviderSettlement(events,maxCalls=null) {
 const active=new Set(),seen=new Set();let count=0;
 for(const e of events){
  if(e.event==='started'){if(seen.has(e.id)||typeof e.id!=='string')throw Error('provider_stop_unconfirmed');seen.add(e.id);active.add(e.id);count++;}
  else if(e.event==='closed'){if(!active.delete(e.id))throw Error('provider_stop_unconfirmed');}
  else throw Error('provider_stop_unconfirmed');
 }
 if(!count||(maxCalls!==null&&count>maxCalls)||active.size)throw Error('provider_stop_unconfirmed');
}
