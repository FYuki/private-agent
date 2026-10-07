import {Fault,LIMITS,jobInput, type Provider,type Run,type Capacity} from '../shared/contracts.ts';
// A tiny SQL boundary; Workers supplies D1, tests use real SQLite with the same SQL.
export interface Statement {bind(...v:unknown[]):Statement; first<T>():Promise<T|null>; all<T>():Promise<{results:T[]}>; run():Promise<unknown>}
export interface Database {prepare(sql:string):Statement; batch(s:Statement[]):Promise<unknown>}
// enqueue前の永続予約以降は監視leaseと実行寿命を分離する。不明な引渡しも再投入しない。
export const DELEGATED_WATCH_SQL=`EXISTS(SELECT 1 FROM jobs watch_job JOIN development_operations watch_op ON watch_op.task_id=watch_job.id AND watch_op.name='takt' WHERE watch_job.id=runs.job_id AND json_extract(watch_job.spec,'$.executionProfileId')='takt-watch')`;
export class Store {
  constructor(public db:Database, public now=()=>Date.now()){}
  q(sql:string,...args:unknown[]){return this.db.prepare(sql).bind(...args);}
  async create(owner:string,key:string,input:unknown){
    const x=jobInput(input), spec=JSON.stringify(x), now=this.now();
    const old=await this.q('SELECT id,spec FROM jobs WHERE owner=? AND request_key=?',owner,key).first<{id:string;spec:string}>();
    if(old){if(old.spec!==spec)throw new Fault(409,'idempotency_conflict');return old.id;}
    const id=crypto.randomUUID();
    await this.q(`INSERT OR IGNORE INTO jobs(id,owner,request_key,spec,name,provider,prompt,start_at,interval_seconds,max_runs,enabled,created_at)
      SELECT ?,?,?,?,?,?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM jobs WHERE owner=?)<?`,id,owner,key,spec,x.name,x.provider,x.prompt,x.startAt,x.intervalSeconds,x.maxRuns,+x.enabled,now,owner,LIMITS.maxJobs).run();
    const saved=await this.q('SELECT id,spec FROM jobs WHERE owner=? AND request_key=?',owner,key).first<{id:string;spec:string}>();
    if(!saved)throw new Fault(429,'job_limit');
    if(saved.spec!==spec)throw new Fault(409,'idempotency_conflict');return saved.id;
  }
  async tick(at=this.now(),owner?:string){
    const jobs=(await this.q(`SELECT * FROM jobs WHERE enabled=1${owner?' AND owner=?':''}`, ...(owner?[owner]:[])).all<{id:string;owner:string;start_at:number;interval_seconds:number;max_runs:number}>()).results;
    let enqueued=0,skipped=0;
    for(const j of jobs){
      // Current occurrence only: missed slots are not caught up. A skip never creates a Workflow.
      const slot=Math.floor((at-j.start_at)/(j.interval_seconds*1000));
      if(slot<0||slot>=j.max_runs)continue;
      const when=j.start_at+slot*j.interval_seconds*1000;
      const r=await this.q(`INSERT OR IGNORE INTO runs(id,job_id,owner,slot,due_at,state)
        SELECT ?,?,?,?,?,CASE WHEN EXISTS(SELECT 1 FROM runs WHERE job_id=? AND (state IN ('starting','queued','running') OR hold_until>?)) THEN 'skipped' ELSE 'starting' END
        WHERE EXISTS(SELECT 1 FROM jobs WHERE id=? AND enabled=1) RETURNING state`,`${j.id}:${slot}`,j.id,j.owner,slot,when,j.id,this.now(),j.id).first<{state:string}>();
      if(r?.state==='starting')enqueued++;if(r?.state==='skipped')skipped++;
    }
    // Transactional outbox: recover accepted starts after scheduler/Workflow-create failure.
    const pending=(await this.q(`SELECT id,owner FROM runs WHERE state='starting'${owner?' AND owner=?':''}`, ...(owner?[owner]:[])).all<{id:string;owner:string}>()).results;
    return {enqueued,skipped,pending};
  }
  async activate(id:string){
    await this.q(`UPDATE runs SET state='queued' WHERE id=? AND state='starting'`,id).run();return {id};
  }
  async failStarting(id:string){
    return this.q(`UPDATE runs SET state='failed',error='workflow_failed' WHERE id=? AND state='starting' AND attempt=0 AND token IS NULL RETURNING id`,id).first<{id:string}>();
  }
  async reap(owner:string){
    await this.q(`UPDATE runs SET state=CASE WHEN attempt>=? OR EXISTS(SELECT 1 FROM jobs WHERE id=runs.job_id AND task_kind='development') THEN 'failed' ELSE 'queued' END,error='lease_expired',lease_until=NULL
      WHERE owner=? AND state='running' AND lease_until<=? AND deadline+3000<=? AND NOT (${DELEGATED_WATCH_SQL})`,LIMITS.maxAttempts,owner,this.now(),this.now()).run();
  }
  async claim(owner:string,worker:string,provider?:Provider,group=owner,limits:Capacity={models:{'codex-luna':1,'pi-swe2':1},groups:{[group]:1}},taskKind:'answer'|'development'='answer',executionProfile='edit-codex-luna'){
    if(limits.groups[group]===undefined)throw new Fault(503,'worker_group_not_configured');
    await this.reap(owner); const now=this.now(),token=crypto.randomUUID();
    if(taskKind==='development'&&executionProfile==='takt-watch'){
      const existing=await this.q(`SELECT * FROM runs WHERE owner=? AND worker=? AND auth_group=? AND state IN ('running','cancelled') AND hold_until>0 AND ${DELEGATED_WATCH_SQL} ORDER BY due_at,id LIMIT 1`,owner,worker,group).first<Run>();
      if(existing){const job=await this.q('SELECT provider,prompt,spec,budget_ms FROM jobs WHERE id=?',existing.job_id).first<any>();return {...existing,provider:job.provider,prompt:job.prompt,task_kind:'development' as const,budget_ms:job.budget_ms,development:JSON.parse(job.spec),issued_at:now};}
    }
    // One atomic conditional UPDATE prevents concurrent claim races across processes.
    const r=await this.q(`UPDATE runs SET state='running',attempt=attempt+1,token=?,worker=?,auth_group=?,lease_until=?,deadline=?+(SELECT budget_ms FROM jobs WHERE id=runs.job_id),hold_until=?+(SELECT budget_ms FROM jobs WHERE id=runs.job_id)+3000,started_at=?,error=NULL
      WHERE id=(SELECT r.id FROM runs r JOIN jobs j ON j.id=r.job_id WHERE r.owner=? AND state='queued' AND due_at<=? AND attempt<? AND j.task_kind=? AND ((? IS NULL AND j.provider!='agent-fixture') OR j.provider=?)
        AND (j.task_kind!='development' OR json_extract(j.spec,'$.executionProfileId')=?)
        AND NOT EXISTS(SELECT 1 FROM json_each(j.spec,'$.watch.dependencies') dependency
          WHERE NOT EXISTS(SELECT 1 FROM development_tasks dt JOIN runs dr ON dr.job_id=dt.id
            JOIN development_operations artifact ON artifact.task_id=dt.id AND artifact.name='artifact'
            WHERE dt.id=dependency.value AND dt.owner=r.owner AND json_extract(dt.spec,'$.repoId')=json_extract(j.spec,'$.repoId')
              AND dr.state='succeeded' AND dr.hold_until=0 AND artifact.state='completed' AND artifact.result IS NOT NULL))
        AND NOT EXISTS(SELECT 1 FROM json_each(COALESCE(j.resources_json,json_object(j.provider,1))) needed
          WHERE COALESCE((SELECT SUM(used.value) FROM runs occupied JOIN jobs oj ON oj.id=occupied.job_id,
            json_each(COALESCE(oj.resources_json,json_object(oj.provider,1))) used
            WHERE (occupied.hold_until>? OR (oj.resources_json IS NOT NULL AND occupied.hold_until>0)) AND used.key=needed.key),0)+needed.value>COALESCE(json_extract(?, '$.'||needed.key),0))
        ORDER BY due_at,r.id LIMIT 1)
      AND NOT EXISTS(SELECT 1 FROM runs r JOIN jobs j ON j.id=r.job_id WHERE worker=? AND (hold_until>? OR (j.resources_json IS NOT NULL AND hold_until>0)))
      AND (SELECT COUNT(*) FROM runs r JOIN jobs j ON j.id=r.job_id WHERE auth_group=? AND (hold_until>? OR (j.resources_json IS NOT NULL AND hold_until>0)))<?
      AND (SELECT COUNT(*) FROM attempts WHERE owner=? AND started_at>=?)<? RETURNING *`,token,worker,group,now+LIMITS.leaseMs,now,now,now,owner,now,LIMITS.maxAttempts,taskKind,provider??null,provider??null,executionProfile,now,JSON.stringify(limits.models),worker,now,group,now,limits.groups[group],owner,Math.floor(now/86400000)*86400000,LIMITS.dailyAttempts).first<Run>();
    if(!r)return null;
    const j=await this.q('SELECT provider,prompt,spec,task_kind,budget_ms FROM jobs WHERE id=?',r.job_id).first<{provider:Run['provider'];prompt:string;spec:string;task_kind:'answer'|'development';budget_ms:number}>();
    return {...r,provider:j!.provider,prompt:j!.prompt,task_kind:j!.task_kind,budget_ms:j!.budget_ms,...(j!.task_kind==='development'?{development:JSON.parse(j!.spec)}:{}),...(j!.provider==='agent-fixture'?{agent:jobInput(JSON.parse(j!.spec)).agent}:{}),issued_at:now};
  }
  async heartbeat(owner:string,worker:string,id:string,token:string){
    const now=this.now();
    const cancelled=await this.q(`SELECT id FROM runs WHERE id=? AND owner=? AND worker=? AND token=? AND state='cancelled' AND hold_until>0 AND ${DELEGATED_WATCH_SQL}`,id,owner,worker,token).first();
    if(cancelled)return {ok:true,cancelRequested:true};
    const r=await this.q(`UPDATE runs SET lease_until=CASE WHEN ${DELEGATED_WATCH_SQL} THEN ? ELSE MIN(?,deadline) END WHERE id=? AND owner=? AND worker=? AND token=? AND state='running' AND ((lease_until>? AND deadline>?) OR ${DELEGATED_WATCH_SQL}) RETURNING id`,now+LIMITS.leaseMs,now+LIMITS.leaseMs,id,owner,worker,token,now,now).first();
    if(!r)throw new Fault(409,'lease_lost_or_cancelled');return {ok:true};
  }
  async finish(owner:string,worker:string,id:string,token:string,result:string|null,error:string|null){
    const now=this.now();
    const r=await this.q(`UPDATE runs SET state=?,result=?,error=?,lease_until=NULL,hold_until=0 WHERE id=? AND owner=? AND worker=? AND token=? AND state='running' AND ((lease_until>? AND deadline>?) OR ? IS NOT NULL OR ${DELEGATED_WATCH_SQL}) RETURNING id`,error?'failed':'succeeded',result,error,id,owner,worker,token,now,now,error).first();
    if(r)return {ok:true,duplicate:false};
    const old=await this.q(`SELECT state,result,error FROM runs WHERE id=? AND owner=? AND worker=? AND token=?`,id,owner,worker,token).first<Run>();
    if(old?.state==='failed'&&old.error==='lease_expired'&&error!==null){
      // 同じlease tokenの停止ACKだけ受ける。失敗結果は維持し、新attemptを許可しない。
      await this.q(`UPDATE runs SET hold_until=0 WHERE id=? AND owner=? AND worker=? AND token=? AND state='failed' AND error='lease_expired' AND EXISTS(SELECT 1 FROM jobs WHERE id=runs.job_id AND resources_json IS NOT NULL)`,id,owner,worker,token).run();
      return {ok:true,duplicate:true,stopConfirmed:true};
    }
    if(old?.state==='cancelled'){
      // The trusted runner reports only after CLI close; acknowledgement releases the reservation.
      await this.q(`UPDATE runs SET hold_until=0 WHERE id=? AND owner=? AND worker=? AND token=? AND state='cancelled'`,id,owner,worker,token).run();
      return {ok:true,duplicate:true};
    }
    if(old && ['succeeded','failed'].includes(old.state) && old.result===result && old.error===error)return {ok:true,duplicate:true};
    throw new Fault(409,'lease_lost_or_conflicting_completion');
  }
  async cancel(owner:string,id:string){
    const r=await this.q(`UPDATE runs SET state='cancelled',lease_until=NULL WHERE id=? AND owner=? AND state IN ('starting','queued','running') RETURNING id`,id,owner).first();
    if(!r && !await this.q('SELECT id FROM runs WHERE id=? AND owner=?',id,owner).first())throw new Fault(404,'not_found');return {ok:true};
  }
  async disable(owner:string,id:string){
    if(!await this.q('SELECT id FROM jobs WHERE id=? AND owner=?',id,owner).first())throw new Fault(404,'not_found');
    await this.db.batch([this.q('UPDATE jobs SET enabled=0 WHERE id=? AND owner=?',id,owner),this.q(`UPDATE runs SET state='cancelled',lease_until=NULL WHERE job_id=? AND owner=? AND state IN ('starting','queued','running')`,id,owner)]);return {ok:true};
  }
  async list(owner:string){
    await this.reap(owner);
    return {jobs:(await this.q("SELECT id,name,provider,json_extract(spec,'$.agent.characterId') AS character_id,start_at,interval_seconds,max_runs,enabled FROM jobs WHERE owner=? ORDER BY created_at DESC",owner).all()).results,
      runs:(await this.q('SELECT id,job_id,slot,due_at,state,attempt,result,error FROM runs WHERE owner=? ORDER BY due_at DESC LIMIT 100',owner).all<Run>()).results};
  }
}
