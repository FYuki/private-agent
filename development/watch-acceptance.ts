type RecordValue = Record<string, unknown>;
type Frame = {workflow:string;workflow_ref:string;step:string;kind:string;occurrence:number};
export type DefaultAcceptanceExpected = {
  task:string;workflow:'default';references:{default:string;core:string;peer:string};
};
const record=(value:unknown):value is RecordValue=>value!==null&&typeof value==='object'&&!Array.isArray(value);
function requireEvidence(value:unknown):asserts value {
  if(!value)throw Error('takt_default_not_approved');
}
function frames(event:RecordValue):Frame[]{
  requireEvidence(Array.isArray(event.stack)&&event.stack.length>0);
  return event.stack.map(value=>{
    requireEvidence(record(value)&&typeof value.workflow==='string'&&typeof value.workflow_ref==='string'&&
      typeof value.step==='string'&&typeof value.kind==='string'&&Number.isSafeInteger(value.occurrence)&&Number(value.occurrence)>0);
    return value as Frame;
  });
}
const same=(a:Frame[],b:Frame[])=>a.length===b.length&&a.every((f,i)=>
  f.workflow===b[i].workflow&&f.workflow_ref===b[i].workflow_ref&&f.step===b[i].step&&f.kind===b[i].kind&&f.occurrence===b[i].occurrence);
function matchesFrame(f:Frame,workflow:string,reference:string,step:string,kind:string){
  return f.workflow===workflow&&f.workflow_ref===reference&&f.step===step&&f.kind===kind;
}

/**
 * 公式0.68.0のsessionLoggerRecordFactory/WorkflowCallRunnerに基づくdefault専用gate。
 * stackはcanonicalな5項目（call_instanceは含まれない）。callInstanceはlifecycle側にある。
 * 親stepのiterationは開始時の値なので、完了順はiterationや時刻でなくNDJSON内の位置で判定する。
 * ログの出所・改竄防止とcommit/固定テストの検証は呼出元の責務。本関数は公開を承認しない。
 */
export function acceptedDefaultResult(meta:unknown,events:unknown[],expected:DefaultAcceptanceExpected){
  requireEvidence(expected.workflow==='default'&&Object.values(expected.references).every(x=>typeof x==='string'&&x.length>0));
  requireEvidence(record(meta)&&meta.status==='completed'&&meta.task===expected.task&&meta.workflow==='default'&&
    typeof meta.startTime==='string'&&meta.startTime.length>0&&typeof meta.endTime==='string'&&meta.endTime.length>0);
  requireEvidence(Array.isArray(events)&&events.length>0&&events.every(record));
  const log=events as RecordValue[],first=log[0],last=log.at(-1)!;
  requireEvidence(first.type==='workflow_start'&&first.task===expected.task&&first.workflowName==='default'&&first.startTime===meta.startTime);
  requireEvidence(last.type==='workflow_complete'&&log.filter(e=>e.type==='workflow_complete').length===1&&
    !log.some(e=>e.type==='workflow_abort')&&log.filter(e=>e.type==='workflow_start').length===1);
  // 名前だけで検索すると古いAPPROVEや別callから証拠を借りられる。最後の完了から逆に辿る。
  const lastStep=(before:number,after=0)=>{
    for(let i=before-1;i>after;i--)if(log[i].type==='step_complete')return i;
    throw Error('takt_default_not_approved');
  };
  const done=(index:number,workflow:string,scope:Frame[])=>{
    const e=log[index];requireEvidence(e.type==='step_complete'&&e.workflow===workflow&&e.step===scope.at(-1)!.step&&
      e.status==='done'&&e.matchedRuleIndex===0&&same(frames(e),scope));
  };
  // workflow_call_completeは親step_completeより先に記録される。return need_replanも
  // status=completedになり得るため、COMPLETE伝播ではreturnValueの存在を許可しない。
  const call=(scope:Frame[],parentReference:string,childReference:string,stepEnd:number)=>{
    const candidates=log.map((e,i)=>({e,i})).filter(({e})=>
      (e.type==='workflow_call_start'||e.type==='workflow_call_complete')&&same(frames(e),scope));
    const starts=candidates.filter(({e})=>e.type==='workflow_call_start'),ends=candidates.filter(({e})=>e.type==='workflow_call_complete');
    requireEvidence(starts.length===1&&ends.length===1);
    for(const {e} of candidates)requireEvidence(e.workflow===parentReference&&e.step===scope.at(-1)!.step&&
      e.childWorkflow===childReference&&e.callInstance===scope.at(-1)!.occurrence);
    const start=starts[0].i,end=ends[0].i;
    requireEvidence(start<end&&end<stepEnd&&ends[0].e.status==='completed'&&!('returnValue' in ends[0].e));
    requireEvidence(!log.slice(end+1,stepEnd).some(e=>e.type==='step_complete'||e.type==='step_start'||e.type==='workflow_call_start'));
    const stepStarts=log.map((e,i)=>({e,i})).filter(({e})=>e.type==='step_start'&&same(frames(e),scope));
    requireEvidence(stepStarts.length===1&&stepStarts[0].i>start&&stepStarts[0].i<end);
    return {start,end,stepStart:stepStarts[0].i};
  };
  const rootIndex=lastStep(log.length-1),rootScope=frames(log[rootIndex]);
  requireEvidence(rootScope.length===1&&matchesFrame(rootScope[0],'default',expected.references.default,'develop','workflow_call'));
  done(rootIndex,'default',rootScope);
  const root=call(rootScope,expected.references.default,expected.references.core,rootIndex);
  const coreIndex=lastStep(root.end,root.start),coreScope=frames(log[coreIndex]);
  requireEvidence(coreScope.length===2&&same(coreScope.slice(0,1),rootScope)&&
    matchesFrame(coreScope[1],'development-core',expected.references.core,'peer-review','workflow_call'));
  done(coreIndex,'development-core',coreScope);
  const core=call(coreScope,expected.references.core,expected.references.peer,coreIndex);
  requireEvidence(root.stepStart<core.start&&coreIndex<root.end);
  const gateIndex=lastStep(core.end,core.start),gateScope=frames(log[gateIndex]);
  requireEvidence(gateScope.length===3&&same(gateScope.slice(0,2),coreScope)&&
    matchesFrame(gateScope[2],'peer-review',expected.references.peer,'final-gate','agent'));
  done(gateIndex,'peer-review',gateScope);
  const gateStarts=log.map((e,i)=>({e,i})).filter(({e})=>e.type==='step_start'&&same(frames(e),gateScope));
  requireEvidence(gateStarts.length===1&&core.stepStart<gateStarts[0].i&&gateStarts[0].i<gateIndex);
  for(const [from,to] of [[gateIndex,core.end],[coreIndex,root.end]])requireEvidence(
    !log.slice(from+1,to).some(e=>['step_start','workflow_call_start'].includes(String(e.type))));
  // 完了後の新しい呼出し・step開始は、選択したチェーンが終端ではないことを示す。
  requireEvidence(!log.slice(rootIndex+1,-1).some(e=>['step_start','workflow_call_start'].includes(String(e.type))));
  return {status:'approved' as const,runSlug:meta.runSlug,iterations:meta.iterations};
}
