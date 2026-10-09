import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { prepareReview } from '../../review/prepare.mjs';
import { reviewProject } from '../../review/project.mjs';
import { acceptedChildReviewResult } from '../../development/watch-review-acceptance.ts';
import { assertReviewApproval } from '../../review/child-issue.mjs';

test('official execution API emits the evidence used by the automatic publication gate', { timeout: 90000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'child-api-'));
  const savedEnv = { ...process.env };
  try {
    execFileSync('git', ['init', '-q', dir]);
    execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture'], { cwd: dir });
    const prepared = await prepareReview({ output: join(dir, 'config') });
    writeFileSync(join(prepared.configDir, 'runtime.yaml'), 'version: 1\ncompanion:\n  enabled: false\nprovider:\n  defaults:\n    profile: fixture\n  profiles:\n    fixture:\n      provider: mock\n      model: mock\n');
    process.env.TAKT_CONFIG_DIR = prepared.configDir;
    const { setMockScenario } = await import('../../runtime/takt/node_modules/takt/dist/infra/mock/index.js');
    setMockScenario([
      ...[1, 1, 1, 1, 2, 1, 1, 2, 1].map(step => ({ persona: 'conductor', status: 'done', content: '', structuredOutput: { step, reason: 'fixture' } })),
      ...Array.from({length: 4}, () => ({persona: 'dynamic-facet-selector', status: 'done', content: '', structuredOutput: {selected_ids: [], rationale: 'fixture'}})),
    ]);
    const { executeTaskWithResult } = await import('../../runtime/takt/node_modules/takt/dist/features/tasks/execute/taskExecution.js');
    const result = await executeTaskWithResult({
      cwd: dir, projectCwd: dir, task: 'fixture child issue', outputMode: 'silent',
      workflowIdentifier: join(prepared.configDir, 'workflows', `${prepared.workflows.child}.yaml`),
      interactiveUserInput: false, runPathsDirectory: join(dir, 'runs'), sessionStorageDirectory: join(dir, 'sessions'),
    });
    assert.equal(result.success, true, JSON.stringify(result));
    assert.ok(result.ndjsonLogPath);
    assert.equal(reviewProject(dir), dir);
    const events = readFileSync(result.ndjsonLogPath, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
    assert.deepEqual(assertReviewApproval(result, events, prepared.workflows.child), { approved: true });
    const {loadWorkflow,resolveWorkflowCallTarget}=await import('../../runtime/takt/node_modules/takt/dist/infra/config/loaders/workflowLoader.js');
    const {getWorkflowReference}=await import('../../runtime/takt/node_modules/takt/dist/core/workflow/workflow-reference.js');
    const child=loadWorkflow(prepared.workflows.child,dir),fix=resolveWorkflowCallTarget(child,child.steps.at(-1),dir);
    const peer=resolveWorkflowCallTarget(fix,fix.steps.at(-1),dir),quality=resolveWorkflowCallTarget(peer,peer.steps[0],dir);
    const expected={task:'fixture child issue',references:Object.fromEntries(Object.entries({child,fix,peer,quality}).map(([k,v])=>[k,getWorkflowReference(v)]))};
    const meta={task:expected.task,workflow:child.name,status:'completed',startTime:events[0].startTime,endTime:'fixture-end'};
    assert.equal(acceptedChildReviewResult(meta,events,expected).status,'approved');
    for(const mutate of [
      e=>e.findLast(x=>x.step==='quality-review'&&x.type==='phase_complete'&&x.phase===3).content='needs_fix',
      e=>e.findLast(x=>x.step==='final-gate'&&x.type==='step_complete').matchedRuleIndex=1,
      e=>e.findLast(x=>x.step==='quality-review'&&x.type==='phase_complete'&&x.phase===3).stack[1].occurrence++,
      e=>e.findLast(x=>x.type==='workflow_call_complete').returnValue='need_replan',
      e=>e.splice(-1,0,{type:'workflow_abort'}),
      e=>e.findLast(x=>x.step==='supervise'&&x.type==='step_complete').matchedRuleIndex=0,
    ]) {const invalid=structuredClone(events);mutate(invalid);assert.throws(()=>acceptedChildReviewResult(meta,invalid,expected),/not_approved/);}

    const completed = events.filter(e => e.type === 'step_complete').map(e => e.step);
    assert.ok(completed.indexOf('supervise') < completed.indexOf('final-gate'));
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
    rmSync(dir, { recursive: true, force: true });
  }
});
