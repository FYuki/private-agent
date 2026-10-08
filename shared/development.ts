import { Fault, exact, object, str, integer } from './contracts.ts';
import { repositoryPolicy } from './repositories.ts';

export const DEVELOPMENT_BUDGET_MS = 15 * 60 * 1000;
export const DEVELOPMENT_MAX_BUDGET_MS = 24 * 60 * 60 * 1000;
export const DEVELOPMENT_DEFAULTS = { orchestratorProfileId: 'programmatic', executionProfileId: 'takt-simple' } as const;
export const DEVELOPMENT_PROFILES = {
  orchestrators: [
    { id: 'programmatic', model: null, capacityKey: null, available: true, reason: null },
    { id: 'plan-codex-luna', model: 'gpt-6-luna', capacityKey: 'codex-luna', available: true, reason: null },
    { id: 'plan-claude', model: null, capacityKey: null, available: false, reason: 'claude_profile_not_verified' },
  ],
  executors: [
    { id: 'takt-simple', model: 'gpt-6-sol + gpt-6-luna', capacityKey: 'takt-simple', available: true, reason: null },
    { id: 'takt-watch', model: 'Sol plan job (gpt-6-sol / gpt-6.1-sol) + internal Sol/Luna', capacityKey: 'takt-watch', available: false, reason: 'watch_runtime_validation_pending' },
    { id: 'edit-codex-luna', model: 'gpt-6-luna', capacityKey: 'codex-luna', available: true, reason: null },
    { id: 'edit-claude', model: null, capacityKey: null, available: false, reason: 'claude_profile_not_verified' },
  ],
};
export type DevelopmentWatch = { issue: number; workflow: 'default'|'simple'|'private-agent-child-issue'; validation: string[]; dependencies: string[] };
export type DevelopmentInput = { repoId: string; goal: string; baseRef: string; acceptanceCriteria: string[]; orchestratorProfileId: string; executionProfileId: string; budgetMs?: number; watch?: DevelopmentWatch };
/** GUI/MCP共通の入力境界。選択可能な管理profileとrepo/baseだけを許可し、利用不能はfallbackしない。 */
export function developmentInput(value: unknown, options: {allowWatchTest?:boolean} = {}): DevelopmentInput {
  const v = object(value); exact(v, ['repoId', 'goal', 'baseRef', 'acceptanceCriteria', 'orchestratorProfileId', 'executionProfileId', 'budgetMs', 'watch']);
  const repository = repositoryPolicy(v.repoId);
  if (v.baseRef !== repository.baseRef) throw new Fault(400, 'base_ref_not_allowed');
  const orchestratorProfileId = v.orchestratorProfileId ?? DEVELOPMENT_DEFAULTS.orchestratorProfileId;
  const executionProfileId = v.executionProfileId ?? DEVELOPMENT_DEFAULTS.executionProfileId;
  const takt = executionProfileId === 'takt-simple' || executionProfileId === 'takt-watch';
  if(v.repoId==='local-GPT-live'&&!takt)throw new Fault(400,'repository_requires_takt');
  if (takt !== (orchestratorProfileId === 'programmatic')) throw new Fault(400, 'orchestration_profile_mismatch');
  const budgetMs = takt ? integer(v.budgetMs ?? 14400000, 60000, DEVELOPMENT_MAX_BUDGET_MS) : undefined;
  if (!takt && v.budgetMs !== undefined) throw new Fault(400, 'unsupported_budget_override');
  for (const [id, profiles] of [[orchestratorProfileId, DEVELOPMENT_PROFILES.orchestrators], [executionProfileId, DEVELOPMENT_PROFILES.executors]] as const) {
    const selected = profiles.find(p => p.id === id);
    if (!selected) throw new Fault(400, 'unknown_development_profile');
    if (!selected.available && !(selected.id==='takt-watch'&&options.allowWatchTest===true)) throw new Fault(409, selected.reason!);
  }
  let watch: DevelopmentWatch | undefined;
  if (executionProfileId === 'takt-watch') {
    const w=object(v.watch); exact(w,['issue','workflow','validation','dependencies']);
    const workflow=w.workflow===undefined?'default':w.workflow;
    if(workflow!=='default'&&workflow!=='simple'&&workflow!=='private-agent-child-issue')throw new Fault(400,'invalid_watch_workflow');
    if(!Array.isArray(w.validation)||w.validation.length<1||w.validation.length>20)throw new Fault(400,'invalid_watch_validation');
    const dependencies=w.dependencies===undefined?[]:w.dependencies;
    if(!Array.isArray(dependencies)||dependencies.length>16||dependencies.some(x=>typeof x!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(x))||new Set(dependencies).size!==dependencies.length)throw new Fault(400,'invalid_watch_dependencies');
    watch={issue:integer(w.issue,1,Number.MAX_SAFE_INTEGER),workflow,validation:w.validation.map(x=>str(x,2048)),dependencies:[...dependencies].sort()};
  } else if(v.watch!==undefined)throw new Fault(400,'unsupported_watch_options');
  if (!Array.isArray(v.acceptanceCriteria) || v.acceptanceCriteria.length < 1 || v.acceptanceCriteria.length > 8) throw new Fault(400, 'invalid_acceptance_criteria');
  return { repoId: v.repoId as string, goal: str(v.goal, 4096), baseRef: repository.baseRef, acceptanceCriteria: v.acceptanceCriteria.map(x => str(x, 512)), orchestratorProfileId: orchestratorProfileId as string, executionProfileId: executionProfileId as string, ...(budgetMs ? {budgetMs} : {}), ...(watch ? {watch} : {}) };
}
