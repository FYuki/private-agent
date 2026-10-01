export const PROVIDERS = ['codex-luna', 'pi-swe2'] as const;
export type Provider = typeof PROVIDERS[number];
export const LIMITS = { promptBytes: 4096, outputBytes: 16384, processBytes: 262144, timeoutMs: 60000, leaseMs: 20000, heartbeatMs: 5000, maxAttempts: 2, maxJobs: 10, dailyAttempts: 40 } as const;
export class Fault extends Error { constructor(public status: number, message: string) { super(message); } }
export function object(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Fault(400, 'object_required');
  return v as Record<string, unknown>;
}
export function exact(v: Record<string, unknown>, keys: string[]) {
  if (Object.keys(v).some(k => !keys.includes(k))) throw new Fault(400, 'unknown_field');
}
export function str(v: unknown, max: number): string {
  if (typeof v !== 'string' || !v.trim() || new TextEncoder().encode(v).length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(v)) throw new Fault(400, 'invalid_text');
  return v;
}
export function integer(v: unknown, min: number, max: number): number {
  if (!Number.isSafeInteger(v) || (v as number) < min || (v as number) > max) throw new Fault(400, 'invalid_integer');
  return v as number;
}
export function provider(v: unknown): Provider {
  if (!PROVIDERS.includes(v as Provider)) throw new Fault(400, 'unsupported_provider');
  return v as Provider;
}
export type JobInput = {name:string; provider:Provider; prompt:string; startAt:number; intervalSeconds:number; maxRuns:number; enabled:boolean;overlapPolicy:'skip'};
export function jobInput(v: unknown): JobInput {
  const x=object(v); exact(x,['name','provider','prompt','startAt','intervalSeconds','maxRuns','enabled','overlapPolicy']);
  if(x.overlapPolicy!==undefined&&x.overlapPolicy!=='skip')throw new Fault(400,'unsupported_overlap_policy');
  if (typeof x.enabled !== 'boolean') throw new Fault(400,'invalid_enabled');
  return {name:str(x.name,100), provider:provider(x.provider), prompt:str(x.prompt,LIMITS.promptBytes), startAt:integer(x.startAt,0,4102444800000), intervalSeconds:integer(x.intervalSeconds,60,86400), maxRuns:integer(x.maxRuns,1,10), enabled:x.enabled,overlapPolicy:'skip'};
}
export type Job = JobInput & {id:string; owner:string; created_at:number};
export type Run = {id:string; job_id:string; owner:string; slot:number; due_at:number; state:'starting'|'queued'|'running'|'succeeded'|'failed'|'cancelled'|'skipped'; attempt:number; token:string|null; worker:string|null; lease_until:number|null; deadline:number|null; result:string|null; error:string|null; provider:Provider; prompt:string};
export type Principal={owner:string; role:'viewer'|'worker'; id:string; hash:string;group?:string};
export type Capacity={models:Record<Provider,number>;groups:Record<string,number>};
export function capacity(raw:unknown):Capacity{
 const c=object(raw);exact(c,['models','groups']);const m=object(c.models),g=object(c.groups);exact(m,[...PROVIDERS]);
 for(const p of PROVIDERS)integer(m[p],0,16);
 for(const [k,v] of Object.entries(g)){if(!/^[a-zA-Z0-9_-]{1,64}$/.test(k))throw new Fault(400,'invalid_group');integer(v,0,16);}
 return c as unknown as Capacity;
}
export const terminal = (s:string) => ['succeeded','failed','cancelled'].includes(s);
