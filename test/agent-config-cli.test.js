import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect } from 'bun:test';
import { run as agent } from '../src/cli/commands/agent.js';
import { run as order } from '../src/cli/commands/intent.js';

function client() {
  const calls = [];
  return { calls, request: async (method, params) => { calls.push({ method, params }); return params; } };
}

test('agent dispatcher mounts packages without reading unrelated Agent config', async () => {
  const c = client();
  await agent('agent', ['packages', 'list'], { client: c, json: true });
  await agent('agent', ['packages', 'install', 'npm:example@1.2.3'], { client: c, json: true });
  expect(c.calls).toEqual([
    { method: 'agent.packages.list', params: {} },
    { method: 'agent.packages.install', params: { source: 'npm:example@1.2.3' } },
  ]);
  c.token = 'agent-capability';
  await expect(agent('agent', ['packages', 'list'], { client: c })).rejects.toThrow('agents cannot change');
  expect(c.calls).toHaveLength(2);
});

test('agent set config-mode clears managed fields and refuses ambiguous mixed overrides', async () => {
  const current = { default: { agent: 'pi', model: 'p/m', thinking: 'high', connection_id: 'source',
    append_prompt: 'private', extensions: ['/plugin'], skills: ['/skill'], env: { SECRET: 'hidden' } }, roles: {} };
  const calls = [];
  const c = { request: async (method, params) => { calls.push({ method, params }); return method === 'agent.config' ? current : params; } };
  const result = await agent('agent', ['set', 'default', '--config-mode', 'pi'], { client: c, json: true });
  expect(result.config.default).toEqual({ agent: 'pi', config_mode: 'pi' });
  expect(JSON.stringify(result)).not.toContain('hidden');
  await expect(agent('agent', ['set', 'default', '--config-mode', 'pi', '--model', 'p/m'], { client: c })).rejects.toThrow('cannot mix');
  await expect(agent('agent', ['set', 'default', '--config-mode', 'bad'], { client: c })).rejects.toThrow('must be lush or pi');
  await expect(agent('agent', ['set', 'default', '--agent', 'codex', '--config-mode', 'pi'], { client: c })).rejects.toThrow('requires the Pi backend');
  expect(calls.filter(call => call.method === 'agent.configure')).toHaveLength(1);
});

test('agent set can return to managed mode without losing unrelated settings', async () => {
  const current = { default: { agent: 'pi', config_mode: 'pi', model: '', thinking: '' }, roles: {} };
  const c = { request: async (method, params) => method === 'agent.config' ? current : params };
  const result = await agent('agent', ['set', 'default', '--config-mode', 'lush', '--model', 'p/m', '--connection', 'source'], { client: c });
  expect(result.config.default).toMatchObject({ config_mode: 'lush', model: 'p/m', connection_id: 'source' });
});

test('order profile-file forwards complete private configuration unchanged', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lush-profile-cli-'));
  try {
    const file = path.join(dir, 'profile.json');
    const profile = { agent: 'pi', config_mode: 'pi' };
    fs.writeFileSync(file, JSON.stringify(profile), { mode: 0o600 });
    const c = client();
    await order('order', ['goal', '--branch', 'main', '--profile-file', file], { client: c });
    expect(c.calls).toEqual([{ method: 'order.submit', params: { content: 'goal', branch: 'main', profile } }]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('order profile-file rejects unsafe files and never echoes contents or submits', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lush-profile-cli-'));
  try {
    const c = client(), file = path.join(dir, 'private.json');
    for (const value of ['{"secret":"do-not-echo"', '[]', 'null', 'x'.repeat(256 * 1024 + 1)]) {
      fs.writeFileSync(file, value, { mode: 0o600 });
      await expect(order('order', ['goal', '--profile-file', file], { client: c })).rejects.toThrow('cannot safely read private Worker profile');
    }
    fs.writeFileSync(file, '{}'); fs.chmodSync(file, 0o644);
    await expect(order('order', ['goal', '--profile-file', file], { client: c })).rejects.toThrow('owner-only');
    fs.chmodSync(file, 0o600); fs.symlinkSync(file, path.join(dir, 'link'));
    for (const bad of [dir, path.join(dir, 'link'), path.join(dir, 'missing')]) {
      await expect(order('order', ['goal', '--profile-file', bad], { client: c })).rejects.toThrow('cannot safely read');
    }
    c.token = 'agent-capability';
    await expect(order('order', ['goal', '--profile-file', file], { client: c })).rejects.toThrow('agents cannot submit');
    expect(c.calls).toHaveLength(0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
