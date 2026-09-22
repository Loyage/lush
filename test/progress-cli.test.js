import { test, expect } from 'bun:test';
import { run } from '../src/cli/commands/progress.js';

test('progress CLI parses stable keys and display labels', async () => {
  const calls = [];
  const client = { token: 'live', async request(method, params) { calls.push({ method, params }); return { ok: true }; } };
  await run('progress', ['plan', 'inspect:确认现状', 'test'], { client, json: false });
  await run('progress', ['complete', 'inspect'], { client, json: false });
  expect(calls).toEqual([
    { method: 'progress.plan', params: { steps: [{ key: 'inspect', label: '确认现状' }, { key: 'test', label: 'test' }] } },
    { method: 'progress.complete', params: { step: 'inspect' } },
  ]);
});

test('progress CLI is unavailable without an agent capability', async () => {
  await expect(run('progress', ['complete', 'test'], { client: { token: null }, json: false })).rejects.toThrow('only inside');
});
