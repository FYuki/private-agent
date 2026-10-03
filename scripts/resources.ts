import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';

export type CleanupScope = { defer(cleanup: () => Promise<void>): void };

/** setup途中の失敗を含め、登録済みcleanupを全件試す。元の失敗とcleanup失敗を両方保持する。 */
export async function withCleanup<T>(work: (scope: CleanupScope) => Promise<T>): Promise<T> {
  const cleanups: (() => Promise<void>)[] = []; let value!: T, failed = false, failure: unknown;
  try { value = await work({ defer: cleanup => cleanups.push(cleanup) }); }
  catch (error) { failed = true; failure = error; }
  const results = await Promise.allSettled(cleanups.map(cleanup => Promise.resolve().then(cleanup)));
  const errors = results.filter(r => r.status === 'rejected').map(r => r.reason);
  if (errors.length) throw new AggregateError([...(failed ? [failure] : []), ...errors], 'resource_cleanup_failed');
  if (failed) throw failure;
  return value;
}

/** closeを待って終了を確認する。TERMに従わない子にはKILLを送り、未終了は成功扱いにしない。 */
export async function stopProcess(child: ChildProcess, graceMs = 3000): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  let closed = false;
  const onClose = () => { closed = true; };
  child.once('close', onClose);
  const wait = (ms: number) => new Promise<void>(resolve => {
    const done = () => { clearTimeout(timer); child.removeListener('close', done); resolve(); };
    const timer = setTimeout(done, ms); child.once('close', done);
    if (closed) done();
  });
  try {
    child.kill('SIGTERM'); await wait(graceMs);
    if (!closed) { child.kill('SIGKILL'); await wait(graceMs); }
    if (!closed) throw new Error('poller_did_not_exit');
  } finally { child.removeListener('close', onClose); }
}

/** spawn直後に終了処理を登録し、非同期spawn失敗も未処理errorにせず呼出元へ返す。 */
export async function startProcess(scope: CleanupScope, file: string, args: string[], options: SpawnOptions): Promise<ChildProcess> {
  const child = spawn(file, args, { ...options, shell: false });
  scope.defer(() => stopProcess(child));
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject); child.once('spawn', resolve);
  });
  return child;
}
