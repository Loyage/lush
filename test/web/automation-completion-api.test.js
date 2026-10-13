import { test, expect } from 'bun:test';
import { setup, fetch } from './harness.js';
import { Dispatcher } from '../../src/rpc/dispatcher.js';
import { repo, until } from '../helpers.js';

const read = (f, query = '') => fetch(f.url + '/api/automation/completion/workers' + query);
function seed(f) {
  const workers = [];
  for (let index = 0; index < 61; index++) {
    const task = f.store.create({ role: 'agent', task_kind: index % 2 ? 'child' : 'order', goal: 'worker '.repeat(60) });
    f.store.update(task.id, { status: ['running','paused','awaiting_acceptance','completed','failed','cancelled'][index % 6],
      auto_merge: JSON.stringify({ version: 1, enabled: true, level: 'accept', private_marker: 'PRIVATE_AUTOMATIC_CONFIG' }),
      retry_profile: JSON.stringify({ prompt: 'PRIVATE_PROMPT', env: { secret: 'PRIVATE_ENV' } }) });
    workers.push(task.id);
  }
  f.store.create({ role: 'manager', task_kind: 'management', goal: 'PRIVATE_MANAGER' });
  f.store.create({ role: 'owner', task_kind: 'owner', goal: 'not source' });
  // The read compatibility seam normalizes this old storage kind without rewriting it.
  f.store.run("UPDATE tasks SET task_kind='say' WHERE id=?", workers[0]);
  return workers.reverse();
}

test('completion HTTP pages all actual Worker states, legacy orders and child with same safe revision; reads never mutate', async () => {
  const f = await setup(); f.project.stopping = true;
  try {
    const ids = seed(f), beforeRows = f.store.tasks(), events = f.store.get('SELECT count(*) AS n FROM events').n;
    const found = []; let cursor = null, hasMore = true;
    while (hasMore) {
      const response = await read(f, `?limit=25${cursor ? `&before=${cursor}` : ''}`);
      expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
      const page = await response.json(); expect(page.workers.length).toBeLessThanOrEqual(25);
      for (const worker of page.workers) {
        found.push(worker.id); expect(worker.hooks.revision).toBe(f.project.taskHooks(worker.id).revision);
        expect(worker.hooks.completion).toEqual(f.project.taskHooks(worker.id).completion);
        expect(worker.goal.length).toBeLessThanOrEqual(200);
        expect(worker.hooks.mounts.every(mount => ['auto-merge','auto-accept'].includes(mount.id))).toBe(true);
        if (worker.task_kind === 'child') expect(worker.hooks.completion).toMatchObject({ locked: true, editable: false });
        for (const key of ['auto_merge','retry_profile','workspace','branch','result']) expect(Object.hasOwn(worker, key)).toBe(false);
      }
      expect(JSON.stringify(page)).not.toContain('PRIVATE_');
      cursor = page.cursor; hasMore = page.has_more;
    }
    expect(found).toEqual(ids); expect(f.store.tasks()).toEqual(beforeRows);
    expect(f.store.get('SELECT count(*) AS n FROM events').n).toBe(events);
    expect(f.store.get('SELECT task_kind FROM tasks WHERE id=?', ids.at(-1)).task_kind).toBe('order'); // Store read normalizes only.
    expect((await (await read(f, `?before=${ids.at(-1)}`)).json()).workers).toEqual([]);
  } finally { await f.close(); }
});

test('completion pages expose exact no-code delivery and acceptance operations, not configuration receipts', async () => {
  const f = await setup(); f.project.stopping = true; f.project.kick = () => f.project.scheduleTaskCompletion();
  f.project.provider = { run() { throw new Error('no real model calls'); } };
  try {
    await repo(f.root); await f.project.bootstrapMain();
    const { task } = await f.project.order('read real completion evidence', 'main', [], null, false);
    await f.project.setTaskCompletion(task.id, 'accept', f.project.taskHooks(task.id).revision);
    let page = await (await read(f)).json();
    expect(page.workers[0].hooks.mounts.every(mount => mount.operation === null)).toBe(true);
    f.store.update(task.id, { status: 'waiting' }); await f.project.workspaces.finish(task);
    await f.project.settleQueuedMerge(task.id);
    f.project.stopping = false; f.project.scheduleTaskCompletion(task.id);
    await until(() => f.store.task(task.id).status === 'completed'); await f.project.completionQueue;
    page = await (await read(f)).json();
    expect(page.workers[0].hooks.mounts.map(mount => mount.operation)).toEqual(f.project.taskHooks(task.id).mounts
      .filter(mount => ['auto-merge','auto-accept'].includes(mount.id)).map(mount => mount.operation));
    expect(page.workers[0].hooks.mounts.map(mount => mount.operation.status)).toEqual(['succeeded','succeeded']);
    expect(page.workers[0].archived).toBe(true);
    expect(JSON.stringify(page)).not.toContain('authorization');
  } finally { await f.close(); }
});

test('completion HTTP/RPC rejects privileged flags, invalid cursors, duplicate parameters and Agent identity', async () => {
  const f = await setup();
  try {
    for (const query of ['?limit=0','?limit=51','?limit=1.5','?before=-1','?before=9007199254740992','?before=1&before=2','?limit=1&limit=2','?_token=agent','?project=elsewhere','?force=true'])
      expect((await read(f, query)).status).toBe(400);
    const rpc = new Dispatcher(f.project);
    for (const params of [{ before: 0 }, { before: '1' }, { limit: null }, { limit: 51 }, { before: 1.2 }, { force: true }, { scope: 'all' }])
      await expect(rpc.dispatch('worker.completion_page', params)).rejects.toThrow();
    const denied = new Dispatcher({ actor: () => 7, completionWorkerPage() { throw new Error('must not read'); } });
    await expect(denied.dispatch('worker.completion_page', { _token: 'agent' })).rejects.toThrow('requires user approval');
    const response = await fetch(f.url + '/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'worker.completion_page', params: {} }) });
    expect(response.status).toBe(400); // Dedicated GET, not a mutation alias.
  } finally { await f.close(); }
});
