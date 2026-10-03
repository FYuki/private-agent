import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { CoreGateway } from '../agent/core-gateway.ts';
import { runAgent } from '../agent/loop.ts';
import { SqliteRunStore } from '../agent/store.ts';

// 明示的に起動したCoreとの結合確認専用。CIでは自動実行しない。
const endpoint = process.env.CORE_URL, character = process.env.CORE_CHARACTER;
if (!endpoint || !character) throw new Error('CORE_URL and CORE_CHARACTER must be explicit');
const gateway = new CoreGateway(endpoint), store = new SqliteRunStore(':memory:');
let executed = 0;
try {
  const result = await runAgent({ owner: 'integration', runId: crypto.randomUUID(), characterId: character,
    goal: 'Synthetic integration check: call fixture_ping, then acknowledge its result. Do not take any other action.', allowedTools: ['fixture_ping'] }, {
    gateway, store, tools: [{ definition: { name: 'fixture_ping', description: 'Return a synthetic constant', parameters: {
      type: 'object', additionalProperties: false,
    } }, version: '1', effect: 'read', async execute() { executed++; return { value: 5 }; } }],
  });
  assert.equal(result.state, 'completed'); assert.equal(executed, 1, 'Core did not request exactly one synthetic tool'); assert.equal(result.final, 'fixture tool result received');
  const evidence = { at: new Date().toISOString(), character, mode: 'actual localhost Core fixture service + private-agent + synthetic read-only tool; no live LLM', state: result.state, turns: result.turns, toolCalls: result.toolCalls, executed, finalAcknowledged: true };
  await mkdir('.local/evidence', { recursive: true });
  await writeFile(`.local/evidence/core-join-${character}.json`, JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
} finally { store.close(); }
