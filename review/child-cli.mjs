import { parseArgs } from 'node:util';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { prepareReview, repository } from './prepare.mjs';
import { reviewProject, isolateReviewEnvironment } from './project.mjs';
import { runChildIssue, assertReviewApproval, validateChildContext } from './child-issue.mjs';
import { gitAt, verifyChildBranch, publishChildIssue } from './child-publish.mjs';

let lock;
try {
  const { values } = parseArgs({ options: {
    project: { type: 'string' }, repo: { type: 'string' }, issue: { type: 'string' },
    epic: { type: 'string' }, branch: { type: 'string' }, development: { type: 'string', default: 'takt' },
    'task-file': { type: 'string' }, config: { type: 'string' },
    'implementation-command': { type: 'string' }, 'resume-publication': { type: 'string' },
    run: { type: 'boolean', default: false },
  } });
  isolateReviewEnvironment();
  const resumed = values['resume-publication'] ? resolve(values['resume-publication']) : undefined;
  const context = resumed ? JSON.parse(readFileSync(join(resumed, 'approved.json'), 'utf8')).context : {
    project: reviewProject(values.project ?? ''), repo: values.repo, issue: Number(values.issue),
    epic: values.epic, branch: values.branch, development: values.development,
  };
  validateChildContext(context);
  reviewProject(context.project);
  verifyChildBranch(context);
  const runs = join(repository, '.local/child-issue-runs');
  mkdirSync(runs, { recursive: true, mode: 0o700 });
  if (values.run) {
    const candidate = join(runs, createHash('sha256').update(context.project).digest('hex') + '.lock');
    mkdirSync(candidate, { mode: 0o700 });
    lock = candidate;
  }
  if (resumed) {
    if (!values.run) throw Error('--resume-publication requires --run');
    console.log(JSON.stringify(await publishChildIssue(context, resumed)));
  } else {
    if (!values['task-file']) throw Error('--task-file is required');
    const task = readFileSync(resolve(values['task-file']), 'utf8');
    if (!task.trim()) throw Error('task_required');
    const implementation = values['implementation-command'] ? JSON.parse(values['implementation-command']) : undefined;
    if (context.development === 'external' && (!Array.isArray(implementation) || !implementation.length || implementation.some(x => typeof x !== 'string' || !x))) throw Error('external_development_requires_implementation_command_argv');
    if (context.development === 'takt' && implementation) throw Error('takt_development_uses_builtin_simple');
    const runDir = mkdtempSync(join(runs, 'run-'));
    const prepared = await prepareReview({ output: join(runDir, 'config'), ...(values.config ? { input: resolve(values.config) } : {}) });
    process.env.TAKT_CONFIG_DIR = prepared.configDir;
    const name = context.development === 'takt' ? prepared.workflows.child : prepared.workflows.external;
    const workflow = join(prepared.configDir, 'workflows', `${name}.yaml`);
    const { loadWorkflowByIdentifier } = await import('../runtime/takt/node_modules/takt/dist/infra/config/loaders/workflowLoader.js');
    if (!loadWorkflowByIdentifier(workflow, context.project)) throw Error('workflow_missing');
    writeFileSync(join(runDir, 'context.json'), JSON.stringify(context, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ runDir, workflow, ...context, execute: values.run }));
    if (values.run) {
      const git = args => gitAt(context.project, args);
      git(['fetch', '--no-tags', 'origin', `refs/heads/${context.epic}`]);
      const baseSha = git(['rev-parse', 'FETCH_HEAD']);
      git(['merge-base', '--is-ancestor', baseSha, 'HEAD']);
      const result = await runChildIssue(context, {
        async execute() {
          // 非TAKTも同じ入口で実装プロセスの成功終了を待ってからレビューを開始する。
          if (implementation) execFileSync(implementation[0], implementation.slice(1), { cwd: context.project, stdio: 'inherit', env: process.env });
          reviewProject(context.project);
          verifyChildBranch(context);
          const { executeTaskWithResult } = await import('../runtime/takt/node_modules/takt/dist/features/tasks/execute/taskExecution.js');
          const outcome = await executeTaskWithResult({
            cwd: context.project, projectCwd: context.project, workflowIdentifier: workflow,
            task: `子Issue #${context.issue}。対象差分のbase SHA: ${baseSha}。PR先: ${context.epic}。commit/push/PR作成はホストが担当する。\n${task}`,
            interactiveUserInput: false, currentTaskIssueNumber: context.issue,
            runPathsDirectory: join(runDir, 'runs'), sessionStorageDirectory: join(runDir, 'sessions'),
          });
          if (!outcome.ndjsonLogPath) throw Error('review_evidence_missing');
          const events = readFileSync(outcome.ndjsonLogPath, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
          const approved = assertReviewApproval(outcome, events, name);
          reviewProject(context.project);
          verifyChildBranch(context);
          // run記録はworktree外。TAKTの既存safe Git処理で同じブランチにcommitする。
          const { stageAndCommit } = await import('../runtime/takt/node_modules/takt/dist/infra/task/git.js');
          await stageAndCommit(context.project, `feat: 子Issue #${context.issue} の実装と品質レビュー`, { allowGitHooks: false, allowGitFilters: false });
          const head = git(['rev-parse', 'HEAD']);
          if (git(['status', '--porcelain'])) throw Error('reviewed_worktree_not_clean');
          if (!git(['diff', '--name-only', `${baseSha}...${head}`])) throw Error('child_issue_has_no_changes');
          writeFileSync(join(runDir, 'approved.json'), JSON.stringify({ context, ...approved, baseSha, head }, null, 2), { mode: 0o600 });
          return approved;
        },
        publish: () => publishChildIssue(context, runDir),
      });
      console.log(JSON.stringify(result));
    }
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  if (lock) rmSync(lock, { recursive: true });
}
