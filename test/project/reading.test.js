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
