import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { prepareDatabaseFile } from '../agent/store.ts';
import type { Database, Statement } from './store.ts';

class SqliteStatement implements Statement {
  private values: SQLInputValue[] = [];
  constructor(readonly database: SqliteDatabase, private sql: string) {}
  bind(...values: unknown[]): Statement {
    this.values = values.map(value => {
      if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint' || value instanceof Uint8Array) return value;
      throw new TypeError('invalid_sql_parameter');
    });
    return this;
  }
  execute() { return this.database.connection.prepare(this.sql).all(...this.values); }
  async first<T>(): Promise<T | null> { return (this.execute()[0] as T | undefined) ?? null; }
  async all<T>(): Promise<{results: T[]}> { return {results: this.execute() as T[]}; }
  async run() { return this.execute(); }
}

export class SqliteDatabase implements Database {
  readonly connection: DatabaseSync;
  constructor(path: string) {
    prepareDatabaseFile(path);
    this.connection = new DatabaseSync(path);
    try { this.connection.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;'); }
    catch (error) { this.connection.close(); throw error; }
  }
  prepare(sql: string): Statement { return new SqliteStatement(this, sql); }
  async batch(statements: Statement[]) {
    const native = statements.map(statement => {
      if (!(statement instanceof SqliteStatement) || statement.database !== this) throw new TypeError('foreign_sql_statement');
      return statement;
    });
    // No await between BEGIN and COMMIT: independent requests cannot join this transaction.
    this.connection.exec('BEGIN IMMEDIATE');
    try {
      const results = native.map(statement => statement.execute());
      this.connection.exec('COMMIT');
      return results;
    } catch (error) { this.connection.exec('ROLLBACK'); throw error; }
  }
  close() { this.connection.close(); }
}
