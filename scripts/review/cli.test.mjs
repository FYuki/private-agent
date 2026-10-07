import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { repository } from '../../review/prepare.mjs';

test('prepare entry resolves both routes without a provider and refuses project overrides', () => {
  const dir = mkdtempSync(join(tmpdir(), 'quality-cli-'));
  execFileSync('git', ['init', '-q', dir]);
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture'], { cwd: dir });
  const task = join(dir, 'task.txt');
  const original = ['config.yaml', 'runtime.yaml'].map(name => readFileSync(join(repository, 'examples/takt', name), 'utf8'));
  const cli = join(repository, 'review/cli.mjs');
  const args = [cli, '--project', dir, '--task-file', task];
  writeFileSync(task, 'Review main...HEAD against the fixture requirements.');
  try {
    for (const route of ['external', 'takt']) {
      const result = JSON.parse(execFileSync(process.execPath, [...args, '--development', route], { encoding: 'utf8', timeout: 20000 }));
      try {
        assert.equal(result.execute, false);
        assert.match(result.workflow, new RegExp(`review-fix-${route}\\.yaml$`));
        assert.equal(readFileSync(join(result.runDir, 'config/runtime.yaml'), 'utf8'), original[1]);
      } finally { rmSync(result.runDir, { recursive: true, force: true }); }
    }
    execFileSync('git', ['checkout', '-qb', 'feature/issue-42'], { cwd: dir });
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/owner/repo.git'], { cwd: dir });
    const childArgs = [join(repository, 'review/child-cli.mjs'), '--project', dir, '--repo', 'owner/repo', '--issue', '42', '--branch', 'feature/issue-42', '--epic', 'epic/feature', '--task-file', task];
    const child = JSON.parse(execFileSync(process.execPath, childArgs, { encoding: 'utf8', timeout: 20000 }));
    try {
      assert.equal(child.execute, false);
      assert.equal(child.epic, 'epic/feature');
      assert.match(child.workflow, /private-agent-child-issue.yaml$/);
    } finally { rmSync(child.runDir, { recursive: true, force: true }); }
    const wrongBase = spawnSync(process.execPath, [...childArgs, '--epic', 'main'], {encoding: 'utf8'});
    assert.equal(wrongBase.status, 1);
    mkdirSync(join(dir, '.takt'));
    writeFileSync(join(dir, '.takt/config.yaml'), 'workflow_overrides: {}\n');
    const rejected = spawnSync(process.execPath, [...args, '--development', 'external'], { encoding: 'utf8', timeout: 20000 });
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /must be isolated/);
    assert.deepEqual(['config.yaml', 'runtime.yaml'].map(name => readFileSync(join(repository, 'examples/takt', name), 'utf8')), original);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
