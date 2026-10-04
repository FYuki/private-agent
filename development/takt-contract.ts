import { createHash } from 'node:crypto';

export const TAKT_PIN = { version: '0.68.0', commit: '6f4abf66c795f4c1a05ee0edb11cacaa0d1a475c', workflow: 'simple', integrity:'sha512-92yoikSQ6kyj/PYMrefONIOKkNW9CdiJrAl2REPdsmdKp3M3XUMZnxDOjCtf1mAnOMadJpVGlGa5sYuaI1hjcw==' } as const;
export const TAKT_BUDGET = { totalMs: 4 * 60 * 60 * 1000, maxMs: 24 * 60 * 60 * 1000, callMs: 20 * 60 * 1000, idleMs: 10 * 60 * 1000 } as const;
export const hash = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
type Assignment = { profile?: string; pool?: string; ladder?: unknown };
type Profile = { provider: string; model?: string; options?: Record<string, unknown>; extends?: string };
export type Runtime = { version: number; companion?: { enabled?: boolean }; provider?: { defaults?: Assignment; profiles: Record<string, Profile>; targets?: Record<string, Record<string, Assignment>>; auto_routing?: unknown; assignments?: unknown } };
export type Step = { name: string; tags?: string[]; persona?: string; parallel?: unknown; steps?: Step[] };

/** 固定profileのみ解決する。未対応provider/競合を選び直さず拒否する。 */
export function resolveProfile(runtime: Runtime, step?: Step, seat?: string) {
 const p = runtime.provider;
 if (runtime.version !== 1 || !p || p.auto_routing || p.assignments || runtime.companion?.enabled) throw Error('unsupported_runtime_policy');
 const target = p.targets ?? {};
 let choice = p.defaults;
 if (seat) choice = target.internal_agents?.[seat] ?? choice;
 else if (step) {
  if (step.parallel || step.steps) throw Error('parallel_workflow_not_verified');
  choice = target.personas?.[step.persona ?? ''] ?? choice;
  const tags = (step.tags ?? []).map(t => target.tags?.[t]).filter((x): x is Assignment => !!x);
  if (!target.steps?.[step.name] && new Set(tags.map(x => JSON.stringify(x))).size > 1) throw Error('tag_profile_conflict');
  choice = target.steps?.[step.name] ?? tags[0] ?? choice;
 }
 if (!choice?.profile || choice.pool || choice.ladder) throw Error('fixed_profile_required');
 const profile = p.profiles[choice.profile];
 if (!profile || profile.extends) throw Error('unsupported_profile_inheritance');
 if (profile.provider !== 'codex' || !['gpt-6-sol', 'gpt-6-luna'].includes(profile.model ?? '')) throw Error('provider_or_model_not_verified');
 if (!['medium','xhigh'].includes(String(profile.options?.reasoning_effort))) throw Error('effort_not_verified');
 return { profile: choice.profile, provider: profile.provider, model: profile.model!, effort: String(profile.options!.reasoning_effort) };
}

export function resourcePlan(runtime: Runtime, steps: Step[]) {
 const resolved = [...steps.map(s => ({ target: s.name, ...resolveProfile(runtime, s) })),
  ...['assistant','selector','loop-judge','review-completion-judge'].map(seat => ({ target: 'internal_agents.' + seat, ...resolveProfile(runtime, undefined, seat) }))];
 return { resolved, models: Object.fromEntries([...new Set(resolved.map(p => p.model === 'gpt-6-sol' ? 'codex-sol' : 'codex-luna'))].map(p => [p, 1])), groupSlots: 1, maxProviderProcesses: 1, maxProviderCalls: 120 };
}

/** exit codeだけを承認扱いしない。最終の外側review/superviseが両方承認された場合だけ完了。 */
export function acceptedResult(meta: any, events: any[], expected: { task: string; workflow: string }) {
 if (meta?.status !== 'completed' || meta.task !== expected.task || meta.workflow !== expected.workflow || !meta.endTime || events.at(-1)?.type !== 'workflow_complete') throw Error('takt_incomplete');
 const steps = events.filter(e => e.type === 'step_complete' && e.workflow === 'simple' && e.stack?.length === 1 && e.stack[0].workflow === 'simple' && e.stack[0].step === e.step && e.stack[0].kind === 'agent');
 const review = steps.findLast(e => e.step === 'review'), supervise = steps.findLast(e => e.step === 'supervise');
 if (!review || !supervise || steps.at(-1) !== supervise || review.iteration >= supervise.iteration || review.matchedRuleIndex !== 0 || supervise.matchedRuleIndex !== 1 || review.status !== 'done' || supervise.status !== 'done') throw Error('takt_review_not_approved');
 return { status: 'approved' as const, runSlug: meta.runSlug, iterations: meta.iterations };
}
