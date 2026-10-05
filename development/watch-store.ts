import {DatabaseSync} from 'node:sqlite';
import {prepareDatabaseFile} from '../agent/store.ts';
import {watchOrder,orderMarker,orderText,digest,type WatchOrder,type WatchQueue} from './watch-contract.ts';

type Row={id:string;owner:string;spec:string;state:string;task_name:string|null;run_slug:string|null;result:string|null;cancel_requested:number};
/** 外部enqueue前に予約し、不明な書込を再送しない。TAKT完了は承認・公開許可ではない。 */
export class WatchStore {
 private db:DatabaseSync;
 constructor(path:string){if(path!==':memory:')prepareDatabaseFile(path);this.db=new DatabaseSync(path);this.db.exec(`PRAGMA busy_timeout=5000;CREATE TABLE IF NOT EXISTS watch_tasks(id TEXT PRIMARY KEY,owner TEXT NOT NULL,spec TEXT NOT NULL,state TEXT NOT NULL,task_name TEXT,run_slug TEXT,result TEXT,cancel_requested INTEGER NOT NULL DEFAULT 0);`);}
 close(){this.db.close();}
 private row(owner:string,id:string){const row=this.db.prepare('SELECT * FROM watch_tasks WHERE id=? AND owner=?').get(id,owner) as Row|undefined;if(!row)throw Error('task_not_found');return row;}
 submit(owner:string,value:unknown){
  if(!/^[a-zA-Z0-9_-]{1,64}$/.test(owner))throw Error('invalid_owner');
  const order=watchOrder(value),spec=JSON.stringify(order);
  this.db.exec('BEGIN IMMEDIATE');try{
   const old=this.db.prepare('SELECT * FROM watch_tasks WHERE id=?').get(order.id) as Row|undefined;
   if(old){if(old.owner!==owner||old.spec!==spec)throw Error('idempotency_conflict');this.db.exec('COMMIT');return order.id;}
   // 既存の同一owner/repoだけを参照するため循環や将来IDの先取りがない。
   for(const id of order.dependencies){const dep=this.row(owner,id);if(JSON.parse(dep.spec).repoId!==order.repoId)throw Error('dependency_repository_mismatch');}
   this.db.prepare("INSERT INTO watch_tasks(id,owner,spec,state) VALUES(?,?,?,'waiting')").run(order.id,owner,spec);this.db.exec('COMMIT');return order.id;
  }catch(e){this.db.exec('ROLLBACK');throw e;}
 }
 status(owner:string,id:string){const row=this.row(owner,id);return {...row,spec:JSON.parse(row.spec),result:row.result?JSON.parse(row.result):null};}
 cancel(owner:string,id:string){this.row(owner,id);this.db.prepare("UPDATE watch_tasks SET cancel_requested=1,state=CASE WHEN state='waiting' THEN 'cancelled' ELSE state END WHERE id=? AND owner=?").run(id,owner);return this.status(owner,id);}
 /** hostの固定検証器だけが呼ぶ境界。TAKTのcompletedやモデル本文だけでは依存を解放しない。 */
 async validate(owner:string,id:string,verify:(order:WatchOrder,runSlug:string)=>Promise<{artifactId:string;headSha:string}>){
  const row=this.row(owner,id);if(row.state!=='collected'||row.cancel_requested||!row.run_slug)throw Error('validation_not_ready');
  const proof=await verify(JSON.parse(row.spec),row.run_slug);
  if(!/^[a-f0-9]{64}$/.test(proof.artifactId)||!/^[a-f0-9]{40}$/.test(proof.headSha))throw Error('invalid_validation_proof');
  const changed=this.db.prepare("UPDATE watch_tasks SET state='validated',result=? WHERE id=? AND owner=? AND state='collected' AND cancel_requested=0 AND run_slug=? AND result=?").run(JSON.stringify({...JSON.parse(row.result!),...proof,validation:'passed'}),id,owner,row.run_slug,row.result);
  if(!changed.changes)throw Error('validation_fenced');return this.status(owner,id);
 }
 async dispatch(owner:string,id:string,repoId:string,queue:WatchQueue){
  let row:Row,order:WatchOrder,fresh=false;
  this.db.exec('BEGIN IMMEDIATE');try{
   row=this.row(owner,id);order=JSON.parse(row.spec);if(order.repoId!==repoId)throw Error('repository_mismatch');
   if(row.cancel_requested)throw Error('cancel_requested');
   for(const dep of order.dependencies)if(this.row(owner,dep).state!=='validated')throw Error('dependency_not_validated');
   fresh=!!this.db.prepare("UPDATE watch_tasks SET state='reserved' WHERE id=? AND owner=? AND state='waiting' AND cancel_requested=0").run(id,owner).changes;
   this.db.exec('COMMIT');
  }catch(e){this.db.exec('ROLLBACK');throw e;}
  if(fresh){
   // reservationからここまでにcancelされた場合も新しい外部書込を開始しない。
   if(this.row(owner,id).cancel_requested)throw Error('cancel_requested');
   const result=await queue.enqueue({task:orderText(order!),workflow:order!.workflow,worktree:true,autoPr:false,taskContext:{baseBranch:order!.baseRef}});
   if(typeof result.taskName!=='string'||!result.taskName||result.taskName.length>255)throw Error('invalid_enqueue_result');
   this.db.prepare("UPDATE watch_tasks SET task_name=?,state='enqueued' WHERE id=? AND owner=? AND state='reserved' AND task_name IS NULL").run(result.taskName,id,owner);
  }
  return this.reconcile(owner,id,repoId,queue);
 }
 async reconcile(owner:string,id:string,repoId:string,queue:WatchQueue){
  const row=this.row(owner,id),order:WatchOrder=JSON.parse(row.spec);if(order.repoId!==repoId)throw Error('repository_mismatch');
  if(row.state==='waiting'||row.state==='cancelled')return this.status(owner,id);
  const tasks=await queue.list();if(!Array.isArray(tasks)||tasks.length>10000)throw Error('invalid_task_list');
  const matches=tasks.filter(t=>t.summary===orderMarker(order));
  if(matches.length!==1)throw Error('enqueue_outcome_uncertain');const task=matches[0];
  if((row.task_name&&row.task_name!==task.name)||task.workflow!==order.workflow||!['pending','running','completed','failed','exceeded','pr_failed'].includes(task.status))throw Error('takt_task_identity_conflict');
  if(row.run_slug&&row.run_slug!==task.runSlug)throw Error('takt_run_identity_conflict');
  let result:string|null=null;
  if(task.runSlug){
   if(!/^[a-zA-Z0-9_-]{1,255}$/.test(task.runSlug))throw Error('invalid_run_slug');
   const run=await queue.run(task.runSlug);
   if(run.runSlug!==task.runSlug||run.task!==orderText(order)||run.workflow!==order.workflow)throw Error('takt_run_identity_conflict');
   if(task.status==='completed'&&run.status!=='completed')throw Error('takt_terminal_mismatch');
   // 生ログ・report本文をUIや台帳へ複製しない。
   result=JSON.stringify({runSlug:run.runSlug,status:run.status,workflow:run.workflow,currentStep:run.currentStep,phase:run.phase,orderHash:digest(orderText(order)),validation:'pending',publication:'not_authorized'});
  }else if(task.status==='completed')throw Error('completed_run_missing');
  if(row.state==='validated'){if(task.status!=='completed')throw Error('takt_terminal_mismatch');return this.status(owner,id);}
  const state=task.status==='completed'?'collected':task.status==='pending'?'enqueued':task.status;
  // 遅延したrunning/collected応答で新しい検証証跡を巻き戻さない。
  this.db.prepare('UPDATE watch_tasks SET task_name=?,run_slug=?,state=?,result=? WHERE id=? AND owner=? AND state=? AND task_name IS ? AND run_slug IS ? AND result IS ?').run(task.name,task.runSlug??null,state,result,id,owner,row.state,row.task_name,row.run_slug,row.result);
  return this.status(owner,id);
 }
}
