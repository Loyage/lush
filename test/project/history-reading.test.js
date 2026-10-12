import { test, expect } from 'bun:test';
import { fixture } from '../helpers.js';
import { encode } from '../../src/rpc/protocol.js';

const make = store => store.create({ role: 'agent', task_kind: 'order', goal: 'history reading' });
const rawEvent = (store, taskId, type, data) => Number(store.run('INSERT INTO events(task_id,type,data) VALUES (?,?,?)', taskId, type, data).lastInsertRowid);
const drain = (store, taskId, limit = 100) => {
  const events = []; let cursor = null;
  do {
    const page = store.historyPage(taskId, cursor, limit);
    expect(encode({ jsonrpc: '2.0', id: 1, result: page }).length).toBeLessThan(1024 * 1024);
    expect(page.events).not.toHaveLength(0);
    if (page.has_more) expect(page.cursor).not.toBe(cursor);
    events.push(...page.events); cursor = page.has_more ? page.cursor : null;
    expect(events.length).toBeLessThan(1000);
  } while (cursor !== null);
  return events.sort((a, b) => a.id - b.id);
};

test('history/historyPage batch projection equals reading-page, including full-history message and first-delivery evidence', async () => {
  const f = fixture(), task = make(f.store), child = make(f.store);
  try {
    const body = 'x'.repeat(23999) + '😀\nLinkedBodyTail';
    const msg = f.store.message(task.id, body), legacyMsg = f.store.message(task.id, 'legacy'), pending = f.store.message(task.id, 'pending');
    const input = f.store.event(task.id, 'message', { sender: null, message_id: msg, append_number: 'A232-1' });
    const legacy = f.store.event(task.id, 'message', { sender: null, message_id: legacyMsg });
    f.store.event(task.id, 'message', { sender: null, message_id: pending, body: 'pending' });
    const signalId = f.store.message(task.id, 'child body', child.id);
    f.store.event(task.id, 'task.signal', { message_id: signalId, signal: 'child.completed' });
    f.store.event(task.id, 'invocation.started', { message_ids: [legacyMsg] });
    f.store.event(task.id, 'invocation.inputs_delivered', { message_ids: [msg, legacyMsg], goal: true });
    const meta = f.store.event(task.id, 'merge.failed', { error: 'x'.repeat(50000) + 'ErrorTail',
      hooks: { secret: 'PRIVATE-HOOK' }, management: 'PRIVATE-MANAGER', retry_profile: 'PRIVATE-PROFILE',
      nested: { auto_merge: 'PRIVATE-MERGE', public: 'allowed' } });
    const before = { events: f.store.all('SELECT * FROM events'), messages: f.store.all('SELECT * FROM messages') };
    const all = f.store.history(task.id), page = f.store.historyPage(task.id), remote = f.store.readingPage(task.id, { before_message: 0, limit: 100 });
    expect(all).toEqual(page.events); expect(page.events).toEqual([...remote.events].reverse());
    expect(JSON.stringify(all)).not.toContain('PRIVATE');
    expect(all.find(row => row.id === input)).toMatchObject({ text_truncated: true, total_chars: body.length,
      input_delivery: { status: 'delivered', at: expect.any(String) }, message: { total_chars: body.length, text_truncated: true,
        body: body.slice(0,23999), input_event: { id: input, data: { sender: null, message_id: msg, append_number: 'A232-1' } } } });
    expect(all.find(row => row.id === legacy).input_delivery.status).toBe('unknown');
    const single = f.store.historyPage(task.id, input + 1, 1).events[0];
    expect(single).toEqual(all.find(row => row.id === input));
    expect(f.store.history(task.id, input).some(row => row.id === input)).toBe(false);
    expect(all.find(row => row.id === meta).data.error.length).toBeLessThanOrEqual(2048);
    let text = '', offset = 0, part;
    do { part = f.store.readingRecord(task.id, { kind: 'event', record_id: meta, offset }); text += part.text; offset = part.next_offset; } while (part.has_more);
    expect(text).toContain('ErrorTail'); expect(text).not.toContain('PRIVATE');
    expect({ events: f.store.all('SELECT * FROM events'), messages: f.store.all('SELECT * FROM messages') }).toEqual(before);
  } finally { await f.close(); }
});

