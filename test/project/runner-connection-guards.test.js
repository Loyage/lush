import { test, expect } from 'bun:test';
import { runnerProjectFixture, git } from './runner-delivery-harness.js';
import { inspectRunnerSafePoint } from '../../src/core/project/runner-safety.js';
import { runnerParentSyncId } from '../../src/core/project/runner-delivery.js';
import { runnerProject } from './fixtures/runner-project.js';
import { until } from '../helpers.js';

test('idle-parent capture and code reads reject a connection changed during network inspection', async () => {
  let f, rotateAt = null;
  f = await runnerProject({ async run() { return 'idle'; } }, { async intercept(frame, request) {
    const result = await request();
    if (frame.method === rotateAt) { rotateAt = null; await changeBudgets(f); }
    return result;
  } });
  try {
    const sent = await f.dispatcher.dispatch('order.submit', { content: 'parent', start: false });
    await f.dispatcher.dispatch('worker.resume', { id: sent.task.id });
    await until(() => f.store.task(sent.task.id).calls === 1 && !f.project.running.size, 8000);
    rotateAt = 'workspace.git.inspect';
    await expect(f.project.spawn(sent.task.id, 'must not create')).rejects.toThrow('configuration changed');
    expect(rotateAt).toBeNull(); expect(f.store.children(sent.task.id)).toHaveLength(0);
    rotateAt = 'workspace.code.read';
    const result = await f.dispatcher.dispatch('worker.code_state', { id: sent.task.id });
    expect(rotateAt).toBeNull(); expect(result.availability).toBe('unavailable');
    expect(f.store.runnerBinding(sent.task.id).state).toBe('ready');
  } finally { await f.close(); }
});

async function changeBudgets(f) {
  const settings = f.service.readNodes();
  await f.service.saveNodes({ nodes: settings.nodes.map(node => ({ ...node,
    budgets: { ...node.budgets, output_bytes: node.budgets.output_bytes - 1 } })) }, settings.revision);
}

test('safe-point proof cannot authorize later central writes after connection configuration changes', async () => {
  const f = await runnerProjectFixture();
  try {
    const worker = await f.worker();
    const proof = await inspectRunnerSafePoint(f.project, worker.id);
    proof.guard();
    await changeBudgets(f);
    expect(() => proof.guard()).toThrow('configuration changed');
    // New explicit inspection may use the new configuration; the old proof cannot.
    const current = await inspectRunnerSafePoint(f.project, worker.id);
    current.guard();
    expect(current.head_commit).toBe(proof.head_commit);
  } finally { await f.close(); }
});

test('remote parent delivery stops before remote mutation when its connected configuration changes', async () => {
  const f = await runnerProjectFixture();
  f.project.kick = () => {}; f.project.scheduleDeliveryHandlerOperation = () => {};
  try {
    const parent = await f.worker(), child = await f.worker({ parent_id: parent.id, node_index: 1 });
    await f.commit(child); await f.project.requestTaskMerge(child.id);
    const sync = f.project.workspaces.syncRemoteWorkspace.bind(f.project.workspaces);
    f.project.workspaces.syncRemoteWorkspace = async options => {
      await changeBudgets(f);
      return sync(options);
    };
    f.project.stopping = false;
    try { await f.project.driveTaskMerge(parent.id); } finally { f.project.stopping = true; }
    const booking = JSON.parse(f.store.task(child.id).reservation);
    expect(booking.status).toBe('blocked');
    expect(booking.blocked_reason).toContain('configuration changed');
    expect(f.store.runnerBinding(parent.id).head_commit).toBe(parent.task.base_commit);
    expect(f.store.runnerReceipt(runnerParentSyncId(child.id, booking.attempt_id)).state).toBe('landed');
    expect(f.store.task(child.id).integration).not.toBe('merged');
    expect(f.store.unread(parent.id).some(row => row.signal_type === 'merge.completed')).toBe(false);
  } finally { await f.close(); }
});

test('checked acceptance retains remote resources and central refs when connected configuration changes', async () => {
  const f = await runnerProjectFixture();
  try {
    const worker = await f.worker();
    const cleanup = f.project.workspaces.cleanupRemoteWorkspace.bind(f.project.workspaces);
    f.project.workspaces.cleanupRemoteWorkspace = async options => {
      await changeBudgets(f);
      return cleanup(options);
    };
    await expect(f.project.acceptTask(worker.id)).rejects.toThrow('configuration changed');
    expect(f.store.runnerBinding(worker.id).state).toBe('ready');
    expect(f.store.task(worker.id).status).toBe('waiting');
    expect(await git(f.root, 'rev-parse', `refs/heads/${worker.task.branch}`)).toBe(worker.task.base_commit);
    f.project.workspaces.cleanupRemoteWorkspace = cleanup;
    // Explicit continuation obtains a new connection, not silent replay under stale authority.
    expect((await f.project.acceptTask(worker.id)).status).toBe('completed');
    expect(f.store.runnerBinding(worker.id).state).toBe('removed');
  } finally { await f.close(); }
});
