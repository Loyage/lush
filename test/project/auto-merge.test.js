import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { Database } from 'bun:sqlite';
import { Store } from '../../src/persistence/store.js';
import { Project } from '../../src/core/project.js';
import { fixture, repo, git, until, gate } from '../helpers.js';

const booking = (f, id) => JSON.parse(f.store.task(id).reservation);
const settings = (f, id) => JSON.parse(f.store.task(id).auto_merge);
async function commit(task, name = 'work') {
  fs.writeFileSync(path.join(task.workspace, `${name}.txt`), `${name}\n`);
  await git(task.workspace, 'add', '.'); await git(task.workspace, 'commit', '-m', name);
}
async function setup(provider) {
  const f = fixture(provider); f.project.stopping = true; await repo(f.root); return f;
}

test('new say hook is off; new delegated child is on and locked through both mutation routes', async () => {
  const f = await setup();
  try {
    const { task } = await f.project.say('parent');
    expect(settings(f, task.id)).toEqual({ version: 1, enabled: false, locked: false });
    expect(f.store.task(task.id).reservation).toBeNull();
    const child = await f.project.spawn(task.id, 'child');
    expect(settings(f, child.id)).toEqual({ version: 1, enabled: true, locked: true });
    expect(booking(f, child.id)).toMatchObject({ version: 2, status: 'pending', auto_merge: true });
    const expected = { enabled: true, locked: true, editable: false };
    expect(f.project.inspect(child.id).auto_merge).toMatchObject(expected);
    expect((await f.project.taskGraph()).nodes.find(row => row.id === child.id).auto_merge).toMatchObject(expected);
    await expect(f.project.setTaskAutoMerge(child.id, false)).rejects.toThrow('不能关闭');
    expect(() => f.project.unreserveTask(child.id)).toThrow('锁定');
    expect((await f.project.setTaskAutoMerge(child.id, true)).changed).toBe(false);
    expect(f.project.inspect(task.parent_id).auto_merge).toBeNull();
    await expect(f.project.setTaskAutoMerge(task.parent_id, true)).rejects.toThrow('only version 2');
  } finally { await f.close(); }
});

test('toggle persists a hook, cancels only automatic pending intent, and validates booleans', async () => {
  const f = await setup();
  try {
    const { task } = await f.project.say('toggle');
    for (const value of ['true', 1, null, undefined]) await expect(f.project.setTaskAutoMerge(task.id, value)).rejects.toThrow('boolean');
    expect((await f.project.setTaskAutoMerge(task.id, true)).auto_merge).toMatchObject({ enabled: true, editable: true });
    expect(booking(f, task.id)).toMatchObject({ status: 'pending', auto_merge: true });
    const count = f.store.history(task.id).length;
    expect((await f.project.setTaskAutoMerge(task.id, true)).changed).toBe(false);
    expect(f.store.history(task.id)).toHaveLength(count);
    await f.project.setTaskAutoMerge(task.id, false);
    expect(f.store.task(task.id).reservation).toBeNull();
    expect(settings(f, task.id).enabled).toBe(false);
    await f.project.setTaskAutoMerge(task.id, true);
    await f.project.reserveTask(task.id, 'merge');
    expect(booking(f, task.id).auto_merge).toBeUndefined();
    await f.project.setTaskAutoMerge(task.id, false);
    expect(booking(f, task.id).status).toBe('pending');
    f.project.unreserveTask(task.id);
    await f.project.reserveTask(task.id, 'merge');
    expect(settings(f, task.id).enabled).toBe(false);
    expect(booking(f, task.id).status).toBe('pending');
  } finally { await f.close(); }
});

