import type {Database,Statement} from './store.ts';
// Local diagnostics only, not billing accounting. D1 metadata is reported as provided.
export class MeasuredDatabase implements Database{
 metrics={statements:0,rowsRead:0,rowsWritten:0};
 private native=new WeakMap<Statement,()=>D1PreparedStatement>();
 constructor(private db:D1Database){}
 private add(meta:D1Meta){this.metrics.statements++;this.metrics.rowsRead+=meta.rows_read||0;this.metrics.rowsWritten+=meta.rows_written||0;}
 prepare(sql:string):Statement{
  let s=this.db.prepare(sql);const parent=this;
  const wrapper:Statement={bind(...v:unknown[]){s=s.bind(...v);return this;},async first<T>(){const r=await s.all<T>();parent.add(r.meta);return r.results[0]??null;},async all<T>(){const r=await s.all<T>();parent.add(r.meta);return r;},async run(){const r=await s.run();parent.add(r.meta);return r;}};
  this.native.set(wrapper,()=>s);return wrapper;
 }
 async batch(statements:Statement[]){const results=await this.db.batch(statements.map(s=>this.native.get(s)!()));for(const r of results)this.add(r.meta);return results;}
}
