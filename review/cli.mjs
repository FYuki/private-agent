import { parseArgs } from 'node:util';
import { readFileSync, mkdirSync, mkdtempSync, existsSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
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
  const project = realpathSync(resolve(values.project));
  const gitRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: project, encoding: 'utf8' }).trim();
  if (realpathSync(gitRoot) !== project) throw Error('--project must be the Git worktree root');
  execFileSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: project, stdio: 'ignore' });
  // project側の同名workflow/fragmentやoverrideで必須レビューを取り除けないよう、曖昧な合成を拒否する。
  for (const name of ['config.yaml', 'runtime.yaml', 'workflows', 'steps', 'facets', 'companions', 'facet-pools']) {
    if (existsSync(join(project, '.takt', name))) throw Error(`Project .takt/${name} must be isolated before running this review entry`);
  }
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('TAKT_')) delete process.env[key];
  }
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
