import { test, expect } from 'bun:test';
import { runnerProjectFixture } from './runner-delivery-harness.js';
import { runnerIdentity } from '../../src/core/runner-service.js';
import { hash } from '../../src/runner/protocol.js';
import { Dispatcher } from '../../src/rpc/dispatcher.js';

async function running(f, worker, journal = false) {
  const task = f.store.update(worker.id, { status: 'running' });
  const run = f.store.startRun(task, { agent: 'controlled-fixture' });
  const identity = runnerIdentity(f.store.runnerBinding(worker.id), { run_id: run.id });
  f.store.authorizeRunnerRun(identity, f.policy.authorization_version);
  if (journal) f.store.startRunnerToolJournal(identity, { version: 1, head_commit: worker.task.base_commit, baseline: {} });
  const token = hash(`run-${run.id}`);
  await worker.client.call('lease.grant', { run_id: run.id, run_token: token });
  return { identity, run, client: worker.client.forRun({ run_id: run.id, run_token: token }) };
}
async function stops(f) { await Promise.allSettled([...(f.project.runnerStopJobs ?? [])]); }

test('Project cancel invokes fixed registered stop, waits for remote command exit and only then permits explicit retry', async () => {
  const f = await runnerProjectFixture();
  try {
    const worker = await f.worker(), active = await running(f, worker);
    const context = await active.client.call('file.context', { scope: 'workspace' });
    const command = await active.client.call('command.start', { script: 'sleep 4', context_ack: context.fingerprint });
    // start acknowledges queue admission, not a captured bootstrap. This test exercises stopping
    // a running command; startup-unknown remains a barrier rather than fabricated release proof.
    const deadline = Date.now() + 4000;
    for (;;) {
      const state = await active.client.call('command.status', { execution_id: command.execution_id });
      if (state.state === 'running') break;
      if (state.stop_confirmed || Date.now() >= deadline) throw new Error(`fixture command did not reach running: ${JSON.stringify(state)}`);
      await Bun.sleep(10);
    }
    let callbacks = 0;
    const unwatch = f.service.watchRun(active.identity, async () => { callbacks++; return worker.client.call('lease.revoke'); });
    const cancelled = f.project.cancel(worker.id);
    expect(cancelled.status).toBe('cancelled');
    expect(f.store.runnerRun(active.run.id).state).toBe('revoked');
    expect(f.project.maintenanceView().ready_to_restart).toBe(false);
    await stops(f);
    expect(callbacks).toBe(1);
    expect(f.store.runnerRun(active.run.id).state).toBe('released');
    expect((await active.client.call('command.status', { execution_id: command.execution_id })).stop_confirmed).toBe(true);
    unwatch(); f.store.finishRun(active.run.id, 'failed', { error: 'cancelled fixture' });
    const retried = await f.project.retry(worker.id);
    expect(retried.status).toBe('queued');
    expect(f.store.runnerBinding(worker.id).state).toBe('ready');
  } finally { await f.close(); }
});

for (const legacy of [false, true]) test(`orphan Run recovery requires explicit verification; ${legacy ? 'legacy missing history stays blocked' : 'new empty journal can prove zero tools'}`, async () => {
  const f = await runnerProjectFixture();
  const dispatcher = new Dispatcher(f.project, { isRequested: () => false });
  try {
    const worker = await f.worker(), active = await running(f, worker, !legacy);
    const verify = () => dispatcher.dispatch('runner.worker.reconcile', { id: worker.id, expected_revision: f.store.runnerBinding(worker.id).revision });
    f.project.recover();
    expect(f.store.task(worker.id).status).toBe('failed');
    expect(f.store.get('SELECT status FROM agent_runs WHERE id=?', active.run.id).status).toBe('failed');
    expect(f.store.runnerBinding(worker.id).state).toBe('unknown');
    expect(f.store.runnerRun(active.run.id).state).toBe('revoked');
    expect(f.project.maintenanceView().blockers.join(' ')).toContain('Runner');
    const original = f.service.transport_factory;
    f.service.transport_factory = () => { throw new Error('fixture node unavailable'); };
    expect(() => f.project.retry(worker.id)).toThrow('explicitly verify');
    expect(await verify()).toMatchObject({ reconciled: false, state: 'unknown' });
    expect(f.store.task(worker.id).status).toBe('failed');
    expect(f.store.runnerRun(active.run.id).state).not.toBe('released');
    f.service.transport_factory = original;
    expect(await verify()).toMatchObject({ reconciled: !legacy, state: legacy ? 'unknown' : 'ready' });
    expect(f.store.task(worker.id).status).toBe('failed'); // verification never starts an Agent
    if (legacy) expect(() => f.project.retry(worker.id)).toThrow('explicitly verify');
    else {
      const retried = await f.project.retry(worker.id);
      expect(retried.status).toBe('queued');
      expect(f.store.runnerRun(active.run.id).state).toBe('released');
    }
  } finally { await f.close(); }
});

