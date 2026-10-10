import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, temp } from '../helpers.js';
import { Store } from '../../src/persistence/store.js';
import { handlers } from '../../src/rpc/handlers/notice.js';
import { assertAllowed } from '../../src/rpc/registry.js';
import { NOTICE_SELECT } from '../../src/persistence/notice-projection.js';

const sync = (f, params = {}) => handlers['notice.sync'](f.project, params);
function record(f, task, title = 'question') {
  return Number(f.store.run('INSERT INTO notices(task_id,title,body) VALUES (?,?,?)', task.id, title, 'body').lastInsertRowid);
}
function collect(f, initial = null, limit = 17) {
  const changes = []; let result, cursor = initial, turns = 0;
  do {
    result = sync(f, { cursor, limit }); changes.push(...result.changes); cursor = result.cursor;
    if (++turns > 100) throw new Error('sync did not converge');
  } while (result.has_more);
  return { changes, cursor, result };
}

test('Notice sync traverses all history and preserves a fixed watermark while snapshot pages change', async () => {
  const f = fixture({ async run() { return 'ok'; } });
  try {
    const task = f.store.create({ role: 'worker', goal: 'history' });
    f.store.transaction(() => { for (let i = 0; i < 245; i++) record(f, task, `record ${i}`); });
    const first = sync(f, { limit: 11 });
    expect(first.reset).toBe(true); expect(first.has_more).toBe(true);
    const firstIdentity = first.changes[0].identity;
    f.store.run("UPDATE notices SET status='dismissed',answer='new' WHERE id=1");
    f.store.run('DELETE FROM notices WHERE id=2');
    const added = record(f, task, 'added during scan');
    const rest = collect(f, first.cursor, 11);
    const cache = new Map();
    for (const change of [...first.changes, ...rest.changes]) {
      if (change.deleted) { if (cache.get(change.id)?.sync_identity === change.identity) cache.delete(change.id); }
      else cache.set(change.id, change.notice);
    }
    expect(cache.size).toBe(245); expect(cache.get(1).status).toBe('dismissed');
    expect(cache.get(1).sync_identity).toBe(firstIdentity); expect(cache.has(2)).toBe(false);
    expect(cache.get(added).title).toBe('added during scan');
    expect(sync(f, { cursor: rest.cursor }).changes).toEqual([]);
  } finally { await f.close(); }
});

test('Notice sync captures direct terminal settlement, read/answer receipts and exact deletion identity', async () => {
  const f = fixture({ async run() { return 'ok'; } });
  try {
    const task = f.store.create({ role: 'worker', goal: 'changes', status: 'paused' });
    const question = record(f, task), terminal = record(f, task, 'terminal');
    const info = Number(f.store.run("INSERT INTO notices(task_id,title,body,kind,status) VALUES (?,?,?,'info','sent')", task.id, 'info', 'body').lastInsertRowid);
    const initial = collect(f), oldIdentity = initial.changes.find(row => row.id === info).identity;
    const answered = handlers['notice.answer'](f.project, { id: question, answer: 'answer', expected_identity: initial.changes[0].identity });
    expect(answered.answer_source).toBe('user');
    handlers['notice.read'](f.project, { id: info, expected_identity: oldIdentity });
    f.store.run("UPDATE notices SET status='dismissed' WHERE id=?", terminal);
    let changes = collect(f, initial.cursor);
    expect(changes.changes.find(row => row.id === question).notice.answer).toBe('answer');
    expect(changes.changes.find(row => row.id === info).notice.read_at).not.toBeNull();
    expect(changes.changes.find(row => row.id === terminal).notice.status).toBe('dismissed');
    const old = f.store.get(`${NOTICE_SELECT} WHERE n.id=?`, info);
    f.store.run('DELETE FROM notices WHERE id=?', info);
    // Even exactly matching legacy identity fields must not recycle the real record identity.
    f.store.run('INSERT INTO notices(id,task_id,title,body,kind,status,created_at) VALUES (?,?,?,?,?,?,?)', info, task.id, old.title, old.body, old.kind, old.status, old.created_at);
    const replaced = collect(f, changes.cursor).changes;
    expect(replaced[0]).toMatchObject({ id: info, identity: oldIdentity, deleted: true });
    expect(replaced.at(-1).notice.sync_identity).not.toBe(oldIdentity);
    expect(() => handlers['notice.read'](f.project, { id: info, expected_identity: oldIdentity })).toThrow('changed');
    expect(f.store.get('SELECT read_at FROM notices WHERE id=?', info).read_at).toBeNull();
  } finally { await f.close(); }
});

