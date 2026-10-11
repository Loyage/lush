import { test, expect } from 'bun:test';
import { fixture } from '../helpers.js';
import { encode } from '../../src/rpc/protocol.js';

const worker = store => store.create({ role: 'agent', task_kind: 'order', goal: 'reading' });
const drain = (store, taskId, options = {}) => {
  const events = [], messages = [], pages = [];
  let before_event = null, before_message = null;
  do {
    const page = store.readingPage(taskId, { ...options, before_event, before_message });
    pages.push(page); events.push(...page.events); messages.push(...page.messages);
    expect(encode({ jsonrpc: '2.0', id: 1, result: page }).length).toBeLessThan(1024 * 1024);
    expect(pages.length).toBeLessThan(1000);
    if (page.has_more_events) expect(page.event_cursor).not.toBe(before_event);
    if (page.has_more_messages) expect(page.message_cursor).not.toBe(before_message);
    before_event = page.event_cursor; before_message = page.message_cursor;
  } while (before_event !== 0 || before_message !== 0);
  return { events, messages, pages };
};
const readAll = (store, taskId, kind, record_id) => {
  let offset = 0, text = '', page;
  do {
    page = store.readingRecord(taskId, { kind, record_id, offset });
    expect(page.text.length).toBeLessThanOrEqual(24000);
    expect(page.next_offset).toBe(offset + page.text.length);
    text += page.text; offset = page.next_offset;
  } while (page.has_more);
  expect(text.length).toBe(page.total_chars);
  return text;
};

test('independent complete scans include >100 rows, orphan/consumed/held messages without changing any facts', async () => {
  const f = fixture(), a = worker(f.store), b = worker(f.store);
  try {
    const eventIds = f.store.all('SELECT id FROM events WHERE task_id=? ORDER BY id', a.id).map(row => row.id), messageIds = [];
    f.store.transaction(() => {
      for (let i = 0; i < 237; i++) {
        eventIds.push(f.store.event(a.id, 'invocation.completed', { result: `result ${i}`, run_id: i + 1 }));
        messageIds.push(f.store.message(a.id, `orphan ${i}`, i % 2 ? b.id : null, i % 3 ? null : 'frozen'));
      }
      f.store.run('UPDATE messages SET consumed=1 WHERE id%2=0');
      f.store.message(b.id, 'other worker'); f.store.event(b.id, 'message', { body: 'other event' });
    });
    const before = { messages: f.store.all('SELECT * FROM messages'), events: f.store.all('SELECT * FROM events'), task: f.store.task(a.id) };
    const result = drain(f.store, a.id);
    expect(result.pages).toHaveLength(5);
    expect(result.events.map(row => row.id)).toEqual(eventIds.reverse());
    expect(result.messages.map(row => row.id)).toEqual(messageIds.reverse());
    expect(result.pages.reduce((sum, page) => sum + page.scanned_events, 0)).toBe(238);
    expect(result.pages.reduce((sum, page) => sum + page.scanned_messages, 0)).toBe(237);
    expect(result.messages.every(row => row.answer_source === null)).toBe(true);
    expect(result.pages.at(-1)).toMatchObject({ event_cursor: 0, message_cursor: 0, has_more_events: false, has_more_messages: false });
    expect(f.store.readingPage(a.id, { before_event: 0, before_message: 0 })).toMatchObject({ events: [], messages: [], scanned_events: 0, scanned_messages: 0 });
    const oneClass = f.store.readingPage(a.id, { before_event: result.events[0].id, before_message: 0, limit: 1 });
    expect(oneClass).toMatchObject({ events: [{ id: result.events[1].id }], messages: [], event_cursor: result.events[1].id,
      message_cursor: 0, has_more_events: true, has_more_messages: false, scanned_events: 1, scanned_messages: 0 });
    expect({ messages: f.store.all('SELECT * FROM messages'), events: f.store.all('SELECT * FROM events'), task: f.store.task(a.id) }).toEqual(before);
  } finally { await f.close(); }
});

