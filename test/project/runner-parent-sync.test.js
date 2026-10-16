import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Dispatcher } from '../../src/rpc/dispatcher.js';
import { Store } from '../../src/persistence/store.js';
import { Project } from '../../src/core/project.js';
import { runnerIdentity } from '../../src/core/runner-service.js';
import { reconcileRunnerWorker, runnerPendingCount } from '../../src/core/project/runner-lifecycle.js';
import { assertRunnerIdle } from '../../src/core/project/runner-safety.js';
import { runnerProjectFixture, git, command } from './runner-delivery-harness.js';

async function parentCommit(f, file = 'parent.txt', content = 'parent') {
  fs.writeFileSync(path.join(f.root, file), content + '\n');
  await git(f.root, 'add', file); await git(f.root, 'commit', '-m', 'parent change');
  return git(f.root, 'rev-parse', 'main');
}
function quiet(project) { project.kick = () => {}; project.scheduleDeliveryHandlerOperation = () => {}; }

test('registered sync RPC merges fixed parent objects into remote source without a local editable checkout', async () => {
  const f = await runnerProjectFixture(); quiet(f.project);
  try {
    const worker = await f.worker(), source = await f.commit(worker, 'source.txt', 'source');
    const parent = await parentCommit(f);
    const dispatcher = new Dispatcher(f.project);
    const result = await dispatcher.dispatch('worker.sync_parent', { id: worker.id });
    expect(result.conflict).toBe(false); expect(result.synced).toBe(true);
    expect(result.source_commit).toBe(source); expect(result.parent_commit).toBe(parent);
    const task = f.store.task(worker.id);
    expect(task.workspace).toBeNull(); expect(task.integration).toBe('pending');
    expect(task.iteration_base_commit).toBe(parent);
    expect(await command(worker.client, 'cat source.txt; cat parent.txt')).toBe('source\nparent');
    expect(await git(f.root, 'show', '-s', '--format=%P', task.head_commit)).toBe(`${source} ${parent}`);
    expect(f.store.runnerBinding(worker.id).head_commit).toBe(task.head_commit);
    expect(await git(f.root, 'rev-parse', 'main')).toBe(parent);
    expect(f.store.runnerBarriers(worker.id).receipts).toHaveLength(0);
    expect((await f.project.syncTaskParent(worker.id)).synced).toBe(false);
  } finally { await f.close(); }
});

test('remote sync conflict only distributes immutable objects; explicit resolution preserves both histories', async () => {
  const f = await runnerProjectFixture(); quiet(f.project);
  try {
    const worker = await f.worker(), source = await f.commit(worker, 'file.txt', 'source');
    const parent = await parentCommit(f, 'file.txt', 'parent');
    const conflict = await f.project.syncTaskParent(worker.id);
    expect(conflict.conflict).toBe(true); expect(f.store.task(worker.id).status).toBe('waiting');
    expect(await command(worker.client, `git rev-parse HEAD; git cat-file -t ${parent}; git status --porcelain`)).toBe(`${source}\ncommit`);
    expect(await git(f.root, 'rev-parse', `refs/heads/${worker.task.branch}`)).toBe(source);
    const requested = await f.project.resolveTaskSync(worker.id);
    expect(requested.status).toBe('queued');
    // Controlled repair represents the invocation's committed output, not a production Provider test.
    const run = f.store.startRun(f.store.update(worker.id, { status: 'running' }), { agent: 'controlled-repair' });
    const output = await command(worker.client, `git -c user.name=Fixture -c user.email=fixture@invalid merge --no-commit ${parent} || true; printf 'resolved\\n' > file.txt; git add file.txt; git -c user.name=Fixture -c user.email=fixture@invalid commit -m resolved; git rev-parse HEAD`);
    const commit = output.split('\n').at(-1);
    await f.project.workspaces.receiveRemoteCommit({ ...worker.options, request_id: randomUUID(), old_commit: source,
      original_commit: source, commit, final_delivery: true, agent_exited: true });
    f.store.finishRun(run.id, 'completed', { result: 'controlled repair' });
    f.store.update(worker.id, { status: 'waiting', head_commit: commit });
    expect(await f.project.settleTaskSyncResolution(worker.id)).toBe(true);
    expect(f.store.task(worker.id).iteration_base_commit).toBe(parent);
    expect(f.store.task(worker.id).integration).toBe('pending');
    expect(await git(f.root, 'merge-base', '--is-ancestor', source, commit)).toBe('');
    expect(await git(f.root, 'merge-base', '--is-ancestor', parent, commit)).toBe('');
    expect(await git(f.root, 'rev-parse', 'main')).toBe(parent);
  } finally { await f.close(); }
});

