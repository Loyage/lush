import { test, expect } from 'bun:test';
import { fixture, repo } from '../helpers.js';
import { Dispatcher } from '../../src/rpc/protocol.js';
import { assertAllowed } from '../../src/rpc/registry.js';

async function setup() {
  const f = fixture(); f.project.stopping = true; f.project.kick = () => {};
  f.project.scheduleInputEmissions = () => {};
  await repo(f.root); await f.project.ensureMainTask(); return f;
}
const read = (f, params = {}) => new Dispatcher(f.project).dispatch('input.history', params);
const stamp = '2020-01-01T00:00:00.000Z';
const key = row => `${row.kind}:${row.id}`;
function receipt(f, draft, state, extra = {}) {
  f.store.run('UPDATE drafts SET emission=? WHERE id=?', JSON.stringify({ state, signals: [], ...extra }), draft.id);
}

test('history and drafts partition before filtering; every unsent state remains and successful receipts stay addressable', async () => {
  const f = await setup();
  try {
    const target = (await f.project.order('actual original', 'main', [], null, false)).task;
    const expected = [];
    for (const mode of ['order', 'append']) {
      for (const state of [null, 'cancelled', 'waiting_conditions', 'queued', 'dispatching', 'failed', 'unknown']) {
        const draft = await f.project.addBufferedDraft(`not sent ${mode} ${state}`, [], 'main', mode === 'append' ? { mode, target_id: target.id } : {});
        if (state) receipt(f, draft, state);
        expected.push(key(draft));
      }
      const sent = await f.project.addBufferedDraft(`sent ${mode}`, [], 'main', mode === 'append' ? { mode, target_id: target.id } : {});
      receipt(f, sent, 'succeeded');
      expect(f.project.inputGet('draft', sent.id).dispatch.state).toBe('succeeded');
    }
    const history = await read(f);
    expect(history.items.map(key)).toEqual([`input:${target.input_id}`]);
    expect(history).toEqual(await read(f, { view: 'history' }));
    expect(history.items[0].source_draft_id).toBeNull();
    expect((await read(f, { status: 'draft' })).items).toEqual([]);
    const drafts = (await read(f, { view: 'drafts' })).items;
    expect(new Set(drafts.map(key))).toEqual(new Set(expected));
    expect((await read(f, { view: 'drafts', modes: ['append'] })).items).toHaveLength(7);
    expect((await read(f, { view: 'drafts', modes: ['order'] })).items).toHaveLength(7);
    expect((await read(f, { view: 'drafts', modes: ['management'] })).items).toEqual([]);
    expect((await read(f, { view: 'drafts', q: 'unknown', status: 'unknown_dispatch' })).items).toHaveLength(2);
    for (const view of [null, '', 'all', [], 1, false]) await expect(read(f, { view })).rejects.toThrow('view must be history or drafts');
    for (const view of ['history', 'drafts']) for (const conditional of ['mounted', 'configured'])
      await expect(read(f, { view, conditional })).rejects.toThrow('view and conditional cannot be combined');
    for (const view of [undefined, 'history', 'drafts']) {
      expect(() => assertAllowed('input.history', { ...(view ? { view } : {}) }, 17)).toThrow('requires user approval');
      expect(() => assertAllowed('input.history', { ...(view ? { view } : {}) }, null)).not.toThrow();
    }
    await expect(read(f, { view: 'drafts', alien: true })).rejects.toThrow('unknown parameter');
  } finally { await f.close(); }
});

