import { test, expect } from 'bun:test';
import { run as intent } from '../src/cli/commands/intent.js';
import { run as task } from '../src/cli/commands/task.js';
import { run as system } from '../src/cli/commands/system.js';
import { fixture } from './helpers.js';
import { codeIdentity } from '../src/identity.js';

test('ordinary say submits content and branch without extra flags', async () => {
  const calls = [], client = { request: async (method, params) => { calls.push({ method, params }); return params; } };
  await intent('say', ['fix it', '--branch', 'main'], { client });
  await intent('say', ['plan it'], { client });
  expect(calls).toEqual([
    { method: 'input.submit', params: { content: 'fix it', branch: 'main' } },
    { method: 'input.submit', params: { content: 'plan it' } },
  ]);
});

test('brief tasks use bounded rows and retain a continuation cursor; ordinary list stays compatible', async () => {
  const rows = Array.from({ length: 3 }, (_, i) => ({ id: i + 1, role: 'worker', status: 'completed', goal: 'x'.repeat(200), progress: 'large' }));
  const calls = [], client = { request: async (method, params) => { calls.push(params); return rows; } };
  const result = await task('task', ['list', '--brief', '--limit', '2'], { client, json: true });
  expect(calls[0]).toEqual({ after: 0, limit: 3 });
  expect(result).toMatchObject({ has_more: true, next_after: 2 });
  expect(result.tasks).toHaveLength(2); expect(result.tasks[0].goal).toHaveLength(160);
  expect(result.tasks[0].progress).toBeUndefined();
  expect(await task('task', ['list'], { client, json: true })).toEqual(rows);
  await expect(task('task', ['list', '--brief', '--limit', '999'], { client })).rejects.toThrow('1..200');
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
