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
    mkdirSync(join(dir, '.takt'));
    writeFileSync(join(dir, '.takt/config.yaml'), 'workflow_overrides: {}\n');
    const rejected = spawnSync(process.execPath, [...args, '--development', 'external'], { encoding: 'utf8', timeout: 20000 });
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /must be isolated/);
    assert.deepEqual(['config.yaml', 'runtime.yaml'].map(name => readFileSync(join(repository, 'examples/takt', name), 'utf8')), original);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