test('explicit sync resumes fixed candidate after ACK loss and new Project/Store without rebuilding or replaying CAS', async () => {
  const f = await runnerProjectFixture(); quiet(f.project); let recovered;
  try {
    const worker = await f.worker(); await parentCommit(f);
    const update = f.store.updateRunnerReceipt.bind(f.store);
    f.store.updateRunnerReceipt = (identity, patch, revision) => {
      if (patch.state === 'acknowledged') throw new Error('fixture lost ACK');
      return update(identity, patch, revision);
    };
    await expect(f.project.syncTaskParent(worker.id)).rejects.toThrow('lost ACK');
    f.store.updateRunnerReceipt = update;
    const fixed = await git(f.root, 'rev-parse', `refs/heads/${worker.task.branch}`);
    expect(f.store.runnerBarriers(worker.id).receipts[0].state).toBe('applying');
    expect(f.project.maintenanceView().blockers.some(reason => reason.includes('Runner'))).toBe(true);
    const store = new Store(path.join(f.config.home, 'project.db'), f.root);
    const project = new Project(f.config, store, null, { runner: f.project.runnerOptions });
    recovered = { store, project }; quiet(project); project.stopping = true;
    project.workspaces.prepareTaskParentSyncUnsafe = async () => { throw new Error('must not regenerate'); };
    project.workspaces.applyRemoteTaskParentSyncUnsafe = async () => { throw new Error('must not replay'); };
    const result = await project.syncTaskParent(worker.id);
    expect(result.conflict).toBe(false); expect(result.task.head_commit).toBe(fixed);
    expect(store.runnerBinding(worker.id).head_commit).toBe(fixed);
    expect(store.runnerBarriers(worker.id).receipts).toHaveLength(0);
    expect(store.history(worker.id).filter(row => row.type === 'task.runner_parent_sync_prepared')).toHaveLength(1);
  } finally {
    if (recovered) { await recovered.project.shutdown(); recovered.store.close(); }
    await f.close();
  }
});

