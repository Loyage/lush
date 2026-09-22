import { test, expect } from 'bun:test';
import { fixture } from '../helpers.js';
import { handlers } from '../../src/rpc/handlers/notice.js';
import { assertAllowed } from '../../src/rpc/registry.js';

const page = (f, params = {}) => handlers['notice.page'](f.project, params);

test('notice history pages traverse more than 200 records, including retained answers and all kinds', async () => {
  const f = fixture({ async run() { return 'ok'; } });
  try {
    const task = f.store.create({ input_id: null, role: 'worker', goal: 'history' });
    for (let i = 0; i < 245; i++) f.store.run('INSERT INTO notices(task_id,title,body,kind,status,answer) VALUES (?,?,?,?,?,?)',
      task.id, `question ${i}`, 'original', ['question','plan','questionnaire','info'][i % 4], ['open','answered','dismissed','sent'][i % 4], `answer ${i}`);
    const rows = []; let before = null;
    do {
      const result = page(f, { before, limit: 17 });
      rows.push(...result.notices);
      if (!result.has_more) break;
      before = result.cursor;
    } while (rows.length < 300);
    expect(rows).toHaveLength(245);
    expect(new Set(rows.map(row => row.id)).size).toBe(245);
    expect(rows[0].id).toBeGreaterThan(rows.at(-1).id);
    for (const status of ['open','answered','dismissed','sent']) {
      const result = page(f, { status, limit: 100 });
      expect(result.notices.every(row => row.status === status)).toBe(true);
      expect(result.notices[0].body).toBe('original');
      expect(result.notices[0].answer).toContain('answer');
    }
    expect(page(f, { before: 1 })).toMatchObject({ notices: [], has_more: false, cursor: null });
    assertAllowed('notice.page', { status: 'all', limit: 30 }, null);
    for (const params of [{ status: 'bad' }, { before: -1 }, { before: 1.2 }, { limit: 0 }, { limit: 101 }, { limit: '2' }]) {
      expect(() => page(f, params)).toThrow();
    }
  } finally { await f.close(); }
});

test('notice pagination byte bound keeps a continuation cursor instead of silently truncating history', async () => {
  const f = fixture({ async run() { return 'ok'; } });
  try {
    const task = f.store.create({ input_id: null, role: 'worker', goal: 'large history' });
    for (let i = 0; i < 40; i++) f.store.run('INSERT INTO notices(task_id,title,body) VALUES (?,?,?)', task.id, `large ${i}`, '中'.repeat(30000));
    const first = page(f, { limit: 100 });
    expect(first.notices.length).toBeLessThan(40);
    expect(first.has_more).toBe(true);
    const next = page(f, { before: first.cursor, limit: 100 });
    expect(next.notices[0].id).toBe(first.cursor - 1);
  } finally { await f.close(); }
});
