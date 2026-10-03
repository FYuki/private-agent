import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { withCleanup, startProcess, stopProcess } from '../scripts/resources.ts';

test('partial setup failure disables acquired job', async () => {
  const disabled: string[] = [];
  await assert.rejects(withCleanup(async scope => {
    scope.defer(async () => { disabled.push('first-job'); });
    throw new Error('second_job_setup_failed');
  }), /second_job_setup_failed/);
  assert.deepEqual(disabled, ['first-job']);
});

test('failed disable does not prevent other cleanup or actual child termination', async () => {
  let disabled = false, child: Awaited<ReturnType<typeof startProcess>> | undefined;
  await assert.rejects(withCleanup(async scope => {
    scope.defer(async () => { throw new Error('disable_failed'); });
    scope.defer(async () => { disabled = true; });
    child = await startProcess(scope, process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    throw new Error('check_failed');
  }), (error: unknown) => error instanceof AggregateError && error.errors.length === 2);
  assert(disabled); assert(child); assert.notEqual(child.signalCode, null);
  assert.throws(() => process.kill(child!.pid!, 0), /ESRCH/);
});

test('failed spawn still cleans earlier process and job', async () => {
  let disabled = false, child: Awaited<ReturnType<typeof startProcess>> | undefined;
  await assert.rejects(withCleanup(async scope => {
    scope.defer(async () => { disabled = true; });
    child = await startProcess(scope, process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    await startProcess(scope, '/nonexistent/private-agent-fixture', [], { stdio: 'ignore' });
  }), /ENOENT/);
  assert(disabled); assert.throws(() => process.kill(child!.pid!, 0), /ESRCH/);
});

test('TERM-resistant real child is killed and awaited', async () => {
  await withCleanup(async scope => {
    const child = await startProcess(scope, process.execPath, ['-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000);process.stdout.write("ready");'], { stdio: ['ignore', 'pipe', 'ignore'] });
    await once(child.stdout!, 'data');
    await stopProcess(child, 100);
    assert.equal(child.signalCode, 'SIGKILL'); assert.throws(() => process.kill(child.pid!, 0), /ESRCH/);
  });
});
