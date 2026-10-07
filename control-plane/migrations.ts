import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { SqliteDatabase } from './sqlite.ts';

export async function migrate(database: SqliteDatabase, directory: string): Promise<void> {
  const files = readdirSync(directory).filter(name => /^\d+_[\w-]+\.sql$/.test(name)).sort();
  if (!files.length) throw new Error('migrations_required');
  const migrations = files.map(name => {
    const sql = readFileSync(join(directory, name), 'utf8');
    return {name, sql, hash: createHash('sha256').update(sql).digest('hex')};
  });
  const db = database.connection;
  db.exec('BEGIN IMMEDIATE');
  try {
    const history = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='local_migrations'").get();
    if (!history && db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get()) throw new Error('explicit_migration_history_required');
    db.exec('CREATE TABLE IF NOT EXISTS local_migrations(name TEXT PRIMARY KEY, hash TEXT NOT NULL)');
    const saved = db.prepare('SELECT name,hash FROM local_migrations').all();
    for (const row of saved) {
      if (!migrations.some(migration => migration.name === row.name && migration.hash === row.hash)) throw new Error('migration_history_mismatch');
    }
    for (const migration of migrations) {
      if (saved.some(row => row.name === migration.name)) continue;
      db.exec(migration.sql);
      db.prepare('INSERT INTO local_migrations VALUES(?,?)').run(migration.name, migration.hash);
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
