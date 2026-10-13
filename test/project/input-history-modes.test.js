import { test, expect } from 'bun:test';
import { fixture, repo } from '../helpers.js';
import { Dispatcher } from '../../src/rpc/protocol.js';
import { assertAllowed } from '../../src/rpc/registry.js';
import { Store } from '../../src/persistence/store.js';
import path from 'node:path';

async function setup() {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  f.call = (method, params = {}) => new Dispatcher(f.project).dispatch(method, params);
  return f;
}
function original(f, content = 'order body') {
  const id = f.store.nextInputId();
  f.store.run('INSERT INTO inputs(id,content) VALUES (?,?)', id, content);
  const task = f.store.create({ input_id: id, role: 'agent', task_kind: 'order', goal: content });
  f.store.run('UPDATE inputs SET task_id=? WHERE id=?', task.id, id);
  f.store.update(task.id, { status: 'running', calls: 1 });
  return task;
}
const key = row => `${row.kind}:${row.id}`;

test('all mode subsets filter full SQL history before mixed-kind same-time pagination and normalize cursor sets', async () => {
  const f = await setup();
  try {
    const task = (await f.call('order.submit', { content: 'order body', start: false })).task;
    f.store.update(task.id, { status: 'running', calls: 1 });
    const d = await f.call('draft.add', { content: 'order draft' });
    const a = await f.call('draft.add', { content: 'append draft', mode: 'append', target_id: task.id });
    const expected = [key(f.project.inputGet('input', task.input_id)), key(d), key(a)];
    // More than one default page of each non-Input source, including full-body search beyond previews.
    for (let i = 0; i < 105; i++) {
      expected.push(`message:${f.store.appendMessage(task.id, `${'x'.repeat(1100)} mixed needle ${i}`)}`);
      const m = f.store.create({ role: 'manager', task_kind: 'management', goal: `${'x'.repeat(1100)} mixed needle ${i}` });
      f.store.update(m.id, { status: 'queued', management: JSON.stringify({ origin: 'input' }) });
      expected.push(`management:${m.id}`);
    }
    for (const table of ['inputs','drafts','messages','tasks']) f.store.run(`UPDATE ${table} SET created_at='2026-01-01T00:00:00.000Z'`);
    const all = f.project.inputHistory({ limit: 100 });
    expect(all.items.every(item => ['order','append','management'].includes(item.mode))).toBe(true);
    const allByKey = new Map();
    let cursor;
    do {
      const page = f.project.inputHistory({ limit: 17, ...(cursor ? { cursor } : {}) });
      for (const row of page.items) { expect(allByKey.has(key(row))).toBe(false); allByKey.set(key(row), row); }
      cursor = page.next_cursor;
      if (cursor) {
        expect(() => f.project.inputHistory({ cursor, modes: ['append'] })).toThrow('changed filters');
        // Explicit all, in any order, is identical to the omitted default.
        expect(() => f.project.inputHistory({ cursor, modes: ['management','order','append'] })).not.toThrow();
      }
    } while (cursor);
    expect([...allByKey.keys()].sort()).toEqual(expected.sort());
    for (let mask = 0; mask < 8; mask++) {
      const modes = ['order','append','management'].filter((_, index) => mask & (1 << index));
      let after, rows = [];
      do {
        const page = await f.call('input.history', { modes: [...modes].reverse(), limit: 13, ...(after ? { cursor: after } : {}) });
        rows.push(...page.items); after = page.next_cursor;
        if (after) expect(() => f.project.inputHistory({ cursor: after, modes })).not.toThrow();
      } while (after);
      expect(rows.map(key).sort()).toEqual([...allByKey.values()].filter(row => modes.includes(row.mode)).map(key).sort());
    }
    const search = f.project.inputHistory({ modes: ['management'], q: 'mixed needle 104' }).items;
    expect(search).toHaveLength(1); expect(search[0]).toMatchObject({ content_truncated: true, mode: 'management' });
    expect(f.project.inputGet('management', search[0].id).content).toContain('mixed needle 104');
    expect(f.project.inputHistory({ modes: ['append'], status: 'running', integration: 'none', limit: 100 }).items).toHaveLength(100);
    expect(f.project.inputHistory({ modes: ['management'], status: 'running' }).items).toEqual([]);
    expect(f.project.inputHistory({ modes: [], conditional: 'configured' })).toEqual({ items: [], next_cursor: null });
  } finally { await f.close(); }
});

