import { test, expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { runnerProjectFixture, command, git } from './runner-delivery-harness.js';
import { assertRunnerIdle, inspectRunnerSafePoint } from '../../src/core/project/runner-safety.js';
import { runnerIdentity } from '../../src/core/runner-service.js';
import { hash } from '../../src/runner/protocol.js';

test('Project remote safe point reads the actual independent workspace and rejects dirty state or central ref drift', async () => {
  const f = await runnerProjectFixture();
  try {
    const worker = await f.worker();
    const state = await inspectRunnerSafePoint(f.project, worker.id);
    expect(state.remote).toBe(true); expect(state.clean).toBe(true); state.guard();
    expect(f.store.task(worker.id).workspace).toBeNull();
    const context = await worker.client.call('file.context', { path: 'file.txt' });
    const read = await worker.client.call('file.read', { path: 'file.txt' });
    await worker.client.call('file.write', { path: 'file.txt', content: 'dirty\n', expected_sha256: read.sha256, context_ack: context.fingerprint });
    await expect(inspectRunnerSafePoint(f.project, worker.id)).rejects.toThrow('dirty');
    expect(await git(f.root, 'show', 'main:file.txt')).toBe('base');
    await command(worker.client, 'git -c user.name=Fixture -c user.email=fixture@invalid commit -am change');
    await expect(inspectRunnerSafePoint(f.project, worker.id)).rejects.toThrow('HEAD');
  } finally { await f.close(); }
});

test('no local running entry is not proof of remote lease or durable Run release', async () => {
  const f = await runnerProjectFixture();
  try {
    const worker = await f.worker();
    const task = f.store.task(worker.id);
    const run = f.store.startRun(task, { agent: 'fixture' });
    const identity = runnerIdentity(f.store.runnerBinding(worker.id), { run_id: run.id });
    f.store.update(worker.id, { status: 'running' });
    f.store.authorizeRunnerRun(identity, f.policy.authorization_version);
    f.store.update(worker.id, { status: 'waiting' });
    expect(() => assertRunnerIdle(f.project, worker.id)).toThrow('stop');
    f.store.releaseRunnerRun(identity, f.store.runnerRun(run.id).revision, { stopped: true });
    await worker.client.call('lease.grant', { run_id: run.id, run_token: hash(randomUUID()) });
    await expect(inspectRunnerSafePoint(f.project, worker.id)).rejects.toThrow();
    expect((await worker.client.call('lease.revoke')).stopped).toBe(true);
    expect((await inspectRunnerSafePoint(f.project, worker.id)).clean).toBe(true);
    f.store.finishRun(run.id, 'completed', 'fixture');
  } finally { await f.close(); }
});

test('safe-point guard rechecks identity, newest authorization and unknown durable barriers', async () => {
  const f = await runnerProjectFixture();
  try {
    const worker = await f.worker();
    const proof = await inspectRunnerSafePoint(f.project, worker.id);
    f.store.revokeRunnerNode(f.nodes[0].id, f.service.readPolicy().revision);
    expect(() => proof.guard()).toThrow('revoked');
    expect((await inspectRunnerSafePoint(f.project, worker.id, { observation: true })).clean).toBe(true);
    const binding = f.store.runnerBinding(worker.id);
    f.store.markRunnerWorkspaceUnknown(runnerIdentity(binding), binding.revision);
    await expect(inspectRunnerSafePoint(f.project, worker.id, { observation: true })).rejects.toThrow('ready');
  } finally { await f.close(); }
});
