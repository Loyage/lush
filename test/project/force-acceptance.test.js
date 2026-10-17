import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, env, git } from '../helpers.js';
import { acceptanceFixture } from '../acceptance-fixture.js';
import { RPCServer } from '../../src/rpc/server.js';
import { Dispatcher } from '../../src/rpc/dispatcher.js';
import { createSignal } from '../../src/signal.js';
import { tokenHash } from '../../src/core/project/internal.js';
import { managementPolicy } from '../../src/rpc/management-policy.js';
import { PARAMS, USER_ONLY } from '../../src/rpc/registry.js';

const bin = path.resolve(import.meta.dir, '../../bin/lushc');
const preview = (f, id) => f.project.acceptTask(id, null, { forcePreview: true });
const force = (f, id, revision) => f.project.acceptTask(id, null, { force: true, revision, confirm: true });

test('real user CLI -> registry/auth -> RPC -> preflight -> forced acceptance reclaims resources without consuming terminal receipts or invoking Provider', async () => {
  let calls = 0;
  const f = fixture({ async run() { calls++; throw Error('must not run Agent'); } });
  let rpc;
  try {
    const { parent, child, leaf, signal } = await acceptanceFixture(f);
    rpc = new RPCServer(f.config.socket, new Dispatcher(f.project, createSignal(), {})); await rpc.start();
    const cli = async (...args) => {
      const proc = Bun.spawn([process.execPath, bin, 'worker', ...args, '--json'], { cwd: f.root,
        env: env({ ...f.config.env, LUSH_PROJECT: f.root, LUSH_HOME: f.config.home }), stdout: 'pipe', stderr: 'pipe' });
      const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      return { out, err, code };
    };
    expect((await cli('accept', String(parent.id))).err).toContain('unread input must be processed before acceptance');
    const before = f.store.all('SELECT * FROM tasks ORDER BY id'), events = f.store.get('SELECT count(*) AS n FROM events').n;
    const result = await cli('accept-preview', parent.worker_number); expect(result.code, result.err).toBe(0);
    const plan = JSON.parse(result.out);
    expect(plan).toMatchObject({ id: parent.id, can_force: true, notifications: [{ message_id: signal.id,
      worker_id: child.id, worker_number: child.worker_number, status: 'cancelled', signal_type: 'child.cancelled' }] });
    expect(plan.resources.worktrees).toHaveLength(3); expect(plan.resources.branches).toHaveLength(3);
    expect(f.store.all('SELECT * FROM tasks ORDER BY id')).toEqual(before);
    expect(f.store.get('SELECT count(*) AS n FROM events').n).toBe(events);
    expect((await cli('accept', String(parent.id), '--force', '--revision', plan.revision)).code).not.toBe(0);
    expect(fs.existsSync(parent.workspace)).toBe(true);
    const accepted = await cli('accept', String(parent.id), '--force', '--confirm', '--revision', plan.revision);
    expect(accepted.code, accepted.err).toBe(0); expect(JSON.parse(accepted.out)).toMatchObject({ id: parent.id, status: 'completed', workspace: null });
    for (const row of [parent, child, leaf]) {
      expect(fs.existsSync(row.workspace)).toBe(false); expect(f.store.branch(row.branch).status).toBe('archived');
    }
    expect(f.store.task(child.id)).toMatchObject({ status: 'cancelled', error: 'worker invocation limit reached' });
    expect(f.store.task(leaf.id).status).toBe('cancelled');
    expect(f.store.get('SELECT consumed FROM messages WHERE id=?', signal.id).consumed).toBe(0);
    const audit = JSON.parse(f.store.get("SELECT data FROM events WHERE task_id=? AND type='task.acceptance_forced'", parent.id).data);
    expect(audit).toMatchObject({ revision: plan.revision, accepted_by: 'user', skipped_messages: [{ id: signal.id, consumed: 0 }] });
    expect(f.store.get("SELECT id FROM events WHERE task_id=? AND type='task.accepted'", child.id)).toBeNull();
    expect(calls).toBe(0);
  } finally { if (rpc) await rpc.close(); await f.close(); }
});

