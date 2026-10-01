import test from 'node:test';
import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {once,executionDeadline} from '../wsl-worker/main.ts';
import {runProcess} from '../wsl-worker/providers.ts';
import {script} from '../control-plane/ui.ts';

const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
test('claim round-trip and preparation consume budget; wall-clock offsets do not matter',async()=>{
 const anchor=process.hrtime.bigint();
 assert.equal(executionDeadline(anchor,{issued_at:1000000,deadline:1060000}),anchor+60000000000n);
 assert.equal(executionDeadline(anchor,{issued_at:9000000000000,deadline:9000000060000}),anchor+60000000000n);
 assert.throws(()=>executionDeadline(anchor,{issued_at:0,deadline:60001}));
 let calls=0;
 const api=async(path:string)=>{if(path==='/api/claim'){await sleep(60);return {id:'id',provider:'codex-luna',prompt:'test',token:'t',issued_at:1,deadline:301};}return {};};
 await once(api,async(_p,_text,_signal,deadline)=>{calls++;assert(Number(deadline-process.hrtime.bigint())/1e6<250,'response delay subtracted');return 'ok';});
 assert.equal(calls,1);
});
test('expired delayed claim is reported without launching provider',async()=>{
 let calls=0,outcome:any;
 const api=async(path:string,body:any)=>{if(path==='/api/claim'){await sleep(30);return {id:'id',provider:'codex-luna',prompt:'test',token:'t',issued_at:1,deadline:11};}outcome=body;return {};};
 await once(api,async()=>{calls++;return 'must not launch';});
 assert.equal(calls,0);assert.equal(outcome.error,'timeout');
 await assert.rejects(runProcess(process.execPath,['-e','throw Error("must not launch")'],'',tmpdir(),new AbortController().signal,60000,process.hrtime.bigint()-1n),/timeout/);
});
test('independent deadline guard kills synthetic CLI after poller SIGKILL',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'private-agent-kill-test-')),marker=join(dir,'child.pid');
 const parent=spawn(process.execPath,['--import','tsx',resolve('tests/fixtures/killed-poller.ts'),marker],{stdio:'ignore'});
 let childPid:number|undefined;
 try{
  for(let i=0;i<150;i++){try{childPid=Number(await readFile(marker,'utf8'));break;}catch{await sleep(10);}}
  assert(childPid,'synthetic CLI launched');parent.kill('SIGKILL');
  const deadline=performance.now()+2500;let running=true;
  while(performance.now()<deadline){
    try{const status=await readFile('/proc/'+childPid+'/stat','utf8');running=!/\) Z /.test(status);}catch{running=false;}
    if(!running)break;await sleep(20);
  }
  assert.equal(running,false,'CLI must stop without its poller, using the original absolute deadline');
 }finally{parent.kill('SIGKILL');if(childPid){try{process.kill(childPid,'SIGKILL');}catch{}}await rm(dir,{recursive:true,force:true});}
});

class Element {
 textContent='';value='';hidden=false;className='';children:Element[]=[];
 onclick?:()=>unknown;onsubmit?:(e:any)=>unknown;
 append(...children:Element[]){this.children.push(...children);}
 replaceChildren(){this.children=[];this.textContent='';}
 text():string{return this.textContent+this.children.map(c=>c.text()).join('');}
}
function page(){
 const ids=Object.fromEntries(['token','login','logout','refresh','status','content','actions'].map(id=>[id,new Element()]));
 const requests:{signal:AbortSignal;resolve:(v:any)=>void;reject:(e:Error)=>void}[]=[];
 runInNewContext(script,{document:{getElementById:(id:string)=>ids[id],createElement:()=>new Element()},AbortController,Date,
  fetch:(_path:string,options:any)=>new Promise((resolve,reject)=>requests.push({signal:options.signal,resolve,reject}))});
 const login=(token:string)=>{ids.token.value=token;return ids.login.onsubmit!({preventDefault(){}}) as Promise<void>;};
 const resolveState=(n:number,text:string)=>requests[n].resolve({ok:true,json:async()=>({jobs:[],runs:[{id:'r',state:'succeeded',attempt:1,due_at:0,result:text}]})});
 return {ids,requests,login,resolveState};
}
test('logout aborts request and ignores late private state even if fetch disregards abort',async()=>{
 const p=page(),pending=p.login('owner-A');p.ids.logout.onclick!();assert(p.requests[0].signal.aborted);
 p.resolveState(0,'PRIVATE_A');await pending;
 assert.equal(p.ids.content.text(),'');assert.equal(p.ids.status.textContent,'ログアウトしました。');
});
test('logout while response body is still parsing cannot restore private results',async()=>{
 const p=page(),pending=p.login('owner-A');let finishBody!:(value:unknown)=>void;
 p.requests[0].resolve({ok:true,json:()=>new Promise(resolve=>{finishBody=resolve;})});
 await sleep(0);p.ids.logout.onclick!();finishBody({jobs:[],runs:[{result:'PRIVATE_BODY'}]});await pending;
 assert.equal(p.ids.content.text(),'');assert.equal(p.ids.status.textContent,'ログアウトしました。');
});
test('token switch clears old DOM and late old success/error cannot replace new owner',async()=>{
 const p=page(),initial=p.login('A');p.resolveState(0,'PRIVATE_A');await initial;assert(p.ids.content.text().includes('PRIVATE_A'));
 const old=p.ids.refresh.onclick!() as Promise<void>;
 const next=p.login('B');assert.equal(p.ids.content.text(),'');assert(p.requests[1].signal.aborted);
 p.resolveState(2,'PRIVATE_B');await next;p.resolveState(1,'STALE_A');await old;
 assert(p.ids.content.text().includes('PRIVATE_B'));assert(!p.ids.content.text().includes('STALE_A'));
 const oldError=p.ids.refresh.onclick!() as Promise<void>;p.ids.logout.onclick!();p.requests[3].reject(new Error('OLD_ERROR'));await oldError;
 assert.equal(p.ids.status.textContent,'ログアウトしました。');assert.equal(p.ids.content.text(),'');
});
