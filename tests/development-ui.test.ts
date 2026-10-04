import test from 'node:test';
import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';
import {developmentScript} from '../control-plane/development-ui.ts';
function submissionPage(){
 const elements=new Map<string,any>(),requests:any[]=[];
 const element=()=>({value:'',textContent:'',hidden:false,disabled:false,append(){},replaceChildren(){},removeAttribute(key:string){delete (this as any)[key];}});
 const get=(id:string)=>{if(!elements.has(id))elements.set(id,element());return elements.get(id);};
 runInNewContext(developmentScript,{document:{getElementById:get,createElement:element},AbortController,crypto,
  fetch:(path:string,options:any)=>new Promise((resolve,reject)=>requests.push({path,options,resolve,reject}))});
 const respond=(request:any,value:unknown)=>request.resolve({ok:true,json:async()=>value});
 const login=async(token:string)=>{get('token').value=token;const pending=get('login').onsubmit({preventDefault(){}});respond(requests.shift(),{repoId:'private-agent',baseRef:'epic/development-runner',profiles:{orchestrators:[],executors:[]},defaults:{}});await pending;};
 const submit=()=>get('task').onsubmit({preventDefault(){}}) as Promise<void>;
 return {get,requests,respond,login,submit};
}
test('session replacement restores submit while old finally cannot unlock a new submission',async()=>{
 const p=submissionPage();await p.login('A');const first=p.submit(),old=p.requests.shift();assert.equal(p.get('submit').disabled,true);
 p.get('logout').onclick();assert.equal(p.get('submit').disabled,false);assert.equal(old.options.signal.aborted,true);
 await p.login('B');const second=p.submit(),next=p.requests.shift();assert.equal(p.get('submit').disabled,true);
 old.reject(Error('stale failure'));await first;assert.equal(p.get('submit').disabled,true);assert.notEqual(p.get('status').textContent,'stale failure');
 next.reject(Error('current failure'));await second;assert.equal(p.get('submit').disabled,false);
});
test('new submission ID fences old success, error and refresh without unlocking its successor',async()=>{
 const p=submissionPage();await p.login('A');const first=p.submit(),old=p.requests.shift();p.get('new').onclick();
 assert.equal(p.get('submit').disabled,false);const second=p.submit(),next=p.requests.shift();assert.notEqual(old.options.headers['Idempotency-Key'],next.options.headers['Idempotency-Key']);
 p.respond(old,{id:'a'.repeat(36)});await first;assert.equal(p.get('task-id').value,'');assert.equal(p.get('submit').disabled,true);assert.equal(p.requests.length,0);
 p.get('new').onclick();const status=p.get('status').textContent;next.reject(Error('stale failure'));await second;assert.equal(p.get('status').textContent,status);
 p.get('task-id').value='a'.repeat(36);const refresh=p.get('refresh').onclick(),request=p.requests.shift();p.get('new').onclick();p.respond(request,{state:'succeeded',result:'stale'});await refresh;
 assert.equal(p.get('task-id').value,'');assert.equal(p.get('result').textContent,'');
});
test('development result links allow only this repository and logout fences delayed results',async()=>{
 const elements=new Map<string,any>(),requests:any[]=[];
 const element=()=>({value:'',textContent:'',hidden:false,href:undefined,append(){},replaceChildren(){},removeAttribute(key:string){delete (this as any)[key];}});
 const get=(id:string)=>{if(!elements.has(id))elements.set(id,element());return elements.get(id);};
 runInNewContext(developmentScript,{document:{getElementById:get,createElement:element},AbortController,crypto,
  fetch:(_p:string,o:any)=>new Promise(resolve=>requests.push({resolve,signal:o.signal}))});
 get('token').value='test';const login=get('login').onsubmit({preventDefault(){}});
 requests.shift().resolve({ok:true,json:async()=>({repoId:'private-agent',baseRef:'epic/development-runner',profiles:{orchestrators:[],executors:[]},defaults:{}})});await login;
 get('task-id').value='a'.repeat(36);
 for(const url of ['https://github.com/FYuki/private-agent/pull/123','javascript:alert(1)','https://github.com/FYuki/private-agent/pull/1/evil','https://evil.test/pull/1']){
  const pending=get('refresh').onclick();requests.shift().resolve({ok:true,json:async()=>({state:'succeeded',result:JSON.stringify({prUrl:url})})});await pending;
  assert.equal(get('pr-link').hidden,url!=='https://github.com/FYuki/private-agent/pull/123');
 }
 const pending=get('refresh').onclick(),request=requests.shift();get('logout').onclick();assert.equal(request.signal.aborted,true);
 request.resolve({ok:true,json:async()=>({state:'succeeded',result:JSON.stringify({prUrl:'https://github.com/FYuki/private-agent/pull/123'})})});await pending;
 assert.equal(get('pr-link').hidden,true);assert.equal(get('pr-link').href,undefined);assert.equal(get('result').textContent,'');
});
