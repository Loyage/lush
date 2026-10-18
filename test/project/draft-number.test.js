import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { Database } from 'bun:sqlite';
import { Store } from '../../src/persistence/store.js';
import { temp, fixture, repo } from '../helpers.js';
import { Dispatcher } from '../../src/rpc/protocol.js';
import { assertAllowed } from '../../src/rpc/registry.js';

test('nullable display numbers never backfill old identities and keep their own high-water mark across deletion and reopen', () => {
  const root = temp(), file = path.join(root, 'old.db'); let store;
  const db = new Database(file);
  db.exec(`CREATE TABLE drafts (id INTEGER PRIMARY KEY,content TEXT NOT NULL,input_id INTEGER,created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
    INSERT INTO drafts VALUES (90,'old draft',NULL,'2020-01-01T00:00:00Z');`);
  const old = db.query('SELECT * FROM drafts').get(); db.close();
  try {
    store = new Store(file, root);
    expect(store.draft(90)).toMatchObject({ ...old, draft_number: null, revision: null, parent_id: null });
    expect(store.get("SELECT value FROM meta WHERE key='draft_number_high'")).toBeNull();
    const direct = store.addDraft('internal emission'); expect(direct).toMatchObject({ id: 91, draft_number: null });
    const first = store.addDraft('first manual', { numbered: true }); expect(first).toMatchObject({ id: 92, draft_number: 1 });
    expect(store.updateDraft(first.id, 'updated').draft_number).toBe(1);
    store.run('DELETE FROM drafts WHERE id=?', first.id); store.close(); store = new Store(file, root);
    const second = store.addDraft('second manual', { numbered: true }); expect(second).toMatchObject({ id: 93, draft_number: 2 });
    expect(store.draft(90)).toMatchObject({ ...old, draft_number: null });
    expect(() => store.run('UPDATE drafts SET draft_number=2 WHERE id=91')).toThrow();
    store.run('DELETE FROM drafts'); store.close(); store = new Store(file, root);
    expect(store.addDraft('after all rows deleted', { numbered: true })).toMatchObject({ id: 94, draft_number: 3 });
  } finally { store?.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('manual buffering alone allocates numbers; condition signals and emission receipts retain internal identities', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  const call = (method, params) => new Dispatcher(f.project).dispatch(method, params);
  f.project.scheduleInputEmissions = () => {};
  try {
    const direct = await call('input.emit', { content: 'direct work', client_request_id: 'direct-draft-number' });
    expect(direct).toMatchObject({ draft_id: 1, draft_number: null });
    expect(await call('input.emit', { content: 'direct work', client_request_id: 'direct-draft-number' })).toEqual(direct);
    const first = await call('draft.add', { content: 'manual work', conditions: [{ kind: 'parent_quiet' }] });
    expect(first).toMatchObject({ id: 2, draft_number: 1 });
    const sent = await call('input.emit', { draft_id: first.id, expected_revision: first.revision });
    expect(sent).toMatchObject({ draft_id: 2, draft_number: 1 });
    expect(f.project.inputGet('draft', first.id)).toMatchObject({ id: 2, draft_number: 1, dispatch: { state: 'waiting_conditions' } });
    const hooks = JSON.parse(f.store.task(first.parent_id).hooks).mounts.filter(mount => mount.input_signal);
    expect(hooks).toHaveLength(1); expect(hooks[0].input_signal.draft_id).toBe(first.id);
    expect(hooks[0].actions[0].draft_id).toBe(first.id);
    const next = await call('draft.add', { content: 'next manual' }); expect(next).toMatchObject({ id: 3, draft_number: 2 });
    await call('draft.remove', { id: next.id, expected_revision: next.revision });
    expect(await call('draft.add', { content: 'not reused' })).toMatchObject({ id: 4, draft_number: 3 });
    for (const method of ['draft.add', 'draft.update', 'input.emit']) {
      expect(() => assertAllowed(method, {}, { id: first.parent_id })).toThrow('user approval');
      expect(() => assertAllowed(method, { draft_number: 99 }, null)).toThrow('unknown parameter');
      expect(() => assertAllowed(method, { numbered: false }, null)).toThrow('unknown parameter');
    }
    expect(f.store.all('SELECT * FROM inputs')).toHaveLength(0); expect(f.store.all('SELECT * FROM agent_runs')).toHaveLength(0);
  } finally { await f.close(); }
});
