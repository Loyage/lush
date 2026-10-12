import { test, expect } from 'bun:test';
import { fixture } from '../helpers.js';
import { handlers } from '../../src/rpc/handlers/notice.js';

const page = (f, params = {}) => handlers['notice.page'](f.project, params);

test('Notice page exact status totals ignore cursor/limit and distinguish Web-hidden plans', async () => {
  const f = fixture(); f.project.kick = () => {};
  try {
    const task = f.store.create({ input_id: null, role: 'worker', goal: 'notice totals' });
    const event = Number(f.store.run("INSERT INTO events(task_id,type,data) VALUES (?,'task.idle','{}')", task.id).lastInsertRowid);
    const readEvent = Number(f.store.run("INSERT INTO events(task_id,type,data) VALUES (?,'task.idle','{}')", task.id).lastInsertRowid);
    const records = [
      ['question', 'open', null, null, null], ['questionnaire', 'open', null, null, null], ['plan', 'open', null, null, null],
      ['question', 'answered', null, null, 'lush'], ['questionnaire', 'answered', null, null, 'lush'],
      ['question', 'answered', null, null, 'user'], ['question', 'answered', null, null, null], ['plan', 'answered', null, null, 'lush'],
      ['info', 'answered', null, null, 'lush'], ['question', 'dismissed', null, null, 'user'],
      ['plan', 'dismissed', null, null, 'user'], ['info', 'sent', event, null, null],
      ['info', 'sent', readEvent, '2026-01-01', null], ['info', 'sent', null, null, null],
    ];
    const inserted = records.map(([kind, status, source, read, answer]) => Number(f.store.run(
      'INSERT INTO notices(task_id,title,body,kind,status,source_event_id,read_at,answer_source) VALUES (?,?,?,?,?,?,?,?)',
      task.id, 'total fixture', '', kind, status, source, read, answer).lastInsertRowid));
    const expected = { all: [14, 11], open: [3, 2], answered: [6, 5], dismissed: [2, 1], sent: [3, 3], unread: [1, 1], automatic: [2, 2] };
    for (const [status, [total, non_plan_total]] of Object.entries(expected)) {
      const full = page(f, { status, limit: 100 });
      expect(full.total).toBe(total); expect(full.non_plan_total).toBe(non_plan_total);
      expect(full.notices).toHaveLength(total); expect(full.has_more).toBe(false);
      const small = page(f, { status, limit: 1 });
      expect(small).toMatchObject({ total, non_plan_total, limit: 1 });
      expect(small.has_more).toBe(total > 1);
      const empty = page(f, { status, before: inserted[0], limit: 1 });
      expect(empty).toEqual({ notices: [], cursor: null, has_more: false, limit: 1, total, non_plan_total });
    }
    // Total follows persistent read facts; no status or record protocol is mutated by pagination.
    const unread = page(f, { status: 'unread' }).notices[0];
    handlers['notice.read'](f.project, { id: unread.id });
    expect(page(f, { status: 'unread' })).toMatchObject({ total: 0, non_plan_total: 0, notices: [] });
    expect(page(f, { status: 'sent' }).total).toBe(3);
    expect(page(f).total).toBe(14);
    for (const params of [{ status: 'unknown' }, { limit: 0 }, { limit: 101 }, { before: 'invalid' }]) expect(() => page(f, params)).toThrow();
  } finally { await f.close(); }
});

test('Notice totals cover more than 200 records and byte-bounded pages without losing legacy cursors', async () => {
  const f = fixture(); f.project.kick = () => {};
  try {
    const task = f.store.create({ input_id: null, role: 'worker', goal: 'byte-bounded totals' });
    f.store.transaction(() => {
      for (let i = 0; i < 240; i++) f.store.run("INSERT INTO notices(task_id,title,body,kind,status) VALUES (?,?,?,'question','open')", task.id, String(i), '');
      for (let i = 0; i < 3; i++) f.store.run("INSERT INTO notices(task_id,title,body,kind,status) VALUES (?,?,?,'plan','open')", task.id, 'legacy', 'x'.repeat(500000));
    });
    const first = page(f, { status: 'open', limit: 100 });
    expect(first).toMatchObject({ total: 243, non_plan_total: 240, has_more: true, limit: 100 });
    expect(first.notices).toHaveLength(1); expect(first.cursor).toBe(first.notices[0].id);
    const all = [...first.notices]; let cursor = first.cursor;
    for (let i = 0; i < 10; i++) {
      const next = page(f, { status: 'open', before: cursor, limit: 100 });
      expect(next).toMatchObject({ total: 243, non_plan_total: 240 });
      all.push(...next.notices); cursor = next.cursor;
      if (!next.has_more) break;
    }
    expect(all).toHaveLength(243); expect(new Set(all.map(row => row.id)).size).toBe(243);
    expect(all.filter(row => row.kind !== 'plan')).toHaveLength(first.non_plan_total);
  } finally { await f.close(); }
});