test('large escaped/Unicode records never disappear at byte pagination boundaries; reader preserves all UTF16 text', async () => {
  const f = fixture(), a = worker(f.store);
  try {
    const huge = 'a'.repeat(23999) + '😀' + '\n中\\\"\u0000'.repeat(180000) + '\nTailNeedle';
    const ids = [], eventIds = [];
    f.store.transaction(() => {
      for (let i = 0; i < 18; i++) {
        ids.push(f.store.message(a.id, huge));
        eventIds.push(f.store.event(a.id, 'invocation.completed', { result: huge, run_id: i }));
      }
    });
    const result = drain(f.store, a.id, { limit: 100 });
    expect(result.events.filter(row => row.type === 'invocation.completed').map(row => row.id)).toEqual(eventIds.reverse());
    expect(result.messages.map(row => row.id)).toEqual(ids.reverse());
    expect(result.pages.length).toBeGreaterThan(1);
    expect(result.messages.every(row => row.body.length === 23999 && row.text_truncated && row.total_chars === huge.length)).toBe(true);
    expect(readAll(f.store, a.id, 'message', ids[0])).toBe(huge);
    expect(readAll(f.store, a.id, 'event', eventIds[0])).toBe(huge);
    expect(() => f.store.readingRecord(a.id, { kind: 'message', record_id: ids[0], offset: 24000 })).toThrow('surrogate pair');
    const tail = drain(f.store, a.id, { query: 'tailneedle', limit: 100 });
    expect(tail.messages).toHaveLength(18); expect(tail.events).toHaveLength(18);
    expect(tail.messages[0].body).not.toContain('TailNeedle');
    expect(f.store.readingRecord(a.id, { kind: 'message', record_id: ids[0], offset: huge.length })).toEqual({ text: '', offset: huge.length, next_offset: huge.length, has_more: false, total_chars: huge.length });
  } finally { await f.close(); }
});

test('worst-case JSON escaping stays under RPC frame budget and does not lose rows', async () => {
  const f = fixture(), a = worker(f.store);
  try {
    const body = '\u0000'.repeat(24000) + '😀尾', messageIds = [], eventIds = [];
    f.store.transaction(() => {
      for (let i = 0; i < 9; i++) {
        messageIds.push(f.store.message(a.id, body));
        eventIds.push(f.store.event(a.id, 'notice.answered', { body, result: 'result tail', answer: { text: 'answer tail' }, answer_source: 'lush' }));
      }
    });
    const result = drain(f.store, a.id, { limit: 100 });
    expect(result.pages.length).toBeGreaterThan(2);
    expect(result.messages.map(row => row.id)).toEqual(messageIds.reverse());
    expect(result.events.filter(row => row.type === 'notice.answered').map(row => row.id)).toEqual(eventIds.reverse());
    expect(result.events.filter(row => row.type === 'notice.answered').every(row => row.data.body.length === 24000 && row.data.result === '' && row.data.answer === '' && row.text_truncated)).toBe(true);
    expect(readAll(f.store, a.id, 'event', eventIds[0])).toBe(body + '\nresult tail\n' + JSON.stringify({ text: 'answer tail' }));
    expect(drain(f.store, a.id, { query: 'answer tail' }).events).toHaveLength(9);
  } finally { await f.close(); }
});

test('query scans full decoded body/result/object answers; zero matches still advance every batch to exhaustion', async () => {
  const f = fixture(), a = worker(f.store);
  try {
    for (let i = 0; i < 111; i++) f.store.event(a.id, 'misc', { body: `not it ${i}` });
    const answer = { answers: [{ text: 'Decoded\nLiNe' + 'x'.repeat(100000) + 'AnswerTail' }] };
    const answerId = f.store.event(a.id, 'notice.answered', { answer, answer_source: 'lush', notice_id: 42 });
    const bodyId = f.store.event(a.id, 'message', { body: 'body\nMatch', sender: null });
    const mixedId = f.store.event(a.id, 'misc', { body: 'one', result: 'two', answer: 'three' });
    f.store.message(a.id, 'old orphan Match');
    expect(drain(f.store, a.id, { query: 'decoded\nline' }).events.map(row => row.id)).toEqual([answerId]);
    expect(drain(f.store, a.id, { query: 'answertail' }).events.map(row => row.id)).toEqual([answerId]);
    expect(drain(f.store, a.id, { query: 'body\nmatch' }).events.map(row => row.id)).toEqual([bodyId]);
    expect(readAll(f.store, a.id, 'event', answerId)).toBe(JSON.stringify(answer));
    expect(readAll(f.store, a.id, 'event', mixedId)).toBe('one\ntwo\nthree');
    const empty = drain(f.store, a.id, { query: 'missing' });
    expect(empty.events).toEqual([]); expect(empty.messages).toEqual([]); expect(empty.pages).toHaveLength(3);
    expect(empty.pages.reduce((n, page) => n + page.scanned_events, 0)).toBe(115);
    expect(empty.pages[0].event_cursor).toBeGreaterThan(0);
  } finally { await f.close(); }
});