test('message provenance excludes Worker, Notice and runtime traffic; legacy and explicit unnumbered user receipts are immutable', async () => {
  const f = await setup();
  try {
    const task = original(f), legacy = f.store.create({ role: 'agent', goal: 'no Input' });
    const numbered = f.store.appendMessage(task.id, '{"notice_id":123,"answer":"user text, not a Notice reply"}');
    const old = f.store.message(task.id, 'old unproven Hook or plan body');
    f.store.event(task.id, 'message', { sender: null, message_id: old });
    const eventNumber = f.store.message(task.id, 'old numbered event');
    f.store.event(task.id, 'message', { sender: null, message_id: eventNumber, append_number: 'A1-99' });
    f.project.message(legacy.id, 'explicit unnumbered user');
    const unnumbered = f.store.unread(legacy.id)[0].id;
    const excluded = [f.store.message(task.id, 'ambiguous sender null'), f.store.message(task.id, '{"notice_id":123,"answer":"real reply"}'),
      f.store.message(task.id, 'Worker communication', legacy.id), f.store.signal(task.id, null, 'system.done', 'system-key', 'system body').id, old];
    // Routing/buffering Events also occur for runtime opt-outs, so neither proves user input.
    f.store.event(task.id, 'task.input_routed', { message_id: old, source: 'default' });
    f.store.event(task.id, 'task.input_buffered', { message_id: old });
    const ambiguous = f.store.message(task.id, 'old null append number');
    f.store.event(task.id, 'message', { sender: null, message_id: ambiguous, append_number: null });
    const columnOptOut = f.store.appendMessage(task.id, 'numbered but explicitly not user input');
    f.store.event(task.id, 'message', { sender: null, message_id: columnOptOut, user_append: false });
    const eventOptOut = f.store.message(task.id, 'numbered Event opt-out');
    f.store.event(task.id, 'message', { sender: null, message_id: eventOptOut, append_number: 'A1-100', user_append: false });
    // Conflicting user proof cannot override a durable opt-out.
    f.store.event(task.id, 'message', { sender: null, message_id: eventOptOut, user_append: true });
    excluded.push(ambiguous, columnOptOut, eventOptOut);
    // Cross-Worker, wrong type, missing explicit sender, opt-out and malformed Events do not establish provenance.
    f.store.event(legacy.id, 'message', { sender: null, message_id: excluded[0] });
    f.store.event(task.id, 'message', { sender: null, message_id: String(excluded[0]) });
    f.store.event(task.id, 'message', { message_id: excluded[0] });
    f.store.event(task.id, 'notice.answered', { sender: null, message_id: excluded[1] });
    f.store.event(task.id, 'message', { sender: null, message_id: excluded[1], user_append: false });
    f.store.run('INSERT INTO events(task_id,type,data) VALUES (?,?,?)', task.id, 'message', 'invalid JSON');
    f.project.message(task.id, 'Hook message', null, false);
    f.project.message(legacy.id, 'unnumbered Hook', null, false);
    excluded.push(...f.store.all("SELECT id FROM messages WHERE body IN ('Hook message','unnumbered Hook')").map(row => row.id));
    const snapshot = f.store.all('SELECT * FROM messages');
    const events = f.store.all('SELECT * FROM events');
    const page = await f.call('input.history', { modes: ['append'] });
    expect(page.items.map(item => item.id).sort((a, b) => a - b)).toEqual([numbered, eventNumber, unnumbered].sort((a, b) => a - b));
    expect(f.project.inputGet('message', eventNumber).append_number).toBe('A1-99');
    expect(f.project.inputGet('message', unnumbered)).toMatchObject({ mode: 'append', task_id: legacy.id, append_number: null, references: [] });
    expect(f.project.inputGet('message', numbered)).toMatchObject({ id: numbered, task_id: task.id, task_worker_number: task.worker_number, references: [] });
    for (const id of excluded) await expect(f.call('input.get', { kind: 'message', id })).rejects.toThrow('not found');
    const reopened = new Store(path.join(f.config.home, 'project.db'), f.root);
    try { expect(reopened.inputHistoryItem('message', unnumbered).mode).toBe('append'); } finally { reopened.close(); }
    expect(f.store.all('SELECT * FROM messages')).toEqual(snapshot);
    expect(f.store.all('SELECT * FROM events')).toEqual(events);
  } finally { await f.close(); }
});

