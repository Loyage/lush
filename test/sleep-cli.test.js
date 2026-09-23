import { test, expect } from 'bun:test';
import { run } from '../src/cli/commands/sleep.js';

test('CLI requires risk confirmation and explicit merge/existing scopes; off is one command', async () => {
  const calls = [];
  const client = { token: null, async request(method, params) { calls.push({ method, params }); return { enabled: method === 'sleep.start' }; } };
  const ctx = { client, json: true };
  await expect(run('sleep', ['on'], ctx)).rejects.toThrow('--confirm');
  await expect(run('sleep', ['on','--confirm'], ctx)).rejects.toThrow('--existing');
  expect(calls).toHaveLength(0);
  await run('sleep', ['on','--mode','preferences','--budget','12345','--merge','yes','--existing','no','--confirm'], ctx);
  expect(calls[0]).toEqual({ method: 'sleep.start', params: { confirmed: true,
    options: { mode: 'preferences', budget_tokens: 12345, allow_merge: true, include_existing: false } } });
  await run('sleep', ['off'], ctx); expect(calls.at(-1).method).toBe('sleep.stop');
  await run('sleep', ['choices','--before','10'], ctx); expect(calls.at(-1)).toEqual({ method: 'sleep.choices', params: { before: 10 } });
  await expect(run('sleep', ['off'], { client: { ...client, token: 'agent' }, json: true })).rejects.toThrow('user-only');
});