test('ACK followed by interrupted Project settlement stays unknown until the explicit sync resumes its fixed result', async () => {
  const f = await runnerProjectFixture(); quiet(f.project);
  try {
    const worker = await f.worker(); await parentCommit(f);
    const event = f.store.event.bind(f.store);
    f.store.event = (id, type, data) => {
      if (type === 'task.parent_synced') throw new Error('fixture interrupted settlement');
      return event(id, type, data);
    };
    await expect(f.project.syncTaskParent(worker.id)).rejects.toThrow('interrupted settlement');
    f.store.event = event;
    expect(f.store.runnerBinding(worker.id).state).toBe('unknown');
    expect(() => f.project.cancel(worker.id)).toThrow('fixed receipt');
    await expect(f.project.acceptTask(worker.id)).rejects.toThrow('Runner workspace is not confirmed ready');
    const preview = await f.project.deleteTaskPreview(worker.id);
    expect(preview.can_delete).toBe(false);
    expect(preview.blockers.some(reason => reason.includes('Runner workspace is not confirmed ready'))).toBe(true);
    expect(f.project.maintenanceView().blockers.some(reason => reason.includes('Runner'))).toBe(true);
    // Represent a crash before the catch path recorded unknown: ACK is durable, settlement is not.
    const binding = f.store.runnerBinding(worker.id);
    expect(() => f.store.confirmRunnerWorkspace(runnerIdentity(binding), binding.head_commit, binding.revision)).toThrow('fixed receipt');
    f.store.run("UPDATE runner_bindings SET state='ready' WHERE worker_id=?", worker.id);
    expect(f.store.runnerBarriers(worker.id).bindings).toHaveLength(1);
    expect(f.store.runnerBarriers(worker.id).receipts[0].state).toBe('acknowledged');
    expect(runnerPendingCount(f.project)).toBeGreaterThan(0);
    expect(() => assertRunnerIdle(f.project, worker.id)).toThrow('fixed receipt');
    await expect(reconcileRunnerWorker(f.project, worker.id)).rejects.toThrow('fixed receipt');
    // Current cancel already refuses this state. A historical cancelled row must not let retry
    // bypass the same durable barrier, even if an older daemon confirmed the binding ready.
    f.store.update(worker.id, { status: 'cancelled' });
    await expect(f.project.retry(worker.id)).rejects.toThrow('fixed receipt');
    expect(() => f.project.retryAfterRunnerStop(worker.id)).toThrow('unresolved work');
    expect(f.store.task(worker.id).status).toBe('cancelled');
    f.store.update(worker.id, { status: 'waiting' });
    f.project.recover();
    expect(f.store.runnerBinding(worker.id).state).toBe('unknown');
    f.project.workspaces.prepareTaskParentSyncUnsafe = async () => { throw new Error('do not regenerate'); };
    f.project.workspaces.applyRemoteTaskParentSyncUnsafe = async () => { throw new Error('do not replay'); };
    const result = await f.project.syncTaskParent(worker.id);
    expect(result.conflict).toBe(false);
    expect(f.store.runnerBinding(worker.id).state).toBe('ready');
    expect(f.store.runnerBinding(worker.id).head_commit).toBe(result.task.head_commit);
    expect(f.store.runnerBarriers(worker.id)).toEqual({ bindings: [], runs: [], receipts: [] });
    expect(runnerPendingCount(f.project)).toBe(0);
    f.project.cancel(worker.id);
    await Promise.all([...f.project.runnerStopJobs]);
    expect((await f.project.retry(worker.id)).status).toBe('queued');
  } finally { await f.close(); }
});

test('explicit sync owns both logical gates before confirmation and keeps acceptance/deletion blocked until settlement', async () => {
  const f = await runnerProjectFixture(); quiet(f.project);
  let proceed, sync;
  const resume = new Promise(resolve => { proceed = resolve; });
  try {
    const worker = await f.worker(); await parentCommit(f);
    const event = f.store.event.bind(f.store);
    f.store.event = (id, type, data) => {
      if (type === 'task.parent_synced') throw new Error('fixture settlement interrupted');
      return event(id, type, data);
    };
    await expect(f.project.syncTaskParent(worker.id)).rejects.toThrow('settlement interrupted');
    f.store.event = event;
    let confirmed = false, paused = false, reached;
    const checkpoint = new Promise(resolve => { reached = resolve; });
    const confirm = f.store.confirmRunnerWorkspace.bind(f.store);
    f.store.confirmRunnerWorkspace = (...args) => {
      const result = confirm(...args); confirmed = true; return result;
    };
    const exclusive = f.project.workspaces.exclusive.bind(f.project.workspaces);
    f.project.workspaces.exclusive = async operation => {
      const result = await exclusive(operation);
      if (confirmed && !paused) { paused = true; reached(); await resume; }
      return result;
    };
    sync = f.project.syncTaskParent(worker.id);
    await Promise.race([checkpoint, sync.then(() => { throw new Error('confirmation checkpoint missing'); })]);
    expect(f.store.runnerBinding(worker.id).state).toBe('ready');
    expect(f.project.taskSyncBusy.has(worker.id)).toBe(true);
    expect(f.project.taskSyncBusy.has(worker.task.parent_id)).toBe(true);
    expect(f.project.workspaces.pending).toBe(0); // pause outside the Git queue
    await expect(f.project.acceptTask(worker.id)).rejects.toThrow('parent sync is in flight');
    const preview = await f.project.deleteTaskPreview(worker.id);
    expect(preview.can_delete).toBe(false);
    expect(preview.blockers.some(reason => reason.includes('fixed receipt'))).toBe(true);
    await expect(f.project.deleteTask(worker.id, { confirm: true, revision: preview.revision })).rejects.toThrow('fixed receipt');
    await expect(reconcileRunnerWorker(f.project, worker.id)).rejects.toThrow('fixed receipt');
    expect(() => assertRunnerIdle(f.project, worker.id)).toThrow('fixed receipt');
    proceed(); await sync;
    expect(f.project.taskSyncBusy.size).toBe(0);
    expect(f.store.runnerBarriers(worker.id)).toEqual({ bindings: [], runs: [], receipts: [] });
    expect((await f.project.acceptTask(worker.id)).status).toBe('completed');
    const settled = await f.project.deleteTaskPreview(worker.id);
    expect(settled.can_delete).toBe(true);
    expect((await f.project.deleteTask(worker.id, { confirm: true, revision: settled.revision })).deleted.ids).toEqual([worker.id]);
  } finally { proceed(); await sync?.catch(() => {}); await f.close(); }
});

