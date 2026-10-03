import { test, expect } from 'bun:test';
import { repo } from '../helpers.js';
import { fetch, setup } from './harness.js';

test('HTTP input history/detail/parent reads and versioned draft actions use task-centred RPC', async () => {
  const f = await setup(); f.project.stopping = true; await repo(f.root);
  const get = async path => { const response = await fetch(f.url + path); return { status: response.status, body: await response.json() }; };
  const post = async (method, params) => {
    const response = await fetch(f.url + '/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, params }) });
    return { status: response.status, body: await response.json() };
  };
  try {
    const added = await post('draft.add', { content: 'buffered search me' });
    expect(added.status).toBe(200);
    expect(added.body).toMatchObject({ kind: 'draft', revision: 1, branch: 'main', references: [] });
    const d = added.body;
    expect((await get(`/api/input/draft/${d.id}`)).body).toEqual(d);
    expect((await get('/api/input-parents')).body.items[0].id).toBe(d.parent_id);
    expect((await get('/api/inputs?q=search&status=draft&integration=none&limit=1')).body.items[0].id).toBe(d.id);
    const updated = await post('draft.update', { id: d.id, content: 'updated snapshot', expected_revision: 1 });
    expect(updated.body.revision).toBe(2);
    expect((await post('draft.remove', { id: d.id, expected_revision: 1 })).status).toBe(400);
    const sent = await post('order.submit', { draft_id: d.id, expected_revision: 2, start: false });
    expect(sent.status).toBe(200); expect(sent.body.task.status).toBe('paused');
    expect((await get(`/api/input/input/${sent.body.id}`)).body).toMatchObject({ status: 'created', content: 'updated snapshot', references: [] });
    expect((await get('/api/inputs')).body.items).toHaveLength(1);
    expect((await get(`/api/input/draft/${d.id}`)).status).toBe(400);
    expect((await post('order.submit', { draft_id: d.id, expected_revision: 2 })).status).toBe(400);
    const second = (await post('draft.add', { content: 'delete me' })).body;
    expect((await post('draft.remove', { id: second.id, expected_revision: second.revision })).status).toBe(200);
    for (const path of ['/api/inputs?status=all','/api/inputs?limit=0','/api/inputs?q=x&q=y','/api/inputs?alien=1','/api/input-parents?extra=1',`/api/input/input/${sent.body.id}?extra=1`]) expect((await get(path)).status).toBe(400);
    expect((await get('/api/input/task/1')).status).toBe(404);
    expect((await post('draft.commit', {})).status).toBe(400);
    expect((await post('input.submit', { content: 'old' })).status).toBe(400);
    expect((await post('draft.add', { content: 'bad', _token: 'agent' })).status).toBe(400);
  } finally { await f.close(); }
});
