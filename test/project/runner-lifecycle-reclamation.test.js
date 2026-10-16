import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { Database } from 'bun:sqlite';
import { runnerProjectFixture, command, git } from './runner-delivery-harness.js';
import { runnerCleanupReceipt } from '../../src/core/project/runner-reclamation.js';
import { runnerIdentity } from '../../src/core/runner-service.js';
import { RunnerError } from '../../src/runner/protocol.js';

async function setup() {
  const f = await runnerProjectFixture();
  // Exercise the production ProjectBase callback, not a test-only substitute.
  expect(typeof f.project.workspaces.remoteReclaim).toBe('function');
  return f;
}
function nodeDatabase(f, worker) {
  const binding = f.store.runnerBinding(worker.id);
  const db = new Database(path.join(f.config.home, binding.node_id, 'runner.db'));
  db.exec('PRAGMA busy_timeout=5000'); return db;
}

test('Project accepts a remote parent and delegated child as one checked batch, retaining history and no local worktree', async () => {
  const f = await setup();
  try {
    const parent = await f.worker(), child = await f.worker({ parent_id: parent.id, node_index: 1 });
    f.store.update(child.id, { status: 'awaiting_acceptance' });
    const accepted = await f.project.acceptTask(parent.id);
    expect(accepted.status).toBe('completed');
    for (const worker of [parent, child]) {
      expect(f.store.task(worker.id).status).toBe('completed');
      expect(f.store.runnerBinding(worker.id).state).toBe('removed');
      expect(runnerCleanupReceipt(f.project, worker.id).state).toBe('removed');
      expect(f.store.branch(worker.task.branch).status).toBe('archived');
      expect(await git(f.root, 'rev-parse', '--verify', `refs/heads/${worker.task.branch}`).catch(() => null)).toBeNull();
      expect(f.store.history(worker.id).some(row => row.type === 'task.accepted')).toBe(true);
    }
    await expect(f.project.reopenTask(parent.id)).rejects.toThrow();
  } finally { await f.close(); }
});

test('whole-tree preflight preserves every remote resource on dirty/ignored descendant and active child refusal', async () => {
  const f = await setup();
  try {
    const parent = await f.worker(), child = await f.worker({ parent_id: parent.id, node_index: 1 });
    await expect(f.project.acceptTask(parent.id)).rejects.toThrow('descendants');
    f.store.update(child.id, { status: 'awaiting_acceptance' });
    await command(child.client, "mkdir .lush; printf kept > .lush/ignored");
    await expect(f.project.acceptTask(parent.id)).rejects.toThrow();
    expect(f.store.runnerBinding(parent.id).state).toBe('ready');
    expect(f.store.runnerBinding(child.id).state).toBe('ready');
    expect(f.store.branch(parent.task.branch).status).toBe('active');
    expect(runnerCleanupReceipt(f.project, parent.id)).toBeNull();
    expect(await command(child.client, 'cat .lush/ignored')).toBe('kept');
  } finally { await f.close(); }
});

test('remote acceptance preserves unknown and offline state rather than treating workspace=null as reclaimed', async () => {
  const f = await setup();
  try {
    const worker = await f.worker();
    const connect = f.service.connect.bind(f.service);
    f.service.connect = async () => { throw new Error('fixture offline'); };
    await expect(f.project.acceptTask(worker.id)).rejects.toThrow('offline');
    expect(f.store.branch(worker.task.branch).status).toBe('active');
    f.service.connect = connect;
    const binding = f.store.runnerBinding(worker.id);
    f.store.markRunnerWorkspaceUnknown(runnerIdentity(binding), binding.revision);
    await expect(f.project.acceptTask(worker.id)).rejects.toThrow('ready');
    expect(f.store.task(worker.id).status).not.toBe('completed');
  } finally { await f.close(); }
});

