import {spawn,type ChildProcess} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,realpathSync,mkdirSync,writeFileSync,unlinkSync,lstatSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {prepareDatabaseFile} from '../agent/store.ts';

export type WatchProcess={file:string;args:string[];cwd:string;env:Record<string,string>};
type WatchRow={root:string;owner:string;token:string;state:string;pid:number|null;identity:string|null;contained:number};
export function watchProcessIdentity(pid:number){
 try{const stat=readFileSync('/proc/'+pid+'/stat','utf8'),fields=stat.slice(stat.lastIndexOf(')')+2).split(' ');return readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim()+':'+fields[19];}catch{return null;}
}
const identity=watchProcessIdentity;
function groupAlive(pid:number){try{process.kill(-pid,0);return true;}catch(e){if((e as NodeJS.ErrnoException).code==='ESRCH')return false;throw e;}}
/** host内部専用。HTTP/MCPからcommandを受け付けない。開始不明や子孫生存時は再起動しない。 */
export class WatchSupervisor {
 private db:DatabaseSync;private children=new Map<string,ChildProcess>();
 constructor(path:string){if(path!==':memory:')prepareDatabaseFile(path);this.db=new DatabaseSync(path);this.db.exec(`PRAGMA busy_timeout=5000;CREATE TABLE IF NOT EXISTS watch_supervisors(root TEXT PRIMARY KEY,owner TEXT NOT NULL,token TEXT NOT NULL,state TEXT NOT NULL,pid INTEGER,identity TEXT,contained INTEGER NOT NULL DEFAULT 0);CREATE TABLE IF NOT EXISTS watch_supervisor_history(root TEXT NOT NULL,owner TEXT NOT NULL,token TEXT PRIMARY KEY,state TEXT NOT NULL,pid INTEGER,identity TEXT,contained INTEGER NOT NULL DEFAULT 0);`);}
 close(){if(this.children.size)throw Error('watch_still_owned');this.db.close();}
 status(owner:string,root:string){
  const row=this.db.prepare('SELECT * FROM watch_supervisors WHERE root=? AND owner=?').get(root,owner) as WatchRow|undefined;
  if(!row)return null;
  if(row.pid&&row.identity&&identity(row.pid)===row.identity)return {...row,observed:'alive'};
  if(row.pid&&groupAlive(row.pid))return {...row,observed:'stop_unconfirmed'};
  return {...row,observed:row.state==='starting'?'start_unconfirmed':row.state==='stop_unconfirmed'||!row.contained?'stop_unconfirmed':'exited'};
 }
 async start(owner:string,spec:WatchProcess){
  if(!/^[a-zA-Z0-9_-]{1,64}$/.test(owner)||realpathSync(spec.cwd)!==spec.cwd)throw Error('untrusted_watch_identity');
  const root=spec.cwd,token=randomUUID();
  const flags=spec.args.slice(0,spec.args.indexOf('--'));
  const contained=spec.file==='/usr/bin/bwrap'&&flags.includes('--unshare-pid')&&flags.includes('--die-with-parent');
  const previous=this.status(owner,root);
  if(previous?.state==='exited'&&previous.observed==='exited'){
   this.db.exec('BEGIN IMMEDIATE');try{
    this.db.prepare("INSERT OR IGNORE INTO watch_supervisor_history SELECT * FROM watch_supervisors WHERE root=? AND token=? AND state='exited'").run(root,previous.token);
    this.db.prepare("DELETE FROM watch_supervisors WHERE root=? AND token=? AND state='exited'").run(root,previous.token);this.db.exec('COMMIT');
   }catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  const inserted=this.db.prepare("INSERT OR IGNORE INTO watch_supervisors(root,owner,token,state,contained) VALUES(?,?,?,'starting',?)").run(root,owner,token,contained?1:0);
  if(!inserted.changes)throw Error('watch_already_reserved');
  const control=join(root,'.takt');mkdirSync(control,{recursive:true,mode:0o700});
  if(realpathSync(control)!==control||!lstatSync(control).isDirectory())throw Error('untrusted_watch_control');
  const lock=join(control,'.private-agent-watch.lock');
  // 異なる管理DBで同じrootを指定しても二重watchにならない。stale lockは自動解除しない。
  try{writeFileSync(lock,token,{flag:'wx',mode:0o600});}catch{throw Error('watch_root_already_reserved');}
  const child=spawn(spec.file,spec.args,{cwd:root,env:spec.env,shell:false,detached:true,stdio:['ignore','pipe','pipe']});this.children.set(root,child);
  // 監視用出力は蓄積せず排出する。累積ログ量を長時間TAKTの停止条件にしない。
  child.stdout?.resume();child.stderr?.resume();
  child.on('close',()=>{
   // child closeだけではsetsid等の子孫消滅を証明できない。実配置はPID namespace必須。
   const stopped=contained&&child.pid&&!groupAlive(child.pid);
   try{if(stopped&&readFileSync(lock,'utf8')===token)unlinkSync(lock);}catch{/* lockを不明なまま解除しない */}
   this.db.prepare('UPDATE watch_supervisors SET state=? WHERE root=? AND token=?').run(stopped?'exited':'stop_unconfirmed',root,token);this.children.delete(root);
  });
  await new Promise<void>((ok,no)=>{child.once('spawn',()=>ok());child.once('error',()=>no(Error('watch_spawn_failed')));});
  const pid=child.pid!,proof=identity(pid);if(!proof)throw Error('watch_start_unconfirmed');
  this.db.prepare("UPDATE watch_supervisors SET state='running',pid=?,identity=? WHERE root=? AND token=? AND state='starting'").run(pid,proof,root,token);
  return this.status(owner,root)!;
 }
 /** cancelはdrainと区別する。自分が所有するPID namespaceのcloseだけを停止証明にする。 */
 async cancel(owner:string,root:string,waitMs=10000){
  if(!Number.isSafeInteger(waitMs)||waitMs<10||waitMs>30000)throw Error('invalid_stop_timeout');
  const row=this.status(owner,root);if(!row)throw Error('watch_not_found');
  if(row.observed==='exited')return row;
  const child=this.children.get(root);
  if(!row.contained||!child||child.pid!==row.pid||!row.pid||!row.identity||identity(row.pid)!==row.identity)throw Error('watch_stop_unconfirmed');
  this.db.prepare("UPDATE watch_supervisors SET state='cancelling' WHERE root=? AND token=?").run(root,row.token);
  process.kill(-row.pid,'SIGKILL');
  const until=Date.now()+waitMs;
  while(Date.now()<until){
   if(!this.children.has(root)){const result=this.status(owner,root);if(result?.observed==='exited')return result;throw Error('watch_stop_unconfirmed');}
   await new Promise(r=>setTimeout(r,20));
  }
  throw Error('watch_stop_unconfirmed');
 }
 async stop(owner:string,root:string,waitMs=10000){
  if(!Number.isSafeInteger(waitMs)||waitMs<10||waitMs>30000)throw Error('invalid_stop_timeout');
  const row=this.status(owner,root);if(!row)throw Error('watch_not_found');
  if(row.observed==='exited')return row;
  if(row.observed!=='alive'||!row.pid||!row.identity||identity(row.pid)!==row.identity)throw Error('watch_identity_unconfirmed');
  // SIGINTはdrain要求。taskのcancel完了へは変換しない。
  this.db.prepare("UPDATE watch_supervisors SET state='draining' WHERE root=? AND token=?").run(root,row.token);
  process.kill(-row.pid,'SIGINT');
  const until=Date.now()+waitMs;
  while(Date.now()<until){if(!groupAlive(row.pid)&&!this.children.has(root)){const result=this.status(owner,root);if(result?.observed==='exited')return result;throw Error('watch_stop_unconfirmed');}await new Promise(r=>setTimeout(r,20));}
  throw Error('watch_stop_unconfirmed');
 }
}
