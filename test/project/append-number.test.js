import { test, expect, setDefaultTimeout } from 'bun:test';
import path from 'node:path';
import { fixture, repo, env } from '../helpers.js';
import { Store } from '../../src/persistence/store.js';
import { settleNoticeAnswer } from '../../src/core/project/messages.js';
setDefaultTimeout(30000);

function input(store) {
  const id = store.nextInputId();
  store.run('INSERT INTO inputs(id,content) VALUES (?,?)', id, `original ${id}`);
  return id;
}
const root = store => store.create({ input_id: input(store), role: 'agent', task_kind: 'order', goal: 'root' });
const child = (store, parent) => store.create({ input_id: parent.input_id, parent_id: parent.id, role: 'agent', task_kind: 'child', goal: 'child' });
const read = (store, id) => store.get('SELECT * FROM messages WHERE id=?', id);
const high = (store, inputId) => store.get('SELECT value FROM meta WHERE key=?', `input_append_high:${inputId}`)?.value ?? null;

test('explicit user appends share an Input sequence across associated Workers, not message/Worker IDs', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const original = await f.project.order('original', null, [], null, false);
    const a = original.task, b = await f.project.spawn(a.id, 'child'), c = await f.project.spawn(b.id, 'grandchild');
    expect(a.id).not.toBe(original.id);
    const originalRow = f.store.get('SELECT * FROM inputs WHERE id=?', original.id);
    // Repeated bodies are different saved inputs, even when they target different Workers.
    await Promise.all([a, b, c, a, b].map(async worker => f.project.message(worker.id, 'same body')));
    const messages = f.store.all('SELECT * FROM messages ORDER BY id');
    expect(messages.map(row => row.append_number)).toEqual(Array.from({ length: 5 }, (_, i) => `A${original.id}-${i + 1}`));
    expect(new Set(messages.map(row => row.id)).size).toBe(5);
    expect(f.store.get('SELECT * FROM inputs WHERE id=?', original.id)).toEqual(originalRow);
    expect(f.project.inputGet('input', original.id).content).toBe('original');
    const saveEvent = f.store.event;
    f.store.event = (taskId, type, data) => { if (type === 'message') throw new Error('event write failed'); return saveEvent.call(f.store, taskId, type, data); };
    expect(() => f.project.message(a.id, 'must roll back with its Event')).toThrow('event write failed');
    f.store.event = saveEvent;
    expect(high(f.store, original.id)).toBe('5');
    expect(f.store.get('SELECT count(*) AS n FROM messages').n).toBe(5);
    const nextOrder = await f.project.order('another original', a.branch, [], null, false);
    f.project.message(nextOrder.task.id, 'separate sequence');
    expect(f.store.unread(nextOrder.task.id)[0].append_number).toBe(`A${nextOrder.id}-1`);
    expect(high(f.store, original.id)).toBe('5');
  } finally { await f.close(); }
});

test('sender-null runtime, Notice answers, direct parent/child communication and signals never consume append numbers', async () => {
  const f = fixture(); f.project.stopping = true;
  try {
    const a = root(f.store), b = child(f.store, a);
    f.project.message(a.id, 'user first');
    f.project.message(a.id, 'child communication', b.id);
    f.project.message(b.id, 'parent communication', a.id);
    f.project.sendTaskSignal(b.id, a.id, 'child.ready', 'ready:1', {});
    f.store.message(a.id, 'runtime sender null');
    f.project.message(a.id, 'runtime Hook path', null, false);
    for (const source of ['user', 'lush']) {
      const question = f.project.notice(a.id, `question ${source}`);
      settleNoticeAnswer(f.project, question.id, 'yes', false, source);
    }
    const questionnaire = f.project.notice(a.id, 'questionnaire', '', 'question', [{ question: 'Which?', header: 'Choice',
      options: [{ label: 'A', description: 'A' }, { label: 'B', description: 'B' }] }]);
    f.project.answer(questionnaire.id, { answers: [{ selected: [0] }] });
    const dismissed = f.project.notice(a.id, 'dismissed');
    f.project.answer(dismissed.id, '', true);
    f.project.notify(a.id, 'info');
    const before = high(f.store, a.input_id);
    const outsider = root(f.store);
    expect(() => f.project.message(a.id, 'invalid sender', outsider.id)).toThrow('direct');
    expect(high(f.store, a.input_id)).toBe(before);
    f.project.message(a.id, 'user last');
    const rows = f.store.all('SELECT * FROM messages ORDER BY id');
    expect(rows.filter(row => row.append_number !== null).map(row => row.body)).toEqual(['user first', 'user last']);
    expect(rows.filter(row => row.append_number !== null).map(row => row.append_number)).toEqual([`A${a.input_id}-1`, `A${a.input_id}-2`]);
    expect(rows.filter(row => row.sender_id !== null).every(row => row.append_number === null)).toBe(true);
    const event = f.store.history(a.id).find(row => row.type === 'message' && row.data.body === 'runtime Hook path');
    expect(event.data.append_number).toBeNull();
  } finally { await f.close(); }
});
