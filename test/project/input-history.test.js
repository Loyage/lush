import { test, expect, setDefaultTimeout } from 'bun:test';
import path from 'node:path';
import { Database } from 'bun:sqlite';
import { fixture, repo, git, gate, until } from '../helpers.js';
import { Store } from '../../src/persistence/store.js';
import { Dispatcher } from '../../src/rpc/protocol.js';
import { assertAllowed } from '../../src/rpc/registry.js';
setDefaultTimeout(15000);

const reference = { version: 1, kind: 'text', target: {}, label: 'quote', quote: 'saved selection', location: {}, captured_at: '2026-01-01T00:00:00.000Z' };
const setup = async () => { const f = fixture(); f.project.stopping = true; await repo(f.root); f.call = (method, params = {}) => new Dispatcher(f.project).dispatch(method, params); return f; };
function insert(f, content, status, calls = 1, integration = 'none', reservation = null) {
  return f.store.transaction(() => {
    const inputId = f.store.nextInputId();
    f.store.run('INSERT INTO inputs(id,content) VALUES (?,?)', inputId, content);
    const task = f.store.create({ input_id: inputId, role: 'agent', task_kind: 'order', goal: content });
    f.store.update(task.id, { status, calls, integration, reservation: reservation ? JSON.stringify(reservation) : null });
    f.store.run('UPDATE inputs SET task_id=? WHERE id=?', task.id, inputId);
    return { inputId, taskId: task.id };
  });
}

test('buffer remembers parent identity across branch switches, preserves references, and distinguishes creation from mounted default emission', async () => {
  const f = await setup();
  try {
    const d = await f.call('draft.add', { content: '  exact\nbody  ', references: [reference] });
    expect(d).toMatchObject({ kind: 'draft', revision: 1, status: 'draft', branch: 'main', references: [reference] });
    expect(f.store.all('SELECT * FROM inputs')).toHaveLength(0);
    expect(f.store.all('SELECT * FROM branches')).toHaveLength(0);
    await git(f.root, 'commit', '--allow-empty', '-m', 'new baseline');
    const next = await git(f.root, 'rev-parse', 'HEAD');
    await git(f.root, 'checkout', '-b', 'unbound');
    const edited = await f.call('draft.update', { id: d.id, content: d.content, expected_revision: 1 });
    expect(edited).toMatchObject({ parent_id: d.parent_id, branch: 'main', revision: 2, references: [reference] });
    const sent = await f.call('order.submit', { draft_id: d.id, expected_revision: 2, start: false });
    expect(sent.task).toMatchObject({ parent_id: d.parent_id, base_commit: next, status: 'paused', calls: 0 });
    expect(f.project.inputGet('input', sent.id)).toMatchObject({ content: d.content, status: 'created', references: [{ segment: 1, ...reference }] });
    await expect(f.call('order.submit', { draft_id: d.id, expected_revision: 2 })).rejects.toThrow('already submitted');
    const owner = await f.project.bindBranch('unbound', next);
    const another = await f.call('draft.add', { content: 'auto parent now unbound' });
    expect(another.parent_id).toBe(owner.id);
    const reassigned = await f.call('draft.update', { id: another.id, content: 'new parent', branch: 'main', references: [], expected_revision: 1 });
    expect(reassigned.parent_id).toBe(d.parent_id);
    const mounted = await f.call('order.submit', { draft_id: another.id, expected_revision: 2 });
    expect(mounted).toMatchObject({ emitted: true, draft_id: another.id, parent_id: d.parent_id, dispatch: { state: 'queued' } });
    expect(mounted.task).toBeUndefined();
    expect(f.project.inputGet('draft', another.id)).toMatchObject({ content: 'new parent', references: [], dispatch: { state: 'queued' } });
  } finally { await f.close(); }
});

test('draft start=false does not invoke an Agent; default start runs the normal order lifecycle', async () => {
  const f = fixture(); await repo(f.root);
  const call = (method, params) => new Dispatcher(f.project).dispatch(method, params);
  try {
    const d = await call('draft.add', { content: 'create only' });
    const paused = await call('order.submit', { draft_id: d.id, expected_revision: 1, start: false });
    const next = await call('draft.add', { content: 'actually run' });
    const mounted = await call('order.submit', { draft_id: next.id, expected_revision: 1 });
    expect(mounted.emitted).toBe(true);
    expect(mounted.task).toBeUndefined();
    await until(() => f.project.inputGet('draft', next.id).dispatch.state === 'succeeded');
    const dispatch = f.project.inputGet('draft', next.id).dispatch;
    await until(() => f.store.task(dispatch.worker_id).status === 'waiting');
    expect(f.store.task(dispatch.worker_id).calls).toBe(1);
    expect(f.store.task(paused.task.id)).toMatchObject({ status: 'paused', calls: 0 });
  } finally { await f.close(); }
});
