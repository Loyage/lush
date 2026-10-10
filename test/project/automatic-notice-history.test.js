import { test, expect } from 'bun:test';
import { fixture } from '../helpers.js';
import { handlers as notices } from '../../src/rpc/handlers/notice.js';
import { handlers as system } from '../../src/rpc/handlers/system.js';

const summary = (f, actor = null) => system['system.summary'].call({ identity: {} }, f.project, {}, actor);

test('automatic history filters explicit Lush answers before pagination, including old records beyond 200', async () => {
  const f = fixture(); f.project.kick = () => {};
  try {
    const task = f.store.create({ input_id: null, role: 'worker', goal: 'history' });
    const expected = [];
    f.store.transaction(() => {
      for (let i = 0; i < 250; i++) {
        const automatic = i % 50 === 0;
        const row = f.store.run('INSERT INTO notices(task_id,title,body,kind,status,answer,answer_source) VALUES (?,?,?,?,?,?,?)',
          task.id, `question ${i}`, 'original question', automatic && i % 100 === 0 ? 'questionnaire' : 'question',
          'answered', '请由 Agent 自行判断并继续。', automatic ? 'lush' : i % 2 ? 'user' : null);
        if (automatic) expected.push(Number(row.lastInsertRowid));
      }
      for (const [kind, status] of [['info', 'answered'], ['plan', 'answered'], ['question', 'open'], ['question', 'dismissed']]) {
        f.store.run('INSERT INTO notices(task_id,title,body,kind,status,answer_source) VALUES (?,?,?,?,?,?)', task.id, 'not an automatic answer', '', kind, status, 'lush');
      }
    });
    const rows = []; let before = null;
    do {
      const page = notices['notice.page'](f.project, { status: 'automatic', before, limit: 2 });
      rows.push(...page.notices);
      if (!page.has_more) break;
      before = page.cursor;
    } while (rows.length < 10);
    expect(rows.map(row => row.id)).toEqual(expected.reverse());
    expect(rows.every(row => row.answer_source === 'lush' && row.body === 'original question')).toBe(true);
    f.project.setDaemonAutoSelect(false, f.project.daemonHooks().revision);
    expect(notices['notice.page'](f.project, { status: 'automatic' }).notices.map(row => row.id)).toEqual(expected);
    expect(notices['notice.page'](f.project, { status: 'answered', limit: 100 }).notices.some(row => row.answer_source === 'user')).toBe(true);
  } finally { await f.close(); }
});

test('user polling summary mirrors only auto-select authorization, changes revision and keeps Agent summary private', async () => {
  const f = fixture(); f.project.kick = () => {};
  try {
    const before = summary(f);
    expect(before.auto_select).toEqual({ enabled: false, revision: f.project.daemonHooks().revision, editable: true,
      scope: 'device', policy_revision: f.project.daemonHooks().policy_revision ?? f.project.daemonHooks().revision,
      available: true, error: null });
    f.project.setDaemonAutoSelect(true, before.auto_select.revision);
    const enabled = summary(f);
    expect(enabled.auto_select.enabled).toBe(true);
    expect(enabled.revision).not.toBe(before.revision);
    expect(enabled.auto_select.revision).not.toBe(before.auto_select.revision);
    expect(summary(f, 999)).not.toHaveProperty('auto_select');
    expect(enabled.auto_select).not.toHaveProperty('mounts');
    expect(enabled.auto_select).not.toHaveProperty('last_execution');
    f.project.setDaemonAutoSelect(false, enabled.auto_select.revision);
    expect(summary(f).auto_select.enabled).toBe(false);
    expect(summary(f).revision).not.toBe(enabled.revision);
  } finally { await f.close(); }
});
