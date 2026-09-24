import { test, expect } from 'bun:test';
import fs from 'node:fs';
import { run } from '../src/cli/commands/sleep.js';
import { main } from '../src/cli/main.js';
import { HELP } from '../src/cli/help.js';
import { fixture } from './helpers.js';
import { RPCServer } from '../src/rpc/server.js';
import { Dispatcher } from '../src/rpc/dispatcher.js';
import { createSignal } from '../src/signal.js';

test('CLI requires risk confirmation and explicit merge/existing scopes; off is one command', async () => {
  const calls = [];
  const client = { token: null, async request(method, params) { calls.push({ method, params }); return { enabled: method === 'sleep.start' }; } };
  const ctx = { client, json: true };
  await expect(run('auto-manage', ['on'], ctx)).rejects.toThrow('--confirm');
  await expect(run('auto-manage', ['on','--confirm'], ctx)).rejects.toThrow('--existing');
  expect(calls).toHaveLength(0);
  await run('auto-manage', ['on','--mode','preferences','--budget','12345','--merge','yes','--existing','no','--confirm'], ctx);
  expect(calls[0]).toEqual({ method: 'sleep.start', params: { confirmed: true,
    options: { mode: 'preferences', budget_tokens: 12345, allow_merge: true, include_existing: false } } });
  await run('auto-manage', ['off'], ctx); expect(calls.at(-1).method).toBe('sleep.stop');
  await run('auto-manage', ['choices','--before','10'], ctx); expect(calls.at(-1)).toEqual({ method: 'sleep.choices', params: { before: 10 } });
  await expect(run('auto-manage', ['bogus'], ctx)).rejects.toThrow('auto-manage expects');
  await expect(run('auto-manage', ['off'], { client: { ...client, token: 'agent' }, json: true })).rejects.toThrow('user-only');
});

test('CLI human output uses 托管模式 and auto-manage hints', async () => {
  const lines = [];
  const original = console.log; console.log = (...args) => lines.push(args.join(' '));
  try {
    await run('auto-manage', ['status'], { client: { token: null, async request() { return { enabled: false, handled: 0, decisions: 0, used_tokens: 0, budget_tokens: null }; } }, json: false });
  } finally { console.log = original; }
  const text = lines.join('\n');
  expect(text).toContain('托管模式');
  expect(text).toContain('bun run lush auto-manage off');
  expect(text).not.toContain('睡觉');
});

test('help advertises auto-manage and notes sleep as the legacy alias', () => {
  expect(HELP).toContain('auto-manage on');
  expect(HELP).toContain('旧别名：sleep');
});

test('auto-manage and the sleep alias dispatch to the same handler', async () => {
  const f = fixture();
  const rpc = new RPCServer(f.config.socket, new Dispatcher(f.project, createSignal(), {}));
  await rpc.start();
  const saved = { LUSH_PROJECT: process.env.LUSH_PROJECT, LUSH_HOME: process.env.LUSH_HOME, LUSH_PROVIDER: process.env.LUSH_PROVIDER, LUSH_AGENT_TOKEN: process.env.LUSH_AGENT_TOKEN };
  delete process.env.LUSH_PROJECT; delete process.env.LUSH_HOME; delete process.env.LUSH_AGENT_TOKEN; process.env.LUSH_PROVIDER = 'mock';
  const lines = []; const original = console.log; console.log = (...args) => lines.push(args.join(' '));
  try {
    await main(['auto-manage', 'status', '--project', f.root]);
    await main(['sleep', 'status', '--project', f.root]);
  } finally {
    console.log = original;
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rpc.close(); await f.close(); fs.rmSync(f.config.socket, { force: true });
  }
  expect(lines.filter(line => line.includes('托管模式'))).toHaveLength(2);
});