test('history uses real message identity and timestamp, strict provenance and unique durable source links, never body matching', async () => {
  const f = await setup();
  try {
    const target = (await f.project.order('original', 'main', [], null, false)).task;
    const draft = await f.project.addBufferedDraft('same body', [], 'main', { mode: 'append', target_id: target.id });
    f.store.run('UPDATE drafts SET created_at=? WHERE id=?', stamp, draft.id);
    f.project.message(target.id, 'same body');
    const message = f.store.get('SELECT * FROM messages ORDER BY id DESC LIMIT 1');
    receipt(f, draft, 'succeeded', { message_id: message.id, worker_id: target.id });
    const item = f.project.inputGet('message', message.id);
    expect(item).toMatchObject({ kind: 'message', id: message.id, created_at: message.created_at, source_draft_id: draft.id, append_number: message.append_number });
    expect((await read(f, { modes: ['append'] })).items).toMatchObject([{ kind: 'message', id: message.id, source_draft_id: draft.id }]);
    expect((await read(f, { view: 'drafts' })).items).toEqual([]);
    // Even an unknown state with an actual trusted Message is no longer an unsent draft.
    receipt(f, draft, 'unknown', { message_id: message.id, worker_id: target.id });
    expect((await read(f, { view: 'drafts' })).items).toEqual([]);
    const same = await f.project.addBufferedDraft('same body', [], 'main', { mode: 'append', target_id: target.id });
    expect(f.project.inputGet('message', message.id).source_draft_id).toBe(draft.id);
    receipt(f, same, 'succeeded', { message_id: message.id, worker_id: target.id });
    expect(f.project.inputGet('message', message.id).source_draft_id).toBeNull();
    const orderDraft = await f.project.addBufferedDraft('source original');
    const original = await f.project.submitBufferedDraft(orderDraft.id, 1, false);
    expect(f.project.inputGet('input', original.id).source_draft_id).toBe(orderDraft.id);
    const duplicate = f.store.addDraft('different body');
    f.store.run('UPDATE drafts SET input_id=? WHERE id=?', original.id, duplicate.id);
    expect(f.project.inputGet('input', original.id).source_draft_id).toBeNull();
    // Wrong target, JSON string IDs, contradictory worker and body equality prove nothing.
    for (const [options, emission] of [
      [{ mode: 'append', target_id: target.id + 999 }, { message_id: message.id }],
      [{ mode: 'append', target_id: target.id }, { message_id: String(message.id) }],
      [{ mode: 'append', target_id: String(target.id) }, { message_id: message.id }],
      [{ mode: 'append', target_id: target.id }, { message_id: message.id, worker_id: target.id + 1 }],
    ]) {
      f.store.run('UPDATE drafts SET input_options=?,emission=? WHERE id IN (?,?)', JSON.stringify(options), JSON.stringify({ state: 'unknown', signals: [], ...emission }), draft.id, same.id);
      expect(f.project.inputGet('message', message.id).source_draft_id).toBeNull();
    }
    const candidates = [];
    function add(body, event = null, extra = {}) {
      const id = f.store.message(target.id, body, extra.sender ?? null);
      if (event) f.store.event(target.id, 'message', { message_id: id, sender: null, ...event });
      if (extra.number) f.store.run('UPDATE messages SET append_number=? WHERE id=?', extra.number, id);
      if (extra.signal) f.store.run('UPDATE messages SET signal_type=? WHERE id=?', 'hook', id);
      candidates.push({ id, allowed: extra.allowed === true }); return id;
    }
    add('no provenance'); add('{"user_append":true}'); add('legacy null sender', {});
    add('null number', { append_number: null }); add('string message id', { message_id: '999', user_append: true });
    add('explicit user event', { user_append: true }, { allowed: true });
    add('old numbered event', { append_number: 'A-old' }, { allowed: true });
    add('durable number', null, { number: 'A-durable', allowed: true });
    const denied = add('false wins', { user_append: false }, { number: 'A-conflict' });
    f.store.event(target.id, 'message', { message_id: denied, sender: null, user_append: true });
    add('worker sender', { user_append: true }, { sender: target.id });
    add('system signal', { user_append: true }, { signal: true });
    const foreign = add('foreign event');
    f.store.event(original.task.id, 'message', { message_id: foreign, sender: null, user_append: true });
    const ids = new Set((await read(f, { modes: ['append'], limit: 100 })).items.map(row => row.id));
    for (const candidate of candidates) {
      expect(ids.has(candidate.id)).toBe(candidate.allowed);
      if (!candidate.allowed) expect(() => f.project.inputGet('message', candidate.id)).toThrow('not found');
    }
  } finally { await f.close(); }
});