test('switching a new say hook off before its invocation ends prevents automatic requests and survives restart', async () => {
  const entered = gate(), pause = gate();
  const f = await setup({ resolve() { return { agent: 'mock' }; }, async run({ task }) {
    await commit(task, 'disabled'); entered.resolve(); await pause.promise; return 'done without merge';
  } });
  try {
    const { task } = await f.project.say('disable before delivery');
    const baseline = await git(f.root, 'rev-parse', 'main');
    await f.project.setTaskAutoMerge(task.id, true);
    f.project.stopping = false; f.project.kick();
    await entered.promise;
    await f.project.setTaskAutoMerge(task.id, false);
    expect(f.store.task(task.id).reservation).toBeNull();
    pause.resolve();
    await until(() => f.store.task(task.id).status === 'waiting' && !f.project.running.has(task.id));
    f.project.stopping = true; f.project.recover();
    await f.project.workspaces.exclusive(async () => {});
    expect(f.store.task(task.id)).toMatchObject({ status: 'waiting', integration: 'pending', reservation: null });
    expect(settings(f, task.id).enabled).toBe(false);
    expect(f.project.inspect(task.id).merge_readiness.ready).toBe(true);
    expect(f.store.history(task.id).filter(event => event.type === 'task.merge_requested')).toHaveLength(0);
    expect(await git(f.root, 'rev-parse', 'main')).toBe(baseline);
  } finally { pause.resolve(); await f.close(); }
});

test('completed work, sent requests, repair, terminal status and parent sync prohibit changing the hook', async () => {
  const f = await setup();
  try {
    const { task } = await f.project.say('guard');
    await commit(task); f.store.update(task.id, { status: 'waiting' });
    await f.project.workspaces.finish(f.store.task(task.id));
    expect(f.project.inspect(task.id).merge_readiness.ready).toBe(true);
    expect(f.project.inspect(task.id).auto_merge).toMatchObject({ enabled: false, editable: false });
    await expect(f.project.setTaskAutoMerge(task.id, true)).rejects.toThrow('合并按钮');
    await f.project.reserveTask(task.id, 'merge');
    expect(booking(f, task.id).status).toBe('requested');
    await expect(f.project.setTaskAutoMerge(task.id, true)).rejects.toThrow('请求已发出');
    f.store.update(task.id, { status: 'queued', reservation: JSON.stringify({ ...booking(f, task.id), status: 'resolving' }) });
    await expect(f.project.setTaskAutoMerge(task.id, true)).rejects.toThrow('请求已发出');
    f.store.update(task.id, { reservation: null });
    for (const status of ['completed','failed','cancelled','awaiting_acceptance']) {
      f.store.update(task.id, { status });
      await expect(f.project.setTaskAutoMerge(task.id, true)).rejects.toThrow('不能调整');
    }
    f.store.update(task.id, { status: 'queued' });
    (f.project.taskSyncBusy ??= new Set()).add(task.id);
    await expect(f.project.setTaskAutoMerge(task.id, true)).rejects.toThrow('同步');
    f.project.taskSyncBusy.delete(task.id);
    f.store.event(task.id, 'task.parent_synced', {});
    await expect(f.project.setTaskAutoMerge(task.id, true)).rejects.toThrow('交付已暂停');
  } finally { await f.close(); }
});

test('legacy NULL settings and legacy approvals remain unchanged through recovery', async () => {
  const f = await setup();
  try {
    const { task } = await f.project.say('old parent');
    const child = await f.project.spawn(task.id, 'old withdrawn child');
    f.store.update(child.id, { auto_merge: null, reservation: null, status: 'waiting' });
    f.store.update(task.id, { auto_merge: null, status: 'waiting', reservation: JSON.stringify({ version: 1, kind: 'merge', status: 'pending' }) });
    expect(f.project.inspect(task.id).auto_merge).toBeNull();
    await expect(f.project.setTaskAutoMerge(task.id, true)).rejects.toThrow('only version 2');
    f.project.recover();
    await f.project.workspaces.exclusive(async () => {});
    expect(f.store.task(child.id)).toMatchObject({ auto_merge: null, reservation: null });
    expect(f.store.task(task.id).auto_merge).toBeNull();
    expect(booking(f, task.id).version).toBe(1);
    expect(f.project.inspect(child.id).auto_merge).toMatchObject({ enabled: false, locked: false });
  } finally { await f.close(); }
});

