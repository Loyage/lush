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
    const first = f.project.sendTaskSignal(child.id, parent.id, 'child.completed', `child:${child.id}:completed`, { result: 'done' });
    expect(first.inserted).toBe(true);
    expect(f.store.task(parent.id).status).toBe('queued');
    const inbox = f.store.unread(parent.id);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({ id: first.id, sender_id: child.id, signal_type: 'child.completed', signal_key: `child:${child.id}:completed` });
    expect(JSON.parse(inbox[0].body).payload).toEqual({ result: 'done' });
    expect(f.store.all("SELECT type FROM events WHERE task_id=? AND type='task.signal'", parent.id)).toHaveLength(1);
    expect(f.project.sendTaskSignal(child.id, parent.id, 'child.completed', `child:${child.id}:completed`, { result: 'done' }))
      .toEqual({ id: first.id, inserted: false });
    expect(f.store.unread(parent.id)).toHaveLength(1);
    expect(f.store.all("SELECT id FROM events WHERE task_id=? AND type='task.signal'", parent.id)).toHaveLength(1);
    expect(() => f.project.sendTaskSignal(child.id, parent.id, 'child.completed', `child:${child.id}:completed`, { result: 'different' }))
      .toThrow('different content');
    expect(f.store.unread(parent.id)).toHaveLength(1);
    f.store.run('UPDATE messages SET consumed=1 WHERE id=?', first.id);
    expect(f.store.unread(parent.id)).toEqual([]);
    expect(f.store.get('SELECT id FROM messages WHERE id=?', first.id)).toBeTruthy();
  } finally { await f.close(); }
});

test('task signals reject unrelated or terminal targets, malformed keys and oversized payloads without writing', async () => {
  const f = fixture(); f.project.stopping = true;
  try {
    const parent = f.store.create({ role: 'coordinator', goal: 'parent' });
    const child = f.store.create({ parent_id: parent.id, role: 'research', goal: 'child' });
    const unrelated = f.store.create({ role: 'coordinator', goal: 'other' });
    expect(() => f.project.sendTaskSignal(child.id, unrelated.id, 'child.completed', 'once')).toThrow('direct parent');
    expect(() => f.project.sendTaskSignal(child.id, parent.id, 'X', 'once')).toThrow('invalid task signal type');
    expect(() => f.project.sendTaskSignal(child.id, parent.id, 'child.completed', 'a b')).toThrow('invalid task signal key');
    expect(() => f.project.sendTaskSignal(child.id, parent.id, 'child.completed', 'once', { value: 'x'.repeat(16384) }))
      .toThrow('exceeds');
    f.store.update(parent.id, { status: 'completed' });
    expect(() => f.project.sendTaskSignal(child.id, parent.id, 'child.completed', 'once')).toThrow('terminal parent');
    expect(f.store.all('SELECT id FROM messages')).toEqual([]);
  } finally { await f.close(); }
});

test('opening an old database adds only nullable signal columns and preserves old messages', () => {
  const root = temp(); const config = new Config({ project: root, env: env() }); config.prepare();
  const file = path.join(config.home, 'project.db');
  try {
    const first = new Store(file, root);
    const task = first.create({ role: 'research', goal: 'old task' });
    first.message(task.id, 'old message'); first.close();
    const old = new Database(file);
    old.query('DROP INDEX messages_signal_once').run();
    old.query('DROP INDEX tasks_new_branch_owner').run();
    old.query('ALTER TABLE messages DROP COLUMN signal_key').run();
    old.query('ALTER TABLE messages DROP COLUMN signal_type').run();
    old.query('ALTER TABLE tasks DROP COLUMN reservation').run();
    old.query('ALTER TABLE tasks DROP COLUMN task_kind').run();
    old.close();
    const reopened = new Store(file, root);
    try {
      expect(reopened.unread(task.id)[0]).toMatchObject({ body: 'old message', signal_type: null, signal_key: null });
      expect(reopened.get('SELECT count(*) AS n FROM messages').n).toBe(1);
      expect(reopened.all('PRAGMA index_list(messages)').some(row => row.name === 'messages_signal_once')).toBe(true);
      expect(reopened.task(task.id)).toMatchObject({ task_kind: null, reservation: null });
      expect(reopened.all('PRAGMA index_list(tasks)').some(row => row.name === 'tasks_new_branch_owner')).toBe(true);
    } finally { reopened.close(); }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
