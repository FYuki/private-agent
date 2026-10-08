import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareReview } from '../../review/prepare.mjs';

test('isolated review-fix routes retain the upstream loop and mandatory reviewer', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'review-contract-'));
  try {
    const result = await prepareReview({ output: join(dir, 'config') });
    process.env.TAKT_CONFIG_DIR = result.configDir;
    const { loadWorkflow, resolveWorkflowCallTarget } = await import('../../runtime/takt/node_modules/takt/dist/infra/config/loaders/workflowLoader.js');
    for (const route of ['external', 'takt']) {
      const workflow = loadWorkflow(result.workflows[route], dir);
      assert.equal(workflow.initialStep, 'gather');
      const peer = resolveWorkflowCallTarget(workflow, workflow.steps.find(s => s.name === 'reviewers'), dir);
      assert.equal(peer.name, 'peer-review');
      for (const name of ['initial-reviewers', 'reviewers']) {
        const suite = resolveWorkflowCallTarget(peer, peer.steps.find(s => s.name === name), dir);
        const review = suite.steps[0];
        const participants = review.parallel?.fixed ?? review.parallel;
        const quality = participants.find(s => s.name === 'quality-review');
        assert.ok(quality);
        assert.equal(quality.edit, false);
        assert.match(readFileSync(quality.personaPath, 'utf8'), /独立したコードレビュアー/);
        assert.match(quality.instruction, /再レビュー/);
        const report = quality.outputContracts.find(r => r.name === 'quality-review.md');
        assert.ok(report);
        assert.match(report.format, /finding_id/);
        assert.doesNotMatch(report.format, /\{\{include:/);
        if (route === 'external') assert.ok(review.parallel.pool.length >= 6);
        else assert.deepEqual(participants.map(s => s.name), ['quality-review']);
      }
      assert.ok(peer.steps.find(s => s.name === 'final-gate').rules.some(r => r.condition.label === 'REJECT' && r.next === 'remediation'));
    }
    assert.equal(JSON.parse(readFileSync(join(result.configDir, 'manifest.json'))).taktVersion, '0.68.0');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
