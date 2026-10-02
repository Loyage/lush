import { test, expect } from 'bun:test';
import { fetch, setup } from './harness.js';

function lifecycle(f, kind, status, type) {
  const task = f.store.create({ input_id: null, role: 'agent', task_kind: kind, goal: `${kind} lifecycle` });
  f.store.update(task.id, { status });
  const notice = f.store.transaction(() => f.project.notifyTaskLifecycle(task.id, f.store.event(task.id, type, {})));
  return { task, notice };
}

test('overview includes analysis and older lifecycle reminders outside the homepage Worker/history windows', async () => {
  const f = await setup();
  try {
    const idle = lifecycle(f, 'say', 'waiting', 'task.idle');
    // The source event remains valid even after the Worker leaves the activity window.
    f.store.update(idle.task.id, { status: 'completed' });
    const analysis = lifecycle(f, 'analysis', 'completed', 'completed');
    const failed = lifecycle(f, 'analysis', 'failed', 'analysis.fork_failed');
    f.store.transaction(() => {
      for (let i = 0; i < 105; i++) {
        const task = f.store.create({ input_id: null, role: 'agent', task_kind: 'say', goal: `new history ${i}` });
        f.store.update(task.id, { status: 'completed' });
        f.project.notify(task.id, `historical info ${i}`);
      }
    });
    const overview = await (await fetch(f.url + '/api/overview')).json();
    expect(overview.tasks.some(row => row.id === idle.task.id)).toBe(false);
    expect(overview.tasks.some(row => row.task_kind === 'analysis')).toBe(false);
    for (const { notice } of [idle, analysis, failed]) {
      expect(overview.notices.filter(row => row.id === notice.id)).toHaveLength(1);
    }
    const before = f.store.task(analysis.task.id);
    const read = await fetch(f.url + '/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'notice.read', params: { id: analysis.notice.id } }) });
    expect(read.status).toBe(200);
    expect(f.store.task(analysis.task.id)).toEqual(before);
    const next = await (await fetch(f.url + '/api/snapshot')).json();
    expect(next.notices.some(row => row.id === analysis.notice.id)).toBe(false);
    expect(f.store.get('SELECT read_at FROM notices WHERE id=?', analysis.notice.id).read_at).toBeTruthy();
    expect(f.store.get('SELECT title FROM notices WHERE id=?', analysis.notice.id).title).toBe(analysis.notice.title);
  } finally { await f.close(); }
});

test('overview deduplicates unread reminders also present in its historical page', async () => {
  const f = await setup();
  try {
    const { notice } = lifecycle(f, 'say', 'waiting', 'task.idle');
    const snapshot = await (await fetch(f.url + '/api/snapshot')).json();
    expect(snapshot.notices.filter(row => row.id === notice.id)).toHaveLength(1);
  } finally { await f.close(); }
});
