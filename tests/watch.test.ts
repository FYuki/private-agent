import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {WatchStore} from '../development/watch-store.ts';
import {watchOrder,orderText,orderMarker,type WatchQueue,type TaktTask} from '../development/watch-contract.ts';
import {WatchSupervisor} from '../development/watch-supervisor.ts';
import {WatchManager} from '../development/watch-manager.ts';

const id='00000000-0000-4000-8000-000000000001',second='00000000-0000-4000-8000-000000000002';
const order=(extra={})=>watchOrder({id,repoId:'local-GPT-live',issue:12,requirements:'One bounded browser issue',acceptance:['An acknowledgement is returned'],validation:['Run the fixed browser test contract'],dependencies:[],baseRef:'epic/transport-playback',...extra});
class Queue implements WatchQueue {
 writes=0;lost=false;tasks:TaktTask[]=[];body='';
 async enqueue(input:Parameters<WatchQueue['enqueue']>[0]){assert.equal(input.autoPr,false);assert.equal(input.worktree,true);assert.equal(input.workflow,'default');this.writes++;this.body=input.task;this.tasks.push({name:'task-a',summary:input.task.split('\n')[0],workflow:input.workflow,status:'pending'});if(this.lost)throw Error('lost_ack');return {taskName:'task-a'};}
 async list(){return this.tasks;}
 async run(runSlug:string){return {runSlug,task:this.body,workflow:'default',status:'completed',currentStep:'final-gate',phase:3};}
}
test('watch orders use explicit default, bounded issue AC/Validation and fixed epic',()=>{
 const x=order();assert.equal(x.workflow,'default');assert.ok(orderMarker(x).length<80);assert.equal(orderText(x).split('\n')[0],orderMarker(x));
 for(const extra of [{workflow:'../../custom'},{baseRef:'main'},{issue:0},{acceptance:[]},{dependencies:[id]},{root:'/tmp'}])assert.throws(()=>order(extra));
});
test('durable enqueue reservation reconciles lost ack and never repeats a write',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'watch-ledger-')),file=join(dir,'state.db'),queue=new Queue();let store=new WatchStore(file);store.submit('a',order());queue.lost=true;
 await assert.rejects(store.dispatch('a',id,'local-GPT-live',queue),/lost_ack/);store.close();store=new WatchStore(file);
 assert.equal((await store.dispatch('a',id,'local-GPT-live',queue)).task_name,'task-a');assert.equal(queue.writes,1);
 await store.dispatch('a',id,'local-GPT-live',queue);assert.equal(queue.writes,1);store.close();
});
test('owner, repository, identity and ambiguous remote tasks fail closed',async()=>{
 const store=new WatchStore(':memory:'),queue=new Queue();store.submit('a',order());
 assert.throws(()=>store.submit('b',order()),/conflict/);assert.throws(()=>store.status('b',id),/not_found/);
 await assert.rejects(store.dispatch('a',id,'private-agent',queue),/repository_mismatch/);assert.equal(queue.writes,0);
 await store.dispatch('a',id,'local-GPT-live',queue);queue.tasks.push({...queue.tasks[0],name:'task-b'});
 await assert.rejects(store.reconcile('a',id,'local-GPT-live',queue),/uncertain/);assert.equal(queue.writes,1);store.close();
});
test('concurrent same task writes once; missing uncertain result is never re-enqueued',async()=>{
 const store=new WatchStore(':memory:'),queue=new Queue();store.submit('a',order());
 await Promise.allSettled([store.dispatch('a',id,'local-GPT-live',queue),store.dispatch('a',id,'local-GPT-live',queue)]);assert.equal(queue.writes,1);
 queue.tasks=[];await assert.rejects(store.dispatch('a',id,'local-GPT-live',queue),/uncertain/);assert.equal(queue.writes,1);store.close();
});
test('TAKT completed is collected, not validated; dependencies wait for host proof',async()=>{
 const store=new WatchStore(':memory:'),queue=new Queue();store.submit('a',order());store.submit('a',order({id:second,dependencies:[id]}));
 await assert.rejects(store.dispatch('a',second,'local-GPT-live',queue),/dependency_not_validated/);
 await store.dispatch('a',id,'local-GPT-live',queue);queue.tasks[0].status='completed';queue.tasks[0].runSlug='run-1';
 const collected=await store.reconcile('a',id,'local-GPT-live',queue);assert.equal(collected.state,'collected');assert.equal(collected.result.validation,'pending');assert.equal(collected.result.publication,'not_authorized');
 await assert.rejects(store.dispatch('a',second,'local-GPT-live',queue),/dependency_not_validated/);
 await store.validate('a',id,async()=>({artifactId:'a'.repeat(64),headSha:'b'.repeat(40)}));assert.equal(store.status('a',id).state,'validated');store.close();
});
test('cancellation does not masquerade as stopping an already submitted TAKT run',async()=>{
 const store=new WatchStore(':memory:'),queue=new Queue();store.submit('a',order());store.cancel('a',id);
 await assert.rejects(store.dispatch('a',id,'local-GPT-live',queue),/cancel_requested/);assert.equal(queue.writes,0);
 store.submit('a',order({id:second}));await store.dispatch('a',second,'local-GPT-live',queue);const state=store.cancel('a',second);assert.equal(state.cancel_requested,1);assert.equal(state.state,'enqueued');store.close();
});
test('run replacement and wrong task body cannot be collected',async()=>{
 const store=new WatchStore(':memory:'),queue=new Queue();store.submit('a',order());await store.dispatch('a',id,'local-GPT-live',queue);queue.tasks[0].status='completed';queue.tasks[0].runSlug='run-1';queue.body='foreign task';
 await assert.rejects(store.reconcile('a',id,'local-GPT-live',queue),/identity_conflict/);store.close();
});
test('watch supervisor reserves once and reconciles the actual PID after reopen',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'watch-supervisor-')),db=join(dir,'state.db'),ready=join(dir,'ready');
 const supervisor=new WatchSupervisor(db),other=new WatchSupervisor(db),foreign=new WatchSupervisor(join(dir,'other.db'));
 const code=`require('fs').writeFileSync(${JSON.stringify(ready)},'ready');process.on('SIGINT',()=>process.exit(0));setInterval(()=>{},1000)`;
 const spec={file:process.execPath,args:['-e',code],cwd:dir,env:{PATH:'/usr/bin:/bin'}};
 await supervisor.start('a',spec);
 try{
  for(let i=0;i<100;i++){try{await readFile(ready);break;}catch{await new Promise(r=>setTimeout(r,10));}}
  assert.equal(other.status('a',dir)?.observed,'alive');assert.equal(other.status('b',dir),null);
  await assert.rejects(other.start('a',spec),/already_reserved/);
  await assert.rejects(foreign.start('a',spec),/root_already_reserved/);
  await assert.rejects(supervisor.stop('a',dir,3000),/stop_unconfirmed/);assert.equal(supervisor.status('a',dir)?.observed,'stop_unconfirmed');
 }finally{foreign.close();other.close();supervisor.close();}
});
test('watch manager refuses a foreign owner before connecting or choosing a root',async()=>{
 const store=new WatchStore(':memory:');
 await assert.rejects(WatchManager.connect('foreign','local-GPT-live',[{repoId:'local-GPT-live',root:'/tmp/watch-fixture-root',worktrees:'/tmp/watch-fixture-trees',owners:['allowed'],visibility:'public',publishAuthorized:false}],'/tmp/runtime','/tmp/config',store),/repository_owner_not_allowed/);store.close();
});
test('late collected response cannot overwrite validated evidence',async()=>{
 const store=new WatchStore(':memory:'),queue=new Queue();store.submit('a',order());await store.dispatch('a',id,'local-GPT-live',queue);queue.tasks[0].status='completed';queue.tasks[0].runSlug='run-1';await store.reconcile('a',id,'local-GPT-live',queue);
 let release!:()=>void;const gate=new Promise<void>(r=>release=r);const slow:WatchQueue={enqueue:x=>queue.enqueue(x),list:()=>queue.list(),async run(slug){await gate;return queue.run(slug);}};
 const pending=store.reconcile('a',id,'local-GPT-live',slow);await new Promise(r=>setImmediate(r));
 await store.validate('a',id,async()=>({artifactId:'a'.repeat(64),headSha:'b'.repeat(40)}));release();await pending;
 assert.equal(store.status('a',id).state,'validated');assert.equal(store.status('a',id).result.headSha,'b'.repeat(40));store.close();
});