test('lost cleanup ACK is reconciled by explicit acceptance retry without repeating remote deletion', async () => {
  const f = await setup();
  try {
    const worker = await f.worker();
    const connect = f.service.connect.bind(f.service); let cleanups = 0;
    f.service.connect = async (...args) => {
      const connection = await connect(...args), request = connection.client.transport.request.bind(connection.client.transport);
      connection.client.transport.request = async (frame, options) => {
        expect(f.project.workspaces.pending).toBe(0); // no central Git gate is held across node IO
        const result = await request(frame, options);
        if (frame.method === 'workspace.cleanup') { cleanups++; throw new RunnerError('UNKNOWN', 'fixture loses ACK'); }
        return result;
      };
      return connection;
    };
    await expect(f.project.acceptTask(worker.id)).rejects.toThrow('ACK');
    expect(f.store.branch(worker.task.branch).status).toBe('active');
    const request = runnerCleanupReceipt(f.project, worker.id).request_id;
    expect((await f.project.acceptTask(worker.id)).status).toBe('completed');
    expect(cleanups).toBe(1);
    expect(runnerCleanupReceipt(f.project, worker.id).request_id).toBe(request);
  } finally { await f.close(); }
});

test('known partial resource failure can resume after exact inode restoration; unknown cannot use a fresh attempt', async () => {
  const f = await setup();
  try {
    const worker = await f.worker();
    const home = await command(worker.client, 'printf cache > "$HOME/cache"; printf %s "$HOME"');
    fs.renameSync(home, home + '-original'); fs.mkdirSync(home);
    await expect(f.project.acceptTask(worker.id)).rejects.toThrow();
    expect(f.store.branch(worker.task.branch).status).toBe('active');
    const request = runnerCleanupReceipt(f.project, worker.id).request_id;
    fs.rmdirSync(home); fs.renameSync(home + '-original', home);
    expect((await f.project.acceptTask(worker.id)).status).toBe('completed');
    expect(runnerCleanupReceipt(f.project, worker.id).request_id).toBe(request);
    const other = await f.worker({ node_index: 1, name: 'unknown' });
    await command(other.client, 'printf cache > "$HOME/cache"');
    const db = nodeDatabase(f, other);
    try { db.exec("UPDATE command_resources SET phase='preparing',home_state='creating',home_json=json_remove(home_json,'$.dev','$.ino')"); }
    finally { db.close(); }
    await expect(f.project.acceptTask(other.id)).rejects.toThrow();
    const attempts = f.store.history(other.id).filter(row => row.type === 'runner.cleanup_attempt').length;
    await expect(f.project.acceptTask(other.id)).rejects.toThrow('unknown');
    expect(f.store.history(other.id).filter(row => row.type === 'runner.cleanup_attempt')).toHaveLength(attempts);
    expect(f.store.runnerBinding(other.id).state).toBe('ready');
  } finally { await f.close(); }
});

test('cleanup keep-branch preserves the remote code workspace, normal cleanup removes resources before central ref', async () => {
  const f = await setup();
  try {
    const worker = await f.worker(); f.store.update(worker.id, { status: 'cancelled' });
    expect((await f.project.workspaces.cleanup(worker.id, { keepBranch: true })).cleanup.worktree).toBe('kept');
    expect(f.store.runnerBinding(worker.id).state).toBe('ready');
    expect((await f.project.workspaces.cleanup(worker.id)).cleanup).toMatchObject({ branch: 'removed', worktree: 'removed' });
    expect(f.store.runnerBinding(worker.id).state).toBe('removed');
    const dirty = await f.worker({ node_index: 1 }); f.store.update(dirty.id, { status: 'cancelled' });
    await command(dirty.client, 'printf dirty > new.txt');
    await expect(f.project.archiveBranch(dirty.task.branch, { discard_worktree: true })).rejects.toThrow('clean');
    expect(f.store.runnerBinding(dirty.id).state).toBe('ready');
  } finally { await f.close(); }
});

