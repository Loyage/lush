import { test, expect } from 'bun:test';
import { fetch, setup } from './harness.js';

const post = (f, method, params) => fetch(f.url + '/api/action', { method: 'POST',
  headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, params }) });

test('HTTP progress-history returns bounded descending pages and inspect bootstrap; disabled reporting hides without deleting', async () => {
  const f = await setup();
  try {
    const task = f.store.create({ role: 'agent', task_kind: 'order', goal: 'history HTTP' });
    for (let i = 0; i < 13; i++) f.project.reportProgressPlan(task.id, [{ key: 'work', label: `plan ${i}` }]);
    const base = `${f.url}/api/worker/${task.id}`;
    const response = await fetch(base + '/progress-history?limit=2');
    expect(response.status).toBe(200);
    const first = await response.json();
    expect(first).toMatchObject({ limit: 2, has_more: true, cursor: first.items[1].id });
    expect(first.items.map(row => row.progress.items[0].label)).toEqual(['plan 11', 'plan 10']);
    expect(first.items[0]).toMatchObject({ reason: 'replan', archived_at: expect.any(String), progress: { frozen: true } });
    const next = await (await fetch(base + `/progress-history?before=${first.cursor}&limit=100`)).json();
    expect(next.items).toHaveLength(10); expect(next.has_more).toBe(false);
    expect(next.items.every(row => row.id < first.cursor)).toBe(true);
    const inspected = await (await fetch(base)).json();
    expect(inspected.progress_history).toMatchObject({ limit: 10, has_more: true });
    expect(inspected.progress_history.items).toHaveLength(10);
    const snapshot = await (await fetch(f.url + '/api/snapshot')).json();
    expect(snapshot.tasks.every(row => !('progress_history' in row))).toBe(true);
    const stored = f.store.all("SELECT * FROM events WHERE task_id=? AND type='progress.archived'", task.id);
    const configured = await post(f, 'system.configure', { settings: { progress_reporting: false } });
    expect(configured.status).toBe(200);
    expect(await (await fetch(base + '/progress-history')).json()).toEqual({ items: [], cursor: null, has_more: false, limit: 10 });
    expect((await (await fetch(base)).json()).progress_history.items).toEqual([]);
    expect(f.store.all("SELECT * FROM events WHERE task_id=? AND type='progress.archived'", task.id)).toEqual(stored);
    expect((await post(f, 'system.configure', { settings: { progress_reporting: true } })).status).toBe(200);
    expect((await (await fetch(base + '/progress-history')).json()).items).toHaveLength(10);
    for (const query of ['before=0', 'before=-1', 'before=1.5', 'before=bad', 'limit=0', 'limit=101', 'limit=bad']) {
      expect((await fetch(base + '/progress-history?' + query)).status).toBe(400);
    }
    expect((await fetch(f.url + '/api/worker/999999/progress-history')).status).toBe(400);
    expect((await fetch(base + '/progress_histories')).status).toBe(404);
    expect((await post(f, 'worker.progress_history', { id: task.id })).status).toBe(400);
  } finally { await f.close(); }
});
