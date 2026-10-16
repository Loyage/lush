import { test, expect } from 'bun:test';
import { runnerProjectFixture } from './runner-delivery-harness.js';
import { runnerIdentity } from '../../src/core/runner-service.js';
import { hash } from '../../src/runner/protocol.js';

test('stop reconciliation cannot revoke a newer node Run with an older central identity', async () => {
  const f = await runnerProjectFixture();
  try {
    const worker = await f.worker();
    const run = f.store.startRun(f.store.update(worker.id, { status: 'running' }), { agent: 'fixture' });
    f.store.authorizeRunnerRun(runnerIdentity(f.store.runnerBinding(worker.id), { run_id: run.id }), f.policy.authorization_version);
    const token = hash('fixture-newer-run');
    await worker.client.call('lease.grant', { run_id: run.id + 1, run_token: token });
    const stopped = await f.service.stopRun(run.id);
    expect(stopped).toEqual({ stopped: false, unknown: true, reason: 'runner_stop_unconfirmed' });
    expect(f.store.runnerRun(run.id).state).toBe('revoked');
    expect(f.store.runnerBinding(worker.id).state).toBe('unknown');
    // Actual node authorization still exists: old central stop never reaches lease.revoke.
    expect((await worker.client.forRun({ run_id: run.id + 1, run_token: token }).call('file.context')).complete).toBe(true);
    await worker.client.call('lease.revoke');
    f.store.update(worker.id, { status: 'failed' });
    f.store.finishRun(run.id, 'failed', { error: 'fixture drift' });
  } finally { await f.close(); }
});
