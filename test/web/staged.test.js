import { test, expect } from 'bun:test';
import { repo } from '../helpers.js';
import { fetch, setup } from './harness.js';

test('web creates a paused「待开始」Worker and worker.resume queues it with a task-local profile', async () => {
  const f = await setup(); await repo(f.root);
  const post = (method, params) => fetch(f.url + '/api/action', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, params }),
  });
  const snapshot = async () => (await fetch(f.url + '/api/snapshot')).json();
  try {
    const created = await (await post('say.submit', { content: '先暂存这条', start: false })).json();
    expect(created.task.status).toBe('paused');
    let snap = await snapshot();
    expect(snap.tasks.find(task => task.id === created.task.id)).toMatchObject({ status: 'paused' });

    // resume is user-only and accepts the same task-local profile shape as retry, including per-task env.
    const profile = { agent: 'pi', model: '', thinking: '', default_prompt: '', append_prompt: '',
      extensions: [], skills: [], env: { API_BASE: 'https://example.invalid' } };
    const resumed = await (await post('worker.resume', { id: created.task.id, profile })).json();
    expect(resumed.status).toBe('queued');

    let stored;
    for (let attempt = 0; attempt < 150; attempt += 1) {
      snap = await snapshot();
      stored = snap.tasks.find(task => task.id === created.task.id);
      if (stored && stored.status !== 'queued' && stored.status !== 'running') break;
      await Bun.sleep(20);
    }
    expect(stored.status).toBe('waiting');
  } finally { await f.close(); }
});

test('web refuses worker.resume on a worker that is not paused and keeps say.submit start defaulting to running', async () => {
  const f = await setup(); await repo(f.root);
  const post = (method, params) => fetch(f.url + '/api/action', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, params }),
  });
  try {
    const created = await (await post('say.submit', { content: '直接开始', start: true })).json();
    expect(created.task.status).toBe('queued');
    const again = await post('worker.resume', { id: created.task.id });
    expect(again.status).toBe(400);
    expect((await again.json()).error).toContain('only paused workers');
    const invalid = await post('say.submit', { content: 'x', start: false, _token: 'forged' });
    expect(invalid.status).toBe(400);
  } finally { await f.close(); }
});