test('history pages retain malformed/oversized rows, same-Worker links and bounded evidence without throwing or losing cursor rows', async () => {
  const f = fixture(), task = make(f.store), other = make(f.store);
  try {
    const bad = rawEvent(f.store, task.id, 'failed', '{broken'), array = rawEvent(f.store, task.id, 'old', '[]');
    const large = f.store.event(task.id, 'failed', { body: 'x'.repeat(16 * 1024 * 1024 + 1), hooks: 'PRIVATE' });
    const oversizedMessage = f.store.message(task.id, 'x'.repeat(16 * 1024 * 1024 + 1));
    const linkedLarge = f.store.event(task.id, 'task.signal', { message_id: oversizedMessage });
    const foreignMessage = f.store.message(other.id, 'FOREIGN-MESSAGE');
    const foreign = f.store.event(task.id, 'task.signal', { message_id: foreignMessage });
    f.store.event(task.id, 'invocation.inputs_delivered', { message_ids: { invalid: 'not an array' } });
    rawEvent(f.store, task.id, 'invocation.started', '{invalid');
    const rows = drain(f.store, task.id, 3), byId = new Map(rows.map(row => [row.id,row]));
    expect(rows.map(row => row.id)).toEqual(f.store.all('SELECT id FROM events WHERE task_id=? ORDER BY id', task.id).map(row => row.id));
    expect(byId.get(bad).error).toBe('invalid_event_json'); expect(byId.get(array).error).toBe('invalid_event_data');
    expect(byId.get(large)).toMatchObject({ error: 'record_exceeds_16_mib', total_chars: null, text_truncated: true });
    expect(byId.get(linkedLarge).error).toBe('linked_message_record_exceeds_16_mib');
    expect(byId.get(foreign).error).toBe('linked_message_unavailable');
    expect(JSON.stringify(rows)).not.toContain('FOREIGN-MESSAGE'); expect(JSON.stringify(rows)).not.toContain('PRIVATE');
    expect(f.store.history(task.id)).toEqual(rows);
    expect(() => f.store.goalInputDelivery(task.id)).not.toThrow();
    const remote = f.store.readingPage(task.id, { before_message: 0, limit: 100 });
    expect([...remote.events].reverse()).toEqual(rows);
  } finally { await f.close(); }
});

test('byte-boundary pagination keeps newest contiguous windows; both directions traverse escaped long records exactly once', async () => {
  const f = fixture(), task = make(f.store);
  try {
    for (let i = 0; i < 19; i++) f.store.event(task.id, 'invocation.completed', { run_id: i + 1, result: '\u0000'.repeat(24000) + '😀Tail' });
    const expected = f.store.all('SELECT id FROM events WHERE task_id=? ORDER BY id', task.id).map(row => row.id);
    const first = f.store.historyPage(task.id, null, 100);
    expect(first.events.length).toBeLessThan(19); expect(first.has_more).toBe(true);
    expect(first.events.at(-1).id).toBe(expected.at(-1)); expect(first.cursor).toBe(first.events[0].id);
    expect(drain(f.store, task.id).map(row => row.id)).toEqual(expected);
    const legacy = []; let after = 0, page;
    do { page = f.store.history(task.id, after); legacy.push(...page); after = page.at(-1)?.id ?? after; } while (page.length);
    expect(legacy.map(row => row.id)).toEqual(expected);
    expect(f.store.historyPage(task.id, expected[0], 100)).toMatchObject({ events: [], has_more: false });
  } finally { await f.close(); }
});

test('100 linked input records keep query count constant and measured median read latency inside the existing 100ms budget', async () => {
  const f = fixture(), task = make(f.store);
  try {
    const messageIds = [];
    f.store.transaction(() => {
      for (let i = 0; i < 5000; i++) f.store.event(task.id, 'progress.completed', { key: `history-${i}`, comment: 'ordinary audit metadata' });
      for (let i = 0; i < 100; i++) {
        const messageId = f.store.message(task.id, `linked body ${i}`); messageIds.push(messageId);
        f.store.event(task.id, 'message', { sender: null, message_id: messageId, append_number: `A232-${i + 1}` });
      }
      f.store.event(task.id, 'invocation.inputs_delivered', { message_ids: messageIds });
    });
    const receiptId = f.store.get('SELECT max(id) AS id FROM events WHERE task_id=?', task.id).id;
    const originals = { all: f.store.all, get: f.store.get }, queries = [];
    f.store.all = function (sql, ...args) { queries.push(sql); return originals.all.call(this, sql, ...args); };
    f.store.get = function (sql, ...args) { queries.push(sql); return originals.get.call(this, sql, ...args); };
    const samples = [];
    for (let i = 0; i < 8; i++) {
      queries.length = 0; const start = performance.now(), page = f.store.historyPage(task.id, receiptId, 100);
      const elapsed = performance.now() - start; if (i) samples.push(elapsed);
      expect(page.events).toHaveLength(100); expect(page.events.every(row => row.input_delivery.status === 'delivered')).toBe(true);
      expect(queries.length).toBeLessThanOrEqual(6);
      expect(queries.some(sql => sql.includes(' WHERE task_id=? AND id=?'))).toBe(false);
    }
    f.store.all = originals.all; f.store.get = originals.get;
    samples.sort((a,b) => a-b);
    console.log('history batch performance', JSON.stringify({ events: 100, audit_rows: 5102, samples_ms: samples,
      median_ms: samples[3], max_ms: samples.at(-1), queries_per_page: queries.length }));
    expect(samples[3]).toBeLessThan(100);
  } finally { await f.close(); }
});
