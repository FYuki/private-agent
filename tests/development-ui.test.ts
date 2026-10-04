import test from 'node:test';
import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';
import {developmentScript} from '../control-plane/development-ui.ts';
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
