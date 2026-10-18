import { test, expect } from 'bun:test';
import { repo } from '../helpers.js';
import { fetch, setup } from './harness.js';

test('HTTP draft save, edit and submit produces a readable original Input', async () => {
  const f = await setup(); f.project.stopping = true; await repo(f.root);
  const get = async path => (await fetch(f.url + path)).json();
  const post = async (method, params) => {
    const response = await fetch(f.url + '/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, params }) });
    expect(response.status).toBe(200); return response.json();
  };
  try {
    const draft = await post('draft.add', { content: 'buffered search me' });
    expect((await get('/api/inputs?view=drafts&q=search')).items[0].id).toBe(draft.id);
    expect((await get(`/api/input/draft/${draft.id}`)).content).toBe('buffered search me');
    expect((await get('/api/input-parents')).items[0].id).toBe(draft.parent_id);
    const updated = await post('draft.update', { id: draft.id, content: 'updated snapshot', expected_revision: draft.revision });
    expect(updated.revision).toBe(draft.revision + 1); expect(updated.draft_number).toBe(1);
    const sent = await post('order.submit', { draft_id: draft.id, expected_revision: updated.revision, start: false });
    expect(sent.task.status).toBe('paused');
    expect(await get(`/api/input/input/${sent.id}`)).toMatchObject({ content: 'updated snapshot', source_draft_id: draft.id });
    expect((await get('/api/inputs')).items).toMatchObject([{ kind: 'input', source_draft_id: draft.id }]);
    expect((await get('/api/inputs?view=drafts')).items).toEqual([]);
  } finally { await f.close(); }
});

test('real HTTP/RPC direct submit does not consume manual draft numbers and dispatch preserves source ids', async () => {
  const f = await setup(); f.project.stopping = true; await repo(f.root);
  f.project.kick = () => {}; f.project.scheduleInputEmissions = () => {};
  const get = async path => (await fetch(f.url + path)).json();
  const post = async (method, params) => {
    const response = await fetch(f.url + '/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, params }) });
    expect(response.status).toBe(200); return response.json();
  };
  try {
    const direct = await post('input.emit', { content: 'direct before manual', client_request_id: 'number-http-direct' });
    expect(direct).toMatchObject({ draft_id: 1, draft_number: null });
    const manual = await post('draft.add', { content: 'manual first' }); expect(manual).toMatchObject({ id: 2, draft_number: 1 });
    expect(await get(`/api/input/draft/${manual.id}`)).toMatchObject({ id: 2, draft_number: 1 });
    expect((await get('/api/inputs?view=drafts')).items).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'draft', id: 1, draft_number: null }), expect.objectContaining({ kind: 'draft', id: 2, draft_number: 1 }),
    ]));
    const sent = await post('input.emit', { draft_id: manual.id, expected_revision: manual.revision, client_request_id: 'number-http-manual' });
    expect(sent).toMatchObject({ draft_id: 2, draft_number: 1 });
    expect(await post('input.emit', { draft_id: manual.id, expected_revision: manual.revision, client_request_id: 'number-http-manual' })).toEqual(sent);
    const next = await post('draft.add', { content: 'manual next' }); expect(next).toMatchObject({ id: 3, draft_number: 2 });
    const directOrder = await post('order.submit', { content: 'direct via order' }); expect(directOrder).toMatchObject({ draft_id: 4, draft_number: null });
    await post('draft.remove', { id: next.id, expected_revision: next.revision });
    expect(await post('draft.add', { content: 'manual after deletion' })).toMatchObject({ id: 5, draft_number: 3 });
    f.project.stopping = false; await f.project.drainInputEmissions(); f.project.stopping = true;
    const receipt = await get(`/api/input/draft/${manual.id}`);
    expect(receipt).toMatchObject({ id: manual.id, draft_number: 1, dispatch: { state: 'succeeded' } });
    expect(await get(`/api/input/input/${receipt.input_id}`)).toMatchObject({ id: receipt.input_id, source_draft_id: manual.id });
    expect(f.store.draft(manual.id)).toMatchObject({ id: manual.id, draft_number: 1, input_id: receipt.input_id });
    expect(f.store.all('SELECT * FROM agent_runs')).toHaveLength(0);
    for (const params of [{ content: 'not allocated', draft_number: 77 }, { content: 'not suppressed', numbered: false }]) {
      const response = await fetch(f.url + '/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method: 'draft.add', params }) });
      expect(response.status).not.toBe(200);
    }
    expect(f.store.get("SELECT value FROM meta WHERE key='draft_number_high'").value).toBe('3');
  } finally { await f.close(); }
});