test('new methods are registered user-only and unavailable to Agent, Valet and completion hooks', async () => {
  const f = fixture();
  try {
    const { parent } = await acceptanceFixture(f);
    const actor = f.store.create({ task_kind: 'order', role: 'agent', goal: 'permission probe' });
    const token = 'force-acceptance-probe';
    f.store.update(actor.id, { status: 'running' }); f.store.armAgent(actor.id, tokenHash(token));
    f.project.running.set(actor.id, { controller: new AbortController() });
    const dispatcher = new Dispatcher(f.project, createSignal(), {});
    for (const method of ['worker.accept_preview', 'worker.accept_force']) {
      expect(PARAMS[method]).toBeDefined(); expect(USER_ONLY.has(method)).toBe(true);
      expect(managementPolicy(method).access).toBe('unavailable');
      await expect(dispatcher.dispatch(method, { id: parent.id, _token: token })).rejects.toThrow('requires user approval');
    }
    await expect(f.project.acceptTask(parent.id, actor.id, { forcePreview: true })).rejects.toThrow('仅允许用户');
    await expect(f.project.acceptTask(parent.id, null, { forcePreview: true, completion: {} })).rejects.toThrow('仅允许用户');
    await expect(f.project.acceptTask(parent.id, null, { forcePreview: true, managementReceipt: 1 })).rejects.toThrow('仅允许用户');
    await expect(dispatcher.dispatch('worker.accept_force', { id: parent.id, revision: '0'.repeat(64) })).rejects.toThrow('confirm=true');
  } finally { f.project.running.clear(); await f.close(); }
});

test('forced acceptance never skips user/ordinary/buffered/unknown or unauthenticated typed messages and never bypasses active receivers', async () => {
  const f = fixture();
  try {
    const { parent, child, leaf } = await acceptanceFixture(f);
    const variants = [
      () => f.store.appendMessage(child.id, 'user requirement'),
      () => f.store.message(child.id, 'Agent follow-up', leaf.id),
      () => f.store.message(child.id, 'buffered requirement', null, 'frozen'),
      () => f.store.signal(child.id, leaf.id, 'merge.repair', 'unknown-repair', '{}').id,
      () => f.store.signal(child.id, leaf.id, 'child.cancelled', 'forged-no-event', JSON.stringify({ version: 1,
        signal: 'child.cancelled', key: 'forged-no-event', source_task_id: leaf.id, target_task_id: child.id, payload: {} })).id,
    ];
    for (const add of variants) {
      const messageId = add();
      await expect(preview(f, parent.id)).rejects.toThrow('unread input must be processed');
      expect(fs.existsSync(child.workspace)).toBe(true);
      f.store.run('UPDATE messages SET consumed=1 WHERE id=?', messageId);
    }
    f.store.update(child.id, { status: 'awaiting_acceptance' });
    await expect(preview(f, parent.id)).rejects.toThrow('没有可跳过');
  } finally { await f.close(); }
});