test('confirmed delete fixes remote identity in preview, refuses stale/dirty scopes and clears only reclaimed FK adjuncts', async () => {
  const f = await setup();
  try {
    const worker = await f.worker(); f.store.update(worker.id, { status: 'cancelled' });
    const preview = await f.project.deleteTaskPreview(worker.id);
    expect(preview.can_delete).toBe(true); expect(preview.resources.runners[0].worker_id).toBe(worker.id);
    const binding = f.store.runnerBinding(worker.id);
    f.store.run('UPDATE runner_bindings SET revision=revision+1 WHERE worker_id=?', worker.id);
    await expect(f.project.deleteTask(worker.id, { revision: preview.revision, confirm: true })).rejects.toThrow('changed');
    expect(f.store.runnerBinding(worker.id).state).toBe('ready');
    const current = await f.project.deleteTaskPreview(worker.id);
    const result = await f.project.deleteTask(worker.id, { revision: current.revision, confirm: true });
    expect(result.deleted.ids).toEqual([worker.id]);
    expect(f.store.get('SELECT * FROM tasks WHERE id=?', worker.id)).toBeNull();
    expect(f.store.get('SELECT * FROM runner_bindings WHERE worker_id=?', worker.id)).toBeNull();
    expect(f.store.get('SELECT * FROM runner_receipts WHERE worker_id=?', worker.id)).toBeNull();
    expect(binding.workspace_id).toBeTruthy();
    const dirty = await f.worker({ name: 'dirty' }); f.store.update(dirty.id, { status: 'cancelled' });
    await command(dirty.client, 'printf dirty > new.txt');
    expect((await f.project.deleteTaskPreview(dirty.id, { force: true })).can_delete).toBe(false);
    expect(f.store.runnerBinding(dirty.id).state).toBe('ready');
  } finally { await f.close(); }
});

test('remote partial batch keeps central refs and requires root continuation after child failure and restart', async () => {
  const f = await setup();
  try {
    const parent = await f.worker(), child = await f.worker({ parent_id: parent.id, node_index: 1 });
    f.store.update(child.id, { status: 'awaiting_acceptance' });
    const home = await command(child.client, 'printf cache > "$HOME/cache"; printf %s "$HOME"');
    fs.renameSync(home, home + '-original'); fs.mkdirSync(home);
    await expect(f.project.acceptTask(parent.id)).rejects.toThrow();
    expect(f.store.runnerBinding(parent.id).state).toBe('removed');
    expect(f.store.branch(parent.task.branch).status).toBe('active');
    expect(f.store.task(parent.id).status).toBe('waiting');
    await expect(f.project.acceptTask(child.id)).rejects.toThrow('partial parent acceptance');
    // Recreate the Project, retaining real persisted SQLite and independent Runner roots.
    const { Project } = await import('../../src/core/project.js');
    const resumed = new Project(f.config, f.store, null, { runner: f.project.runnerOptions });
    resumed.stopping = true;
    try {
      await expect(resumed.acceptTask(child.id)).rejects.toThrow('partial parent acceptance');
      fs.rmdirSync(home); fs.renameSync(home + '-original', home);
      expect((await resumed.acceptTask(parent.id)).status).toBe('completed');
      expect(f.store.task(child.id).status).toBe('completed');
    } finally { await resumed._runners?.close(); await resumed.shutdown(); }
  } finally { await f.close(); }
});

