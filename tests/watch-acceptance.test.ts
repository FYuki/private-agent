import test from 'node:test';
import assert from 'node:assert/strict';
import {acceptedDefaultResult} from '../development/watch-acceptance.ts';

const expected={task:'synthetic bounded task',workflow:'default' as const,references:{default:'builtin:default',core:'builtin:development-core',peer:'builtin:peer-review'}};
function fixture(){
  const meta={task:expected.task,workflow:'default',status:'completed',startTime:'synthetic-start',endTime:'synthetic-end',runSlug:'fixture',iterations:30};
  const root={workflow:'default',workflow_ref:expected.references.default,step:'develop',kind:'workflow_call',occurrence:1};
  const core={workflow:'development-core',workflow_ref:expected.references.core,step:'peer-review',kind:'workflow_call',occurrence:2};
  const gate={workflow:'peer-review',workflow_ref:expected.references.peer,step:'final-gate',kind:'agent',occurrence:3};
  const step=(type:string,stack:any[],iteration:number)=>({type,workflow:stack.at(-1).workflow,step:stack.at(-1).step,stack:structuredClone(stack),iteration,...(type==='step_complete'?{status:'done',matchedRuleIndex:0}:{})});
  const call=(type:string,stack:any[],childWorkflow:string)=>({type,workflow:stack.at(-1).workflow_ref,step:stack.at(-1).step,childWorkflow,callInstance:stack.at(-1).occurrence,stack:structuredClone(stack),...(type==='workflow_call_complete'?{status:'completed'}:{})});
  const events:any[]=[
    {type:'workflow_start',task:expected.task,workflowName:'default',startTime:meta.startTime},
    call('workflow_call_start',[root],expected.references.core),
    step('step_start',[root],1),
    call('workflow_call_start',[root,core],expected.references.peer),
    step('step_start',[root,core],12),
    step('step_start',[root,core,gate],30),
    step('step_complete',[root,core,gate],30),
    call('workflow_call_complete',[root,core],expected.references.peer),
    step('step_complete',[root,core],12),
    call('workflow_call_complete',[root],expected.references.core),
    step('step_complete',[root],1),
    {type:'workflow_complete',iterations:30,endTime:meta.endTime},
  ];
  return {meta,events};
}
const reject=(mutate:(events:any[],meta:any)=>void)=>{
  const {meta,events}=fixture();mutate(events,meta);
  assert.throws(()=>acceptedDefaultResult(meta,events,expected),/takt_default_not_approved/);
};
test('default accepts exact nested APPROVE propagation with decreasing parent iterations',()=>{
  const {meta,events}=fixture(),before=JSON.stringify({meta,events});
  assert.deepEqual(acceptedDefaultResult(meta,events,expected),{status:'approved',runSlug:'fixture',iterations:30});
  assert.equal(JSON.stringify({meta,events}),before);
  events.splice(7,0,{type:'phase_complete',phase:3});
  assert.equal(acceptedDefaultResult(meta,events,expected).status,'approved');
});
test('default rejects task/meta mismatch, abort and ambiguous workflow terminals',()=>{
  for(const mutate of [
    (_e:any[],m:any)=>m.task='foreign',(_e:any[],m:any)=>m.status='aborted',
    (e:any[])=>e[0].startTime='other', (e:any[])=>e[0].workflowName='simple',
    (e:any[])=>e.splice(-1,0,{type:'workflow_abort'}),
    (e:any[])=>e.splice(-1,0,{type:'workflow_complete'}),
    (e:any[])=>e.pop(),
  ])reject(mutate);
});
test('question-only development-core COMPLETE is not implementation approval',()=>{
  reject(e=>{
    const scope=[e[2].stack[0],{workflow:'development-core',workflow_ref:expected.references.core,step:'plan',kind:'agent',occurrence:1}];
    e.splice(3,6,{type:'step_complete',workflow:'development-core',step:'plan',stack:scope,status:'done',matchedRuleIndex:1});
  });
});
test('rejects REJECT/BLOCKED/text-only APPROVE and incorrect parent rules',()=>{
  for(const index of [6,8,10])for(const value of [1,2,'0',undefined])reject(e=>e[index].matchedRuleIndex=value);
  reject(e=>{delete e[6].matchedRuleIndex;e[6].content='APPROVE';});
  for(const index of [6,8,10])reject(e=>e[index].status='error');
});
test('rejects foreign stack/ref/kind and mismatched lifecycle invocation',()=>{
  reject(e=>e[6].stack[0].occurrence=2);
  reject(e=>e[6].stack[1].workflow_ref='foreign');
  reject(e=>e[6].stack[2].kind='workflow_call');
  reject(e=>e[6].stack.push({...e[6].stack[2]}));
  reject(e=>e[7].callInstance=99);
  reject(e=>e[9].childWorkflow='other');
  reject(e=>delete e[6].stack);
});
test('rejects missing, reordered, duplicate and returned parent completion',()=>{
  for(const index of [1,2,3,4,5,7,8,9,10])reject(e=>e.splice(index,1));
  reject(e=>[e[6],e[7]]=[e[7],e[6]]);
  reject(e=>[e[7],e[8]]=[e[8],e[7]]);
  reject(e=>e.splice(7,0,structuredClone(e[7])));
  for(const index of [7,9])for(const value of ['need_replan','COMPLETE',null])reject(e=>e[index].returnValue=value);
  reject(e=>e[7].status='aborted');
});
test('old APPROVE cannot supply evidence for a later invocation',()=>{
  reject(e=>{
    const old=structuredClone(e.slice(3,9));
    for(const event of old){event.stack[1].occurrence=1;if('callInstance' in event)event.callInstance=1;}
    e.splice(3,0,...old);
    e.splice(e.findIndex((x:any)=>x.type==='step_complete'&&x.step==='final-gate'&&x.stack[1].occurrence===2),1);
  });
  reject(e=>{
    const old=structuredClone(e[6]);old.stack[0].occurrence=99;e.splice(6,0,old);e[7].matchedRuleIndex=1;
  });
});
test('new unfinished work after the approved chain is rejected',()=>{
  reject(e=>e.splice(-1,0,{...structuredClone(e[5]),stack:[{...e[5].stack[0],occurrence:2}]}));
  reject(e=>{const next=structuredClone(e[5]);next.stack[2].occurrence++;e.splice(7,0,next);});
  reject(e=>{const next=structuredClone(e[4]);next.stack[1].occurrence++;e.splice(9,0,next);});
  reject(e=>e.splice(7,0,{...structuredClone(e[6]),step:'remediation',stack:[...e[6].stack.slice(0,2),{...e[6].stack[2],step:'remediation'}]}));
});
