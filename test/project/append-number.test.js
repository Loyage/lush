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

test('message allocation is atomic, high-water survives message/Worker/Input deletion, reopen and purge', async () => {
  const f = fixture(); f.project.stopping = true;
  let other;
  try {
    const a = root(f.store), b = child(f.store, a);
    const first = f.store.appendMessage(a.id, 'one'), second = f.store.appendMessage(b.id, 'two');
    expect(read(f.store, second).append_number).toBe(`A${a.input_id}-2`);
    f.store.run('DELETE FROM messages WHERE id=?', second);
    other = new Store(path.join(f.config.home, 'project.db'), f.root);
    const third = other.appendMessage(b.id, 'three');
    expect(read(other, third).append_number).toBe(`A${a.input_id}-3`);
    expect(() => other.run('UPDATE messages SET append_number=? WHERE id=?', read(f.store, first).append_number, third)).toThrow('UNIQUE');
    const count = other.get('SELECT count(*) AS n FROM messages').n;
    expect(() => other.transaction(() => { other.appendMessage(a.id, 'rolled back'); throw new Error('rollback'); })).toThrow('rollback');
    expect(other.get('SELECT count(*) AS n FROM messages').n).toBe(count);
    expect(high(other, a.input_id)).toBe('3');
    f.store.hardDeleteTasks([b.id]);
    expect(read(other, other.appendMessage(a.id, 'after child deletion')).append_number).toBe(`A${a.input_id}-4`);
    f.store.hardDeleteTasks([a.id], [a.input_id]);
    expect(high(other, a.input_id)).toBe('4');
    f.store.purge();
    expect(high(other, a.input_id)).toBe('4');
    const next = root(other);
    expect(next.input_id).toBeGreaterThan(a.input_id);
    expect(read(other, other.appendMessage(next.id, 'next Input')).append_number).toBe(`A${next.input_id}-1`);
  } finally { other?.close(); await f.close(); }
});

test('independent concurrent Store processes serialize allocation for the same Input', async () => {
  const f = fixture(); f.project.stopping = true;
  const processes = [], readers = new Map();
  try {
    const a = root(f.store), b = child(f.store, a);
    const script = `import { Store } from ${JSON.stringify(path.resolve('src/persistence/store.js'))};
      const s = new Store(process.argv[1], process.argv[2]);
      console.log('ready'); await Bun.stdin.text();
      const ids = []; for (let i=0;i<20;i++) ids.push(s.appendMessage(Number(process.argv[3]), 'concurrent '+i));
      console.log(JSON.stringify(ids.map(id => s.get('SELECT append_number FROM messages WHERE id=?', id).append_number)));
      s.close();`;
    // Open schema serially; all three processes then compete for the allocation lock.
    for (const target of [a, b, a]) {
      const proc = Bun.spawn([process.execPath, '-e', script, path.join(f.config.home, 'project.db'), f.root, String(target.id)],
        { env: env(), stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
      processes.push(proc);
      const reader = proc.stdout.getReader();
      expect(new TextDecoder().decode((await reader.read()).value).trim()).toBe('ready');
      readers.set(proc, reader);
    }
    for (const proc of processes) { proc.stdin.write('go'); proc.stdin.end(); }
    const results = await Promise.all(processes.map(async proc => {
      const output = async () => {
        const chunks = [], reader = readers.get(proc);
        for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); }
        reader.releaseLock(); return Buffer.concat(chunks).toString();
      };
      const [stdout, stderr, exit] = await Promise.all([output(), new Response(proc.stderr).text(), proc.exited]);
      expect(stderr).toBe(''); expect(exit).toBe(0);
      return JSON.parse(stdout);
    }));
    const numbers = results.flat();
    expect(new Set(numbers).size).toBe(60);
    expect(numbers.map(value => Number(value.split('-')[1])).sort((a, b) => a - b)).toEqual(Array.from({ length: 60 }, (_, i) => i + 1));
    expect(high(f.store, a.input_id)).toBe('60');
  } finally { for (const proc of processes) { if (proc.exitCode === null) proc.kill(); await proc.exited; } await f.close(); }
});

