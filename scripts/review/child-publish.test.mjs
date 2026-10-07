import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { publishChildIssue, gitAt } from '../../review/child-publish.mjs';

test('approved child SHA is pushed once per retry; PR uses Epic and reconciles a lost response', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'child-publish-'));
  const project = join(dir, 'worktree'), remote = join(dir, 'remote.git'), run = join(dir, 'run');
  mkdirSync(project); mkdirSync(run);
  const git = args => gitAt(project, args);
  try {
    execFileSync('git', ['init', '-q', '--bare', remote]);
    git(['init', '-q']); git(['config', 'user.name', 'Fixture']); git(['config', 'user.email', 'fixture@example.invalid']);
    writeFileSync(join(project, 'file.txt'), 'base'); git(['add', '.']); git(['commit', '-qm', 'base']);
    git(['branch', 'epic/feature']); git(['push', remote, 'epic/feature']);
    const baseSha = git(['rev-parse', 'HEAD']);
    git(['checkout', '-qb', 'feature/issue-42']);
    writeFileSync(join(project, 'file.txt'), 'reviewed fix'); git(['commit', '-qam', 'feat: reviewed']);
    git(['remote', 'add', 'origin', 'https://github.com/owner/repo.git']);
    const context = { project, repo: 'owner/repo', issue: 42, epic: 'epic/feature', branch: 'feature/issue-42', development: 'takt' };
    const head = git(['rev-parse', 'HEAD']);
    writeFileSync(join(run, 'approved.json'), JSON.stringify({ context, approved: true, baseSha, head }));
    let prs = [], creates = 0, pushes = 0, createDraft = true;
    const deps = {
      git(args) {
        if (args[0] === 'push') { pushes++; assert.deepEqual(args, ['push', 'origin', `${head}:refs/heads/feature/issue-42`]); }
        return git(args.map(arg => arg === 'origin' ? remote : arg));
      },
      gh(args) {
        if (args[1] === 'list') {
          assert.ok(args[args.indexOf('--json') + 1].split(',').includes('isDraft'));
          return JSON.stringify(prs);
        }
        creates++;
        assert.ok(args.includes('--draft'));
        assert.equal(args[args.indexOf('--base') + 1], 'epic/feature');
        assert.equal(args[args.indexOf('--head') + 1], 'feature/issue-42');
        assert.ok(args.includes('--body-file'));
        prs = [{ url: 'https://github.com/owner/repo/pull/7', headRefName: context.branch, baseRefName: context.epic, headRefOid: head, isCrossRepository: false, isDraft: createDraft }];
        throw Error('response lost after creation');
      },
    };
    assert.equal((await publishChildIssue(context, run, deps)).url, prs[0].url);
    await publishChildIssue(context, run, deps);
    assert.equal(creates, 1);
    assert.equal(git(['ls-remote', remote, 'refs/heads/feature/issue-42']).split(/\s/)[0], head);
    const draftPr = prs[0];
    prs[0] = { ...draftPr, isDraft: false };
    await assert.rejects(publishChildIssue(context, run, deps), /existing_pull_request_mismatch/);
    assert.equal(pushes, 2);
    prs[0] = { ...draftPr, isDraft: undefined };
    await assert.rejects(publishChildIssue(context, run, deps), /existing_pull_request_mismatch/);
    assert.equal(pushes, 2);

    const secondRun = join(dir, 'second-run');
    mkdirSync(secondRun);
    writeFileSync(join(secondRun, 'approved.json'), JSON.stringify({ context, approved: true, baseSha, head }));
    prs = [];
    createDraft = false;
    await assert.rejects(publishChildIssue(context, secondRun, deps), /existing_pull_request_mismatch/);
    assert.equal(existsSync(join(secondRun, 'published.json')), false);
    assert.equal(creates, 2);
    assert.equal(pushes, 3);

    prs = [draftPr];
    prs[0].baseRefName = 'main';
    await assert.rejects(publishChildIssue(context, run, deps), /existing_pull_request_mismatch/);
    assert.equal(pushes, 3);
    writeFileSync(join(project, 'file.txt'), 'unreviewed');
    await assert.rejects(publishChildIssue(context, run, deps), /approved_sources_changed/);
    assert.equal(creates, 2);
    git(['restore', 'file.txt']);
    git(['config', 'remote.origin.pushurl', 'https://github.com/other/repository.git']);
    await assert.rejects(publishChildIssue(context, run, deps), /repository_remote_mismatch/);
    git(['config', '--unset', 'remote.origin.pushurl']);
    git(['push', remote, 'HEAD:refs/heads/epic/feature']);
    await assert.rejects(publishChildIssue(context, run, deps), /epic_base_changed/);
    assert.equal(pushes, 3);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
