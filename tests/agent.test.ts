import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAgent } from '../agent/loop.ts';
import { SqliteRunStore } from '../agent/store.ts';
import type { AgentTask, ModelGateway, ModelReply, ToolExecutor } from '../agent/contracts.ts';
const task: AgentTask = { owner: 'owner', runId: 'run', characterId: 'alice', goal: 'test', allowedTools: ['lookup'] };
const call = (id = 'c1', args = '{"key":"x"}'): ModelReply => ({ content: null, toolCalls: [{ id, name: 'lookup', arguments: args }] });
const final: ModelReply = { content: 'done', toolCalls: [] };
const tool = (execute: ToolExecutor['execute'], effect: 'read' | 'write' = 'read'): ToolExecutor => ({ definition: { name: 'lookup', description: 'fixture', parameters: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'], additionalProperties: false } }, version: '1', effect, execute });
function sequence(...replies: ModelReply[]): ModelGateway { return { async complete() { return replies.shift() || final; } }; }
test('character swap, tool result and persistent semantic deduplication', async () => {
  const store = new SqliteRunStore(':memory:'); let calls = 0, turn = 0;
  try {
    const gateway: ModelGateway = { async complete(input) {
      assert.equal(input.characterId, 'alice');
      if (turn++ < 2) return call('c' + turn);
      assert.equal(input.messages.filter(m => m.role === 'tool').length, 2); return final;
    } };
    const deps = { store, gateway, tools: [tool(async () => { calls++; return { value: 5 }; }, 'write')] };
    assert.equal((await runAgent(task, deps)).state, 'completed'); assert.equal(calls, 1);
    assert.equal((await runAgent(task, deps)).state, 'completed'); assert.equal(calls, 1);
    assert.equal((await runAgent({ ...task, runId: 'other', characterId: 'bob' }, { ...deps, gateway: { async complete(i) { assert.equal(i.characterId, 'bob'); return final; } } })).state, 'completed');
  } finally { store.close(); }
});
test('schema and permission checks never execute invalid calls', async () => {
  for (const allowedTools of [[], ['lookup']]) {
    const store = new SqliteRunStore(':memory:'); let calls = 0;
    try { await runAgent({ ...task, allowedTools }, { store, gateway: sequence(call('c', '{"key":1}'), final), tools: [tool(async () => ++calls)] }); assert.equal(calls, 0); } finally { store.close(); }
  }
});
test('write failure is uncertain; read failure returns bounded feedback', async () => {
  for (const effect of ['read', 'write'] as const) {
    const store = new SqliteRunStore(':memory:');
    try { const result = await runAgent(task, { store, gateway: sequence(call(), final), tools: [tool(async () => { throw new Error('SECRET'); }, effect)] }); assert.equal(result.state, effect === 'write' ? 'blocked' : 'completed'); assert.ok(!JSON.stringify(result).includes('SECRET')); } finally { store.close(); }
  }
});
test('turn, tool and duration limits stop execution', async () => {
  for (const limits of [{ maxTurns: 1 }, { maxToolCalls: 1 }, { maxDurationMs: 10 }]) {
    const store = new SqliteRunStore(':memory:');
    try { const result = await runAgent({ ...task, limits }, { store, gateway: limits.maxDurationMs ? { complete: () => new Promise(() => {}) } : sequence(call(), call('c2'), final), tools: [tool(async () => 'ok')] }); assert.notEqual(result.state, 'completed'); } finally { store.close(); }
  }
});
test('cancel before execution and conflicting call identity fail closed', async () => {
  const store = new SqliteRunStore(':memory:');
  try {
    const controller = new AbortController(); controller.abort();
    assert.equal((await runAgent(task, { store, gateway: sequence(final), tools: [tool(async () => 'ok')] }, controller.signal)).state, 'stopped');
    const result = await runAgent({ ...task, runId: 'conflict' }, { store, gateway: sequence(call(), call('c1', '{"key":"y"}')), tools: [tool(async () => 'ok')] });
    assert.equal(result.error, 'tool_call_conflict');
  } finally { store.close(); }
});
test('restart does not replay an uncertain side effect and owner fencing holds', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-')); const file = join(dir, 'state.db');
  let store = new SqliteRunStore(file);
  try { const a = store.acquire('o/r', 'f'); assert.equal(a.kind, 'acquired'); if (a.kind !== 'acquired') return;
    store.reserve('o/r', a.token, 'effect', 'call', 'f');
    assert.throws(() => store.reserve('other/r', a.token, 'effect', 'call', 'f'));
    store.close(); store = new SqliteRunStore(file); assert.equal(store.acquire('o/r', 'f').kind, 'busy');
    assert.equal(store.reserve('o/r', a.token, 'effect', 'call', 'f').kind, 'uncertain');
  } finally { store.close(); rmSync(dir, { recursive: true }); }
});
test('synchronous provider cannot bypass deadline or final transcript budget', async () => {
  for (const limits of [{ maxDurationMs: 5 }, { maxTranscriptBytes: 100 }]) {
    const store = new SqliteRunStore(':memory:');
    try { const result = await runAgent({ ...task, limits }, { store, tools: [tool(async () => 'ok')], gateway: { async complete() {
      if (limits.maxDurationMs) { const end = performance.now() + 15; while (performance.now() < end) {} }
      return { content: 'x'.repeat(1000), toolCalls: [] };
    } } }); assert.notEqual(result.state, 'completed'); } finally { store.close(); }
  }
});
test('new read call observes fresh data; repeated call ID reuses its result', async () => {
  const store = new SqliteRunStore(':memory:'); let calls = 0;
  try { await runAgent(task, { store, gateway: sequence(call(), call('c2'), call('c2'), final), tools: [tool(async () => ++calls)] }); assert.equal(calls, 2); } finally { store.close(); }
});