test('old schema/history stay unnumbered; missing Input keeps message ID rather than fabricating O/A', async () => {
  const f = fixture(); f.project.stopping = true;
  let other;
  try {
    const a = root(f.store);
    const messageId = f.store.message(a.id, 'historical body');
    const eventId = f.store.event(a.id, 'message', { sender: null, body: 'historical body', message_id: messageId });
    const oldMessage = read(f.store, messageId), oldEvent = f.store.get('SELECT * FROM events WHERE id=?', eventId);
    f.store.run('DROP INDEX messages_append_number');
    f.store.run('ALTER TABLE messages DROP COLUMN append_number');
    other = new Store(path.join(f.config.home, 'project.db'), f.root);
    expect(read(other, messageId)).toEqual(oldMessage);
    expect(other.get('SELECT * FROM events WHERE id=?', eventId)).toEqual(oldEvent);
    expect(other.historyPage(a.id).events.find(row => row.id === eventId).data).not.toHaveProperty('append_number');
    expect(high(other, a.input_id)).toBeNull();
    expect(read(other, other.appendMessage(a.id, 'new after migration')).append_number).toBe(`A${a.input_id}-1`);
    const legacy = other.create({ role: 'agent', goal: 'no Input' });
    // Also test an explicitly user-originated Project.message to a legacy unassociated Worker.
    f.project.message(legacy.id, 'no associated Input');
    const unnumbered = other.unread(legacy.id)[0];
    expect(unnumbered.id).toBeNumber(); expect(unnumbered.append_number).toBeNull();
    expect(other.history(legacy.id).find(row => row.type === 'message').data).toMatchObject({ message_id: unnumbered.id, append_number: null });
  } finally { other?.close(); await f.close(); }
});

for (const status of ['requested', 'executing', 'resolving', 'blocked']) test(`${status}: frozen appends save their number once before delivery and expose it on history/read pages`, async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const a = (await f.project.order('original', null, [], null, false)).task;
    const b = await f.project.spawn(a.id, 'child');
    f.store.update(b.id, { status: 'waiting', reservation: JSON.stringify({ version: 2, kind: 'merge', queue_protocol: 1,
      status, parent_id: a.id, commit: b.base_commit, attempt_id: 123, baseline: b.base_commit }) });
    const reservation = f.store.task(b.id).reservation;
    for (const [i, sender] of [null, a.id, null].entries()) {
      const response = f.project.message(b.id, `frozen ${i}`, sender);
      expect(response.input_queue.buffered).toBe(i + 1);
    }
    expect(f.store.task(b.id).reservation).toBe(reservation);
    expect(f.store.unreadPage(b.id).messages).toEqual([]);
    const rows = f.store.unread(b.id);
    expect(rows.map(row => row.append_number)).toEqual([`A${a.input_id}-1`, null, `A${a.input_id}-2`]);
    expect(f.project.inspect(b.id).messages.map(row => row.append_number)).toEqual([`A${a.input_id}-2`, null, `A${a.input_id}-1`]);
    const all = []; let before = null;
    do {
      const page = f.store.historyPage(b.id, before, 2); all.push(...page.events);
      before = page.has_more ? page.cursor : null;
    } while (before !== null);
    const events = all.filter(row => row.type === 'message').sort((a, b) => a.id - b.id);
    expect(events.map(row => row.data.append_number)).toEqual(rows.map(row => row.append_number));
    expect(events.map(row => row.data.message_id)).toEqual(rows.map(row => row.id));
    expect(f.store.history(b.id).filter(row => row.type === 'message').map(row => row.data.append_number)).toEqual(rows.map(row => row.append_number));
    const referenceId = f.store.event(b.id, 'test.message_reference', { message_id: rows[0].id });
    expect(f.store.historyPage(b.id, null, 1).events[0]).toMatchObject({ id: referenceId, message: { id: rows[0].id, append_number: rows[0].append_number } });
    f.store.update(b.id, { reservation: null });
    f.store.update(a.id, { status: 'waiting' });
    expect(f.project.releaseTaskInputs(b.id)).toBe(true);
    expect(f.store.unreadPage(b.id, { limit: 2 }).messages.map(row => row.append_number)).toEqual([`A${a.input_id}-1`, null]);
    expect(f.store.unread(b.id).map(row => row.append_number)).toEqual(rows.map(row => row.append_number));
    expect(high(f.store, a.input_id)).toBe('2');
  } finally { await f.close(); }
});

test('an actual lifecycle Hook message does not occupy a user append number', async () => {
  const f = fixture(); f.project.kick = () => {}; await repo(f.root);
  try {
    const a = (await f.project.order('original', null, [], null, false)).task;
    f.project.attachTaskHook(a.id, { name: 'runtime message', trigger: 'agent.returned', mode: 'once', enabled: true,
      actions: [{ type: 'message', target_id: a.id, body: 'Hook body' }] }, f.project.taskHooks(a.id).revision);
    f.project.emitTaskHook(a.id, 'agent.returned', f.store.event(a.id, 'test.returned', {}));
    await f.project.hookQueue;
    expect(f.store.unread(a.id)[0]).toMatchObject({ body: 'Hook body', sender_id: null, append_number: null });
    expect(high(f.store, a.input_id)).toBeNull();
    f.project.message(a.id, 'user');
    expect(f.store.unread(a.id).at(-1).append_number).toBe(`A${a.input_id}-1`);
  } finally { await f.close(); }
});
