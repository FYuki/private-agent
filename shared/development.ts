import { Fault, exact, object, str } from './contracts.ts';

export const DEVELOPMENT_BUDGET_MS = 15 * 60 * 1000;
export const DEVELOPMENT_DEFAULTS = { orchestratorProfileId: 'plan-codex-luna', executionProfileId: 'edit-codex-luna' } as const;
export const DEVELOPMENT_PROFILES = {
  orchestrators: [
    { id: 'plan-codex-luna', model: 'gpt-6-luna', capacityKey: 'codex-luna', available: true, reason: null },
    { id: 'plan-claude', model: null, capacityKey: null, available: false, reason: 'claude_profile_not_verified' },
  ],
  executors: [
    { id: 'edit-codex-luna', model: 'gpt-6-luna', capacityKey: 'codex-luna', available: true, reason: null },
    { id: 'edit-claude', model: null, capacityKey: null, available: false, reason: 'claude_profile_not_verified' },
  ],
};
export type DevelopmentInput = { repoId: string; goal: string; baseRef: string; acceptanceCriteria: string[]; orchestratorProfileId: string; executionProfileId: string };
/** GUI/MCP共通の入力境界。選択可能な管理profileとrepo/baseだけを許可し、利用不能はfallbackしない。 */
export function developmentInput(value: unknown): DevelopmentInput {
  const v = object(value); exact(v, ['repoId', 'goal', 'baseRef', 'acceptanceCriteria', 'orchestratorProfileId', 'executionProfileId']);
  if (v.repoId !== 'private-agent') throw new Fault(400, 'repository_not_allowed');
  if (v.baseRef !== 'epic/development-runner') throw new Fault(400, 'base_ref_not_allowed');
  const orchestratorProfileId = v.orchestratorProfileId ?? DEVELOPMENT_DEFAULTS.orchestratorProfileId;
  const executionProfileId = v.executionProfileId ?? DEVELOPMENT_DEFAULTS.executionProfileId;
  for (const [id, profiles] of [[orchestratorProfileId, DEVELOPMENT_PROFILES.orchestrators], [executionProfileId, DEVELOPMENT_PROFILES.executors]] as const) {
    const selected = profiles.find(p => p.id === id);
    if (!selected) throw new Fault(400, 'unknown_development_profile');
    if (!selected.available) throw new Fault(409, selected.reason!);
  }
  if (!Array.isArray(v.acceptanceCriteria) || v.acceptanceCriteria.length < 1 || v.acceptanceCriteria.length > 8) throw new Fault(400, 'invalid_acceptance_criteria');
  return { repoId: v.repoId, goal: str(v.goal, 4096), baseRef: v.baseRef, acceptanceCriteria: v.acceptanceCriteria.map(x => str(x, 512)), orchestratorProfileId: orchestratorProfileId as string, executionProfileId: executionProfileId as string };
}
