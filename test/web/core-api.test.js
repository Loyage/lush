import { test, expect } from 'bun:test';
import { repo } from '../helpers.js';
import { fetch, setup } from './harness.js';

test('Web creates an order and reads its Worker and overview through real RPC', async () => {
  const f = await setup(); await repo(f.root);
  try {
    const response = await fetch(f.url + '/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'order.submit', params: { content: '新目标', start: false } }) });
    expect(response.status).toBe(200);
    const created = await response.json(); expect(created.task.task_kind).toBe('order');
    const detail = await (await fetch(f.url + `/api/worker/${created.task.id}`)).json();
    expect(detail.id).toBe(created.task.id); expect(detail.goal).toBe('新目标');
    const overview = await (await fetch(f.url + '/api/overview')).json();
    expect(overview.tasks.some(task => task.id === created.task.id)).toBe(true);
  } finally { await f.close(); }
});
