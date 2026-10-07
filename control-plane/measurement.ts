import type { Database, Statement } from './store.ts';

export class MeasuredDatabase implements Database {
  metrics = {statements: 0};
  private native = new WeakMap<Statement, Statement>();
  constructor(private db: Database) {}
  prepare(sql: string): Statement {
    const statement = this.db.prepare(sql), parent = this;
    const wrapper: Statement = {
      bind(...values: unknown[]) { statement.bind(...values); return this; },
      async first<T>() { const result = await statement.first<T>(); parent.metrics.statements++; return result; },
      async all<T>() { const result = await statement.all<T>(); parent.metrics.statements++; return result; },
      async run() { const result = await statement.run(); parent.metrics.statements++; return result; },
    };
    this.native.set(wrapper, statement);
    return wrapper;
  }
  async batch(statements: Statement[]) {
    const native = statements.map(statement => {
      const result = this.native.get(statement);
      if (!result) throw new TypeError('foreign_measured_statement');
      return result;
    });
    const result = await this.db.batch(native);
    this.metrics.statements += statements.length;
    return result;
  }
}
