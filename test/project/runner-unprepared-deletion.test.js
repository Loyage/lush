import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { Database } from 'bun:sqlite';
import { runnerProjectFixture, git } from './runner-delivery-harness.js';
import { runnerCleanupReceipt } from '../../src/core/project/runner-reclamation.js';
import { runnerIdentity } from '../../src/core/runner-service.js';
import { workspaceKey, RunnerError } from '../../src/runner/protocol.js';
import { Dispatcher } from '../../src/rpc/dispatcher.js';

async function failed(f, options = {}) {
  const worker = await f.worker({ ...options, prepare: false });
  f.store.update(worker.id, { status: 'failed', error: 'Remote Lush Pi requires verified SDK 1.0.4' });
  return worker;
}
function intercept(f, inspect) {
  const connect = f.service.connect.bind(f.service);
  f.service.connect = async (...args) => {
    const connection = await connect(...args), request = connection.client.transport.request.bind(connection.client.transport);
    connection.client.transport.request = async (frame, options) => {
      expect(f.project.workspaces.pending).toBe(0);
      return inspect(frame, () => request(frame, options));
    };
    return connection;
  };
}
const confirm = (f, worker, preview) => f.project.deleteTask(worker.id, { confirm: true, revision: preview.revision });

test('RPC previews legacy SDK preparation failure read-only and confirmed deletion closes it without creating remote resources', async () => {
  const f = await runnerProjectFixture();
  try {
    const worker = await failed(f), before = f.store.runnerBinding(worker.id), methods = [];
    intercept(f, async (frame, send) => { methods.push(frame.method); return send(); });
    const rpc = new Dispatcher(f.project);
    const history = f.store.history(worker.id);
    const preview = await rpc.dispatch('worker.delete_preview', { id: worker.id });
    expect(preview.can_delete).toBe(true);
    expect(preview.resources.runners[0].state).toBe('preparing');
    expect(f.store.runnerBinding(worker.id)).toEqual(before);
    expect(runnerCleanupReceipt(f.project, worker.id)).toBeNull();
    expect(f.store.history(worker.id)).toEqual(history);
    await expect(rpc.dispatch('worker.delete', { id: worker.id, revision: preview.revision })).rejects.toThrow('confirmation');
    const remove = f.project.workspaces.deleteWorkerResourcesUnsafe.bind(f.project.workspaces);
    f.project.workspaces.deleteWorkerResourcesUnsafe = async (...args) => {
      expect(f.store.runnerBinding(worker.id).state).toBe('removed');
      expect(runnerCleanupReceipt(f.project, worker.id)).toMatchObject({ state: 'removed', terminal: 1,
        evidence: { unprepared: true, verified: true, removed: true, head_commit: before.base_commit } });
      return remove(...args);
    };
    const deleted = await rpc.dispatch('worker.delete', { id: worker.id, revision: preview.revision, confirm: true });
    expect(deleted.deleted.ids).toEqual([worker.id]);
    expect(methods.length).toBeGreaterThan(1);
    expect(methods.every(method => ['workspace.preparation.inspect', 'workspace.preparation.close'].includes(method))).toBe(true);
    expect(methods.filter(method => method === 'workspace.preparation.close')).toHaveLength(1);
    await expect(worker.client.call('workspace.register')).rejects.toThrow('permanently closed');
    expect(f.store.get('SELECT id FROM tasks WHERE id=?', worker.id)).toBeNull();
    expect(f.store.all('PRAGMA foreign_key_check')).toHaveLength(0);
    expect(await git(f.root, 'rev-parse', '--verify', worker.task.branch).catch(() => null)).toBeNull();
  } finally { await f.close(); }
});

test('unprepared deletion preserves offline, unsupported and malformed evidence barriers, even with force', async () => {
  const f = await runnerProjectFixture();
  try {
    const worker = await failed(f);
    let mode = 'offline';
    intercept(f, async (frame, send) => {
      if (frame.method !== 'workspace.preparation.inspect') return send();
      if (mode === 'offline') throw new RunnerError('UNKNOWN', 'offline fixture');
      if (mode === 'unsupported') throw new RunnerError('UNSUPPORTED', 'old node fixture');
      const response = await send();
      if (mode === 'identity') response.result.identity.generation++;
      else if (mode === 'incomplete') delete response.result.absent;
      else response.result.unknown = true;
      return response;
    });
    const connect = f.service.connect.bind(f.service);
    f.service.connect = async (...args) => {
      const connection = await connect(...args);
      if (mode === 'missing-close') connection.client.capabilities = connection.client.capabilities.filter(name => name !== 'workspace.preparation.close');
      return connection;
    };
    for (mode of ['offline', 'unsupported', 'identity', 'incomplete', 'unknown', 'missing-close']) {
      expect((await f.project.deleteTaskPreview(worker.id, { force: true })).can_delete).toBe(false);
      expect(f.store.runnerBinding(worker.id).state).toBe('preparing');
      expect(runnerCleanupReceipt(f.project, worker.id)).toBeNull();
    }
  } finally { await f.close(); }
});