test('real remote child and parent delivery receipts remain compatible with whole-tree acceptance', async () => {
  const f = await setup();
  f.project.kick = () => {};
  f.project.scheduleDeliveryHandlerOperation = () => {};
  const drive = async parentId => {
    f.project.stopping = false;
    try { await f.project.driveTaskMerge(parentId); }
    finally { f.project.stopping = true; }
  };
  try {
    const parent = await f.worker(), child = await f.worker({ parent_id: parent.id, node_index: 1 });
    await f.commit(child);
    await f.project.requestTaskMerge(child.id);
    await drive(parent.id);
    expect(f.store.task(child.id).integration).toBe('merged');
    const sync = f.store.get("SELECT state FROM runner_receipts WHERE worker_id=? AND kind='parent_sync'", parent.id);
    expect(sync.state).toBe('acknowledged');
    // Controlled parent consumes the child result and produces its own final reviewed commit.
    // Creation/invocation settlement remains the integration owner's separate responsibility.
    f.store.run('UPDATE messages SET consumed=1 WHERE task_id=?', parent.id);
    await f.commit(parent, 'parent.txt', 'checked child');
    f.store.update(parent.id, { status: 'waiting' });
    await f.project.requestTaskMerge(parent.id);
    await drive(f.main.id);
    const delivered = f.store.task(parent.id);
    if (delivered.integration !== 'merged') throw new Error(`Parent delivery failed: ${delivered.reservation}; ${delivered.integration_error}`);
    expect(delivered.integration).toBe('merged');
    expect(await git(f.root, 'show', 'main:remote.txt')).toBe('remote');
    expect((await f.project.acceptTask(parent.id)).status).toBe('completed');
    for (const worker of [parent, child]) {
      expect(f.store.runnerBinding(worker.id).state).toBe('removed');
      expect(f.store.branch(worker.task.branch).status).toBe('archived');
    }
    expect(f.store.runnerBarriers().receipts).toHaveLength(0);
  } finally { await f.close(); }
});

test('real cancellation stop proof permits later checked cleanup without adopting an unknown Run', async () => {
  const f = await setup();
  try {
    const worker = await f.worker();
    const task = f.store.update(worker.id, { status: 'running' });
    const run = f.store.startRun(task, { agent: 'fixture' });
    f.store.authorizeRunnerRun(runnerIdentity(f.store.runnerBinding(worker.id), { run_id: run.id }), f.policy.authorization_version);
    await worker.client.call('lease.grant', { run_id: run.id, run_token: '2'.repeat(64) });
    f.project.cancel(worker.id);
    await Promise.all([...f.project.runnerStopJobs]);
    expect(f.store.runnerRun(run.id).state).toBe('released');
    expect((await f.project.workspaces.cleanup(worker.id)).cleanup.worktree).toBe('removed');
    expect(f.store.runnerBinding(worker.id).state).toBe('removed');
  } finally { await f.close(); }
});

test('reclamation rechecks frozen state and deletion FK release includes completed Runs', async () => {
  const f = await setup();
  try {
    const worker = await f.worker();
    const task = f.store.update(worker.id, { status: 'running' });
    const run = f.store.startRun(task, { agent: 'fixture' });
    const identity = runnerIdentity(f.store.runnerBinding(worker.id), { run_id: run.id });
    f.store.authorizeRunnerRun(identity, f.policy.authorization_version);
    await worker.client.call('lease.grant', { run_id: run.id, run_token: '1'.repeat(64) });
    expect((await worker.client.call('lease.revoke')).stopped).toBe(true);
    f.store.releaseRunnerRun(identity, f.store.runnerRun(run.id).revision, { stopped: true });
    f.store.finishRun(run.id, 'completed', 'fixture');
    f.store.update(worker.id, { status: 'cancelled' });
    const frozen = f.project.branchFreeze.bind(f.project);
    f.project.branchFreeze = branch => branch === worker.task.branch ? { reason: 'fixture frozen' } : frozen(branch);
    await expect(f.project.workspaces.cleanup(worker.id)).rejects.toThrow('frozen');
    expect(f.store.runnerBinding(worker.id).state).toBe('ready');
    f.project.branchFreeze = frozen;
    const preview = await f.project.deleteTaskPreview(worker.id);
    expect(preview.can_delete).toBe(true);
    const deleted = await f.project.deleteTask(worker.id, { revision: preview.revision, confirm: true });
    expect(deleted.deleted.runner_runs).toBe(1);
    expect(deleted.deleted.agent_runs).toBe(1);
    expect(f.store.all('PRAGMA foreign_key_check')).toHaveLength(0);
  } finally { await f.close(); }
});