test('legacy one-shot v2 intent stays explicit when the persistent hook is enabled then disabled', async () => {
  const f = await setup();
  try {
    const { task } = await f.project.say('old v2 intent');
    const original = { version: 2, kind: 'merge', status: 'pending', created_at: '2026-01-01T00:00:00.000Z' };
    f.store.update(task.id, { auto_merge: null, reservation: JSON.stringify(original) });
    expect(f.project.inspect(task.id).auto_merge).toMatchObject({ enabled: false, locked: false, editable: true });
    expect((await f.project.setTaskAutoMerge(task.id, false)).changed).toBe(false);
    expect(booking(f, task.id)).toEqual(original);
    await f.project.setTaskAutoMerge(task.id, true);
    expect(booking(f, task.id)).toMatchObject(original);
    expect(booking(f, task.id).auto_merge).toBeUndefined();
    await f.project.setTaskAutoMerge(task.id, false);
    expect(f.project.inspect(task.id).auto_merge.enabled).toBe(false);
    expect(booking(f, task.id)).toMatchObject(original);
    expect(f.project.unreserveTask(task.id).changed).toBe(true);
    expect(f.store.task(task.id).reservation).toBeNull();
  } finally { await f.close(); }
});

test('cancelled sent intent stays withdrawn on restart; explicit retry must finish a fresh safe point before re-requesting', async () => {
  const entered = gate(), pause = gate();
  let calls = 0;
  const f = await setup({ resolve() { return { agent: 'mock' }; }, async run({ task }) {
    calls++; await commit(task, 'retry-work'); entered.resolve(); await pause.promise; return 'reviewed and continued';
  } });
  try {
    const { task } = await f.project.say('cancel and retry');
    await f.project.setTaskAutoMerge(task.id, true); await commit(task, 'original');
    f.store.update(task.id, { status: 'waiting' });
    await f.project.settleQueuedMerge(task.id);
    const requested = booking(f, task.id), baseline = await git(f.root, 'rev-parse', 'main');
    expect(requested.status).toBe('requested');
    f.project.cancel(task.id);
    expect(booking(f, task.id)).toMatchObject({ status: 'withdrawn', retry_status: null });
    f.project.recover(); f.project.recover();
    await f.project.workspaces.exclusive(async () => {});
    expect(calls).toBe(0);
    expect(settings(f, task.id).enabled).toBe(true);
    expect(booking(f, task.id).status).toBe('withdrawn');
    expect(await git(f.root, 'rev-parse', 'main')).toBe(baseline);
    f.project.retry(task.id);
    expect(f.store.task(task.id)).toMatchObject({ status: 'queued', reservation: null });
    f.project.recover();
    expect(f.store.task(task.id).reservation).toBeNull();
    f.project.stopping = false; f.project.kick();
    await entered.promise;
    expect(f.store.task(task.id).reservation).toBeNull();
    expect(await git(f.root, 'rev-parse', 'main')).toBe(baseline);
    pause.resolve();
    await until(() => f.store.task(task.id).integration === 'merged', 10000);
    expect(calls).toBe(1);
    const requests = f.store.history(task.id).filter(event => event.type === 'task.merge_requested');
    expect(requests).toHaveLength(2);
    expect(requests[1].data.commit).not.toBe(requested.commit);
    expect(await git(f.root, 'show', 'main:retry-work.txt')).toBe('retry-work');
  } finally { pause.resolve(); await f.close(); }
});

