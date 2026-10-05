import { test, expect } from 'bun:test';
import { repo } from '../helpers.js';
import { fetch, setup } from './harness.js';

// Real HTTP -> RPC -> Project, with only temporary configuration and a mock execution backend.
test('creation profile reaches Worker through HTTP, Pi mode is sanitized and survives retry', async () => {
  const f = await setup(); await repo(f.root); f.project.stopping = true;
  const post = (method, params) => fetch(f.url + '/api/action', { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, params }) });
  try {
    const response = await post('order.submit', { content: 'Pi defaults', start: false,
      profile: { agent: 'pi', config_mode: 'pi', model: 'provider/old', thinking: 'high',
        connection_id: '9eebd857-0711-45e8-a1c1-98d6ec24ce02', env: { PRIVATE_SECRET: 'must-not-survive' },
        append_prompt: 'must-not-survive', extensions: ['/unused/plugin'], skills: ['/unused/skill'] } });
    expect(response.status).toBe(200);
    const created = await response.json();
    const id = created.task.id, saved = f.store.task(id).retry_profile;
    expect(JSON.parse(saved)).toMatchObject({ agent: 'pi', config_mode: 'pi', model: '', thinking: '', extensions: [], skills: [] });
    expect(saved).not.toContain('must-not-survive');
    const inspectResponse = await fetch(f.url + `/api/worker/${id}`);
    expect(inspectResponse.status).toBe(200);
    const inspected = await inspectResponse.json();
    expect(inspected.model_selection).toMatchObject({ config_mode: 'pi', connection_id: null, model: '', explicit: true });
    expect(inspected.retry_profile).toBeUndefined();
    const narrow = await post('worker.configure', { id, model_selection: {
      connection_id: '9eebd857-0711-45e8-a1c1-98d6ec24ce02', model: 'provider/old' } });
    expect(narrow.status).toBe(400);
    expect(f.store.task(id).retry_profile).toBe(saved);
    f.store.update(id, { status: 'failed' });
    expect((await post('worker.retry', { id })).status).toBe(200);
    expect(f.store.task(id)).toMatchObject({ status: 'queued', retry_profile: saved });
  } finally { await f.close(); }
});

test('HTTP rejects invalid backend/mode before creating any Worker or Input', async () => {
  const f = await setup(); await repo(f.root); f.project.stopping = true;
  const post = params => fetch(f.url + '/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method: 'order.submit', params }) });
  try {
    // Ensure main exists independently so validation counts only the submitted order.
    await f.project.ensureMainTask();
    const before = f.store.tasks().length;
    const invalid = await post({ content: 'bad mode', start: false, profile: { agent: 'codex', config_mode: 'pi' } });
    expect(invalid.status).toBe(400);
    expect(f.store.tasks()).toHaveLength(before);
    expect(f.store.all('SELECT id FROM inputs')).toHaveLength(0);
    const wrongType = await post({ content: 'bad shape', profile: [] });
    expect(wrongType.status).toBe(400);
    const draft = await post({ draft_id: 1, expected_revision: 1, profile: { agent: 'pi', config_mode: 'pi' } });
    expect(draft.status).toBe(400);
    expect((await draft.json()).error).toContain('cannot be combined');
  } finally { await f.close(); }
});