test('remote registration, unfinished request or residual path appearing after preview blocks confirmation without replay', async () => {
  const f = await runnerProjectFixture();
  try {
    const registered = await failed(f), preview = await f.project.deleteTaskPreview(registered.id);
    await registered.client.call('workspace.register');
    await expect(confirm(f, registered, preview)).rejects.toThrow('registration');
    expect(f.store.runnerBinding(registered.id).state).toBe('preparing');
    expect(runnerCleanupReceipt(f.project, registered.id)).toBeNull();
    const remnant = await failed(f, { name: 'remnant' }), before = await f.project.deleteTaskPreview(remnant.id);
    const binding = f.store.runnerBinding(remnant.id), directory = path.join(f.config.home, binding.node_id, 'workspaces', workspaceKey(binding));
    fs.mkdirSync(directory); fs.writeFileSync(path.join(directory, 'keep'), 'keep');
    await expect(confirm(f, remnant, before)).rejects.toThrow('directory');
    expect(fs.readFileSync(path.join(directory, 'keep'), 'utf8')).toBe('keep');
    const pending = await failed(f, { name: 'pending' }), initial = await f.project.deleteTaskPreview(pending.id);
    const row = f.store.runnerBinding(pending.id), db = new Database(path.join(f.config.home, row.node_id, 'runner.db'));
    try {
      const identity = runnerIdentity(row, { operation_id: `prepare:${row.workspace_id}:${row.generation}` });
      db.query('INSERT INTO requests VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(row.project_id, 'lost-register', workspaceKey(row),
        JSON.stringify(identity), 'workspace.register', 'f'.repeat(64), 'unknown', null, null, 'lost-session', 0, 0);
    } finally { db.close(); }
    await expect(confirm(f, pending, initial)).rejects.toThrow('recorded preparation');
    expect(f.store.get('SELECT id FROM tasks WHERE id=?', pending.id)).not.toBeNull();
  } finally { await f.close(); }
});

test('central history, active invocation, unknown binding, revision and ref drift remain protected', async () => {
  const f = await runnerProjectFixture();
  try {
    const worker = await failed(f), preview = await f.project.deleteTaskPreview(worker.id);
    f.project.running.set(worker.id, {});
    expect((await f.project.deleteTaskPreview(worker.id)).can_delete).toBe(false);
    f.project.running.delete(worker.id);
    f.store.update(worker.id, { calls: 1 });
    expect((await f.project.deleteTaskPreview(worker.id)).can_delete).toBe(false);
    f.store.update(worker.id, { calls: 0 });
    const run = f.store.startRun(f.store.task(worker.id), { agent: 'fixture' });
    f.store.finishRun(run.id, 'failed', 'fixture');
    expect((await f.project.deleteTaskPreview(worker.id)).can_delete).toBe(false);
    await expect(confirm(f, worker, preview)).rejects.toThrow();
    const unknown = await failed(f, { name: 'unknown' }), row = f.store.runnerBinding(unknown.id);
    f.store.markRunnerWorkspaceUnknown(runnerIdentity(row), row.revision);
    expect((await f.project.deleteTaskPreview(unknown.id)).can_delete).toBe(false);
    const changed = await failed(f, { name: 'changed' }), current = await f.project.deleteTaskPreview(changed.id);
    f.store.run('UPDATE runner_bindings SET revision=revision+1 WHERE worker_id=?', changed.id);
    await expect(confirm(f, changed, current)).rejects.toThrow();
    const drifted = await failed(f, { name: 'drifted' }), fixed = await f.project.deleteTaskPreview(drifted.id);
    await git(f.root, 'commit', '--allow-empty', '-m', 'external advancement');
    await git(f.root, 'update-ref', `refs/heads/${drifted.task.branch}`, await git(f.root, 'rev-parse', 'HEAD'));
    expect((await f.project.deleteTaskPreview(drifted.id)).can_delete).toBe(false);
    await expect(confirm(f, drifted, fixed)).rejects.toThrow();
    expect(f.store.runnerBinding(drifted.id).state).toBe('preparing');
  } finally { await f.close(); }
});

