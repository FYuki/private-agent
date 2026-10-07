import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateChildContext } from './child-issue.mjs';

export function gitAt(project, args) {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], { cwd: project, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
export function verifyChildBranch(context) {
  validateChildContext(context);
  for (const branch of [context.branch, context.epic]) gitAt(context.project, ['check-ref-format', '--branch', branch]);
  if (gitAt(context.project, ['branch', '--show-current']) !== context.branch) throw Error('child_branch_changed');
  const allowed = [`https://github.com/${context.repo}.git`, `git@github.com:${context.repo}.git`, `https://github.com/${context.repo}`].map(url => url.toLowerCase());
  for (const args of [['remote', 'get-url', '--all', 'origin'], ['remote', 'get-url', '--push', '--all', 'origin']]) {
    const remotes = gitAt(context.project, args).split('\n');
    if (remotes.length !== 1 || !allowed.includes(remotes[0].toLowerCase())) throw Error('repository_remote_mismatch');
  }
}

/** GitHubの既存PRを照合する。別baseやforkのPRを再利用しない。 */
export function matchingPullRequest(list, context, sha) {
  if (!list.length) return undefined;
  if (list.length !== 1) throw Error('ambiguous_child_pull_request');
  const pr = list[0];
  if (pr.baseRefName !== context.epic || pr.headRefName !== context.branch || pr.headRefOid !== sha || pr.isCrossRepository || pr.isDraft !== true) throw Error('existing_pull_request_mismatch');
  const prefix = `https://github.com/${context.repo}/pull/`;
  if (!pr.url.toLowerCase().startsWith(prefix.toLowerCase()) || !/^\d+$/.test(pr.url.slice(prefix.length))) throw Error('invalid_pull_request_url');
  return pr.url;
}

export async function publishChildIssue(context, runDir, dependencies = {}) {
  verifyChildBranch(context);
  const git = dependencies.git ?? (args => gitAt(context.project, args));
  const gh = dependencies.gh ?? (args => execFileSync('gh', args, { cwd: context.project, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim());
  const receiptPath = join(runDir, 'approved.json');
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
  if (JSON.stringify(receipt.context) !== JSON.stringify(context) || receipt.approved !== true || git(['rev-parse', 'HEAD']) !== receipt.head || git(['status', '--porcelain'])) throw Error('approved_sources_changed');
  const remoteBase = git(['ls-remote', '--heads', 'origin', `refs/heads/${context.epic}`]).split(/\s/)[0];
  if (remoteBase !== receipt.baseSha) throw Error('epic_base_changed');
  const find = () => JSON.parse(gh(['pr', 'list', '--repo', context.repo, '--state', 'open', '--head', context.branch, '--json', 'url,baseRefName,headRefName,headRefOid,isCrossRepository,isDraft']));
  const existing = find();
  if (existing.length) matchingPullRequest(existing, context, existing[0].headRefOid);
  // 公開先の変更を防ぐ。pushは通常のfast-forwardのみ、レビュー済みSHAを明示する。
  git(['push', 'origin', `${receipt.head}:refs/heads/${context.branch}`]);
  let url = matchingPullRequest(find(), context, receipt.head);
  if (!url) {
    const bodyPath = join(runDir, 'pr-body.md');
    writeFileSync(bodyPath, `子Issue #${context.issue} の実装と必須の広範品質レビューを完了しました。\n\nTAKT review-fixの修正・再レビューと最終APPROVEを確認しています。CIと利用者レビューは別途確認してください。\n\nRefs #${context.issue}\n`, { mode: 0o600 });
    let failure;
    try {
      gh(['pr', 'create', '--repo', context.repo, '--draft', '--head', context.branch, '--base', context.epic, '--title', `feat: 子Issue #${context.issue} の実装`, '--body-file', bodyPath]);
    } catch (error) { failure = error; }
    // 応答不明でも二重作成せず、同じhead/base/SHAのPRだけを成功にする。
    url = matchingPullRequest(find(), context, receipt.head);
    if (!url) throw failure ?? Error('pull_request_unconfirmed');
  }
  const result = { url, head: receipt.head, base: context.epic, issue: context.issue };
  writeFileSync(join(runDir, 'published.json'), JSON.stringify(result, null, 2), { mode: 0o600 });
  return result;
}
