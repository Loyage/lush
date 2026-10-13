import { test, expect } from 'bun:test';
import { fetch, setup } from './harness.js';
import { repo, until } from '../helpers.js';

test('real HTTP no-code order waiting is silent; parent synchronization delivers a readable acceptance notice without rescheduling', async () => {
  const f = await setup();
  try {
    await repo(f.root);
    let calls = 0;
    f.project.provider = { async run() { calls++; return '本轮实际收尾结果'; } };
    const post = (method, params) => fetch(f.url + '/api/action', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, params }) });
    const submitted = await post('order.submit', { content: '用户直接创建的工作', start: false });
    expect(submitted.status).toBe(200);
    const { task } = await submitted.json();
    expect((await post('worker.resume', { id: task.id })).status).toBe(200);
    await until(() => f.store.task(task.id).status === 'waiting' && !f.project.running.has(task.id));
    const waiting = await (await fetch(f.url + '/api/snapshot')).json();
    const initial = waiting.notices.filter(row => row.task_id === task.id);
    expect(initial).toHaveLength(1);
    expect(initial[0].lifecycle_type).toBe('created'); // The independent creation reminder remains historical.
    expect(f.store.all(`SELECT n.id FROM notices n JOIN events e ON e.id=n.source_event_id
      WHERE n.task_id=? AND n.kind='info' AND e.type<>'task.start_pending'`, task.id)).toEqual([]);
    expect((await (await fetch(f.url + `/api/worker/${task.id}`)).json()).status).toBe('waiting');
    // Use the real HTTP/RPC/Git transition, not a store status edit, to deliver this unchanged answer.
    const synced = await post('worker.sync_parent', { id: task.id });
    expect(synced.status).toBe(200);
    expect((await synced.json()).task.status).toBe('awaiting_acceptance');
    const snapshot = await (await fetch(f.url + '/api/snapshot')).json();
    const notices = snapshot.notices.filter(row => row.task_id === task.id && row.lifecycle_type !== 'created');
    expect(notices).toHaveLength(1);
    const [notice] = notices;
    expect(notice).toMatchObject({ kind: 'info', status: 'sent', read_at: null });
    expect(notice.source_event_id).toBeGreaterThan(0);
    expect(f.store.get('SELECT type FROM events WHERE id=?', notice.source_event_id).type).toBe('task.parent_synced');
    expect(notice.title).toContain('待验收');
    expect(notice.body).toContain('本轮实际收尾结果');
    const detail = await (await fetch(f.url + `/api/worker/${notice.task_id}`)).json();
    expect(detail).toMatchObject({ id: task.id, status: 'awaiting_acceptance', result: '本轮实际收尾结果' });
    const before = f.store.task(task.id);
    const response = await fetch(f.url + '/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'notice.read', params: { id: notice.id } }) });
    expect(response.status).toBe(200);
    expect((await response.json()).read_at).toBeTruthy();
    expect(f.store.task(task.id)).toEqual(before);
    expect(f.project.running.size).toBe(0);
    expect(calls).toBe(1);
    const updated = await (await fetch(f.url + '/api/snapshot')).json();
    expect(updated.notices.find(row => row.id === notice.id).read_at).toBeTruthy();
  } finally { await f.close(); }
});

test('HTTP lifecycle info unread page and read action preserve decision and Task state', async () => {
  const f = await setup();
  try {
    const task = f.store.create({ input_id: null, role: 'agent', task_kind: 'order', goal: '告知 API' });
    // Projection fixture: state and its delivery source are committed together.
    const notice = f.store.transaction(() => {
      f.store.update(task.id, { status: 'awaiting_acceptance' });
      const eventId = f.store.event(task.id, 'task.delivered', { no_changes: true });
      return f.project.notifyAcceptanceEntry(task.id, eventId);
    });
    const question = f.project.notice(task.id, '决策');
    const unread = await fetch(f.url + '/api/notices?status=unread');
    expect(unread.status).toBe(200);
    expect((await unread.json()).notices.map(row => row.id)).toEqual([notice.id]);
    const before = f.store.task(task.id);
    const post = params => fetch(f.url + '/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method: 'notice.read', params }) });
    const marked = await post({ id: notice.id }); expect(marked.status).toBe(200);
    expect((await marked.json()).read_at).not.toBeNull();
    expect((await post({ id: notice.id })).status).toBe(200);
    expect((await post({ id: question.id })).status).toBe(400);
    expect((await post({ id: notice.id, _token: 'agent' })).status).toBe(400);
    expect((await (await fetch(f.url + '/api/notices?status=unread')).json()).notices).toEqual([]);
    expect(f.store.task(task.id)).toEqual(before);
    expect(f.store.task(task.id).status).toBe('awaiting_acceptance');
    expect(f.store.task(task.id).calls).toBe(0);
    expect(f.store.history(task.id).filter(row => row.type === 'notice.read')).toHaveLength(1);
    expect(f.store.get('SELECT status FROM notices WHERE id=?', question.id).status).toBe('open');
  } finally { await f.close(); }
});
