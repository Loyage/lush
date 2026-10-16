import { test, expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { Store } from '../../src/persistence/store.js';
import { Project } from '../../src/core/project.js';
import { Dispatcher } from '../../src/rpc/dispatcher.js';
import { tokenHash } from '../../src/core/project/internal.js';
import { runnerProjectFixture, command, git } from './runner-delivery-harness.js';
import { runnerParentSyncId } from '../../src/core/project/runner-delivery.js';

const booking = (f, id) => JSON.parse(f.store.task(id).reservation);
function manualDriver(f) {
  // Keep actual request/queue/Git/Runner paths; only the invocation scheduler is controlled.
  f.project.kick = () => {};
  f.project.scheduleDeliveryHandlerOperation = () => {};
}
async function drive(f, parent) {
  f.project.stopping = false;
  try { await f.project.driveTaskMerge(parent); }
  finally { f.project.stopping = true; }
}
async function repairSource(f, worker) {
  const request = booking(f, worker.id), before = f.store.runnerBinding(worker.id).head_commit;
  expect(request.status).toBe('resolving');
  const run = f.store.startRun(f.store.task(worker.id), { agent: 'controlled-repair' });
  const output = await command(worker.client, `git -c user.name=Fixture -c user.email=fixture@invalid merge --no-edit ${request.baseline}; git rev-parse HEAD`);
  const commit = output.split('\n').at(-1);
  await f.project.workspaces.receiveRemoteCommit({ ...worker.options, request_id: randomUUID(), commit, old_commit: before,
    original_commit: request.original_commit, final_delivery: true, agent_exited: true });
  f.store.finishRun(run.id, 'completed', 'fixed source repair');
  f.store.run("UPDATE messages SET consumed=1 WHERE task_id=? AND signal_type='merge.repair'", worker.id);
  f.store.update(worker.id, { status: 'waiting', head_commit: commit,
    reservation: JSON.stringify({ ...request, repair_ready: true, repair_run_id: run.id }) });
  return commit;
}

test('real Project request receives a remote source into local main without creating a local source checkout', async () => {
  const f = await runnerProjectFixture(); manualDriver(f);
  try {
    const source = await f.worker(); const commit = await f.commit(source);
    const dispatcher = new Dispatcher(f.project), token = randomUUID();
    f.store.armAgent(source.id, tokenHash(token)); f.store.update(source.id, { status: 'running' });
    f.project.running.set(source.id, { controller: new AbortController() });
    try {
      await expect(dispatcher.dispatch('worker.reserve', { id: source.id, kind: 'merge', _token: token })).rejects.toThrow('user approval');
    } finally { f.project.running.delete(source.id); f.store.update(source.id, { status: 'waiting' }); f.store.armAgent(source.id, null); }
    const result = await dispatcher.dispatch('worker.reserve', { id: source.id, kind: 'merge' });
    expect(result.reservation.status).toBe('requested');
    expect(booking(f, source.id).status).toBe('requested');
    await drive(f, f.main.id);
    expect(booking(f, source.id)).toMatchObject({ status: 'integrated' });
    expect(f.store.task(source.id).integration).toBe('merged');
    expect(f.store.task(source.id).workspace).toBeNull();
    expect(await git(f.root, 'show', 'main:remote.txt')).toBe('remote');
    expect(booking(f, source.id).commit).toBe(commit);
  } finally { await f.close(); }
});

test('remote parent keeps the execution slot through lost sync ACK and resumes fixed landing without another Squash', async () => {
  const f = await runnerProjectFixture(); manualDriver(f);
  let recovered;
  try {
    const parent = await f.worker(), source = await f.worker({ parent_id: parent.id, node_index: 1, name: 'child' });
    await f.commit(source);
    await f.project.requestTaskMerge(source.id);
    const sync = f.project.workspaces.syncRemoteWorkspace.bind(f.project.workspaces);
    let applied = false;
    f.project.workspaces.syncRemoteWorkspace = async options => {
      expect(f.project.workspaces.pending).toBe(0); // No central Git gate crosses the network.
      const acknowledged = f.store.updateRunnerReceipt.bind(f.store);
      f.store.updateRunnerReceipt = (identity, patch, revision) => {
        if (patch.state === 'acknowledged') { applied = true; throw new Error('fixture lost acknowledgement'); }
        return acknowledged(identity, patch, revision);
      };
      try { return await sync(options); } finally { f.store.updateRunnerReceipt = acknowledged; }
    };
    await drive(f, parent.id);
    expect(applied).toBe(true);
    const request = booking(f, source.id), landed = request.landing_receipt.commit;
    expect(request.status).toBe('blocked');
    expect(f.store.task(source.id).integration).not.toBe('merged');
    expect(f.store.unread(parent.id).some(row => row.signal_type === 'merge.completed')).toBe(false);
    expect(f.project.activeTaskMerge(parent.id).id).toBe(source.id);
    expect(f.store.runnerReceipt(runnerParentSyncId(source.id, request.attempt_id)).state).toBe('applying');
    expect(f.project.maintenanceView().blockers.some(reason => reason.includes('Runner'))).toBe(true);
    expect(await command(parent.client, 'git rev-parse HEAD')).toBe(landed);
    f.project.workspaces.syncRemoteWorkspace = sync;
    // New Store connection and Project instance: no old in-memory attempt/connection survives.
    await source.connection.close(); await parent.connection.close();
    const store = new Store(path.join(f.config.home, 'project.db'), f.root);
    const project = new Project(f.config, store, null, { runner: f.project.runnerOptions });
    recovered = { project, store }; manualDriver(recovered); project.stopping = true;
    project.workspaces.applyTaskSquashUnsafe = async () => { throw new Error('must never reapply Squash'); };
    project.recoverTaskDeliveries();
    await drive(recovered, parent.id);
    expect(f.store.task(source.id).integration).toBe('merged');
    expect(booking(f, source.id).landed_commit).toBe(landed);
    expect(f.store.runnerBinding(parent.id).head_commit).toBe(landed);
    expect(f.store.runnerBarriers(parent.id).receipts).toHaveLength(0);
    expect(recovered.project.maintenanceView().blockers.some(reason => reason.includes('Runner'))).toBe(false);
    expect(f.store.unread(parent.id).filter(row => row.signal_type === 'merge.completed')).toHaveLength(1);
    expect(await git(f.root, 'rev-parse', `refs/heads/${parent.task.branch}`)).toBe(landed);
  } finally {
    if (recovered) { await recovered.project.runners.close(); recovered.store.close(); }
    await f.close();
  }
});

test('two cross-node children serialize remote-parent delivery and fixed source-side repair objects', async () => {
  const f = await runnerProjectFixture(); manualDriver(f);
  try {
    const parent = await f.worker();
    const first = await f.worker({ parent_id: parent.id, node_index: 1, name: 'first' });
    const second = await f.worker({ parent_id: parent.id, node_index: 0, name: 'second' });
    await f.commit(first, 'first.txt', 'one'); const original = await f.commit(second, 'second.txt', 'two');
    await f.project.requestTaskMerge(first.id); await f.project.requestTaskMerge(second.id);
    await drive(f, parent.id);
    expect(f.store.task(first.id).integration).toBe('merged');
    const baseline = f.store.runnerBinding(parent.id).head_commit;
    await drive(f, parent.id);
    const request = booking(f, second.id);
    expect(request.status).toBe('resolving'); expect(request.baseline).toBe(baseline);
    expect(await command(second.client, `git rev-parse HEAD; git cat-file -t ${baseline}`)).toBe(`${original}\ncommit`);
    expect(f.project.activeTaskMerge(parent.id).id).toBe(second.id);
    const repaired = await repairSource(f, second);
    await drive(f, parent.id);
    expect(f.store.task(second.id).integration).toBe('merged');
    expect(booking(f, second.id).commit).toBe(repaired);
    expect(await command(parent.client, 'cat first.txt; cat second.txt')).toBe('one\ntwo');
    expect(f.store.history(first.id).find(row => row.type === 'task.merge_integrated').id)
      .toBeLessThan(f.store.history(second.id).find(row => row.type === 'task.merge_integrated').id);
  } finally { await f.close(); }
});

test('dirty remote parent suspends an unwritten attempt instead of treating null workspace as clean', async () => {
  const f = await runnerProjectFixture(); manualDriver(f);
  try {
    const parent = await f.worker(), source = await f.worker({ parent_id: parent.id });
    await f.commit(source); await f.project.requestTaskMerge(source.id);
    await command(parent.client, 'printf dirty > dirt.txt');
    await drive(f, parent.id);
    expect(booking(f, source.id).status).toBe('suspended');
    expect(booking(f, source.id).blocked_reason).toContain('dirty');
    expect(await git(f.root, 'rev-parse', `refs/heads/${parent.task.branch}`)).toBe(parent.task.base_commit);
    expect(await command(parent.client, 'cat dirt.txt')).toBe('dirty');
  } finally { await f.close(); }
});
