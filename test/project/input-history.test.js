import { test, expect, setDefaultTimeout } from 'bun:test';
import { fixture, repo, git } from '../helpers.js';
import { Dispatcher } from '../../src/rpc/protocol.js';
setDefaultTimeout(15000);

const reference = { version: 1, kind: 'text', target: {}, label: 'quote', quote: 'saved selection', location: {}, captured_at: '2026-01-01T00:00:00.000Z' };

test('buffer preserves its parent and references through edit, create-only submission and mounted emission', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  const call = (method, params) => new Dispatcher(f.project).dispatch(method, params);
  try {
    const d = await call('draft.add', { content: '  exact\nbody  ', references: [reference] });
    expect(d).toMatchObject({ kind: 'draft', revision: 1, status: 'draft', branch: 'main', references: [reference] });
    expect(f.store.all('SELECT * FROM inputs')).toHaveLength(0);
    await git(f.root, 'commit', '--allow-empty', '-m', 'new baseline');
    const next = await git(f.root, 'rev-parse', 'HEAD');
    await git(f.root, 'checkout', '-b', 'unbound');
    const edited = await call('draft.update', { id: d.id, content: d.content, expected_revision: 1 });
    expect(edited).toMatchObject({ parent_id: d.parent_id, branch: 'main', revision: 2, references: [reference] });
    const sent = await call('order.submit', { draft_id: d.id, expected_revision: 2, start: false });
    expect(sent.task).toMatchObject({ parent_id: d.parent_id, base_commit: next, status: 'paused', calls: 0 });
    expect(f.project.inputGet('input', sent.id)).toMatchObject({ content: d.content, status: 'created', references: [{ segment: 1, ...reference }] });
    const another = await call('draft.add', { content: 'mounted work', branch: 'main' });
    const mounted = await call('order.submit', { draft_id: another.id, expected_revision: 1 });
    expect(mounted).toMatchObject({ emitted: true, draft_id: another.id, parent_id: d.parent_id, dispatch: { state: 'queued' } });
    expect(mounted.task).toBeUndefined();
  } finally { await f.close(); }
});