test('whole-database SQL pagination binds view and complete normalized filters and keeps same-time cross-kind identities', async () => {
  const f = await setup();
  try {
    // More history than the overview window; no task is needed to retain an original Input.
    f.store.transaction(() => {
      for (let i = 1; i <= 235; i++) {
        const id = f.store.nextInputId();
        f.store.run('INSERT INTO inputs(id,content,created_at) VALUES (?,?,?)', id, `old search ${i}`, stamp);
      }
    });
    const target = (await f.project.order('target', 'main', [], null, false)).task;
    for (let i = 0; i < 8; i++) f.project.message(target.id, `old search message ${i}`);
    await f.project.addBufferedDraft('old search unsent');
    const manager = f.project.submitManagementInstruction({ instruction: 'old search management' }).task;
    f.store.run('UPDATE inputs SET created_at=?', stamp); f.store.run('UPDATE messages SET created_at=?', stamp);
    f.store.run('UPDATE tasks SET created_at=? WHERE id=?', stamp, manager.id);
    const expected = (await read(f, { q: 'search', limit: 100 })).items;
    const keys = [], pages = []; let cursor;
    do {
      const page = await read(f, { q: 'search', limit: 13, ...(cursor ? { cursor } : {}) });
      keys.push(...page.items.map(key)); pages.push(page); cursor = page.next_cursor;
    } while (cursor);
    expect(keys).toHaveLength(244); expect(new Set(keys).size).toBe(244);
    expect(keys.slice(0, 100)).toEqual(expected.map(key));
    expect(keys.some(k => k.startsWith('draft:'))).toBe(false);
    const first = pages[0].next_cursor;
    expect((await read(f, { q: 'search', cursor: first, view: 'history', modes: ['management', 'append', 'order'] })).items.length).toBeGreaterThan(0);
    for (const changed of [{ view: 'drafts' }, { conditional: 'configured' }, { q: 'old' }, { status: 'unknown' }, { integration: 'none' }, { modes: ['order'] }])
      await expect(read(f, { q: 'search', cursor: first, ...changed })).rejects.toThrow('changed filters');
    for (const cursor of ['', '!', Buffer.from('{}').toString('base64url'), 1, null])
      await expect(read(f, { cursor })).rejects.toThrow('cursor');
    const onlyOld = await read(f, { q: 'old search 235', status: 'unknown', modes: ['order'] });
    expect(onlyOld.items).toMatchObject([{ kind: 'input', id: 235, content: 'old search 235', status: 'unknown' }]);
    const longId = f.store.nextInputId(), longBody = 'x'.repeat(1200) + 'needle outside preview';
    f.store.run('INSERT INTO inputs(id,content) VALUES (?,?)', longId, longBody);
    expect((await read(f, { q: 'needle outside preview' })).items).toMatchObject([{ id: longId, content: 'x'.repeat(1000), content_truncated: true }]);
    expect(f.project.inputGet('input', longId).content).toBe(longBody);
  } finally { await f.close(); }
});

test('draft and conditional cursors cannot cross views, retain SQL filtering, and reads never rewrite persisted facts', async () => {
  const f = await setup();
  try {
    for (let i = 0; i < 5; i++) {
      const draft = await f.project.addBufferedDraft(`conditional ${i}`, [], 'main', { conditions: [{ kind: 'parent_quiet' }] });
      await f.project.emitBufferedInput({ draft_id: draft.id, expected_revision: draft.revision });
    }
    const snapshot = () => JSON.stringify(['inputs', 'messages', 'drafts', 'tasks', 'events'].map(table => f.store.all(`SELECT * FROM ${table} ORDER BY id`)));
    const before = snapshot();
    for (const selector of [{ view: 'drafts' }, { conditional: 'configured' }, { conditional: 'mounted' }]) {
      const first = await read(f, { ...selector, limit: 2, q: 'conditional', modes: ['order'] });
      expect(first.items).toHaveLength(2); expect(first.next_cursor).not.toBeNull();
      const second = await read(f, { ...selector, limit: 2, q: 'conditional', modes: ['order'], cursor: first.next_cursor });
      expect(new Set([...first.items, ...second.items].map(key)).size).toBe(4);
      for (const other of [{ view: 'history' }, { view: 'drafts' }, { conditional: 'configured' }, { conditional: 'mounted' }]) {
        if (JSON.stringify(other) !== JSON.stringify(selector))
          await expect(read(f, { ...other, q: 'conditional', modes: ['order'], cursor: first.next_cursor })).rejects.toThrow('changed filters');
      }
      expect((await read(f, { ...selector, q: 'conditional 0', status: 'waiting_conditions', modes: ['order'] })).items).toHaveLength(1);
      expect((await read(f, { ...selector, modes: [] })).items).toEqual([]);
      for (const row of first.items) expect(f.project.inputGet('draft', row.id).source_draft_id).toBeNull();
    }
    expect(snapshot()).toBe(before);
  } finally { await f.close(); }
});
