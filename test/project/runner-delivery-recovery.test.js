import { test, expect } from 'bun:test';
import { runnerProjectFixture, git, command } from './runner-delivery-harness.js';
import { runnerParentSyncId } from '../../src/core/project/runner-delivery.js';

const booking = (f, id) => JSON.parse(f.store.task(id).reservation);
function controlled(f) {
  f.project.kick = () => {};
  f.project.scheduleDeliveryHandlerOperation = () => {};
}
async function drive(f, parent) {
  f.project.stopping = false;
  try { await f.project.driveTaskMerge(parent); } finally { f.project.stopping = true; }
}

test('central ref drift after exact Squash never publishes remote parent success or overwrites either head', async () => {
  const f = await runnerProjectFixture(); controlled(f);
  try {
    const parent = await f.worker(), source = await f.worker({ parent_id: parent.id });
    await f.commit(source); await f.project.requestTaskMerge(source.id);
    const apply = f.project.workspaces.applyTaskSquashUnsafe.bind(f.project.workspaces);
    let external;
    f.project.workspaces.applyTaskSquashUnsafe = async (receipt, guard) => {
      await apply(receipt, guard);
      external = await git(f.root, 'commit-tree', receipt.tree, '-p', receipt.commit, '-m', 'external drift');
      await git(f.root, 'update-ref', `refs/heads/${receipt.parent}`, external, receipt.commit);
      return receipt;
    };
    await drive(f, parent.id);
    expect(booking(f, source.id).status).toBe('blocked');
    expect(booking(f, source.id).blocked_reason).toContain('drifted');
    expect(f.store.runnerBinding(parent.id).head_commit).toBe(parent.task.base_commit);
    expect(await git(f.root, 'rev-parse', `refs/heads/${parent.task.branch}`)).toBe(external);
    expect(f.store.runnerBarriers(parent.id).receipts).toHaveLength(1);
    f.project.workspaces.applyTaskSquashUnsafe = async () => { throw new Error('no replay'); };
    f.project.recoverTaskDeliveries(); await drive(f, parent.id);
    expect(booking(f, source.id).status).toBe('blocked');
    expect(f.store.unread(parent.id).some(row => row.signal_type === 'merge.completed')).toBe(false);
  } finally { await f.close(); }
});

test('explicit requeue rejects only a proved unwritten parent sync and then uses a fresh attempt', async () => {
  const f = await runnerProjectFixture(); controlled(f);
  try {
    const parent = await f.worker(), source = await f.worker({ parent_id: parent.id });
    await f.commit(source); await f.project.requestTaskMerge(source.id);
    const apply = f.project.workspaces.applyTaskSquashUnsafe;
    f.project.workspaces.applyTaskSquashUnsafe = async () => { throw new Error('fixture before any Git mutation'); };
    await drive(f, parent.id);
    const previous = booking(f, source.id), requestId = runnerParentSyncId(source.id, previous.attempt_id);
    expect(previous.status).toBe('blocked');
    expect(f.store.runnerReceipt(requestId).state).toBe('prepared');
    f.project.workspaces.applyTaskSquashUnsafe = apply;
    // Recovery alone cannot turn an unknown central apply into authorization to replay it.
    f.project.recoverTaskDeliveries(); await drive(f, parent.id);
    expect(f.store.runnerReceipt(requestId).state).toBe('prepared');
    await f.project.requestTaskMerge(source.id);
    expect(f.store.runnerReceipt(requestId).state).toBe('rejected');
    expect(booking(f, source.id).status).toBe('requested');
    expect(f.store.runnerBinding(parent.id).head_commit).toBe(parent.task.base_commit);
    await drive(f, parent.id);
    expect(f.store.task(source.id).integration).toBe('merged');
    expect(booking(f, source.id).attempt_id).not.toBe(previous.attempt_id);
  } finally { await f.close(); }
});

test('explicit unwritten requeue cannot discard a dirty remote parent or its prepared receipt', async () => {
  const f = await runnerProjectFixture(); controlled(f);
  try {
    const parent = await f.worker(), source = await f.worker({ parent_id: parent.id });
    await f.commit(source); await f.project.requestTaskMerge(source.id);
    f.project.workspaces.applyTaskSquashUnsafe = async () => { throw new Error('fixture unwritten'); };
    await drive(f, parent.id);
    const previous = booking(f, source.id), requestId = runnerParentSyncId(source.id, previous.attempt_id);
    await command(parent.client, 'printf kept > inspect.txt');
    await expect(f.project.requestTaskMerge(source.id)).rejects.toThrow('dirty');
    expect(f.store.runnerReceipt(requestId).state).toBe('prepared');
    expect(f.project.activeTaskMerge(parent.id).id).toBe(source.id);
    expect(await command(parent.client, 'cat inspect.txt')).toBe('kept');
  } finally { await f.close(); }
});

test('latest source authorization is rechecked at central write and revoked remote branches cannot use legacy Git routes', async () => {
  const f = await runnerProjectFixture(); controlled(f);
  try {
    const source = await f.worker(); await f.commit(source);
    await expect(f.project.workspaces.mergeBranch(source.task.branch)).rejects.toThrow('does not support remote');
    await f.project.requestTaskMerge(source.id);
    const initial = await git(f.root, 'rev-parse', 'main');
    const apply = f.project.workspaces.applyTaskSquashUnsafe.bind(f.project.workspaces);
    f.project.workspaces.applyTaskSquashUnsafe = async (receipt, guard) => {
      f.store.revokeRunnerNode(f.nodes[0].id, f.service.readPolicy().revision);
      return apply(receipt, guard);
    };
    await drive(f, f.main.id);
    expect(await git(f.root, 'rev-parse', 'main')).toBe(initial);
    expect(f.store.task(source.id).integration).not.toBe('merged');
    expect(booking(f, source.id).status).toBe('blocked');
    expect(booking(f, source.id).blocked_reason).toContain('revoked');
  } finally { await f.close(); }
});