test('hook cannot bypass invocation, child, unread-message, user-answer or dirty-worktree barriers', async () => {
  const f = await setup();
  try {
    const { task } = await f.project.say('barriers');
    await f.project.setTaskAutoMerge(task.id, true);
    await commit(task); f.store.update(task.id, { status: 'waiting' });
    f.project.running.set(task.id, {});
    expect(await f.project.settleQueuedMerge(task.id)).toBe(false);
    f.project.running.delete(task.id);
    const child = f.store.create({ parent_id: task.id, role: 'agent', task_kind: 'child', goal: 'unfinished' });
    expect(await f.project.settleQueuedMerge(task.id)).toBe(false);
    expect(booking(f, task.id).blocked_reason).toContain('子Worker');
    f.store.update(child.id, { status: 'completed' });
    const message = f.store.message(task.id, 'unprocessed');
    expect(await f.project.settleQueuedMerge(task.id)).toBe(false);
    expect(booking(f, task.id).blocked_reason).toContain('未处理');
    f.store.run('UPDATE messages SET consumed=1 WHERE id=?', message);
    f.store.update(task.id, { status: 'awaiting' });
    expect(await f.project.settleQueuedMerge(task.id)).toBe(false);
    expect(booking(f, task.id).blocked_reason).toContain('答复');
    f.store.update(task.id, { status: 'waiting' });
    fs.writeFileSync(path.join(task.workspace, 'dirty.txt'), 'not committed');
    await expect(f.project.settleQueuedMerge(task.id)).rejects.toThrow();
    expect(booking(f, task.id).status).toBe('pending');
    fs.unlinkSync(path.join(task.workspace, 'dirty.txt'));
    expect(await f.project.settleQueuedMerge(task.id)).toBe(true);
    expect(booking(f, task.id).status).toBe('requested');
    expect(f.store.history(task.id).filter(event => event.type === 'task.merge_requested')).toHaveLength(1);
    expect(await f.project.settleQueuedMerge(task.id)).toBe(false);
  } finally { f.project.running.clear(); await f.close(); }
});

test('disabling during an asynchronous safe-point check cannot emit a stale automatic request', async () => {
  const f = await setup();
  try {
    const { task } = await f.project.say('race');
    await commit(task); f.store.update(task.id, { status: 'waiting' });
    // HEAD has not yet been registered, so the toggle remains editable while finish awaits Git.
    const finish = f.project.workspaces.finish.bind(f.project.workspaces), pause = gate(), entered = gate();
    f.project.workspaces.finish = async value => { entered.resolve(); await pause.promise; return finish(value); };
    const enabling = f.project.setTaskAutoMerge(task.id, true);
    await entered.promise;
    await f.project.setTaskAutoMerge(task.id, false); pause.resolve(); await enabling;
    expect(f.store.task(task.id).reservation).toBeNull();
    expect(f.store.history(task.id).filter(event => event.type === 'task.merge_requested')).toHaveLength(0);
    expect(await git(f.root, 'rev-list', '--count', 'main')).toBe('1');
  } finally { await f.close(); }
});

test('late input during no-change child Git checks cannot be overwritten by automatic delivery', async () => {
  const f = await setup(), pause = gate();
  try {
    const { task: parent } = await f.project.say('late input');
    const child = await f.project.spawn(parent.id, 'research');
    f.store.update(child.id, { status: 'waiting' });
    const branchState = f.project.workspaces.branchState.bind(f.project.workspaces), entered = gate();
    f.project.workspaces.branchState = async branch => {
      const state = await branchState(branch); entered.resolve(); await pause.promise; return state;
    };
    const settlement = f.project.settleQueuedMerge(child.id);
    await entered.promise;
    f.project.message(child.id, 'additional work'); pause.resolve();
    expect(await settlement).toBe(false);
    expect(f.store.task(child.id).status).toBe('queued');
    expect(booking(f, child.id).status).toBe('pending');
    expect(f.store.history(child.id).filter(row => row.type === 'task.delivered')).toHaveLength(0);
  } finally { pause.resolve(); await f.close(); }
});

test('persistent say hook automatically delivers multiple rounds and settles no-op follow-up', async () => {
  let rounds = 0;
  const f = await setup({ resolve() { return { agent: 'mock' }; }, async run({ task, messages }) {
    const repair = messages.find(row => row.body.includes('合并分歧'));
    if (repair) await git(task.workspace, 'merge', '--no-edit', repair.body.match(/[0-9a-f]{40}/)[0]);
    else if (++rounds <= 2) await commit(task, `round-${rounds}`);
    return 'done';
  } });
  try {
    const { task } = await f.project.say('persistent');
    await f.project.setTaskAutoMerge(task.id, true);
    f.project.stopping = false; f.project.kick();
    await until(() => f.store.task(task.id).status === 'awaiting_acceptance', 10000);
    expect(settings(f, task.id).enabled).toBe(true);
    f.project.message(task.id, 'second round');
    expect(booking(f, task.id)).toMatchObject({ status: 'pending', auto_merge: true });
    await until(() => f.store.history(task.id).filter(row => row.type === 'task.merge_integrated').length === 2, 10000);
    await until(() => !f.project.running.has(task.id));
    expect(settings(f, task.id)).toEqual({ version: 1, enabled: true, locked: false });
    expect(await git(f.root, 'show', 'main:round-2.txt')).toBe('round-2');
    f.project.message(task.id, 'explain only');
    await until(() => rounds === 3 && f.store.task(task.id).status === 'awaiting_acceptance' && !f.project.running.has(task.id), 10000);
    expect(f.store.task(task.id).reservation).toBeNull();
    expect(settings(f, task.id).enabled).toBe(true);
    expect(f.store.history(task.id).filter(row => row.type === 'task.merge_integrated')).toHaveLength(2);
  } finally { await f.close(); }
}, 30000);

