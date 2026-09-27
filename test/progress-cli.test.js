import { test, expect } from 'bun:test';
import { run } from '../src/cli/commands/progress.js';

test('progress CLI parses stable keys and display labels', async () => {
  const calls = [];
  const response = { task_id: 7, progress: { items: [{ key: 'inspect' }, { key: 'test' }] } };
  const client = { token: 'live', async request(method, params) { calls.push({ method, params }); return response; } };
  expect(await run('progress', ['plan', 'inspect:确认现状', 'test'], { client, json: false })).toEqual({ task_id: 7, planned: 2 });
  expect(await run('progress', ['complete', 'inspect'], { client, json: false })).toMatchObject({ task_id: 7, completed: 'inspect' });
  expect(calls).toEqual([
    { method: 'progress.plan', params: { steps: [{ key: 'inspect', label: '确认现状' }, { key: 'test', label: 'test' }] } },
    { method: 'progress.complete', params: { step: 'inspect' } },
  ]);
  expect(await run('progress', ['complete', 'test'], { client, json: true })).toEqual(response);
});

test('progress CLI is unavailable without an agent capability', async () => {
  await expect(run('progress', ['complete', 'test'], { client: { token: null }, json: false })).rejects.toThrow('only inside');
});
