import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture } from './helpers.js';
import { run } from '../src/cli/commands/agent.js';
import { HELP } from '../src/cli/help.js';

test('CLI help no longer advertises project configuration overrides and describes private initialization', () => {
  expect(HELP).not.toContain('--scope device|project');
  expect(HELP).toContain('--scope device');
  expect(HELP).toContain('agent init [ROLE] [--local]');
  expect(HELP).toContain('不向 Agent token 开放');
});

for (const verb of ['prompt', 'env']) {
  test(`Agent CLI ${verb} cannot bypass device read authorization through direct local helpers`, async () => {
    let configReads = 0, requests = 0;
    const client = { token: 'temporary-invocation-token',
      get config() { configReads++; throw new Error('private configuration should not be inspected'); },
      request() { requests++; throw new Error('unexpected transport call'); },
    };
    await expect(run('agent', [verb, 'worker'], { client, json: true })).rejects.toThrow('requires user approval');
    expect(configReads).toBe(0);
    expect(requests).toBe(0);
  });
}

test('user CLI prompt and redacted env inspection retain device roots and project conventions', async () => {
  const f = fixture();
  try {
    fs.mkdirSync(path.join(f.root, '.lush-agent'));
    fs.writeFileSync(path.join(f.root, '.lush-agent', 'common.md'), 'repository convention');
    const client = { token: null, config: f.config };
    await run('agent', ['init', '--local', 'worker'], { client, json: true });
    fs.writeFileSync(path.join(f.config.deviceHome, 'agent', 'common.md'), 'device supplement', { mode: 0o600 });
    fs.writeFileSync(path.join(f.config.deviceHome, 'agent', 'agent.env'), 'DEVICE_KEY=private-test-value\n', { mode: 0o600 });
    const prompt = await run('agent', ['prompt', 'worker'], { client, json: true });
    expect(prompt.text).toContain('repository convention');
    expect(prompt.text).toContain('device supplement');
    expect(prompt.customization.settings).toBe(path.join(f.config.deviceHome, 'agent.json'));
    const environment = await run('agent', ['env', 'worker'], { client, json: true });
    expect(environment.keys).toContain('DEVICE_KEY');
    expect(JSON.stringify(environment)).not.toContain('private-test-value');
    expect(environment.loaded).toContain(path.join(f.config.deviceHome, 'agent', 'agent.env'));
  } finally { await f.close(); }
});