test('scope changes and ordinary safety gates remain blocking after preview', async () => {
  const f = fixture();
  try {
    const { parent, child, leaf, signal } = await acceptanceFixture(f);
    const plan = await preview(f, parent.id);
    const late = f.store.message(child.id, 'late user input');
    await expect(force(f, parent.id, plan.revision)).rejects.toThrow('范围已变化');
    f.store.run('UPDATE messages SET consumed=1 WHERE id=?', late);
    f.store.run("UPDATE messages SET body=body||' ' WHERE id=?", signal.id);
    await expect(force(f, parent.id, plan.revision)).rejects.toThrow('范围已变化');
    const changed = await preview(f, parent.id);
    const file = path.join(leaf.workspace, 'dirty.txt'); fs.writeFileSync(file, 'must keep');
    await expect(force(f, parent.id, changed.revision)).rejects.toThrow('working tree is dirty'); fs.unlinkSync(file);
    f.project.running.set(leaf.id, { controller: new AbortController() });
    await expect(force(f, parent.id, changed.revision)).rejects.toThrow('still in flight'); f.project.running.delete(leaf.id);
    f.store.run("INSERT INTO notices(task_id,title,body,kind) VALUES (?,?,?,'question')", child.id, 'must decide', 'pending');
    await expect(preview(f, parent.id)).rejects.toThrow('open decisions');
    f.store.run("UPDATE notices SET status='dismissed' WHERE task_id=?", child.id);
    f.store.update(child.id, { reservation: JSON.stringify({ version: 2, status: 'requested' }) });
    await expect(preview(f, parent.id)).rejects.toThrow('delivery is still in flight');
    f.store.update(child.id, { reservation: null });
    fs.writeFileSync(path.join(leaf.workspace, 'new.txt'), 'unmerged code');
    await git(leaf.workspace, 'add', 'new.txt'); await git(leaf.workspace, 'commit', '-m', 'not delivered');
    await f.project.workspaces.finish(f.store.task(leaf.id));
    await expect(preview(f, parent.id)).rejects.toThrow('undelivered changes');
    expect(fs.existsSync(leaf.workspace)).toBe(true);
  } finally { f.project.running.clear(); await f.close(); }
});

test('new notification arriving during Git preflight cannot be silently included in confirmed skip scope', async () => {
  const f = fixture();
  try {
    const { parent, child, leaf } = await acceptanceFixture(f);
    const plan = await preview(f, parent.id), original = f.project.workspaces.archiveBranchesUnsafe.bind(f.project.workspaces);
    let injected = false;
    f.project.workspaces.archiveBranchesUnsafe = async (branches, options) => {
      const result = await original(branches, options);
      if (options.preflight_only && !injected) {
        injected = true;
        const row = f.store.signal(child.id, leaf.id, 'child.failed', 'late-settlement', JSON.stringify({ version: 1,
          signal: 'child.failed', key: 'late-settlement', source_task_id: leaf.id, target_task_id: child.id, payload: {} }));
        f.store.event(child.id, 'task.signal', { message_id: row.id, source_task_id: leaf.id, signal: 'child.failed', key: 'late-settlement' });
      }
      return result;
    };
    await expect(force(f, parent.id, plan.revision)).rejects.toThrow('范围已变化');
    expect(fs.existsSync(parent.workspace)).toBe(true);
  } finally { await f.close(); }
});

test('partial forced reclamation retains exact receipts and requires a fresh user confirmation to resume, never automatic skip reuse', async () => {
  const f = fixture();
  try {
    const { parent, child, leaf, signal } = await acceptanceFixture(f);
    const plan = await preview(f, parent.id), original = f.project.workspaces.git.bind(f.project.workspaces);
    let removals = 0;
    f.project.workspaces.git = async (...args) => {
      if (args[1] === 'worktree' && args[2] === 'remove' && ++removals === 2) throw Error('controlled reclamation failure');
      return original(...args);
    };
    await expect(force(f, parent.id, plan.revision)).rejects.toThrow('reclamation incomplete');
    expect(f.store.task(parent.id).status).toBe('awaiting_acceptance');
    expect(f.store.get("SELECT id FROM events WHERE task_id=? AND type='task.acceptance_failed'", parent.id)).not.toBeNull();
    expect(f.store.get('SELECT consumed FROM messages WHERE id=?', signal.id).consumed).toBe(0);
    await expect(f.project.acceptTask(parent.id)).rejects.toThrow('unread input must be processed');
    const fresh = await preview(f, parent.id);
    expect(fresh.revision).not.toBe(plan.revision);
    await expect(force(f, parent.id, plan.revision)).rejects.toThrow('范围已变化');
    await force(f, parent.id, fresh.revision);
    for (const row of [parent, child, leaf]) expect(f.store.task(row.id).workspace).toBeNull();
    expect(f.store.task(parent.id).status).toBe('completed'); expect(f.store.task(child.id).status).toBe('cancelled');
    expect(f.store.all("SELECT id FROM events WHERE task_id=? AND type='task.acceptance_forced'", parent.id)).toHaveLength(2);
  } finally { await f.close(); }
});