test('cross-node sync after Squash uses its delivery baseline without replaying old source changes', async () => {
  const f = await runnerProjectFixture(); quiet(f.project);
  try {
    const parent = await f.worker(), child = await f.worker({ parent_id: parent.id, node_index: 1 });
    const source = await f.commit(child, 'file.txt', 'delivered-child');
    await f.project.requestTaskMerge(child.id);
    f.project.stopping = false;
    try { await f.project.driveTaskMerge(parent.id); } finally { f.project.stopping = true; }
    expect(f.store.task(child.id).integration).toBe('merged');
    const parentTip = await f.commit(parent, 'file.txt', 'new-parent');
    // The controlled parent has processed its delivery notification and finished this new commit.
    f.store.run('UPDATE messages SET consumed=1 WHERE task_id=?', parent.id);
    f.store.update(parent.id, { status: 'waiting' });
    const result = await f.project.syncTaskParent(child.id);
    expect(result.conflict).toBe(false); expect(result.task.integration).toBe('merged');
    expect(result.task.iteration_base_commit).toBe(parentTip);
    expect(await command(child.client, 'cat file.txt')).toBe('new-parent');
    expect(await git(f.root, 'show', '-s', '--format=%P', result.task.head_commit)).toBe(`${source} ${parentTip}`);
    expect(f.store.runnerBinding(parent.id).head_commit).toBe(parentTip);
  } finally { await f.close(); }
});

test('fixed parent ref drift leaves an explicit sync receipt blocked without overwriting the source', async () => {
  const f = await runnerProjectFixture(); quiet(f.project);
  try {
    const worker = await f.worker(), parent = await parentCommit(f);
    const apply = f.project.workspaces.applyRemoteTaskParentSyncUnsafe.bind(f.project.workspaces);
    let moved;
    f.project.workspaces.applyRemoteTaskParentSyncUnsafe = async (...args) => {
      moved = await git(f.root, 'commit-tree', `${parent}^{tree}`, '-p', parent, '-m', 'external advance');
      await git(f.root, 'update-ref', 'refs/heads/main', moved, parent);
      return apply(...args);
    };
    await expect(f.project.syncTaskParent(worker.id)).rejects.toThrow();
    expect(await git(f.root, 'rev-parse', `refs/heads/${worker.task.branch}`)).toBe(worker.task.base_commit);
    expect(await git(f.root, 'rev-parse', 'main')).toBe(moved);
    expect(f.store.runnerBarriers(worker.id).receipts[0].state).toBe('prepared');
    expect(f.store.history(worker.id).some(row => row.type === 'task.parent_synced')).toBe(false);
  } finally { await f.close(); }
});

test('dirty remote source blocks explicit parent sync before any central ref update', async () => {
  const f = await runnerProjectFixture(); quiet(f.project);
  try {
    const worker = await f.worker(); await parentCommit(f);
    await command(worker.client, 'printf dirty > dirty.txt');
    await expect(f.project.syncTaskParent(worker.id)).rejects.toThrow('dirty');
    expect(await git(f.root, 'rev-parse', `refs/heads/${worker.task.branch}`)).toBe(worker.task.base_commit);
    expect(f.store.runnerBarriers(worker.id).receipts).toHaveLength(0);
  } finally { await f.close(); }
});
