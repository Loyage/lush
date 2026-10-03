import { test, expect } from 'bun:test';
import { fixture } from '../helpers.js';
import { handlers } from '../../src/rpc/handlers/notice.js';
import { UIClient } from '../../src/ui/client.js';

function worker(f, kind = 'order', status = 'waiting') {
  const task = f.store.create({ input_id: null, role: 'agent', task_kind: kind, goal: '分类不可由标题猜测' });
  f.store.update(task.id, { status });
  return f.store.task(task.id);
}
function lifecycle(f, task, type) {
  return f.store.transaction(() => f.project.notifyTaskLifecycle(task.id, f.store.event(task.id, type, {})));
}
function sourced(f, task, type, kind = 'info', eventTask = task) {
  const source = f.store.event(eventTask.id, type, {});
  const row = f.store.run(`INSERT INTO notices(task_id,title,body,kind,status,source_event_id)
    VALUES (?,'Worker 异常停止 / 分析已完成 / 本轮已结束','',?,'sent',?)`, task.id, kind, source);
  return Number(row.lastInsertRowid);
}

test('lifecycle_type is projected consistently from source Events across list/page/unread/detail/read', async () => {
  const f = fixture(); f.project.stopping = true;
  try {
    const cases = [
      ['order', 'waiting', 'task.idle', 'idle'],
      ['order', 'failed', 'failed', 'failed'],
      ['order', 'failed', 'merge.repair_interrupted', 'failed'],
      ['analysis', 'failed', 'analysis.fork_failed', 'failed'],
      ['analysis', 'completed', 'completed', 'analysis'],
    ];
    const expected = new Map();
    for (const [kind, status, event, category] of cases) {
      const task = worker(f, kind, status), notice = lifecycle(f, task, event);
      expect(notice.lifecycle_type).toBe(category);
      expect(f.project.notifyTaskLifecycle(task.id, notice.source_event_id)).toEqual(notice);
      expected.set(notice.id, { category, task });
      // Later invocation, merge, acceptance or failure must not reclassify this historical notice.
      f.store.update(task.id, { status: category === 'failed' ? 'completed' : 'failed', integration: 'merged' });
      f.store.run("UPDATE notices SET title='不可信标题' WHERE id=?", notice.id);
    }
    for (const notices of [handlers['notice.list'](f.project, {}),
      handlers['notice.page'](f.project, {}).notices,
      handlers['notice.page'](f.project, { status: 'unread' }).notices]) {
      expect(notices).toHaveLength(cases.length);
      for (const notice of notices) expect(notice.lifecycle_type).toBe(expected.get(notice.id).category);
    }
    const firstPage = handlers['notice.page'](f.project, { status: 'unread', limit: 2 });
    expect(firstPage.has_more).toBe(true);
    const secondPage = handlers['notice.page'](f.project, { status: 'unread', before: firstPage.cursor, limit: 2 });
    expect(secondPage.notices.map(row => row.id)).toEqual([...expected.keys()].reverse().slice(2, 4));
    for (const [noticeId, { category, task }] of expected) {
      expect(f.project.inspect(task.id).notices.find(row => row.id === noticeId).lifecycle_type).toBe(category);
      const before = f.store.task(task.id);
      const first = handlers['notice.read'](f.project, { id: noticeId });
      expect(first).toMatchObject({ lifecycle_type: category, status: 'sent' });
      expect(first.read_at).not.toBeNull();
      expect(handlers['notice.read'](f.project, { id: noticeId })).toEqual(first);
      expect(f.store.task(task.id)).toEqual(before);
      expect(f.store.history(task.id).filter(row => row.type === 'notice.read')).toHaveLength(1);
    }
    expect(handlers['notice.page'](f.project, { status: 'unread' }).notices).toEqual([]);
    expect(f.project.running.size).toBe(0);
    // Classification is a read projection: no schema column and no source or historical text rewritten.
    expect(f.store.all('PRAGMA table_info(notices)').map(row => row.name)).not.toContain('lifecycle_type');
    expect(f.store.all('SELECT title FROM notices').every(row => row.title === '不可信标题')).toBe(true);
  } finally { await f.close(); }
});

test('legacy info, unknown/missing/mismatched source and non-info Notices project null without guessing', async () => {
  const f = fixture(); f.project.stopping = true;
  try {
    const task = worker(f), other = worker(f);
    const legacy = f.project.notify(task.id, 'Worker 本轮已结束');
    const question = f.project.notice(task.id, '分析已完成');
    expect(legacy.lifecycle_type).toBeNull();
    expect(question.lifecycle_type).toBeNull();
    const unknown = sourced(f, task, 'invocation.preempted');
    const mismatch = sourced(f, task, 'failed', 'info', other);
    const nonInfo = sourced(f, task, 'task.idle', 'question');
    const missing = sourced(f, task, 'task.idle');
    const sourceId = f.store.get('SELECT source_event_id FROM notices WHERE id=?', missing).source_event_id;
    f.store.run('DELETE FROM events WHERE id=?', sourceId);
    const stored = f.store.all('SELECT * FROM notices ORDER BY id');
    for (const notices of [handlers['notice.list'](f.project, {}),
      handlers['notice.page'](f.project, {}).notices, f.project.inspect(task.id).notices]) {
      expect(notices).toHaveLength(6);
      expect(notices.every(row => row.lifecycle_type === null)).toBe(true);
    }
    // Unknown sources retain the existing unread/history contract; classification never deletes records.
    expect(handlers['notice.page'](f.project, { status: 'unread' }).notices.map(row => row.id))
      .toEqual([missing, mismatch, unknown]);
    expect(f.project.readNotice(legacy.id).lifecycle_type).toBeNull();
    for (const noticeId of [unknown, mismatch, missing]) expect(f.project.readNotice(noticeId).lifecycle_type).toBeNull();
    expect(f.project.answer(question.id, '知道了').lifecycle_type).toBeNull();
    expect(f.store.all('SELECT * FROM notices ORDER BY id').map(({ read_at, status, answer, ...row }) => row))
      .toEqual(stored.map(({ read_at, status, answer, ...row }) => row));
    expect(f.store.get('SELECT kind FROM notices WHERE id=?', nonInfo).kind).toBe('question');
  } finally { await f.close(); }
});

test('homepage overview and compatibility snapshot preserve lifecycle_type supplied by Notice pages', async () => {
  const f = fixture(); f.project.stopping = true;
  try {
    const task = worker(f), notice = lifecycle(f, task, 'task.idle');
    const analysis = worker(f, 'analysis', 'completed');
    const analyzed = lifecycle(f, analysis, 'completed');
    const client = new UIClient(f.config), requests = [];
    client.request = async (method, params) => {
      requests.push(method);
      if (method === 'system.summary') return f.project.summary();
      if (method === 'worker.activity') return f.project.activity(params.limit, params.scope);
      return handlers[method](f.project, params);
    };
    for (const result of [await client.overview(), await client.snapshot()]) {
      expect(result.notices.find(row => row.id === notice.id).lifecycle_type).toBe('idle');
      // Homepage scope is owned by UIClient; every included lifecycle row must keep its source classification.
      expect(result.notices.every(row => row.lifecycle_type === (row.id === analyzed.id ? 'analysis' : 'idle'))).toBe(true);
    }
    expect(requests.filter(method => method === 'notice.page').length).toBeGreaterThanOrEqual(2);
    expect(handlers['notice.page'](f.project, {}).notices.find(row => row.id === analyzed.id).lifecycle_type).toBe('analysis');
  } finally { await f.close(); }
});