test('preserves exact event/message linkage, identity, source and delivery evidence, never guesses old JSON provenance', async () => {
  const f = fixture(), a = worker(f.store), b = worker(f.store);
  try {
    const msg = f.store.message(a.id, 'child body', b.id);
    const signal = f.store.event(a.id, 'task.signal', { message_id: msg, source_task_id: b.id, signal: 'child.done', key: 'done:1' });
    const old = f.store.message(a.id, JSON.stringify({ notice_id: 1, answer_source: 'lush', answer: 'same answer' }));
    const missing = f.store.event(a.id, 'notice.answered', { answer: 'same answer', notice_id: 1 });
    const explicit = f.store.event(a.id, 'notice.answered', { answer: 'same answer', notice_id: 2, answer_source: 'user' });
    const automatic = f.store.event(a.id, 'notice.answered', { answer: 'same answer', notice_id: 3, answer_source: 'lush' });
    const messageId = f.store.message(a.id, 'user input');
    const input = f.store.event(a.id, 'message', { sender: null, message_id: messageId, body: 'user input', append_number: 'A8-1' });
    f.store.event(a.id, 'invocation.inputs_delivered', { run_id: 1, message_ids: [messageId], goal: true });
    // A newer malformed event must not break receipt queries or silently disappear.
    f.store.run('INSERT INTO events(task_id,type,data) VALUES (?,?,?)', a.id, 'invocation.started', '{broken');
    const result = drain(f.store, a.id);
    const byId = new Map(result.events.map(row => [row.id, row]));
    expect(byId.get(signal)).toMatchObject({ type: 'task.signal', data: { message_id: msg, source_task_id: b.id, signal: 'child.done', key: 'done:1' }, message: { id: msg, sender_id: b.id, body: 'child body' } });
    expect(readAll(f.store, a.id, 'event', signal)).toBe('child body');
    expect(drain(f.store, a.id, { query: 'child body' }).events.filter(row => !row.error).map(row => row.id)).toEqual([signal]);
    expect(result.messages.find(row => row.id === old).answer_source).toBeNull();
    expect(byId.get(missing).answer_source).toBeNull();
    expect(byId.get(explicit).answer_source).toBe('user'); expect(byId.get(automatic).answer_source).toBe('lush');
    expect(byId.get(input)).toMatchObject({ data: { append_number: 'A8-1' }, input_delivery: { status: 'delivered', at: expect.any(String) } });
    expect(result.pages.flatMap(page => page.errors)).toEqual([expect.objectContaining({ kind: 'event', error: 'invalid_event_json' })]);
  } finally { await f.close(); }
});

test('message input_event evidence searches full history by exact same-Worker integer ID, outside cursor/query pages', async () => {
  const f = fixture(), a = worker(f.store), b = worker(f.store);
  try {
    const messageId = f.store.message(a.id, 'Only inbox has the full body\nTailNeedle'), orphanId = f.store.message(a.id, 'same orphan body');
    f.store.event(b.id, 'message', { sender: null, message_id: messageId, append_number: 'WRONG PROJECT' });
    f.store.event(a.id, 'message', { sender: null, message_id: String(messageId), append_number: 'WRONG TYPE' });
    const eventId = f.store.event(a.id, 'message', { sender: null, message_id: messageId, append_number: 'A8-1' });
    f.store.event(a.id, 'notice.answered', { answer: 'same orphan body', answer_source: 'user' });
    f.store.run('INSERT INTO events(task_id,type,data) VALUES (?,?,?)', a.id, 'message', '{malformed');
    for (let i = 0; i < 115; i++) f.store.event(a.id, 'irrelevant', { result: `other ${i}` });
    f.store.event(a.id, 'invocation.inputs_delivered', { message_ids: [messageId] });
    const first = f.store.readingPage(a.id, { limit: 1 });
    expect(first.events.some(row => row.id === eventId)).toBe(false);
    const page = f.store.readingPage(a.id, { before_event: 0, query: 'tailneedle', limit: 1 });
    expect(page.events).toEqual([]);
    const message = drain(f.store, a.id, { before_event: 0, query: 'tailneedle', limit: 1 }).messages[0];
    expect(message).toMatchObject({ id: messageId, body: 'Only inbox has the full body\nTailNeedle', input_event: {
      id: eventId, task_id: a.id, type: 'message', data: { sender: null, message_id: messageId, append_number: 'A8-1' },
      input_delivery: { status: 'delivered', at: expect.any(String) },
    } });
    expect(message.input_event.data.body).toBeUndefined();
    expect(f.store.readingPage(a.id, { before_event: 0 }).messages.find(row => row.id === orphanId).input_event).toBeNull();
    expect(readAll(f.store, a.id, 'event', eventId)).toBe(message.body);
  } finally { await f.close(); }
});

