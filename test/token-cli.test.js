import { test, expect } from 'bun:test';
import { run as intent } from '../src/cli/commands/intent.js';
import { run as worker } from '../src/cli/commands/task.js';
import { run as system } from '../src/cli/commands/system.js';
import { fixture } from './helpers.js';
import { codeIdentity } from '../src/identity.js';

test('ordinary order submits content and branch without extra flags', async () => {
  const calls = [], client = { request: async (method, params) => { calls.push({ method, params }); return params; } };
  await intent('order', ['fix it', '--branch', 'main'], { client });
  await intent('order', ['plan it'], { client });
  expect(calls).toEqual([
    { method: 'order.submit', params: { content: 'fix it', branch: 'main' } },
    { method: 'order.submit', params: { content: 'plan it' } },
  ]);
});

test('worker reserve and unreserve pass one explicit order Worker and kind', async () => {
  const calls = [], client = { request: async (method, params) => { calls.push({ method, params }); return params; } };
  await worker('worker', ['reserve', '7', 'merge'], { client, json: true });
  await worker('worker', ['reserve-all', 'main'], { client, json: true });
  await worker('worker', ['resolve-divergence', '7'], { client, json: true });
  await worker('worker', ['resolve-child-divergence', '9'], { client, json: true });
  await worker('worker', ['unreserve', '7'], { client, json: true });
  await worker('worker', ['approve-merge', '7', 'a'.repeat(40), 'b'.repeat(40)], { client, json: true });
  expect(calls).toEqual([
    { method: 'worker.reserve', params: { id: 7, kind: 'merge' } },
    { method: 'worker.reserve_all', params: { branch: 'main' } },
    { method: 'worker.resolve_divergence', params: { id: 7 } },
    { method: 'worker.resolve_child_divergence', params: { id: 9 } },
    { method: 'worker.unreserve', params: { id: 7 } },
    { method: 'worker.approve_merge', params: { id: 7, commit: 'a'.repeat(40), baseline: 'b'.repeat(40) } },
  ]);
  await expect(worker('worker', ['reserve', '7'], { client, json: true })).rejects.toThrow();
  await expect(worker('worker', ['reserve-all'], { client, json: true })).rejects.toThrow();
  expect(calls).toHaveLength(6);
});

test('brief workers use bounded rows and retain a continuation cursor; ordinary list stays compatible', async () => {
  const rows = Array.from({ length: 3 }, (_, i) => ({ id: i + 1, role: 'worker', status: 'completed', goal: 'x'.repeat(200), progress: 'large' }));
  const calls = [], client = { request: async (method, params) => { calls.push({ method, params }); return rows; } };
  const result = await worker('worker', ['list', '--brief', '--limit', '2'], { client, json: true });
  expect(calls[0]).toEqual({ method: 'worker.list', params: { after: 0, limit: 3 } });
  expect(result).toMatchObject({ has_more: true, next_after: 2 });
  expect(result.tasks).toHaveLength(2); expect(result.tasks[0].goal).toHaveLength(160);
  expect(result.tasks[0].progress).toBeUndefined();
  expect(result.note).toContain('lush worker inspect ID');
  expect(await worker('worker', ['list'], { client, json: true })).toEqual(rows);
  await expect(worker('worker', ['list', '--brief', '--limit', '999'], { client })).rejects.toThrow('1..200');
});

test('doctor keeps identity checks but full daemon profiles require --verbose', async () => {
  const f = fixture();
  try {
    const status = { ...codeIdentity(), project: f.root, pid: 123, agent_config: { prompt: 'private large prompt' } };
    const client = { config: f.config, request: async () => status };
    const brief = await system('doctor', [], { client });
    expect(brief.daemon_code_match).toBe(true);
    expect(JSON.stringify(brief)).not.toContain('private large prompt');
    const verbose = await system('doctor', ['--verbose'], { client });
    expect(verbose.daemon.agent_config).toEqual(status.agent_config);
  } finally { await f.close(); }
});
