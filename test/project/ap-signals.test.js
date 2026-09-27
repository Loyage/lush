import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { Database } from 'bun:sqlite';
import { fixture, temp, env } from '../helpers.js';
import { Config } from '../../src/config.js';
import { Store } from '../../src/persistence/store.js';

test('child signals are durable, typed, source-bound and delivered once after the transaction', async () => {
  const f = fixture(); f.project.stopping = true;
  try {
    const parent = f.store.create({ role: 'coordinator', goal: 'parent' });
    const child = f.store.create({ parent_id: parent.id, role: 'research', goal: 'child' });
    f.store.update(parent.id, { status: 'waiting' });
    const first = f.project.sendAPSignal(child.id, parent.id, 'child.completed', `child:${child.id}:completed`, { result: 'done' });
    expect(first.inserted).toBe(true);
    expect(f.store.ap(parent.id).status).toBe('queued');
    const inbox = f.store.unread(parent.id);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({ id: first.id, sender_id: child.id, signal_type: 'child.completed', signal_key: `child:${child.id}:completed` });
    expect(JSON.parse(inbox[0].body).payload).toEqual({ result: 'done' });
    // 历史事件默认只存 message_id；读取历史时把被引用的消息正文一并带上，时间线才看得到通信内容。
    const signalEvent = f.store.historyPage(parent.id).events.find(event => event.type === 'ap.signal');
    expect(signalEvent.message).toMatchObject({ id: first.id, ap_id: parent.id, sender_id: child.id, signal_type: 'child.completed' });
    expect(JSON.parse(signalEvent.message.body).payload).toEqual({ result: 'done' });
    expect(f.store.all("SELECT type FROM events WHERE ap_id=? AND type='ap.signal'", parent.id)).toHaveLength(1);
    expect(f.project.sendAPSignal(child.id, parent.id, 'child.completed', `child:${child.id}:completed`, { result: 'done' }))
      .toEqual({ id: first.id, inserted: false });
    expect(f.store.unread(parent.id)).toHaveLength(1);
    expect(f.store.all("SELECT id FROM events WHERE ap_id=? AND type='ap.signal'", parent.id)).toHaveLength(1);
    expect(() => f.project.sendAPSignal(child.id, parent.id, 'child.completed', `child:${child.id}:completed`, { result: 'different' }))
      .toThrow('different content');
    expect(f.store.unread(parent.id)).toHaveLength(1);
    f.store.run('UPDATE messages SET consumed=1 WHERE id=?', first.id);
    expect(f.store.unread(parent.id)).toEqual([]);
    expect(f.store.get('SELECT id FROM messages WHERE id=?', first.id)).toBeTruthy();
  } finally { await f.close(); }
});

test('普通文本消息事件正文内联在 data.body，不重复挂 event.message', async () => {
  const f = fixture(); f.project.stopping = true;
  try {
    const parent = f.store.create({ role: 'coordinator', goal: 'parent' });
    const child = f.store.create({ parent_id: parent.id, role: 'research', goal: 'child' });
    f.store.update(parent.id, { status: 'waiting' });
    f.project.message(parent.id, 'a plain note', child.id);
    const messageEvent = f.store.history(parent.id).find(event => event.type === 'message');
    expect(messageEvent.data.body).toBe('a plain note');
    expect(messageEvent.message).toBeUndefined();
  } finally { await f.close(); }
});

test('AP signals reject unrelated or terminal targets, malformed keys and oversized payloads without writing', async () => {
  const f = fixture(); f.project.stopping = true;
  try {
    const parent = f.store.create({ role: 'coordinator', goal: 'parent' });
    const child = f.store.create({ parent_id: parent.id, role: 'research', goal: 'child' });
    const unrelated = f.store.create({ role: 'coordinator', goal: 'other' });
    expect(() => f.project.sendAPSignal(child.id, unrelated.id, 'child.completed', 'once')).toThrow('direct parent');
    expect(() => f.project.sendAPSignal(child.id, parent.id, 'X', 'once')).toThrow('invalid AP signal type');
    expect(() => f.project.sendAPSignal(child.id, parent.id, 'child.completed', 'a b')).toThrow('invalid AP signal key');
    expect(() => f.project.sendAPSignal(child.id, parent.id, 'child.completed', 'once', { value: 'x'.repeat(16384) }))
      .toThrow('exceeds');
    f.store.update(parent.id, { status: 'completed' });
    expect(() => f.project.sendAPSignal(child.id, parent.id, 'child.completed', 'once')).toThrow('terminal parent');
    expect(f.store.all('SELECT id FROM messages')).toEqual([]);
  } finally { await f.close(); }
});

test('opening an old database adds only nullable signal columns and preserves old messages', () => {
  const root = temp(); const config = new Config({ project: root, env: env() }); config.prepare();
  const file = path.join(config.home, 'project.db');
  try {
    const first = new Store(file, root);
    const ap = first.create({ role: 'research', goal: 'old AP' });
    first.message(ap.id, 'old message'); first.close();
    const old = new Database(file);
    old.query('DROP INDEX messages_signal_once').run();
    old.query('DROP INDEX aps_new_branch_owner').run();
    old.query('ALTER TABLE messages DROP COLUMN signal_key').run();
    old.query('ALTER TABLE messages DROP COLUMN signal_type').run();
    old.query('ALTER TABLE aps DROP COLUMN reservation').run();
    old.query('ALTER TABLE aps DROP COLUMN ap_kind').run();
    old.close();
    const reopened = new Store(file, root);
    try {
      expect(reopened.unread(ap.id)[0]).toMatchObject({ body: 'old message', signal_type: null, signal_key: null });
      expect(reopened.get('SELECT count(*) AS n FROM messages').n).toBe(1);
      expect(reopened.all('PRAGMA index_list(messages)').some(row => row.name === 'messages_signal_once')).toBe(true);
      expect(reopened.ap(ap.id)).toMatchObject({ ap_kind: null, reservation: null });
      expect(reopened.all('PRAGMA index_list(aps)').some(row => row.name === 'aps_new_branch_owner')).toBe(true);
    } finally { reopened.close(); }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
