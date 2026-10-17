import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { Config } from '../src/config.js';
import { AgentSettings } from '../src/agent/settings.js';
import { run as runAgentCommand } from '../src/cli/commands/agent.js';
import { temp, env } from './helpers.js';

test('Agent settings persist role overrides and reload without restarting', () => {
  const root = temp();
  const config = new Config({ project: root, env: env({ LUSH_GLOBAL_CONFIG: path.join(root, 'device') }) });
  config.prepare();
  try {
    const settings = new AgentSettings(config);
    settings.save({ version: 1, default: { agent: 'pi', model: 'deepseek/deepseek-chat', thinking: '' },
      roles: { worker: { agent: 'codex', model: 'gpt-5.4-mini', thinking: 'high' } } });
    const next = new AgentSettings(config);
    expect(next.resolve('worker')).toMatchObject({ agent: 'codex', model: 'gpt-5.4-mini', thinking: 'high' });
    expect(next.get().default.model).toBe('deepseek/deepseek-chat');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Agent CLI selects a connection, edits its model and clears the binding', async () => {
  const id = '9e32c7e1-9b59-4ec2-a4b0-8fbbf224ef87';
  let profile = { agent: 'pi', model: 'deepseek/deepseek-chat', thinking: '' };
  const client = { token: null, async request(method, params) {
    if (method === 'agent.config') return { version: 1, default: profile, roles: {}, resolved: { agent: profile } };
    expect(method).toBe('agent.configure'); profile = params.config.default; return params.config;
  } };
  await runAgentCommand('agent', ['set', 'default', '--connection', id], { client });
  await runAgentCommand('agent', ['set', 'default', '--model', 'deepseek/deepseek-reasoner'], { client });
  expect(profile).toMatchObject({ connection_id: id, model: 'deepseek/deepseek-reasoner' });
  await runAgentCommand('agent', ['set', 'default', '--connection', 'off'], { client });
  expect(profile.connection_id).toBeUndefined();
});
