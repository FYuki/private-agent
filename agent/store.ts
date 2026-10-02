import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { chmodSync } from 'node:fs';
import type { Acquisition, AgentResult, Effect, RunStore } from './contracts.ts';

// WSLの実行台帳。D1のjob/lease台帳やCoreの人格・記憶ストアとは別責務。
export class SqliteRunStore implements RunStore {
  private db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec(`PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS agent_runs(key TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,token TEXT NOT NULL,result TEXT);
      CREATE TABLE IF NOT EXISTS agent_effects(run_key TEXT NOT NULL,effect_key TEXT NOT NULL,fingerprint TEXT NOT NULL,result TEXT,PRIMARY KEY(run_key,effect_key));
      CREATE TABLE IF NOT EXISTS agent_call_ids(run_key TEXT NOT NULL,call_id TEXT NOT NULL,fingerprint TEXT NOT NULL,PRIMARY KEY(run_key,call_id));`);
  }
  close() { this.db.close(); }
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
  settle(key: string, token: string, effectKey: string, result: string) {
    this.assertOwner(key, token);
    const changed = this.db.prepare(`UPDATE agent_effects SET result=? WHERE run_key=? AND effect_key=? AND result IS NULL
      AND EXISTS(SELECT 1 FROM agent_runs WHERE key=? AND token=? AND result IS NULL)`).run(result, key, effectKey, key, token);
    if (!changed.changes) throw new Error('effect_fenced');
  }
  finish(key: string, token: string, result: AgentResult) {
    const changed = this.db.prepare('UPDATE agent_runs SET result=? WHERE key=? AND token=? AND result IS NULL').run(JSON.stringify(result), key, token);
    if (!changed.changes) throw new Error('run_fenced');
  }
}
