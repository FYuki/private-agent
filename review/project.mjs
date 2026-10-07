import { existsSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * HEADを持つworktreeルートを正規化して返す。Git管理外・サブディレクトリや、
 * 必須レビューを上書きし得るproject設定は拒否する。設定の移動・削除は行わない。
 */
export function reviewProject(path) {
  const project = realpathSync(resolve(path));
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: project, encoding: 'utf8' }).trim();
  if (realpathSync(root) !== project) throw Error('--project must be the Git worktree root');
  execFileSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: project, stdio: 'ignore' });
  for (const name of ['config.yaml', 'runtime.yaml', 'workflows', 'steps', 'facets', 'companions', 'facet-pools']) {
    if (existsSync(join(project, '.takt', name))) throw Error(`Project .takt/${name} must be isolated before running this review entry`);
  }
  return project;
}
/**
 * 専用CLIプロセスの継承TAKT設定と共有メモリフックを無効化する。
 * 認証環境は保持する。process.envを変更し復元しないため、共有ホストからは呼ばない。
 */
export function isolateReviewEnvironment() {
  for (const key of Object.keys(process.env)) if (key.startsWith('TAKT_')) delete process.env[key];
  process.env.PK_MEMORY_HOOKS = '0';
}
