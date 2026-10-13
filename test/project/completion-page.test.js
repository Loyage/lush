import { test, expect } from 'bun:test';
import { fixture, repo, until } from '../helpers.js';
import { Dispatcher } from '../../src/rpc/dispatcher.js';

test('completion RPC directory preserves all-state cursor pagination, safe projection and conditional-input registration after source repair', async () => {
  const f = fixture(); f.project.stopping = true;
  try {
    const rpc = new Dispatcher(f.project), ids = [];
    for (let index = 0; index < 57; index++) {
      const task = f.store.create({ role: 'agent', task_kind: index % 2 ? 'child' : 'order', goal: 'scope '.repeat(50) }); ids.unshift(task.id);
      f.store.update(task.id, { status: ['running','paused','awaiting_acceptance','completed','failed','cancelled'][index % 6],
        auto_merge: JSON.stringify({ version: 1, enabled: false, locked: index % 2 === 1 }),
        retry_profile: JSON.stringify({ prompt: 'PRIVATE_PROFILE' }) });
    }
    f.store.create({ role: 'manager', task_kind: 'management', goal: 'PRIVATE_MANAGER' });
    f.store.run("UPDATE tasks SET task_kind='say' WHERE id=?", ids.at(-1));
    const beforeRows = f.store.tasks(), events = f.store.get('SELECT count(*) AS n FROM events').n;
    let before, found = [];
    do {
      const page = await rpc.dispatch('worker.completion_page', { limit: 20, ...(before ? { before } : {}) });
      found.push(...page.workers.map(worker => worker.id));
      for (const worker of page.workers) {
        expect(worker.hooks.revision).toBe(f.project.taskHooks(worker.id).revision);
        expect(worker.goal.length).toBeLessThanOrEqual(200);
        if (worker.task_kind === 'child') expect(worker.hooks.completion).toMatchObject({ locked: true, editable: false });
      }
      expect(JSON.stringify(page)).not.toContain('PRIVATE_');
      before = page.has_more ? page.cursor : null;
    } while (before);
    expect(found).toEqual(ids); expect(f.store.tasks()).toEqual(beforeRows);
    expect(f.store.get('SELECT count(*) AS n FROM events').n).toBe(events);
    expect(await rpc.dispatch('input.history', { conditional: 'configured' })).toMatchObject({ items: [], next_cursor: null });
    for (const params of [{ before: 0 }, { before: '1' }, { limit: 51 }, { force: true }])
      await expect(rpc.dispatch('worker.completion_page', params)).rejects.toThrow();
    const denied = new Dispatcher({ actor: () => 7 });
    await expect(denied.dispatch('worker.completion_page', { _token: 'agent' })).rejects.toThrow('requires user approval');
  } finally { await f.close(); }
});

test('completion RPC directory exposes original exact operation proofs after real no-code delivery and safe acceptance', async () => {
  const f = fixture(); f.project.stopping = true; f.project.kick = () => f.project.scheduleTaskCompletion();
  f.project.provider = { run() { throw new Error('must not invoke a model'); } };
  try {
    await repo(f.root); await f.project.bootstrapMain();
    const rpc = new Dispatcher(f.project), { task } = await f.project.order('completion read proof', 'main', [], null, false);
    await rpc.dispatch('worker.completion', { id: task.id, level: 'accept', expected_revision: f.project.taskHooks(task.id).revision });
    expect((await rpc.dispatch('worker.completion_page')).workers[0].hooks.mounts.every(mount => mount.operation === null)).toBe(true);
    f.store.update(task.id, { status: 'waiting' }); await f.project.workspaces.finish(task); await f.project.settleQueuedMerge(task.id);
    f.project.stopping = false; f.project.scheduleTaskCompletion(task.id);
    await until(() => f.store.task(task.id).status === 'completed'); await f.project.completionQueue;
    const worker = (await rpc.dispatch('worker.completion_page')).workers[0];
    expect(worker.archived).toBe(true);
    expect(worker.hooks.mounts.map(mount => mount.operation)).toEqual(f.project.taskHooks(task.id).mounts
      .filter(mount => ['auto-merge','auto-accept'].includes(mount.id)).map(mount => mount.operation));
    expect(worker.hooks.mounts.map(mount => mount.operation.status)).toEqual(['succeeded','succeeded']);
    expect(JSON.stringify(worker)).not.toContain('authorization');
  } finally { await f.close(); }
});
