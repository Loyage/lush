import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, repo, git, until } from '../helpers.js';
import { Dispatcher } from '../../src/rpc/dispatcher.js';
import { tokenHash } from '../../src/core/project/internal.js';

async function setup() {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  const parent = (await f.project.order('user goal')).task;
  f.store.update(parent.id, { status: 'waiting' });
  const child = await f.project.spawn(parent.id, 'delegated answer');
  await f.project.workspaces.finish(child);
  f.store.update(child.id, { status: 'awaiting_acceptance', integration: 'none', reservation: null, result: 'answer' });
  const token = 'live-parent';
  const run = { controller: new AbortController(), parked: false };
  f.store.update(parent.id, { status: 'running' });
  f.store.armAgent(parent.id, tokenHash(token));
  f.project.running.set(parent.id, run);
  const rpc = new Dispatcher(f.project);
  const confirm = id => rpc.dispatch('worker.accept', { id, _token: token });
  const close = async () => { f.project.running.clear(); await f.close(); };
  return { ...f, parent, child, token, run, rpc, confirm, close };
}

test('only the live direct delegator can confirm child results; user order and other Tasks remain protected', async () => {
  const f = await setup();
  try {
    const siblingOrder = (await f.project.order('another user goal', f.parent.branch)).task;
    const other = (await f.project.order('unrelated')).task;
    f.store.update(other.id, { status: 'waiting' });
    const otherChild = await f.project.spawn(other.id, 'not mine');
    await expect(f.confirm(f.parent.id)).rejects.toThrow('own direct child');
    await expect(f.confirm(siblingOrder.id)).rejects.toThrow('user-created order');
    await expect(f.confirm(otherChild.id)).rejects.toThrow('own direct child');
    await expect(f.rpc.dispatch('worker.accept', { id: f.child.id, parent: f.parent.id, _token: f.token })).rejects.toThrow('unknown parameter');
    const result = await f.confirm(f.child.id);
    expect(result).toMatchObject({ status: 'completed', integration: 'none', result: 'answer' });
    expect(fs.existsSync(f.child.workspace)).toBe(true);
    expect(f.project.inspect(f.child.id).accepted).toBe(true);
    expect(f.store.history(f.child.id).filter(event => event.type === 'task.accepted').map(event => event.data))
      .toMatchObject([{ accepted_by: 'parent', parent_id: f.parent.id }]);
    await f.confirm(f.child.id); // Idempotent, but never bypasses authority checks.
    expect(f.store.history(f.child.id).filter(event => event.type === 'task.accepted')).toHaveLength(1);
    expect(f.store.task(f.parent.id).status).toBe('running');
    f.project.running.delete(f.parent.id);
    await expect(f.confirm(f.child.id)).rejects.toThrow('expired agent token');
  } finally { await f.close(); }
});

test('parent confirmation rejects failure, unfinished delivery, unread input, decisions, dirt and unconfirmed descendants', async () => {
  const f = await setup();
  try {
    for (const status of ['queued', 'running', 'waiting', 'failed', 'cancelled']) {
      f.store.update(f.child.id, { status });
      await expect(f.confirm(f.child.id)).rejects.toThrow('delivered');
    }
    f.store.update(f.child.id, { status: 'awaiting_acceptance' });
    const message = f.store.message(f.child.id, 'unprocessed input');
    await expect(f.confirm(f.child.id)).rejects.toThrow('unread');
    f.store.run('UPDATE messages SET consumed=1 WHERE id=?', message);
    const notice = f.project.notice(f.child.id, 'decision', 'need user choice');
    await expect(f.confirm(f.child.id)).rejects.toThrow('open decisions');
    f.store.run("UPDATE notices SET status='dismissed' WHERE id=?", notice.id);
    f.store.update(f.child.id, { reservation: JSON.stringify({ version: 2, kind: 'merge', status: 'requested' }) });
    await expect(f.confirm(f.child.id)).rejects.toThrow('reserved');
    f.store.update(f.child.id, { reservation: null });
    const file = path.join(f.child.workspace, 'undelivered.txt');
    fs.writeFileSync(file, 'not delivered\n');
    await expect(f.confirm(f.child.id)).rejects.toThrow();
    await git(f.child.workspace, 'add', '.'); await git(f.child.workspace, 'commit', '-m', 'not delivered');
    await expect(f.confirm(f.child.id)).rejects.toThrow('undelivered');
    expect(f.store.task(f.child.id).status).toBe('awaiting_acceptance');
    expect(f.store.history(f.child.id).some(event => event.type === 'task.accepted')).toBe(false);
    const grandchild = await f.project.spawn(f.child.id, 'unfinished grandchild');
    f.store.update(f.child.id, { status: 'awaiting_acceptance', reservation: null });
    await expect(f.confirm(f.child.id)).rejects.toThrow('descendants');
    expect(f.store.task(grandchild.id).status).toBe('queued');
  } finally { await f.close(); }
});

test('parent confirmation rechecks invocation identity, input and decisions after asynchronous Git checks', async () => {
  for (const arrival of ['abort', 'new invocation', 'message', 'decision', 'reparent']) {
    const f = await setup();
    try {
      const finish = f.project.workspaces.finish.bind(f.project.workspaces);
      f.project.workspaces.finish = async task => {
        await finish(task);
        if (arrival === 'abort') f.run.controller.abort();
        if (arrival === 'new invocation') f.project.running.set(f.parent.id, { controller: new AbortController() });
        if (arrival === 'message') f.store.message(f.child.id, 'new input');
        if (arrival === 'decision') f.project.notice(f.child.id, 'new decision', 'need answer');
        if (arrival === 'reparent') f.store.update(f.child.id, { parent_id: null });
      };
      await expect(f.confirm(f.child.id)).rejects.toThrow();
      expect(f.store.task(f.child.id).status).toBe('awaiting_acceptance');
      expect(f.store.history(f.child.id).some(event => event.type === 'task.accepted')).toBe(false);
    } finally { await f.close(); }
  }
});

test('a parent requests revisions then confirms a no-code child without any user child acceptance', async () => {
  let parentId, childId;
  const f = fixture({ resolve() { return { agent: 'mock' }; }, async run({ task, messages, token, api }) {
    if (task.task_kind === 'child') return messages.length ? 'revised answer' : 'first answer';
    const child = api.store.task(childId);
    if (task.calls === 1) {
      expect(child).toMatchObject({ status: 'awaiting_acceptance', result: 'first answer' });
      api.message(child.id, 'please clarify', task.id);
    } else {
      expect(child).toMatchObject({ status: 'awaiting_acceptance', result: 'revised answer' });
      await new Dispatcher(api).dispatch('worker.accept', { id: child.id, _token: token });
    }
    return 'checked delegated result';
  } });
  f.project.stopping = true; await repo(f.root);
  try {
    const parent = (await f.project.order('user goal')).task; parentId = parent.id;
    f.store.update(parent.id, { status: 'waiting' });
    childId = (await f.project.spawn(parent.id, 'answer')).id;
    f.project.stopping = false; f.project.kick();
    await until(() => f.store.task(childId).status === 'completed' && f.store.task(parentId).status === 'waiting', 8000);
    expect(f.store.task(childId)).toMatchObject({ result: 'revised answer', integration: 'none', calls: 2 });
    expect(f.store.task(parentId).calls).toBe(2);
    expect((await f.project.acceptTask(parentId)).status).toBe('completed');
    expect(f.store.history(parentId).find(event => event.type === 'task.accepted').data.accepted_by).toBe('user');
    expect(fs.existsSync(f.store.task(childId).workspace)).toBe(true);
  } finally { await f.close(); }
});
