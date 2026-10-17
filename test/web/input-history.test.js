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
    expect(updated.revision).toBe(draft.revision + 1);
    const sent = await post('order.submit', { draft_id: draft.id, expected_revision: updated.revision, start: false });
    expect(sent.task.status).toBe('paused');
    expect(await get(`/api/input/input/${sent.id}`)).toMatchObject({ content: 'updated snapshot', source_draft_id: draft.id });
    expect((await get('/api/inputs')).items).toMatchObject([{ kind: 'input', source_draft_id: draft.id }]);
    expect((await get('/api/inputs?view=drafts')).items).toEqual([]);
  } finally { await f.close(); }
});
