import test from 'node:test';
import assert from 'node:assert/strict';
import { runChildIssue, assertReviewApproval } from '../../review/child-issue.mjs';

const context = { project: '/fixture', repo: 'owner/repo', issue: 42, epic: 'epic/feature', branch: 'feature/issue-42', development: 'takt' };
test('implementation completion automatically reviews and publishes to Epic in the same worktree', async () => {
  const calls = [];
  await runChildIssue(context, {
    async execute(c) { calls.push(['execute', c.project]); return { approved: true }; },
    async publish(c) { calls.push(['publish', c.branch, c.epic]); return { url: 'fixture' }; },
  });
  assert.deepEqual(calls, [['execute', '/fixture'], ['publish', 'feature/issue-42', 'epic/feature']]);
});
test('failed review and main base never publish', async () => {
  let writes = 0;
  const deps = { async execute() { return { approved: false }; }, async publish() { writes++; } };
  await assert.rejects(runChildIssue(context, deps), /review_not_approved/);
  await assert.rejects(runChildIssue({ ...context, epic: 'main' }, deps), /epic/);
  assert.equal(writes, 0);
});
test('workflow success alone is insufficient: final quality and gate must approve', () => {
  assert.throws(() => assertReviewApproval({success: true}, [], 'fixture'), /review_not_approved/);
});

test('later REJECT invalidates earlier approval', () => {
  const events = [
    { type: 'workflow_start', workflowName: 'fixture' },
    { type: 'phase_complete', step: 'quality-review', phase: 3, status: 'done', content: 'approved' },
    { type: 'step_complete', workflow: 'peer-review', step: 'final-gate', status: 'done', matchedRuleIndex: 0 },
    { type: 'workflow_complete' },
  ];
  assert.deepEqual(assertReviewApproval({ success: true }, events, 'fixture'), { approved: true });
  assert.throws(() => assertReviewApproval({ success: true }, [...events.slice(0, -1), { ...events[2], matchedRuleIndex: 1 }, events.at(-1)], 'fixture'), /review_not_approved/);
});

test('an implementation process failure prevents review/publication continuation', async () => {
  let published = false;
  await assert.rejects(runChildIssue({ ...context, development: 'external' }, {
    async execute() { throw Error('implementation_failed'); },
    async publish() { published = true; },
  }), /implementation_failed/);
  assert.equal(published, false);
});