test('a stopped workspace never clears unknown operation receipts or makes maintenance/retry/clear safe', async () => {
  const f = await runnerProjectFixture();
  try {
    const worker = await f.worker(), active = await running(f, worker);
    const receiptIdentity = { ...active.identity, request_id: 'unknown-edit' };
    const receipt = f.store.createRunnerReceipt({ ...receiptIdentity, kind: 'execution', data: {},
      params_hash: hash('fixed-unknown-edit'), authorization_version: f.policy.authorization_version });
    f.store.updateRunnerReceipt(receiptIdentity, { state: 'unknown' }, receipt.revision);
    f.project.cancel(worker.id); await stops(f);
    expect((await worker.client.call('workspace.barrier')).stopped).toBe(true);
    expect(f.store.runnerReceipt('unknown-edit').state).toBe('unknown');
    expect(f.store.runnerRun(active.run.id).state).toBe('revoked');
    expect(f.project.maintenanceView().ready_to_restart).toBe(false);
    await expect(f.project.retry(worker.id)).rejects.toThrow();
    expect(() => f.project.clear()).toThrow('Runner');
    const result = await f.project.shutdown();
    expect(result).toEqual({ stopped: false, unknown: true });
    expect(f.store.runnerReceipt('unknown-edit').state).toBe('unknown');
  } finally { await f.close(); }
});

test('project clear preserves remote binding history even after exact resource removal', async () => {
  const f = await runnerProjectFixture();
  try {
    const worker = await f.worker();
    expect(() => f.project.clear()).toThrow('binding history');
    await f.project.workspaces.cleanupRemoteWorkspace({ ...worker.options, request_id: 'explicit-resource-removal',
      head_commit: worker.task.base_commit, agent_exited: true });
    expect(f.store.runnerBinding(worker.id).state).toBe('removed');
    expect(() => f.project.clear()).toThrow('binding history');
    expect(f.store.task(worker.id).id).toBe(worker.id);
  } finally { await f.close(); }
});

test('maintenance explicitly stops orphan lease but never grants new execution after node revocation', async () => {
  const f = await runnerProjectFixture();
  try {
    const worker = await f.worker(), active = await running(f, worker);
    f.store.update(worker.id, { status: 'failed' });
    f.store.finishRun(active.run.id, 'failed', { error: 'orphan fixture' });
    f.project.stopping = false;
    const view = f.project.interruptAll();
    expect(view.paused).toBe(true); expect(view.ready_to_restart).toBe(false);
    await stops(f);
    expect(f.store.runnerRun(active.run.id).state).toBe('released');
    // Maintenance itself remains closed: no model is started by reconciliation.
    expect(f.project.maintenanceView().active_calls).toBe(0);
    f.store.revokeRunnerNode(f.nodes[0].id, f.service.readPolicy().revision);
    await expect(f.project.retry(worker.id)).rejects.toThrow('revoked');
    expect(f.store.task(worker.id).status).toBe('failed');
  } finally { await f.close(); }
});
