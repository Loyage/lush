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
    expect((await get('/api/inputs?view=drafts&q=search&status=draft&integration=none&limit=1')).body.items[0].id).toBe(d.id);
    expect((await get('/api/inputs')).body.items).toEqual([]);
    expect((await get('/api/inputs?view=history')).body.items).toEqual([]);
    const updated = await post('draft.update', { id: d.id, content: 'updated snapshot', expected_revision: 1 });
    expect(updated.body.revision).toBe(2);
    expect((await post('draft.remove', { id: d.id, expected_revision: 1 })).status).toBe(400);
    const sent = await post('order.submit', { draft_id: d.id, expected_revision: 2, start: false });
    expect(sent.status).toBe(200); expect(sent.body.task.status).toBe('paused');
    expect((await get(`/api/input/input/${sent.body.id}`)).body).toMatchObject({ status: 'created', content: 'updated snapshot', source_draft_id: d.id, references: [] });
    expect((await get('/api/inputs')).body.items).toMatchObject([{ kind: 'input', source_draft_id: d.id }]);
    expect((await get('/api/inputs?view=drafts')).body.items).toEqual([]);
    expect((await post('worker.message', { id: sent.body.task.id, body: 'HTTP ordinary append' })).status).toBe(200);
    const message = f.store.get('SELECT id,append_number FROM messages WHERE task_id=? ORDER BY id DESC LIMIT 1', sent.body.task.id);
    const manager = await post('management.submit', { instruction: 'HTTP immediate management' });
    expect(manager.status).toBe(200);
    const queryModes = modes => '/api/inputs?modes=' + encodeURIComponent(JSON.stringify(modes));
    expect((await get(queryModes([]))).body).toEqual({ items: [], next_cursor: null });
    expect((await get(queryModes(['order']))).body.items.map(item => item.kind)).toEqual(['input']);
    expect((await get(queryModes(['append']))).body.items).toMatchObject([{ kind: 'message', mode: 'append', id: message.id, task_id: sent.body.task.id, append_number: message.append_number }]);
    expect((await get(queryModes(['management']))).body.items).toMatchObject([{ kind: 'management', mode: 'management', id: manager.body.task.id, task_worker_number: manager.body.task.worker_number }]);
    expect((await get(`/api/input/message/${message.id}`)).body).toMatchObject({ content: 'HTTP ordinary append', references: [] });
    expect((await get(`/api/input/management/${manager.body.task.id}`)).body).toMatchObject({ content: 'HTTP immediate management', references: [] });
    for (const value of ['bad','null','"append"','{}','["alien"]','["append","append"]','[null]'])
      expect((await get('/api/inputs?modes=' + encodeURIComponent(value))).status).toBe(400);
    expect((await get(queryModes(['order']) + '&modes=%5B%5D')).status).toBe(400);
    for (const kind of ['message','management']) {
      expect((await get(`/api/input/${kind}/99999`)).status).toBe(400);
      expect((await get(`/api/input/${kind}/1?extra=1`)).status).toBe(400);
    }
    const runtime = f.store.message(sent.body.task.id, 'runtime, not input');
    expect((await get(`/api/input/message/${runtime}`)).status).toBe(400);
    expect((await get(`/api/input/draft/${d.id}`)).status).toBe(400);
    expect((await post('order.submit', { draft_id: d.id, expected_revision: 2 })).status).toBe(400);
    const conditional = (await post('draft.add', { content: 'conditional draft', conditions: [{ kind: 'parent_quiet' }] })).body;
    expect((await get('/api/inputs?conditional=configured&limit=1')).body.items.map(item => item.id)).toEqual([conditional.id]);
    expect((await get('/api/inputs?conditional=mounted')).body.items).toEqual([]);
    expect((await post('input.emit', { draft_id: conditional.id, expected_revision: conditional.revision })).status).toBe(200);
    expect((await get('/api/inputs?conditional=mounted')).body.items[0]).toMatchObject({ id: conditional.id, kind: 'draft', dispatch: { state: 'waiting_conditions' } });
    const second = (await post('draft.add', { content: 'delete me' })).body;
    expect((await post('draft.remove', { id: second.id, expected_revision: second.revision })).status).toBe(200);
    for (const path of ['/api/inputs?view=all','/api/inputs?view=','/api/inputs?view=drafts&view=history','/api/inputs?view=history&conditional=configured','/api/inputs?view=drafts&conditional=mounted','/api/inputs?conditional=all','/api/inputs?conditional=configured&conditional=mounted','/api/inputs?status=all','/api/inputs?limit=0','/api/inputs?q=x&q=y','/api/inputs?alien=1','/api/input-parents?extra=1',`/api/input/input/${sent.body.id}?extra=1`]) expect((await get(path)).status).toBe(400);
    expect((await get('/api/input/task/1')).status).toBe(404);
    expect((await post('draft.commit', {})).status).toBe(400);
    expect((await post('input.submit', { content: 'old' })).status).toBe(400);
    expect((await post('draft.add', { content: 'bad', _token: 'agent' })).status).toBe(400);
  } finally { await f.close(); }
});
