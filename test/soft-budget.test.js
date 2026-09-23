import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import runtime from '../src/agent/pi-runtime.js';
import { projectRecord } from '../src/core/transcript.js';
import { AgentSettings, normalizeSoftBudget } from '../src/agent/settings.js';
import { PiProvider, CodexProvider } from '../src/agent/provider.js';
import { run as agentCommand } from '../src/cli/commands/agent.js';
import { fixture, temp, env } from './helpers.js';
import { Config } from '../src/config.js';

function extension(settings) {
  const previous = process.env.LUSH_RUNTIME_CONTEXT;
  process.env.LUSH_RUNTIME_CONTEXT = JSON.stringify(settings);
  const hooks = {}, entries = [];
  try { runtime({ on: (name, fn) => hooks[name] = fn, appendEntry: (type, data) => entries.push({ type, data }) }); }
  finally { if (previous === undefined) delete process.env.LUSH_RUNTIME_CONTEXT; else process.env.LUSH_RUNTIME_CONTEXT = previous; }
  return { hooks, entries };
}

test('soft budget is one advisory on the next natural request; no messages, model calls or tool interception', () => {
  const { hooks, entries } = extension({ task_id: 2, run_id: 9, role: 'worker', soft_budget: { responses: 2, tokens: 500 } });
  hooks.session_start();
  expect(entries[0]).toEqual({ type: 'lush.invocation', data: { task_id: 2, run_id: 9, role: 'worker' } });
  const assistant = tokens => ({ message: { role: 'assistant', usage: { totalTokens: tokens } } });
  hooks.message_end({ message: { role: 'toolResult' } });
  hooks.message_end(assistant(200));
  expect(hooks.context({ messages: [] })).toBeUndefined();
  hooks.message_end(assistant(200));
  // A completed response crossing the limit does NOT create a new request.
  expect(entries).toHaveLength(1);
  const original = [{ role: 'user', content: 'work' }];
  const result = hooks.context({ messages: original });
  expect(result.messages).toHaveLength(2); expect(original).toHaveLength(1);
  expect(result.messages[1].content).toContain('不能为预算虚报成功');
  expect(entries[1].data).toMatchObject({ responses: 2, tokens: 400 });
  expect(projectRecord({ type: 'custom', customType: entries[1].type, data: entries[1].data })[0]).toMatchObject({
    title: '软预算提醒', body: result.messages[1].content,
  });
  expect(hooks.context({ messages: original })).toBeUndefined();
  const next = extension({ task_id: 2, run_id: 10, role: 'worker', soft_budget: { responses: 2 } });
  expect(next.hooks.context({ messages: original })).toBeUndefined();
});

test('budget counts cache tokens but not reasoning twice, and handles unknown usage', () => {
  const { hooks, entries } = extension({ soft_budget: { tokens: 100 } });
  hooks.message_end({ message: { role: 'assistant', usage: { input: 10, output: 20, cacheRead: 70, reasoning: 10 } } });
  hooks.message_end({ message: { role: 'assistant' } });
  expect(hooks.context({ messages: [] }).messages[0].content).toContain('1 条用量未知');
  expect(entries[0].data).toMatchObject({ tokens: 100, responses: 2 });
  const disabled = extension({});
  for (let i = 0; i < 100; i++) disabled.hooks.message_end({ message: { role: 'assistant', usage: { totalTokens: 10000 } } });
  expect(disabled.hooks.context({ messages: [] })).toBeUndefined();
});

test('budget configuration validates supported backends, preserves disabled compatibility and CLI reset', async () => {
  const f = fixture();
  try {
    expect(normalizeSoftBudget()).toEqual({});
    for (const value of [{ tokens: 0 }, { responses: 1.5 }, { tokens: -1 }, { cost: 2 }, { tokens: Infinity }, { tokens: '20' }]) {
      expect(() => normalizeSoftBudget(value)).toThrow();
    }
    const settings = new AgentSettings(f.config);
    settings.save({ default: { agent: 'pi', soft_budget: { responses: 20 } }, roles: {} });
    expect(settings.resolve('worker').soft_budget).toEqual({ responses: 20 });
    expect(settings.resolve('explainer').soft_budget).toBeUndefined();
    expect(() => settings.save({ default: { agent: 'codex', soft_budget: { responses: 2 } } })).toThrow('only by Pi');
    expect(() => settings.save({ default: { agent: 'pi' }, roles: { explainer: { agent: 'pi', soft_budget: { tokens: 50 } } } })).toThrow('explainer');
    const client = { token: null, request: async (method, params) => method === 'agent.config' ? settings.get() : settings.save(params.config) };
    await agentCommand('agent', ['set', 'worker', '--budget-responses', '30', '--budget-tokens', '100000'], { client });
    expect(settings.resolve('worker').soft_budget).toEqual({ responses: 30, tokens: 100000 });
    await agentCommand('agent', ['set', 'worker', '--budget-responses', 'off', '--budget-tokens', 'off'], { client });
    expect(settings.resolve('worker').soft_budget).toBeUndefined();
  } finally { await f.close(); }
});

test('Pi receives pretty task data inline, no credential hash or repeated prompts, and trusted runtime metadata', async () => {
  const root = temp(), fake = path.join(root, 'fake-pi');
  fs.writeFileSync(fake, `#!/usr/bin/env bun\nconsole.log(JSON.stringify({args:process.argv.slice(2),runtime:JSON.parse(process.env.LUSH_RUNTIME_CONTEXT)}));\n`, { mode: 0o755 });
  const config = new Config({ project: root, env: env({ LUSH_PI_COMMAND: fake }) }); config.prepare();
  try {
    const options = { task: { id: 3, role: 'worker', goal: 'hello', agent_token_hash: 'DO-NOT-INJECT' },
      context: { invocation: { run_id: 5 } }, messages: [], cwd: root, token: 'secret', signal: new AbortController().signal, onSpawn() {},
      agent: { agent: 'pi', model: '', thinking: '', append_prompt: 'already in system', soft_budget: { responses: 5 } } };
    const result = JSON.parse(await new PiProvider(config).run(options));
    const file = path.join(config.home, 'sessions/task-3-input.md'), body = fs.readFileSync(file, 'utf8');
    expect(body.split('\n').length).toBeGreaterThan(5);
    expect(body).not.toContain('DO-NOT-INJECT'); expect(body).not.toContain('already in system');
    expect(result.args).toContain(`@${file}`);
    expect(result.args.some(arg => arg.endsWith('/pi-runtime.js'))).toBe(true);
    expect(result.runtime).toMatchObject({ run_id: 5, task_id: 3, role: 'worker', soft_budget: { responses: 5 } });
    await expect(new CodexProvider(config).run(options)).rejects.toThrow('only by Pi');
    await expect(new PiProvider(config).run({ ...options, task: { ...options.task, role: 'explainer' } })).rejects.toThrow('explainer');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