test('sent unified append drafts deduplicate their real Messages; conditional remains draft-only and modes bind its cursor', async () => {
  const f = await setup();
  try {
    const task = (await f.call('order.submit', { content: 'order body', start: false })).task, ids = [];
    for (let i = 0; i < 3; i++) {
      const d = await f.call('draft.add', { content: `sent append ${i}`, mode: 'append', target_id: task.id, conditions: [{ kind: 'parent_quiet' }] });
      const messageId = f.store.appendMessage(task.id, d.content); ids.push(d.id);
      f.store.run('UPDATE drafts SET emission=? WHERE id=?', JSON.stringify({ state: 'succeeded', message_id: messageId, worker_id: task.id,
        signals: [{ kind: 'parent_quiet', satisfied: true }] }), d.id);
      expect(f.project.inputGet('message', messageId).mode).toBe('append');
    }
    expect(f.project.inputHistory({ modes: ['append'] }).items.map(item => item.kind)).toEqual(['draft','draft','draft']);
    expect(f.project.inputHistory({ modes: ['order'] }).items.map(item => item.kind)).toEqual(['input']);
    const page = f.project.inputHistory({ conditional: 'mounted', modes: ['append'], limit: 1 });
    expect(page.items[0].kind).toBe('draft'); expect(page.next_cursor).not.toBeNull();
    expect(() => f.project.inputHistory({ conditional: 'mounted', modes: ['order'], cursor: page.next_cursor })).toThrow('changed filters');
    expect(f.project.inputHistory({ conditional: 'mounted', modes: ['management'] }).items).toEqual([]);
    expect(f.project.inputHistory({ conditional: 'configured', modes: ['append'] }).items.map(item => item.id).sort()).toEqual(ids.sort());
    // An unrelated Message with identical text is not deduplicated by text or sender.
    f.store.appendMessage(task.id, 'sent append 0');
    expect(f.project.inputHistory({ modes: ['append'], q: 'sent append 0' }).items.map(item => item.kind).sort()).toEqual(['draft','message']);
  } finally { await f.close(); }
});

test('management history only accepts immediate input origins, safely exposes real Valet identity and retains user-only RPC validation', async () => {
  const f = await setup();
  try {
    const manager = (await f.call('management.submit', { instruction: 'immediate management input', client_request_id: 'history-request' })).task;
    const state = JSON.parse(f.store.task(manager.id).management);
    f.store.update(manager.id, { management: JSON.stringify({ ...state, private_marker: 'DO_NOT_EXPOSE', profile: { token: 'DO_NOT_EXPOSE' } }) });
    const signal = f.store.create({ role: 'manager', task_kind: 'management', goal: 'scheduled manager' });
    f.store.update(signal.id, { management: JSON.stringify({ origin: 'signal', instruction: 'DO_NOT_EXPOSE' }) });
    const unknown = f.store.create({ role: 'manager', task_kind: 'management', goal: 'unknown origin' });
    const wrong = original(f, 'not a manager');
    f.store.update(wrong.id, { management: JSON.stringify({ origin: 'input' }) });
    const history = await f.call('input.history', { modes: ['management'] });
    expect(history.items).toHaveLength(1);
    expect(history.items[0]).toMatchObject({ kind: 'management', id: manager.id, mode: 'management', task_id: manager.id, task_worker_number: manager.worker_number });
    const detail = await f.call('input.get', { kind: 'management', id: manager.id });
    expect(detail).toMatchObject({ content: manager.goal, references: [], revision: null });
    expect(JSON.stringify([history, detail])).not.toContain('DO_NOT_EXPOSE');
    for (const id of [signal.id, unknown.id, wrong.id]) await expect(f.call('input.get', { kind: 'management', id })).rejects.toThrow('not found');
    for (const modes of [null, 'order', {}, true, ['order','order'], ['append','alien'], [''], [null], [1]])
      await expect(f.call('input.history', { modes })).rejects.toThrow('modes');
    for (const kind of ['message','management']) expect(() => assertAllowed('input.get', { kind, id: manager.id }, wrong.id)).toThrow('requires user approval');
    expect(() => assertAllowed('input.history', { modes: ['management'] }, wrong.id)).toThrow('requires user approval');
    const orphan = f.store.nextInputId(); f.store.run('INSERT INTO inputs(id,content,task_id) VALUES (?,?,?)', orphan, 'orphan Input', 99999);
    expect(f.project.inputHistory({ modes: ['order'], q: 'orphan Input' }).items[0]).toMatchObject({ kind: 'input', id: orphan, mode: 'order', status: 'unknown' });
  } finally { await f.close(); }
});
