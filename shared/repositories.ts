import {Fault} from './contracts.ts';

/** ID以外のrepo・base・変更範囲・検証コマンドの追加はコードレビューを要する。 */
export const REPOSITORIES = {
  'private-agent': { github: 'FYuki/private-agent', githubId: 1400010158, baseRef: 'epic/development-runner', validation: 'private-agent-v1' },
  'local-GPT-live': { github: 'FYuki/local-GPT-live', githubId: 1402876013, baseRef: 'epic/transport-playback', validation: 'browser-ack-v1' },
} as const;
export type RepositoryId = keyof typeof REPOSITORIES;
export function repositoryPolicy(id: unknown) {
  if (typeof id !== 'string' || !Object.hasOwn(REPOSITORIES, id)) throw new Fault(400, 'repository_not_allowed');
  return REPOSITORIES[id as RepositoryId];
}
export const repositoryChoices = Object.entries(REPOSITORIES).map(([repoId, p]) => ({repoId, baseRef:p.baseRef}));

/** browser契約は純粋JS部品だけ。既存Python回帰・音声サービス・Coreには書き込まない。 */
export function allowedRepositoryPath(id: RepositoryId, path: string): boolean {
  if (path.split('/').some(p => !p || p === '..' || p === '.') || path.includes('\\')) return false;
  if (id === 'private-agent') return !path.split('/').some(p=>p.startsWith('.')) && /^(agent|control-plane|shared|wsl-worker|development|tests)\/[a-zA-Z0-9_./-]+\.(ts|js)$/.test(path);
  return ['browser/playback-ack.mjs', 'browser/tests/playback-ack.test.mjs', 'browser/README.md', '.github/workflows/browser-ack.yml', 'docs/evidence/browser-playback-ack.md'].includes(path);
}
export function repositoryBranch(id: RepositoryId, taskId: string) {
  return id === 'local-GPT-live' ? 'feature/browser-playback-ack-client' : 'feature/development-task-' + taskId;
}
export function validationCommands(id: RepositoryId): readonly (readonly string[])[] {
  return id === 'local-GPT-live'
    ? [['/usr/bin/node', '--check', 'browser/playback-ack.mjs'], ['/usr/bin/node', '--test', 'browser/tests/playback-ack.test.mjs']]
    : [['/usr/bin/npm', 'run', 'check'], ['/usr/bin/npm', 'run', 'test']];
}
