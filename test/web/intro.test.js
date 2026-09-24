import { test, expect } from 'bun:test';
import { setup, fetch } from './harness.js';
import { until } from '../helpers.js';

test('Web 快速介绍：配置读写、直连模型、历史与来源任务', async () => {
  const f = await setup();
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200,
    json: async () => ({ choices: [{ message: { content: '这是快速介绍结果。' } }] }) });
  try {
    const action = (method, params) => fetch(`${f.url}/api/action`, { method: 'POST',
      headers: { 'content-type': 'application/json', origin: f.url }, body: JSON.stringify({ method, params }) });
    const configured = await (await action('intro.configure', { config: {
      base_url: 'https://api.example.com/v1', model: 'demo', api_key: 'sk-9999' } })).json();
    expect(configured).toMatchObject({ base_url: 'https://api.example.com/v1', model: 'demo', has_key: true, key_hint: '••••9999', ready: true });
    expect(configured.api_key).toBeUndefined();
    expect(await (await fetch(`${f.url}/api/intro/config`)).json()).toMatchObject({ model: 'demo', has_key: true });

    const started = await (await action('intro.start', { quote: '一段文字',
      location: { view: 'task-detail', section: 'selection', task_id: 42 } })).json();
    expect(started).toMatchObject({ kind: 'quick', status: 'running', quote: '一段文字' });
    await until(() => f.store.intro(started.id).status === 'completed');
    const read = await (await fetch(`${f.url}/api/intro/${started.id}`)).json();
    expect(read.result).toContain('这是快速介绍结果');
    expect(read.location.task_id).toBe(42);
    expect((await (await fetch(`${f.url}/api/task/42/intros`)).json())).toMatchObject({ introductions: [{ id: started.id }] });
    // 空选区在落库前被拒。
    expect((await action('intro.start', { quote: '', location: {} })).status).toBe(400);
    expect(f.store.tasks()).toHaveLength(0);
  } finally { globalThis.fetch = original; await f.close(); }
});
