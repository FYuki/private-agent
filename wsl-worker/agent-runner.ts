import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { runAgent } from '../agent/loop.ts';
import { SqliteRunStore } from '../agent/store.ts';
import type { ModelGateway, ToolExecutor } from '../agent/contracts.ts';
import { agentSpec, type Run } from '../shared/contracts.ts';

// 合成専用。任意のコマンド、実ファイル、ネットワークへアクセスするツールは登録しない。
export async function invokeAgentFixture(run: Run, signal: AbortSignal, deadlineNs: bigint, statePath: string): Promise<string> {
  if (run.provider !== 'agent-fixture' || !isAbsolute(statePath)) throw new Error('invalid_agent_configuration');
  const spec = agentSpec(run.agent);
  const remaining = Math.min(30000, Math.floor(Number(deadlineNs - process.hrtime.bigint()) / 1000000));
  if (remaining < 1 || signal.aborted) throw new Error('timeout');
  const gateway: ModelGateway = { async complete(input) {
    const result = input.messages.find(m => m.role === 'tool');
    return result ? { content: `${input.characterId}: ${JSON.parse(result.content!).data.value}`, toolCalls: [] }
      : { content: null, toolCalls: [{ id: 'fixture_sum', name: 'sum', arguments: '{"a":2,"b":3}' }] };
  } };
  const sum: ToolExecutor = { definition: { name: 'sum', description: '合成の足し算', parameters: {
    type: 'object', properties: { a: { type: 'integer', minimum: -100, maximum: 100 }, b: { type: 'integer', minimum: -100, maximum: 100 } }, required: ['a', 'b'], additionalProperties: false,
  } }, version: '1', effect: 'read', async execute(args) { return { value: (args.a as number) + (args.b as number) }; } };
  const hash = (text: string) => createHash('sha256').update(text).digest('hex');
  const store = new SqliteRunStore(statePath);
  try {
    const result = await runAgent({ owner: hash(run.owner), runId: hash(run.id), characterId: spec.characterId,
      goal: run.prompt, allowedTools: ['sum'], limits: { maxDurationMs: 30000 } }, { gateway, tools: [sum], store },
      AbortSignal.any([signal, AbortSignal.timeout(remaining)]));
    if (result.state !== 'completed') throw new Error(result.state === 'stopped' ? 'cancelled' : 'provider_failed');
    if (signal.aborted || process.hrtime.bigint() >= deadlineNs) throw new Error('timeout');
    return result.final!;
  } finally { store.close(); }
}
