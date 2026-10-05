import {Store} from './store.ts';
import {Fault,object,exact,str} from '../shared/contracts.ts';
import {publicationInput,publicationArtifact,uuid} from '../shared/publication.ts';
import {repositoryPolicy} from '../shared/repositories.ts';

/** Post-run publication grants have their own immutable approval and external-write ledger. */
export class PublicationStore{
 constructor(private store:Store){}
 async approve(owner:string,principal:string,key:string,value:unknown){
  const input=publicationInput(value),spec=JSON.stringify(input),s=this.store;str(key,100);
  const old=await s.q('SELECT id,spec FROM development_publications WHERE owner=? AND request_key=?',owner,key).first<any>();
  if(old){if(old.spec!==spec)throw new Fault(409,'idempotency_conflict');return old.id;}
  const task=await s.q(`SELECT r.state,r.result,r.lease_until,r.hold_until,o.result AS artifact FROM development_tasks t JOIN runs r ON r.job_id=t.id JOIN development_operations o ON o.task_id=t.id AND o.name='artifact' AND o.state='completed' WHERE t.id=? AND t.owner=?`,input.taskId,owner).first<any>();
  if(!task)throw new Fault(404,'not_found');
  if(task.state!=='succeeded'||task.lease_until!==null||task.hold_until!==0)throw new Fault(409,'task_not_released');
  const completed=object(JSON.parse(task.result));if(completed.outcome!=='local_only')throw new Fault(409,'not_local_only');
  const artifact=await publicationArtifact(JSON.parse(task.artifact),owner,input);
  await publicationArtifact(completed,owner,input);
  const id=crypto.randomUUID(),now=s.now();
  await s.db.batch([
   // 新しい明示承認だけで、外部writeを一度も予約していない期限切れ承認を置換できる。
   s.q(`UPDATE development_publications SET state='superseded',superseded_at=? WHERE owner=? AND artifact_id=? AND state='approved' AND expires_at<=? AND NOT EXISTS(SELECT 1 FROM publication_operations WHERE publication_id=development_publications.id)`,now,owner,input.artifactId,now),
   s.q(`INSERT OR IGNORE INTO development_publications(id,owner,approved_by,request_key,task_id,artifact_id,repo_id,branch,spec,artifact,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,id,owner,principal,key,input.taskId,input.artifactId,input.repoId,artifact.branch,spec,JSON.stringify(artifact),now,now+3600000)
  ]);
  const saved=await s.q('SELECT id,spec FROM development_publications WHERE owner=? AND request_key=?',owner,key).first<any>();
  if(!saved||saved.spec!==spec)throw new Fault(409,'publication_conflict');return saved.id;
 }
 async status(owner:string,id:string){
  uuid(id);const row=await this.store.q('SELECT * FROM development_publications WHERE id=? AND owner=?',id,owner).first<any>();
  if(!row)throw new Fault(404,'not_found');
  const operations=(await this.store.q('SELECT name,worker,state,result,created_at,completed_at FROM publication_operations WHERE publication_id=?',id).all()).results;
  return {...row,spec:JSON.parse(row.spec),artifact:JSON.parse(row.artifact),operations};
 }
 /** A reservation is single-use. Other invocations may only reconcile a verified remote result. */
 async operation(owner:string,worker:string,id:string,name:string,value?:unknown){
  if(!['push','pull-request'].includes(name))throw new Fault(400,'invalid_operation');
  const row=await this.status(owner,id),s=this.store;
  if(name==='pull-request'&&!row.operations.some((o:any)=>o.name==='push'&&o.state==='completed'))throw new Fault(409,'push_not_confirmed');
  let result:string|undefined;
  if(value!==undefined){
   const v=object(value);
   if(name==='push'){exact(v,['sha']);if(v.sha!==row.spec.headSha)throw new Fault(409,'publication_result_mismatch');result=JSON.stringify({sha:v.sha});}
   else{exact(v,['url']);const url=str(v.url,256),prefix='https://github.com/'+repositoryPolicy(row.spec.repoId).github+'/pull/';if(!url.startsWith(prefix)||!/^\d+$/.test(url.slice(prefix.length)))throw new Fault(409,'publication_result_mismatch');result=JSON.stringify({url});}
  }
  let fresh=false;
  if(result===undefined){
   fresh=!!await s.q(`INSERT OR IGNORE INTO publication_operations(publication_id,name,worker,created_at) SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM development_publications WHERE id=? AND owner=? AND state='approved' AND expires_at>?) RETURNING name`,id,name,worker,s.now(),id,owner,s.now()).first();
  }
  const operation=await s.q('SELECT state,result FROM publication_operations WHERE publication_id=? AND name=?',id,name).first<any>();
  if(!operation)throw new Fault(409,'publication_expired_or_unreserved');
  if(result!==undefined){
   // Completion after approval expiry only records the outcome of an already reserved write.
   const saved=await s.q(`UPDATE publication_operations SET state='completed',result=?,completed_at=COALESCE(completed_at,?) WHERE publication_id=? AND name=? AND (result IS NULL OR result=?) RETURNING name`,result,s.now(),id,name,result).first();
   if(!saved)throw new Fault(409,'operation_conflict');
   if(name==='pull-request')await s.q("UPDATE development_publications SET state='published' WHERE id=?",id).run();
   return {state:'completed',result};
  }
  return {...operation,fresh};
 }
}