test('Notice sync observes deferred device automatic answers without triggering backlog execution from reads', async () => {
  const f = fixture({ async run() { return 'ok'; } });
  try {
    const task = f.store.create({ role: 'worker', goal: 'device automatic answer', status: 'paused' });
    const backlog = record(f, task, 'existing unanswered question');
    f.project.deviceAutomation.save({ auto_select: { enabled: true } }, f.project.deviceAutomation.get().revision);
    const created = f.project.notice(task.id, 'new automatic question', 'body');
    // The creation transaction commits before the deferred policy-locked answer.
    expect(created.status).toBe('open');
    const before = collect(f);
    const original = before.changes.find(change => change.id === created.id).notice;
    expect(original.status).toBe('open');
    expect(f.store.get('SELECT status FROM notices WHERE id=?', backlog).status).toBe('open');
    await Promise.resolve();
    const changes = collect(f, before.cursor).changes;
    const answered = changes.find(change => change.id === created.id).notice;
    expect(answered).toMatchObject({ status: 'answered', answer_source: 'lush', sync_identity: original.sync_identity });
    expect(answered.sync_revision).toBeGreaterThan(original.sync_revision);
    // Only runtime backlog entry points may apply the device policy to old questions.
    expect(f.store.get('SELECT status FROM notices WHERE id=?', backlog).status).toBe('open');
    expect(sync(f, { cursor: collect(f, before.cursor).cursor }).changes).toEqual([]);
  } finally { await f.close(); }
});

test('bounded journal expiration resets a lagging client and transactions roll back synchronization metadata', async () => {
  const f = fixture({ async run() { return 'ok'; } });
  try {
    const task = f.store.create({ role: 'worker', goal: 'retention' }), notice = record(f, task);
    const initial = collect(f), originalRevision = initial.changes[0].notice.sync_revision;
    expect(() => f.store.transaction(() => { f.store.run("UPDATE notices SET title='rolled back' WHERE id=?", notice); throw new Error('rollback'); })).toThrow('rollback');
    expect(sync(f, { cursor: initial.cursor }).changes).toEqual([]);
    expect(f.store.get(`${NOTICE_SELECT} WHERE n.id=?`, notice).sync_revision).toBe(originalRevision);
    f.store.transaction(() => { for (let i = 0; i < 10001; i++) f.store.run('UPDATE notices SET title=? WHERE id=?', `revision ${i}`, notice); });
    expect(f.store.get('SELECT COUNT(*) AS n FROM notice_sync_changes').n).toBe(10000);
    const reset = sync(f, { cursor: initial.cursor });
    expect(reset.reset).toBe(true); expect(reset.changes[0].notice.title).toBe('revision 10000');
    const otherEpoch = JSON.parse(Buffer.from(initial.cursor, 'base64url').toString()); otherEpoch.epoch = '0'.repeat(32);
    expect(sync(f, { cursor: Buffer.from(JSON.stringify(otherEpoch)).toString('base64url') }).reset).toBe(true);
  } finally { await f.close(); }
});

test('Notice sync is user-only, strictly validates cursors and respects the byte budget', async () => {
  const f = fixture({ async run() { return 'ok'; } });
  try {
    assertAllowed('notice.sync', {}, null);
    expect(() => assertAllowed('notice.sync', {}, 123)).toThrow('user approval');
    for (const params of [{ cursor: '' }, { cursor: 'broken' }, { cursor: 3 }, { limit: 0 }, { limit: 101 }, { limit: '2' }]) expect(() => sync(f, params)).toThrow();
    const task = f.store.create({ role: 'worker', goal: 'bytes' });
    f.store.transaction(() => { for (let i = 0; i < 30; i++) f.store.run('INSERT INTO notices(task_id,title,body) VALUES (?,?,?)', task.id, `record ${i}`, '中'.repeat(30000)); });
    const first = sync(f);
    expect(first.changes.length).toBeLessThan(30); expect(first.has_more).toBe(true);
    expect(collect(f, first.cursor).changes.length + first.changes.length).toBe(30);
  } finally { await f.close(); }
});

test('installing derived synchronization metadata does not rewrite historical Notice rows', () => {
  const root = temp(), file = path.join(root, 'project.db'); let store;
  try {
    store = new Store(file, root);
    const task = store.create({ role: 'worker', goal: 'legacy' });
    const notice = Number(store.run('INSERT INTO notices(task_id,title,body) VALUES (?,?,?)', task.id, 'original', 'original body').lastInsertRowid);
    const original = store.get('SELECT * FROM notices WHERE id=?', notice);
    store.db.exec('DROP TRIGGER notice_sync_insert; DROP TRIGGER notice_sync_update; DROP TRIGGER notice_sync_delete; DROP TABLE notice_sync_changes; DROP TABLE notice_sync_records;');
    store.run("DELETE FROM meta WHERE key='notice_sync_epoch'"); store.close();
    store = new Store(file, root);
    expect(store.get('SELECT * FROM notices WHERE id=?', notice)).toEqual(original);
    const value = handlers['notice.sync']({ store, config: { project: root } }, {});
    expect(value.changes[0].notice.title).toBe('original'); expect(value.changes[0].notice.sync_revision).toBe(0);
    const identity = value.changes[0].identity;
    store.close(); store = new Store(file, root);
    expect(handlers['notice.sync']({ store, config: { project: root } }, {}).changes[0].identity).toBe(identity);
  } finally { store?.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
