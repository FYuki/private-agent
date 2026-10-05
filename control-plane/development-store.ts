import { Store } from './store.ts';
import { Fault, LIMITS } from '../shared/contracts.ts';
import { DEVELOPMENT_BUDGET_MS, developmentInput } from '../shared/development.ts';

/** 単発開発taskを既存run/lease台帳へ関連付ける。定期jobの60秒予算は変更しない。 */
export class DevelopmentStore {
  constructor(private store: Store) {}
  async submit(owner: string, requestKey: string, value: unknown) {
    const input = developmentInput(value), spec = JSON.stringify(input), s = this.store;
    const old = await s.q('SELECT id,spec FROM development_tasks WHERE owner=? AND request_key=?', owner, requestKey).first<{ id: string; spec: string }>();
    if (old) { if (old.spec !== spec) throw new Fault(409, 'idempotency_conflict'); return old.id; }
    // 既存の同owner・同repo taskだけを参照するため、未来参照や循環は作れない。
    for(const dependency of input.watch?.dependencies??[]) {
      if(!await s.q("SELECT id FROM development_tasks WHERE id=? AND owner=? AND json_extract(spec,'$.repoId')=?",dependency,owner,input.repoId).first())throw new Fault(400,'invalid_watch_dependency');
    }
    const id = crypto.randomUUID(), now = s.now();
    await s.db.batch([
      s.q(`INSERT OR IGNORE INTO jobs(id,owner,request_key,spec,name,provider,prompt,start_at,interval_seconds,max_runs,enabled,created_at,task_kind,budget_ms,resources_json)
        SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM jobs WHERE owner=?)<?`, id, owner, 'dev:'+requestKey, spec, 'Development task', 'codex-luna', input.goal, now, 60, 1, 0, now, 'development', input.budgetMs ?? DEVELOPMENT_BUDGET_MS, ['takt-simple','takt-watch'].includes(input.executionProfileId) ? JSON.stringify({'codex-luna':1,'codex-sol':1}) : null, owner, LIMITS.maxJobs),
      s.q(`INSERT OR IGNORE INTO development_tasks SELECT id,owner,?,spec,created_at FROM jobs WHERE owner=? AND request_key=? AND task_kind='development'`, requestKey, owner, 'dev:'+requestKey),
      s.q(`INSERT OR IGNORE INTO runs(id,job_id,owner,slot,due_at,state) SELECT id||':0',id,owner,0,created_at,'queued' FROM development_tasks WHERE owner=? AND request_key=?`, owner, requestKey),
    ]);
    const saved = await s.q('SELECT id,spec FROM development_tasks WHERE owner=? AND request_key=?', owner, requestKey).first<{ id: string; spec: string }>();
    if (!saved) throw new Fault(429, 'job_limit');
    if (saved.spec !== spec) throw new Fault(409, 'idempotency_conflict');
    return saved.id;
  }
  async status(owner: string, id: string) {
    await this.store.reap(owner);
    const task = await this.store.q(`SELECT t.id,t.spec,t.created_at,r.id AS run_id,r.state,r.attempt,r.result,r.error,r.deadline,r.progress_json FROM development_tasks t JOIN runs r ON r.job_id=t.id WHERE t.id=? AND t.owner=?`, id, owner).first<any>();
    if (!task) throw new Fault(404, 'not_found');
    const workers = (await this.store.q('SELECT id,capabilities,reason,last_seen FROM development_workers WHERE owner=?', owner).all<any>()).results;
    const operations=(await this.store.q('SELECT name,state,fingerprint FROM development_operations WHERE task_id=?',id).all()).results;
    return { ...task, operations, spec: JSON.parse(task.spec), queueReason: task.state === 'queued' ? workers.some(w => w.last_seen > this.store.now()-30000 && !w.reason && JSON.parse(w.capabilities).includes(JSON.parse(task.spec).executionProfileId)) ? 'waiting_for_capacity' : 'runner_offline_or_unavailable' : null,
      workers: workers.map(w => ({ ...w, capabilities: JSON.parse(w.capabilities), online: w.last_seen > this.store.now()-30000 })) };
  }
  async announce(owner: string, worker: string, available: boolean, executionProfile='edit-codex-luna') {
    const capabilities = available ? ['takt-simple','takt-watch'].includes(executionProfile)?['programmatic',executionProfile]:['plan-codex-luna', 'edit-codex-luna'] : [];
    await this.store.q(`INSERT INTO development_workers VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,capabilities=excluded.capabilities,reason=excluded.reason,last_seen=excluded.last_seen`, worker, owner, JSON.stringify(capabilities), available ? null : 'sandbox_or_cli_unavailable', this.store.now()).run();
  }
  async progress(owner:string,worker:string,id:string,token:string,stage:string,iteration:number){
   if(!/^[a-z][a-z0-9_/-]{0,63}$/.test(stage)||!Number.isSafeInteger(iteration)||iteration<0||iteration>30)throw new Fault(400,'invalid_progress');
   const now=this.store.now();
   const row=await this.store.q(`UPDATE runs SET progress_json=? WHERE job_id=? AND owner=? AND worker=? AND token=? AND state='running' AND lease_until>? AND deadline>? RETURNING id`,JSON.stringify({stage,iteration,at:now}),id,owner,worker,token,now,now).first();
   if(!row)throw new Fault(409,'lease_lost_or_cancelled');return {ok:true};
  }
  /** 外部write前予約。同一内容でもreservedは再実行許可ではなく、GitHub照合が必要。 */
  async operation(owner: string, worker: string, taskId: string, token: string, name: string, fingerprint: string, result?: string) {
    const s=this.store;
    await s.heartbeat(owner,worker,taskId+':0',token);
    if (!await s.q('SELECT id FROM development_tasks WHERE id=? AND owner=?',taskId,owner).first()) throw new Fault(404,'not_found');
    const fence=`EXISTS(SELECT 1 FROM runs WHERE id=? AND owner=? AND worker=? AND token=? AND state='running' AND lease_until>? AND deadline>?)`;
    const lease=()=>[taskId+':0',owner,worker,token,s.now(),s.now()];
    const inserted=await s.q(`INSERT OR IGNORE INTO development_operations(task_id,name,fingerprint) SELECT ?,?,? WHERE ${fence} RETURNING name`,taskId,name,fingerprint,...lease()).first();
    if(!await s.q(`SELECT 1 WHERE ${fence}`,...lease()).first())throw new Fault(409,'lease_lost_or_cancelled');
    const row=await s.q('SELECT fingerprint,state,result FROM development_operations WHERE task_id=? AND name=?',taskId,name).first<any>();
    if(row.fingerprint!==fingerprint)throw new Fault(409,'operation_conflict');
    if(result!==undefined){
      if(row.result!==null&&row.result!==result)throw new Fault(409,'operation_conflict');
      const updated=await s.q(`UPDATE development_operations SET state='completed',result=? WHERE task_id=? AND name=? AND fingerprint=? AND (result IS NULL OR result=?) AND ${fence} RETURNING name`,result,taskId,name,fingerprint,result,...lease()).first();
      if(!updated)throw new Fault(409,'operation_conflict_or_lease_lost');
      return {state:'completed',result};
    }
    return {...row,fresh:!!inserted};
  }
}
