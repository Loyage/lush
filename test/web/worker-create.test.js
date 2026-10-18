import { test, expect } from 'bun:test';
import { repo } from '../helpers.js';
import { fetch, setup } from './harness.js';

test('real HTTP/RPC append-first draft -> Input/O -> exact source dispatch roundtrip, with wrong-target evidence rejected', async () => {
  const f = await setup(); f.project.kick = () => {}; await repo(f.root);
  const get = async route => { const response = await fetch(f.url + route); expect(response.status).toBe(200); return response.json(); };
  const post = async (method, params) => {
    const response = await fetch(f.url + '/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, params }) });
    expect(response.status).toBe(200); return response.json();
  };
  try {
    const { task } = await post('worker.create', { mode: 'spawn' });
    const draft = await post('draft.add', { content: 'first append-first instruction', mode: 'append', target_id: task.id,
      conditions: [] });
    await post('input.emit', { draft_id: draft.id, expected_revision: draft.revision, client_request_id: 'http-first-source' });
    await f.project.drainInputEmissions();
    const dispatched = await get(`/api/input/draft/${draft.id}`);
    expect(dispatched.dispatch).toMatchObject({ state: 'succeeded', worker_id: task.id });
    const original = await get(`/api/input/input/${dispatched.dispatch.input_id}`);
    expect(original).toMatchObject({ kind: 'input', mode: 'order', source_draft_id: draft.id, task_id: task.id });
    const history = await get('/api/inputs?view=history&q=append-first');
    expect(history.items).toHaveLength(1); expect(history.items[0].source_draft_id).toBe(draft.id);
    const source = await get(`/api/input/draft/${original.source_draft_id}`);
    expect(source).toMatchObject({ mode: 'append', target_id: task.id,
      dispatch: { state: 'succeeded', input_id: original.id, worker_id: task.id } });
    expect(source.conditions).toEqual([]);
    f.store.run("UPDATE drafts SET input_options=json_set(input_options,'$.target_id',?) WHERE id=?", task.parent_id, draft.id);
    expect((await get(`/api/input/input/${original.id}`)).source_draft_id).toBeNull();
    expect((await get('/api/inputs?view=history&q=append-first')).items[0].source_draft_id).toBeNull();
  } finally { await f.close(); }
});

test('Web user action creates a paused container and inspect/workers expose safe creation metadata without phantom Input', async () => {
  const f = await setup(); f.project.kick = () => {}; await repo(f.root);
  const action = (method, params) => fetch(f.url + '/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, params }) });
  try {
    const response = await action('worker.create', { mode: 'spawn', title: '新工作' }); expect(response.status).toBe(200);
    const made = await response.json();
    expect(made.task).toMatchObject({ status: 'paused', input_id: null, goal: '', calls: 0,
      creation: { mode: 'spawn', waiting_first_input: true, session_inherited: false } });
    const detail = await (await fetch(f.url + `/api/worker/${made.task.id}`)).json();
    expect(detail.creation).toEqual(made.task.creation); expect(detail.session_fork).toBeUndefined();
    const overview = await (await fetch(f.url + '/api/overview')).json();
    expect(overview.tasks.find(t => t.id === made.task.id).creation).toEqual(made.task.creation);
    expect((await action('worker.resume', { id: made.task.id })).status).toBe(400);
    const first = await action('worker.message', { id: made.task.id, body: '第一条真实指令' }); expect(first.status).toBe(200);
    const started = await first.json(); expect(started.input_id).toBeGreaterThan(0);
    expect(started.creation.waiting_first_input).toBe(false);
    const before = f.store.tasks().length;
    const fork = await action('worker.create', { mode: 'fork', source: made.task.id }); expect(fork.status).toBe(400);
    expect(JSON.stringify(await fork.json())).toContain('fork 无法继承会话');
    expect(f.store.tasks()).toHaveLength(before);
    expect((await action('worker.create', { mode: 'spawn', _token: 'not-a-user' })).status).toBe(400);
  } finally { await f.close(); }
});
