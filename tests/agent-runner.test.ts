import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { invokeAgentFixture } from '../wsl-worker/agent-runner.ts';
import type { Run } from '../shared/contracts.ts';
test('generic queue adapter reuses completed run across attempt changes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-runner-'));
  const run = { id: 'job:0', owner: 'local', provider: 'agent-fixture', prompt: 'fixture', agent: { characterId: 'bob', toolset: 'fixture-v1' } } as Run;
  const deadline = () => process.hrtime.bigint() + 30000000000n;
  try {
    assert.equal(await invokeAgentFixture(run, new AbortController().signal, deadline(), join(dir, 'state.db')), 'bob: 5');
    assert.equal(await invokeAgentFixture({ ...run, attempt: 2 }, new AbortController().signal, deadline(), join(dir, 'state.db')), 'bob: 5');
    await assert.rejects(invokeAgentFixture({ ...run, agent: { characterId: '../x', toolset: 'fixture-v1' } }, new AbortController().signal, deadline(), join(dir, 'state.db')));
  } finally { rmSync(dir, { recursive: true }); }
});
