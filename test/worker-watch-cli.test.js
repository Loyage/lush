import { test, expect } from 'bun:test';
import { run } from '../src/cli/commands/task.js';
import { HELP } from '../src/cli/help.js';

function fixture(token = null) {
  const requests = [], views = [], environment = { PATH: '/fixture/bin' };
  const client = { token, config: { env: environment }, async request(method, params) {
    requests.push({ method, params });
    if (method === 'worker.lookup') return { id: 360, worker_number: 'W195' };
    if (method === 'worker.inspect') return { id: params.id, worker_number: params.id === 360 ? 'W195' : null };
    throw new Error(`unexpected RPC: ${method}`);
  } };
  return { requests, views, environment, client, watchWorker: async (...args) => { views.push(args); } };
}

test('watch resolves a persistent Worker number once and passes a read-only native viewer its explicit label', async () => {
  const f = fixture();
  expect(await run('worker', ['watch', 'W195', '--after', '42'], f)).toBeUndefined();
  expect(f.requests).toEqual([
    { method: 'worker.lookup', params: { number: 'W195' } },
    { method: 'worker.inspect', params: { id: 360 } },
  ]);
  expect(f.views).toEqual([[f.client, 360, { after: 42, label: 'W195', env: f.environment }]]);
  expect(HELP).toContain('worker watch ID [--after N]');
  expect(HELP).toContain('终端内观看');
  expect(HELP).not.toContain('原生 Pi 只读终端观看');
  expect(HELP).not.toContain('需本机 Pi');
  expect(HELP).toContain('worker transcript ID [--after N]');
  expect(HELP).not.toContain('--follow');
});

test('watch falls back to an internal ID label without inventing a W number', async () => {
  const f = fixture();
  await run('worker', ['watch', '7'], f);
  expect(f.requests).toEqual([{ method: 'worker.inspect', params: { id: 7 } }]);
  expect(f.views[0][2]).toEqual({ after: 0, label: '#7', env: f.environment });
});

test('watch rejects Agent credentials, JSON and invalid arguments before any RPC or renderer load', async () => {
  for (const [args, token, json] of [
    [['watch', 'W195'], 'live', false], [['watch', '7'], '', false],
    [['watch', '7'], null, true], [['watch'], null, false],
    [['watch', '7', 'extra'], null, false], [['watch', 'bad'], null, false],
    ...['-1', '1.5', 'NaN', 'Infinity', '9007199254740991'].map(value => [['watch', '7', '--after', value], null, false]),
  ]) {
    const f = fixture(token);
    await expect(run('worker', args, { ...f, json })).rejects.toThrow();
    expect(f.requests).toEqual([]); expect(f.views).toEqual([]);
  }
});

test('watch propagates failures rather than claiming successful viewing', async () => {
  const f = fixture();
  await expect(run('worker', ['watch', '7'], { ...f, watchWorker: async () => { throw new Error('Pi unavailable'); } }))
    .rejects.toThrow('Pi unavailable');
  expect(f.requests).toEqual([{ method: 'worker.inspect', params: { id: 7 } }]);
});
