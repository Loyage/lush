import { test, expect } from 'bun:test';
import { setup, fetch } from './harness.js';

test('Notice HTTP history filters stored answers and follows a continuation cursor', async () => {
  const f = await setup();
  try {
    const task = f.store.create({ input_id: null, role: 'worker', goal: 'notice route' });
    for (let i = 0; i < 3; i++) f.store.run("INSERT INTO notices(task_id,title,body,status,answer) VALUES (?,?,?,'answered',?)", task.id, `record ${i}`, 'body', 'decision');
    f.store.run("INSERT INTO notices(task_id,title,body,status) VALUES (?,?,?,'open')", task.id, 'pending', 'body');
    const first = await (await fetch(f.url + '/api/notices?status=answered&limit=2')).json();
    expect(first.notices).toHaveLength(2); expect(first.has_more).toBe(true); expect(first.total).toBe(3);
    const second = await (await fetch(f.url + `/api/notices?status=answered&limit=2&before=${first.cursor}`)).json();
    expect(second.notices).toHaveLength(1); expect(second.has_more).toBe(false);
    expect(new Set([...first.notices, ...second.notices].map(row => row.id)).size).toBe(3);
    expect(second.notices[0].answer).toBe('decision');
  } finally { await f.close(); }
});
