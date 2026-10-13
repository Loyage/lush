import { test, expect } from 'bun:test';
import { fixture, repo } from '../helpers.js';
import { Dispatcher } from '../../src/rpc/protocol.js';

const conditionalOptions = { mode: 'order', conditions: [{ kind: 'parent_quiet' }], exclusive: false };

test('conditional history filters the full database before pagination and binds cursors to the exact view', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  const call = (method, params) => new Dispatcher(f.project).dispatch(method, params);
  try {
    const ordinary = await call('draft.add', { content: 'ordinary' });
    const exclusive = await call('draft.add', { content: 'exclusive', exclusive: true });
    for (let index = 0; index < 105; index++) {
      const draft = f.store.addDraft(`${'x'.repeat(1100)} searchable ${index}`);
      f.store.run('UPDATE drafts SET parent_id=?,revision=1,input_options=? WHERE id=?', ordinary.parent_id, JSON.stringify(conditionalOptions), draft.id);
    }
    f.store.run("UPDATE drafts SET created_at='2026-01-01T00:00:00Z'");
    let cursor, seen = [];
    do {
      const page = await call('input.history', { conditional: 'configured', limit: 13, ...(cursor ? { cursor } : {}) });
      seen.push(...page.items.map(item => item.id)); cursor = page.next_cursor;
      if (cursor && seen.length === 13) {
        for (const conditional of [undefined, 'mounted']) await expect(call('input.history', { cursor, ...(conditional ? { conditional } : {}) })).rejects.toThrow('changed filters');
        expect(page.items[0]).toMatchObject({ kind: 'draft', content_truncated: true, conditions: [{ kind: 'parent_quiet' }] });
      }
    } while (cursor);
    expect(seen).toHaveLength(106); expect(new Set(seen).size).toBe(106);
    expect(seen).toContain(exclusive.id); expect(seen).not.toContain(ordinary.id);
    expect((await call('input.history', { conditional: 'configured', q: 'searchable 0' })).items).toHaveLength(1);
    expect((await call('input.history', { conditional: 'mounted' })).items).toEqual([]);
    for (const conditional of [null, true, 'all', '']) await expect(call('input.history', { conditional })).rejects.toThrow('conditional');
  } finally { await f.close(); }
});

test('conditional mounted view retains successful order and append receipts, failure/unknown/cancelled without private authorization', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  const call = (method, params) => new Dispatcher(f.project).dispatch(method, params);
  try {
    const draft = await call('draft.add', { content: 'successful conditional order', ...conditionalOptions });
    const created = await call('order.submit', { draft_id: draft.id, expected_revision: draft.revision, start: false });
    const states = ['succeeded', 'waiting_conditions', 'dispatching', 'failed', 'unknown', 'cancelled'];
    const ids = [];
    for (const state of states) {
      const item = state === 'succeeded' ? draft : await call('draft.add', { content: state, ...conditionalOptions });
      ids.push(item.id);
      f.store.run('UPDATE drafts SET emission=? WHERE id=?', JSON.stringify({ state, signals: [{ kind: 'parent_quiet', satisfied: state === 'succeeded', snapshot: 'private' }],
        profile: { token: 'private-token' }, definition_hash: 'private-hash', ...(state === 'succeeded' ? { input_id: created.id, worker_id: created.task.id, worker_number: created.task.worker_number } : {}) }), item.id);
    }
    const append = await call('draft.add', { content: 'conditional append', mode: 'append', target_id: created.task.id, conditions: [{ kind: 'parent_quiet' }] });
    f.store.run('UPDATE drafts SET emission=? WHERE id=?', JSON.stringify({ state: 'succeeded', signals: [{ kind: 'parent_quiet', satisfied: true }], message_id: 123, append_number: 'A9-1' }), append.id);
    // An immediate, non-conditional emission must not leak into this feature.
    const immediate = await call('draft.add', { content: 'immediate' });
    f.store.run('UPDATE drafts SET emission=? WHERE id=?', JSON.stringify({ state: 'queued', signals: [] }), immediate.id);
    const page = await call('input.history', { conditional: 'mounted' });
    expect(page.items).toHaveLength(7); expect(page.items.every(item => item.kind === 'draft')).toBe(true);
    expect(page.items.find(item => item.id === draft.id).dispatch).toMatchObject({ state: 'succeeded', input_id: created.id, worker_id: created.task.id });
    expect(page.items.find(item => item.id === append.id)).toMatchObject({ mode: 'append', dispatch: { message_id: 123, append_number: 'A9-1' } });
    expect(page.items.find(item => item.id === append.id).dispatch.input_id).toBeUndefined();
    expect(JSON.stringify(page)).not.toContain('private');
    expect((await call('input.get', { kind: 'draft', id: draft.id })).dispatch.input_id).toBe(created.id);
    expect((await call('input.history', {})).items.filter(item => item.content === draft.content).map(item => item.kind)).toEqual(['input']);
    // The retained cancelled authorization remains auditable after its local options change.
    f.store.run('UPDATE drafts SET input_options=? WHERE id=?', JSON.stringify({ mode: 'order', conditions: [], exclusive: false }), ids.at(-1));
    expect((await call('input.history', { conditional: 'mounted' })).items.map(item => item.id)).toContain(ids.at(-1));
  } finally { await f.close(); }
});
