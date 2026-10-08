type Event=Record<string,any>;
export type ChildReviewExpected={task:string;references:{child:string;fix:string;peer:string;quality:string}};
const names=['private-agent-child-issue','private-agent-review-fix-takt','peer-review','private-agent-review-takt'];
const fail=()=>{throw Error('watch_quality_review_not_approved');};
const need=(v:unknown)=>{if(!v)fail();};
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const frame=(f:Event)=>({workflow:f.workflow,workflow_ref:f.workflow_ref,step:f.step,kind:f.kind,occurrence:f.occurrence});
const scope=(e:Event)=>{
 need(Array.isArray(e.stack)&&e.stack.length>0);
 return e.stack.map((f:Event)=>{need(f&&typeof f.workflow==='string'&&typeof f.workflow_ref==='string'&&typeof f.step==='string'&&typeof f.kind==='string'&&Number.isSafeInteger(f.occurrence)&&f.occurrence>0);return frame(f);});
};
/**
 * 公式0.68.0の実NDJSONで、同じ呼出し内の必須品質レビューと最終gateを照合する。
 * call開始は名前、完了は内容hashを記録し、call自身のstep_completeは記録しない。
 * 古い承認や別callの承認は借用しない。ログの出所と対象HEADはadapterで検証する。
 */
export function acceptedChildReviewResult(meta:unknown,events:unknown[],expected:ChildReviewExpected){
 const m=meta as Event,log=events as Event[];
 need(m&&m.status==='completed'&&m.workflow===names[0]&&m.task===expected.task&&m.startTime&&m.endTime);
 need(log.length>0&&log.every(e=>e&&typeof e==='object'));
 need(log[0].type==='workflow_start'&&log[0].workflowName===names[0]&&log[0].task===expected.task&&log[0].startTime===m.startTime);
 need(log.at(-1)?.type==='workflow_complete'&&log.filter(e=>e.type==='workflow_start').length===1&&log.filter(e=>e.type==='workflow_complete').length===1&&!log.some(e=>e.type==='workflow_abort'));
 const refs=[expected.references.child,expected.references.fix,expected.references.peer,expected.references.quality];
 need(refs.every(r=>typeof r==='string'&&r.length>0));
 const lastIndex=(predicate:(e:Event)=>boolean)=>log.findLastIndex(predicate);
 const gateIndex=lastIndex(e=>e.type==='step_complete');
 const gate=log[gateIndex];need(gate?.step==='final-gate'&&gate.workflow===names[2]&&gate.status==='done'&&gate.matchedRuleIndex===0);
 const gs=scope(gate);need(gs.length===3);
 for(let i=0;i<3;i++)need(gs[i].workflow===names[i]&&gs[i].workflow_ref===refs[i]);
 need(gs[0].step==='quality-review-fix'&&gs[0].kind==='workflow_call'&&gs[1].step==='reviewers'&&gs[1].kind==='workflow_call'&&gs[2].kind==='agent'&&gs[2].step==='final-gate');
 const call=(s:Event[],childName:string,childRef:string)=>{
  const matches=log.map((e,i)=>({e,i})).filter(({e})=>['workflow_call_start','workflow_call_complete'].includes(e.type)&&same(scope(e),s));
  need(matches.length===2);const [start,end]=matches;
  need(start.e.type==='workflow_call_start'&&end.e.type==='workflow_call_complete'&&start.e.childWorkflow===childName&&end.e.childWorkflow===childRef&&end.e.status==='completed'&&!('returnValue' in end.e));
  for(const {e} of matches)need(e.workflow===s.at(-1)!.workflow_ref&&e.step===s.at(-1)!.step&&e.callInstance===s.at(-1)!.occurrence);
  return {start:start.i,end:end.i};
 };
 const outer=call(gs.slice(0,1),names[1],refs[1]),peer=call(gs.slice(0,2),names[2],refs[2]);
 need(outer.start<peer.start&&peer.start<gateIndex&&gateIndex<peer.end&&peer.end<outer.end);
 need(!log.slice(gateIndex+1,-1).some(e=>['step_start','phase_start','workflow_call_start'].includes(e.type)));
 const qualityIndex=lastIndex(e=>e.type==='phase_complete'&&e.phase===3&&e.step==='quality-review');
 const quality=log[qualityIndex];need(quality?.status==='done'&&quality.content==='approved'&&quality.workflow===names[3]);
 const qs=scope(quality);need(qs.length===4&&same(qs.slice(0,2),gs.slice(0,2)));
 need(qs[2].workflow===names[2]&&qs[2].workflow_ref===refs[2]&&qs[2].kind==='workflow_call'&&['initial-reviewers','reviewers'].includes(qs[2].step));
 need(qs[3].workflow===names[3]&&qs[3].workflow_ref===refs[3]&&qs[3].step==='review'&&qs[3].kind==='parallel');
 const suite=call(qs.slice(0,3),names[3],refs[3]);
 need(peer.start<suite.start&&suite.start<qualityIndex&&qualityIndex<suite.end&&suite.end<gateIndex);
 const suiteDone=log.slice(qualityIndex+1,suite.end).filter(e=>e.type==='step_complete');
 need(suiteDone.length===1&&suiteDone[0].status==='done'&&suiteDone[0].matchedRuleIndex===1&&same(scope(suiteDone[0]),qs));
 // 再修正後の古い品質承認を採用しない。裁定と最終gate以外は再レビューが必要。
 need(!log.slice(suite.end+1,gateIndex).some(e=>e.type==='workflow_call_start'||e.type==='step_start'&&!['review-adjudication','final-gate'].includes(e.step)));
 const supervise=log.slice(0,outer.start).findLast(e=>e.type==='step_complete');
 need(supervise?.step==='supervise'&&supervise.workflow===names[0]&&supervise.status==='done'&&supervise.matchedRuleIndex===1);
 const ss=scope(supervise!);need(ss.length===1&&ss[0].workflow_ref===refs[0]);
 return {status:'approved' as const,runSlug:m.runSlug,iterations:m.iterations};
}