test('lost closure ACK resumes only its original fence after restart; unknown unsealed requests never replay', async () => {
  const f = await runnerProjectFixture();
  try {
    const worker = await failed(f); let sends = 0;
    intercept(f, async (frame, send) => {
      const result = await send();
      if (frame.method === 'workspace.preparation.close') { sends++; throw new RunnerError('UNKNOWN', 'lost closure ACK'); }
      return result;
    });
    const preview = await f.project.deleteTaskPreview(worker.id);
    await expect(confirm(f, worker, preview)).rejects.toThrow('lost closure ACK');
    const receipt = runnerCleanupReceipt(f.project, worker.id);
    expect(receipt.state).toBe('prepared');
    expect(f.store.runnerBinding(worker.id).state).toBe('preparing');
    await expect(worker.client.call('workspace.register')).rejects.toThrow('permanently closed');
    const { Project } = await import('../../src/core/project.js');
    const resumed = new Project(f.config, f.store, null, { runner: f.project.runnerOptions });
    resumed.stopping = true;
    try {
      const current = await resumed.deleteTaskPreview(worker.id);
      expect(current.can_delete).toBe(true);
      expect((await resumed.deleteTask(worker.id, { confirm: true, revision: current.revision })).deleted.ids).toEqual([worker.id]);
      expect(sends).toBe(1);
    } finally { await resumed._runners?.close(); await resumed.shutdown(); }
    // A request accepted without an atomic seal remains blocked, not retried with the same/new ID.
    const unknown = await failed(f, { name: 'unsealed' });
    const initial = await f.project.deleteTaskPreview(unknown.id);
    const row = f.store.runnerBinding(unknown.id), close = f.project.workspaces.closeUnpreparedRemoteWorkspace.bind(f.project.workspaces);
    f.project.workspaces.closeUnpreparedRemoteWorkspace = async options => {
      const value = { ...options.identity, request_id: options.request_id, authorization_version: options.authorization_version };
      f.store.prepareUnpreparedRunnerCleanup(value, row.revision);
      const db = new Database(path.join(f.config.home, row.node_id, 'runner.db'));
      try {
        db.query('INSERT INTO requests VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(row.project_id, options.request_id, workspaceKey(row),
          JSON.stringify(options.identity), 'workspace.preparation.close', 'f'.repeat(64), 'unknown', null, null, 'lost', 0, 0);
      } finally { db.close(); }
      throw new RunnerError('UNKNOWN', 'unsealed fixture');
    };
    await expect(confirm(f, unknown, initial)).rejects.toThrow('unsealed fixture');
    f.project.workspaces.closeUnpreparedRemoteWorkspace = close;
    expect((await f.project.deleteTaskPreview(unknown.id)).can_delete).toBe(false);
    expect(f.store.runnerBinding(unknown.id).state).toBe('preparing');
  } finally { await f.close(); }
});

test('partial deletion retains atomic absence receipt across restart and needs a fresh preview to continue', async () => {
  const f = await runnerProjectFixture();
  try {
    const parent = await failed(f), child = await failed(f, { parent_id: parent.id, node_index: 1 });
    const preview = await f.project.deleteTaskPreview(parent.id);
    const remove = f.project.workspaces.deleteWorkerResourcesUnsafe;
    f.project.workspaces.deleteWorkerResourcesUnsafe = async () => { throw new Error('fixture central cleanup failure'); };
    await expect(confirm(f, parent, preview)).rejects.toThrow('central cleanup failure');
    expect(f.store.runnerBinding(parent.id).state).toBe('removed');
    expect(f.store.runnerBinding(child.id).state).toBe('removed');
    expect(runnerCleanupReceipt(f.project, parent.id).evidence.unprepared).toBe(true);
    expect(f.store.get('SELECT id FROM tasks WHERE id=?', parent.id)).not.toBeNull();
    f.project.workspaces.deleteWorkerResourcesUnsafe = remove;
    const { Project } = await import('../../src/core/project.js');
    const resumed = new Project(f.config, f.store, null, { runner: f.project.runnerOptions });
    resumed.stopping = true;
    try {
      await expect(resumed.deleteTask(parent.id, { confirm: true, revision: preview.revision })).rejects.toThrow('changed');
      const current = await resumed.deleteTaskPreview(parent.id);
      expect(current.can_delete).toBe(true);
      const result = await resumed.deleteTask(parent.id, { confirm: true, revision: current.revision });
      expect(result.deleted.ids).toEqual([parent.id, child.id]);
    } finally { await resumed._runners?.close(); await resumed.shutdown(); }
  } finally { await f.close(); }
});