test('a no-change child keeps its locked hook for a later coding round', async () => {
  const f = await setup({ resolve() { return { agent: 'mock' }; }, async run({ task }) {
    if (task.task_kind === 'child' && task.calls > 1) await commit(task, 'second');
    return 'answer';
  } });
  try {
    const { task: parent } = await f.project.say('parent'); f.store.update(parent.id, { status: 'waiting' });
    const child = await f.project.spawn(parent.id, 'first research');
    f.project.stopping = false; f.project.kick();
    await until(() => f.store.task(child.id).status === 'awaiting_acceptance' && !f.project.running.has(child.id));
    expect(f.store.task(child.id).reservation).toBeNull();
    expect(settings(f, child.id)).toMatchObject({ enabled: true, locked: true });
    f.project.message(child.id, 'now code');
    expect(booking(f, child.id)).toMatchObject({ auto_merge: true, status: 'pending' });
    await until(() => f.store.task(child.id).integration === 'merged', 10000);
    expect(await git(parent.workspace, 'show', 'HEAD:second.txt')).toBe('second');
  } finally { await f.close(); }
});

test('restart restores enabled pending hooks but never replays an interrupted Agent', async () => {
  const f = await setup();
  let reopened, runtime;
  try {
    const { task } = await f.project.say('restart safe point');
    await f.project.setTaskAutoMerge(task.id, true); await commit(task);
    f.store.update(task.id, { status: 'waiting', reservation: null }); // crash before re-arming
    const { task: interrupted } = await f.project.say('interrupted');
    await f.project.setTaskAutoMerge(interrupted.id, true);
    f.store.update(interrupted.id, { status: 'running' });
    reopened = new Store(path.join(f.config.home, 'project.db'), f.root);
    runtime = new Project(f.config, reopened); runtime.stopping = true;
    runtime.recover();
    await runtime.workspaces.exclusive(async () => {});
    expect(JSON.parse(reopened.task(task.id).auto_merge).enabled).toBe(true);
    expect(JSON.parse(reopened.task(task.id).reservation).status).toBe('requested');
    expect(reopened.task(interrupted.id)).toMatchObject({ status: 'failed', calls: 0 });
    expect(JSON.parse(reopened.task(interrupted.id).auto_merge).enabled).toBe(true);
    expect(reopened.history(interrupted.id).some(event => event.type === 'task.merge_requested')).toBe(false);
    runtime.stopping = false; runtime.kick = () => {};
    await runtime.driveTaskMerge(task.parent_id);
    expect(reopened.task(task.id).integration).toBe('merged');
  } finally { if (runtime) await runtime.shutdown(); reopened?.close(); await f.close(); }
});

test('opening an old database only adds the nullable hook column without rewriting historical tasks', async () => {
  const f = await setup();
  let reopened;
  try {
    const { task } = await f.project.say('old database');
    const old = new Database(path.join(f.config.home, 'project.db'));
    old.exec('ALTER TABLE tasks DROP COLUMN auto_merge'); old.close();
    reopened = new Store(path.join(f.config.home, 'project.db'), f.root);
    expect(reopened.task(task.id).auto_merge).toBeNull();
    expect(reopened.task(task.id).reservation).toBeNull();
    expect(reopened.task(task.id).status).toBe('queued');
  } finally { reopened?.close(); await f.close(); }
});
