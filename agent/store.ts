import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { openSync, closeSync, constants, fstatSync, lstatSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Acquisition, AgentResult, Effect, RunStore } from './contracts.ts';

/** SQLiteへ渡す前に0600で作成する。既存の権限・リンク・所有者が不適切なら変更せず拒否する。 */
export function prepareDatabaseFile(path: string): void {
  if (process.platform !== 'linux') throw new Error('unsupported_store_platform');
  const absolute = resolve(path), parent = dirname(absolute), directory = lstatSync(parent);
  // 他ユーザーによるpath差替えを防ぐ。管理者が用意した同一uidの信頼済みディレクトリだけを使う。
  if (realpathSync(parent) !== parent || !directory.isDirectory() || directory.uid !== process.getuid!() || (directory.mode & 0o022)) throw new Error('unsafe_store_directory');
  let fd: number;
  try { fd = openSync(absolute, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    fd = openSync(absolute, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  }
  try {
    const file = fstatSync(fd);
    if (!file.isFile() || file.uid !== process.getuid!() || file.nlink !== 1 || (file.mode & 0o777) !== 0o600) throw new Error('unsafe_store_file');
  } finally { closeSync(fd); }
}

/** WSLの実行台帳。D1のjob/leaseやCoreの人格・記憶とは分離し、不明な副作用を自動再実行しない。 */
export class SqliteRunStore implements RunStore {
  private db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') prepareDatabaseFile(path);
    this.db = new DatabaseSync(path);
    try { this.db.exec(`PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS agent_runs(key TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,token TEXT NOT NULL,result TEXT);
      CREATE TABLE IF NOT EXISTS agent_effects(run_key TEXT NOT NULL,effect_key TEXT NOT NULL,fingerprint TEXT NOT NULL,result TEXT,PRIMARY KEY(run_key,effect_key));
      CREATE TABLE IF NOT EXISTS agent_call_ids(run_key TEXT NOT NULL,call_id TEXT NOT NULL,fingerprint TEXT NOT NULL,PRIMARY KEY(run_key,call_id));`); }
    catch (error) { this.db.close(); throw error; }
  }
  /** 呼出元が所有する接続を閉じる。永続台帳は削除しない。 */
  close() { this.db.close(); }
  /** 同じ入力の完了runは再利用し、未完runは副作用不明としてbusyを返す。 */
  acquire(key: string, fingerprint: string): Acquisition {
    const token = randomUUID();
    const inserted = this.db.prepare('INSERT OR IGNORE INTO agent_runs VALUES(?,?,?,NULL)').run(key, fingerprint, token);
    if (inserted.changes) return { kind: 'acquired', token };
    const row = this.db.prepare('SELECT * FROM agent_runs WHERE key=?').get(key)!;
    if (row.fingerprint !== fingerprint) throw new Error('run_identity_conflict');
    return row.result ? { kind: 'terminal', result: JSON.parse(row.result as string) } : { kind: 'busy' };
  }
  private assertOwner(key: string, token: string) {
    if (!this.db.prepare('SELECT key FROM agent_runs WHERE key=? AND token=? AND result IS NULL').get(key, token)) throw new Error('run_fenced');
  }
  /** 実行前予約を原子的に記録する。別入力のcall ID再利用は拒否し、不明予約を再取得しない。 */
  reserve(key: string, token: string, effectKey: string, callId: string, fingerprint: string): Effect {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.assertOwner(key, token);
      this.db.prepare('INSERT OR IGNORE INTO agent_call_ids VALUES(?,?,?)').run(key, callId, fingerprint);
      const call = this.db.prepare('SELECT fingerprint FROM agent_call_ids WHERE run_key=? AND call_id=?').get(key, callId)!;
      if (call.fingerprint !== fingerprint) throw new Error('tool_call_conflict');
      const inserted = this.db.prepare('INSERT OR IGNORE INTO agent_effects VALUES(?,?,?,NULL)').run(key, effectKey, fingerprint);
      const row = this.db.prepare('SELECT * FROM agent_effects WHERE run_key=? AND effect_key=?').get(key, effectKey)!;
      if (row.fingerprint !== fingerprint) throw new Error('tool_call_conflict');
      this.db.exec('COMMIT');
      return inserted.changes ? { kind: 'new' } : row.result === null ? { kind: 'uncertain' } : { kind: 'cached', result: row.result as string };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  /** 現在のrun所有者だけが未確定予約へ結果を書ける。後着・重複確定は拒否する。 */
  settle(key: string, token: string, effectKey: string, result: string) {
    this.assertOwner(key, token);
    const changed = this.db.prepare(`UPDATE agent_effects SET result=? WHERE run_key=? AND effect_key=? AND result IS NULL
      AND EXISTS(SELECT 1 FROM agent_runs WHERE key=? AND token=? AND result IS NULL)`).run(result, key, effectKey, key, token);
    if (!changed.changes) throw new Error('effect_fenced');
  }
  /** 現在のrun所有者が一度だけ終端状態を保存する。 */
  finish(key: string, token: string, result: AgentResult) {
    const changed = this.db.prepare('UPDATE agent_runs SET result=? WHERE key=? AND token=? AND result IS NULL').run(JSON.stringify(result), key, token);
    if (!changed.changes) throw new Error('run_fenced');
  }
}