test('input_event missing or contradictory sender evidence remains unknown instead of inventing user provenance', async () => {
  const f = fixture(), a = worker(f.store), b = worker(f.store);
  try {
    const missingSender = f.store.message(a.id, 'no sender evidence');
    f.store.event(a.id, 'message', { message_id: missingSender });
    const contradiction = f.store.message(a.id, 'contradictory evidence', b.id);
    f.store.event(a.id, 'message', { sender: null, message_id: contradiction });
    const workerMessage = f.store.message(a.id, 'worker evidence', b.id);
    f.store.event(a.id, 'message', { sender: b.id, message_id: workerMessage });
    const rows = f.store.readingPage(a.id, { before_event: 0 }).messages;
    expect(Object.hasOwn(rows.find(row => row.id === missingSender).input_event.data, 'sender')).toBe(false);
    expect(rows.find(row => row.id === contradiction).input_event).toMatchObject({
      data: { message_id: contradiction }, limitations: ['message_event_sender_mismatch'],
    });
    expect(Object.hasOwn(rows.find(row => row.id === contradiction).input_event.data, 'sender')).toBe(false);
    expect(rows.find(row => row.id === workerMessage).input_event.data.sender).toBe(b.id);
  } finally { await f.close(); }
});

test('unreadable/over-limit rows are explicit even during no-match search; oversized metadata is bounded separately', async () => {
  const f = fixture(), a = worker(f.store);
  try {
    const big = f.store.message(a.id, 'z'.repeat(16 * 1024 * 1024 + 1));
    const oversizedEvent = f.store.event(a.id, 'invocation.completed', { result: 'z'.repeat(16 * 1024 * 1024 + 1) });
    const broken = Number(f.store.run('INSERT INTO events(task_id,type,data) VALUES (?,?,?)', a.id, 'old', 'not json').lastInsertRowid);
    const meta = f.store.event(a.id, 'message', { more: 'x'.repeat(100000), noisy: Array.from({ length: 500 }, (_, i) => i),
      sender: null, body: 'readable', retry_profile: 'PRIVATE', message_id: 9999, run_id: 1234, append_number: 'A8-1' });
    const missing = f.store.event(a.id, 'task.signal', { message_id: 9999 });
    const page = f.store.readingPage(a.id, { query: 'does not match' });
    expect(page.errors).toEqual(expect.arrayContaining([
      { kind: 'event', record_id: broken, error: 'invalid_event_json' },
      { kind: 'event', record_id: oversizedEvent, error: 'record_exceeds_16_mib' },
      { kind: 'event', record_id: missing, error: 'linked_message_unavailable' },
      { kind: 'message', record_id: big, error: 'record_exceeds_16_mib' },
    ]));
    expect(page.messages[0].error).toBe('record_exceeds_16_mib');
    expect(() => f.store.readingRecord(a.id, { kind: 'message', record_id: big })).toThrow('record_exceeds_16_mib');
    expect(() => f.store.readingRecord(a.id, { kind: 'event', record_id: broken })).toThrow('invalid_event_json');
    const readable = f.store.readingPage(a.id).events.find(row => row.id === meta);
    expect(readable.limitations).toEqual(['event_metadata_bounded']);
    expect(readable.data.body).toBe('readable'); expect(readable.data.more.length).toBe(2048);
    expect(readable.data).toMatchObject({ sender: null, message_id: 9999, run_id: 1234, append_number: 'A8-1' });
    expect(readable.data.retry_profile).toBeUndefined();
    expect(readAll(f.store, a.id, 'event', meta)).toBe('readable');
  } finally { await f.close(); }
});

test('Store validates independent cursors, limits, query, kind, offsets and record ownership', async () => {
  const f = fixture(), a = worker(f.store), b = worker(f.store);
  try {
    const messageId = f.store.message(b.id, 'not yours'), eventId = f.store.event(b.id, 'message', { body: 'not yours' });
    for (const options of [{ before_event: -1 }, { before_message: '1' }, { before_event: 1.2 }, { limit: 101 }, { limit: 0 }, { query: null }, { query: 'x'.repeat(2001) }]) expect(() => f.store.readingPage(a.id, options)).toThrow();
    for (const kind of ['event','message']) expect(() => f.store.readingRecord(a.id, { kind, record_id: kind === 'event' ? eventId : messageId })).toThrow('not found in worker');
    expect(() => f.store.readingPage(9999)).toThrow();
    expect(() => f.store.readingRecord(a.id, { kind: 'other', record_id: messageId })).toThrow('kind');
    for (const offset of [-1, 10, 1.5, '1']) expect(() => f.store.readingRecord(b.id, { kind: 'message', record_id: messageId, offset })).toThrow('offset');
  } finally { await f.close(); }
});
