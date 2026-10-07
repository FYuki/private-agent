import { parseArgs } from 'node:util';
import { readFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { reviewProject, isolateReviewEnvironment } from './project.mjs';
import { prepareReview, repository, taktRoot } from './prepare.mjs';

try {
  const { values } = parseArgs({ options: {
    development: { type: 'string' }, project: { type: 'string' },
    'task-file': { type: 'string' }, config: { type: 'string' },
    run: { type: 'boolean', default: false },
  } });
  if (!['external', 'takt'].includes(values.development) || !values.project || !values['task-file']) {
    throw Error('Usage: npm run review:prepare -- --development external|takt --project /path/to/worktree --task-file /path/to/task.txt [--config /path/to/config-directory] [--run]');
  }
  const project = reviewProject(values.project);
  isolateReviewEnvironment();
  const task = readFileSync(resolve(values['task-file']), 'utf8');
  if (!task.trim()) throw Error('Task file must describe the requirements and review diff/base');
  const runs = join(repository, '.local/review-runs');
  mkdirSync(runs, { recursive: true, mode: 0o700 });
  const runDir = mkdtempSync(join(runs, 'run-'));
  const prepared = await prepareReview({ output: join(runDir, 'config'), ...(values.config ? { input: resolve(values.config) } : {}) });
  process.env.TAKT_CONFIG_DIR = prepared.configDir;
  const workflow = join(prepared.configDir, 'workflows', `${prepared.workflows[values.development]}.yaml`);
  const { loadWorkflowByIdentifier } = await import('../runtime/takt/node_modules/takt/dist/infra/config/loaders/workflowLoader.js');
  if (!loadWorkflowByIdentifier(workflow, project)) throw Error('Workflow could not be loaded');
  console.log(JSON.stringify({ prepared: true, development: values.development, runDir, workflow, execute: values.run }));
  if (values.run) {
    const result = spawnSync(process.execPath, [join(taktRoot, 'dist/app/cli/index.js'), '--pipeline', '--skip-git', '--workflow', workflow, '--task', task], {
      cwd: project, env: { ...process.env, PK_MEMORY_HOOKS: '0' }, stdio: 'inherit',
    });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
