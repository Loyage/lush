import { expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from '../src/cli/commands/agent.js';
import { HELP } from '../src/cli/help.js';

const safe = (extra = {}) => ({ version: 1, mode: 'inherit', proxy_url: null, no_proxy: [], has_proxy_auth: false, ...extra });
function fixture(value = safe()) {
  const calls = [], client = { request: async (method, params) => { calls.push({ method, params }); return value; } };
  return { calls, client, execute: args => run('agent', ['network', ...args], { client, json: true }) };
}

test('agent network show/reset使用窄RPC并仅输出安全投影，帮助说明文件录入', async () => {
  const f = fixture({ ...safe(), proxy_auth: { username: 'PRIVATE-USER', password: 'PRIVATE-PASS' } });
  expect(await f.execute(['show'])).toEqual(safe()); expect(f.calls).toEqual([{ method: 'agent.network', params: {} }]);
  expect(await f.execute(['reset'])).toEqual(safe());
  expect(f.calls.at(-1)).toEqual({ method: 'agent.network.configure', params: { config: { version: 1, mode: 'inherit', proxy_url: null, no_proxy: [], proxy_auth: null } } });
  for (const entry of ['agent network show', 'agent network set --file PATH', 'agent network reset']) expect(HELP).toContain(entry);
});

test('agent network set从JSON文件读取认证，不将秘密放在输出或其他配置RPC', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lush-network-cli-'));
  try {
    const file = path.join(dir, 'network.json'), config = { version: 1, mode: 'proxy', proxy_url: 'http://127.0.0.1:7897', no_proxy: ['.example.com'], proxy_auth: { username: 'PRIVATE-USER', password: 'PRIVATE-PASS' } };
    fs.writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
    const value = safe({ mode: 'proxy', proxy_url: config.proxy_url, no_proxy: config.no_proxy, has_proxy_auth: true }), f = fixture(value);
    expect(await f.execute(['set', '--file', file])).toEqual(value);
    expect(f.calls).toEqual([{ method: 'agent.network.configure', params: { config } }]);
    expect(JSON.stringify(await f.execute(['show']))).not.toContain('PRIVATE-');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Agent token不能读取、重设或录入网络，不读文件不发RPC', async () => {
  const f = fixture(); f.client.token = 'invocation-capability';
  for (const args of [['show'], ['reset'], ['set', '--file', '/missing']]) await expect(f.execute(args)).rejects.toThrow('agents cannot change');
  expect(f.calls).toHaveLength(0);
});

test('CLI严格拒绝未知动作、额外参数和命令行密码', async () => {
  const f = fixture();
  for (const args of [['show', 'extra'], ['reset', 'extra'], ['set'], ['set', '--file'], ['set', '--password', 'PRIVATE-PASS'], ['test'], ['set', '--file', '/missing', '--file', '/another']]) await expect(f.execute(args)).rejects.toThrow();
  expect(f.calls).toHaveLength(0);
});

test('无效、大文件与非对象JSON不发RPC，语法错误不回显秘密', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lush-network-cli-')), f = fixture();
  try {
    const file = path.join(dir, 'input.json');
    for (const source of ['{"password":"PRIVATE-PASS",', 'x'.repeat(65537), '[]', 'null']) {
      fs.writeFileSync(file, source);
      try { await f.execute(['set', '--file', file]); throw new Error('expected rejection'); }
      catch (error) { expect(error.message).not.toContain('PRIVATE-PASS'); expect(error.message).not.toBe('expected rejection'); }
    }
    await expect(f.execute(['set', '--file', dir])).rejects.toThrow('cannot safely read'); expect(f.calls).toHaveLength(0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('CLI preserves only validated scope metadata without proxy credentials', async () => {
  const configuration_scope = { selected: 'device', source: 'device', device_home: '/private/lush/shared',
    project_home: '/project/.lush', project_override: true };
  const f = fixture(safe({ configuration_scope, proxy_auth: { password: 'PRIVATE-PASS' } }));
  expect(await f.execute(['show', '--scope', 'device'])).toEqual(safe({ configuration_scope }));
  expect(f.calls).toEqual([{ method: 'agent.network', params: { scope: 'device' } }]);
  const invalid = fixture(safe({ configuration_scope: { ...configuration_scope, credential: 'PRIVATE-PASS' } }));
  await expect(invalid.execute(['show'])).rejects.toThrow('invalid configuration scope response');
});

test('上游错误和认证URL响应不能泄露到CLI错误', async () => {
  const f = fixture(); f.client.request = async () => { throw new Error('PRIVATE-PASS raw provider response'); };
  await expect(f.execute(['show'])).rejects.toThrow('network configuration unavailable');
  for (const proxy_url of ['http://PRIVATE-USER:PRIVATE-PASS@proxy.invalid', 'http://proxy.invalid?secret=PRIVATE-PASS', 'socks5://proxy.invalid']) {
    const unsafe = fixture(safe({ mode: 'proxy', proxy_url }));
    try { await unsafe.execute(['show']); throw new Error('expected rejection'); }
    catch (error) { expect(error.message).toBe('invalid network configuration response'); }
  }
});
