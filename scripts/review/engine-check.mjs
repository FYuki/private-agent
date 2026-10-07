import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { prepareReview } from '../../review/prepare.mjs';
const dir = mkdtempSync(join(tmpdir(), 'quality-engine-'));
try {
  execFileSync('git', ['init', '-q', dir]);
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture'], {cwd: dir});
  const prepared = await prepareReview({ output: join(dir, 'config') });
  process.env.TAKT_CONFIG_DIR = prepared.configDir;
  process.env.TAKT_MOCK_CALL_LOG = join(dir, 'calls.jsonl');
  const { loadWorkflow, resolveWorkflowCallTarget } = await import('../../runtime/takt/node_modules/takt/dist/infra/config/loaders/workflowLoader.js');
  const { WorkflowEngine } = await import('../../runtime/takt/node_modules/takt/dist/core/workflow/engine/WorkflowEngine.js');
  const { setMockScenario } = await import('../../runtime/takt/node_modules/takt/dist/infra/mock/index.js');
  const decisions = new Map();
  let scenario;
  // 判定だけをstub化し、選択・report・修正・子workflow・遷移は公式Engineを通す。
  // 検出精度を測るfixtureではなく、ループと必須実行の契約試験。
  const structuredCaller = {
    async judgeStatus(_instruction, _tag, candidates, options) {
      options.onStructuredPromptResolved?.({systemPrompt: 'fixture', userInstruction: _instruction});
      const name = options.stepName;
      const count = (decisions.get(name) ?? 0) + 1;
      decisions.set(name, count);
      let index = 0;
      if (name === 'quality-review') index = count === 1 ? 1 : 0;
      if (name === 'review-adjudication') index = count === 1 ? 0 : 1;
      if (name === 'final-gate') index = scenario === 'blocked' ? 2 : count === 1 ? 1 : 0;
      assert.ok(candidates[index], `Missing rule for ${name}`);
      return { candidateIndex: index, method: 'structured_output' };
    },
    async evaluateCondition() { throw Error('Unexpected condition evaluation'); },
    async decomposeTask() { throw Error('Unexpected decomposition'); },
    async requestMoreParts() { throw Error('Unexpected decomposition'); },
  };
  for (const [route, mode] of [['external', 'empty-pool'], ['takt', 'empty-pool'], ['external', 'selected'], ['takt', 'blocked'], ['external', 'invalid-selection']]) {
    scenario = mode;
    decisions.clear();
    setMockScenario(['dynamic-parallel-selector', 'dynamic-facet-selector'].flatMap(persona =>
      Array.from({ length: 10 }, () => ({ persona, status: 'done', content: '', structuredOutput: { selected_ids: persona === 'dynamic-parallel-selector' ? (mode === 'selected' ? ['backend-review'] : mode === 'invalid-selection' ? ['quality-review'] : []) : [], rationale: 'fixture: fixed reviewers remain mandatory' } }))));
    const workflow = loadWorkflow(prepared.workflows[route], dir);
    const engine = new WorkflowEngine(workflow, dir, 'Review the fixture change; preserve the public contract.', {
      projectCwd: dir, provider: 'mock', language: 'ja',
      selectorProvider: { provider: 'mock' }, structuredCaller,
      selectorGitCommandRunner: { async run(cwd, args) { return {output: execFileSync('git', args, {cwd})}; } },
      companionEnabled: false, reportDirName: `fixture-${route}-${mode}`,
      workflowCallResolver: ({ parentWorkflow, step }) => resolveWorkflowCallTarget(parentWorkflow, step, dir),
    });
    engine.on('workflow:abort', (_state, reason) => console.error(reason));
    engine.on('step:error', (...args) => console.error('step:error', args));
    const state = await engine.run();
    console.log(`${route}/${mode}: ${state.status}`);
    if (mode === 'blocked' || mode === 'invalid-selection') {
      assert.equal(state.status, 'aborted');
      assert.equal(decisions.get('final-gate') ?? 0, mode === 'blocked' ? 1 : 0);
      assert.equal(decisions.get('quality-review') ?? 0, mode === 'blocked' ? 2 : 0);
      continue;
    }
    assert.equal(state.status, 'completed');
    assert.equal(decisions.get('quality-review'), 3, 'initial rejection and final-gate rejection both require re-review');
    assert.equal(decisions.get('fix'), 2);
    assert.equal(decisions.get('fix-verifier'), 2);
    assert.equal(decisions.get('final-gate'), 2);
    assert.equal(decisions.has('ai-antipattern-review'), route === 'external');
    assert.equal(decisions.has('backend-review'), mode === 'selected');
  }
  const calls = readFileSync(process.env.TAKT_MOCK_CALL_LOG, 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(calls.filter(c => c.event === 'start').every(c => c.provider === 'mock'));
  console.log('Official review-fix mock engine: PASS');
} finally { rmSync(dir, { recursive: true, force: true }); }
