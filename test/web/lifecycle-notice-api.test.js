import { test, expect } from 'bun:test';
import { fetch, setup } from './harness.js';
import { repo, until } from '../helpers.js';

test('real say completion reaches HTTP snapshot and opens a readable Task without rescheduling', async () => {
  const f = await setup();
  try {
    await repo(f.root);
    f.project.provider = { async run() { return '本轮实际收尾结果'; } };
    const { task } = await f.project.say('用户直接创建的工作');
    await until(() => f.store.task(task.id).status === 'waiting' && !f.project.running.has(task.id));
    const snapshot = await (await fetch(f.url + '/api/snapshot')).json();
    const notices = snapshot.notices.filter(row => row.task_id === task.id);
    expect(notices).toHaveLength(1);
    const [notice] = notices;
    expect(notice).toMatchObject({ kind: 'info', status: 'sent', read_at: null });
    expect(notice.source_event_id).toBeGreaterThan(0);
    expect(notice.body).toContain('本轮实际收尾结果');
    const detail = await (await fetch(f.url + `/api/task/${notice.task_id}`)).json();
    expect(detail).toMatchObject({ id: task.id, status: 'waiting', result: '本轮实际收尾结果' });
    const before = f.store.task(task.id);
    const response = await fetch(f.url + '/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'notice.read', params: { id: notice.id } }) });
    expect(response.status).toBe(200);
    expect((await response.json()).read_at).toBeTruthy();
    expect(f.store.task(task.id)).toEqual(before);
    expect(f.project.running.size).toBe(0);
    const updated = await (await fetch(f.url + '/api/snapshot')).json();
    expect(updated.notices.find(row => row.id === notice.id).read_at).toBeTruthy();
  } finally { await f.close(); }
});

test('HTTP lifecycle info unread page and read action preserve decision and Task state', async () => {
  const f = await setup();
  try {
    const task = f.store.create({ input_id: null, role: 'agent', task_kind: 'say', goal: '告知 API' });
    f.store.update(task.id, { status: 'waiting' });
    const notice = f.store.transaction(() => {
      const eventId = f.store.event(task.id, 'task.idle', {});
      return f.project.notifyTaskLifecycle(task.id, eventId);
    });
    const question = f.project.notice(task.id, '决策');
    const unread = await fetch(f.url + '/api/notices?status=unread');
    expect(unread.status).toBe(200);
    expect((await unread.json()).notices.map(row => row.id)).toEqual([notice.id]);
    const post = params => fetch(f.url + '/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method: 'notice.read', params }) });
    const marked = await post({ id: notice.id }); expect(marked.status).toBe(200);
    expect((await marked.json()).read_at).not.toBeNull();
    expect((await post({ id: notice.id })).status).toBe(200);
    expect((await post({ id: question.id })).status).toBe(400);
    expect((await post({ id: notice.id, _token: 'agent' })).status).toBe(400);
    expect((await (await fetch(f.url + '/api/notices?status=unread')).json()).notices).toEqual([]);
    expect(f.store.task(task.id).status).toBe('waiting');
    expect(f.store.task(task.id).calls).toBe(0);
    expect(f.store.get('SELECT status FROM notices WHERE id=?', question.id).status).toBe('open');
  } finally { await f.close(); }
});
