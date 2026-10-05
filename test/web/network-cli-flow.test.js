import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { run } from '../../src/cli/commands/agent.js';
import { RPCClient } from '../../src/rpc/client.js';
import { networkSnapshot } from '../../src/agent/network.js';
import { setup, fetch } from './harness.js';

test('CLI file configuration, real RPC and HTTP share private project policy without returning authentication', async () => {
  const f = await setup();
  const client = new RPCClient(f.config.socket);
  const execute = args => run('agent', ['network', ...args], { client, json: true });
  const file = path.join(f.root, 'network-input.json');
  const config = { version: 1, mode: 'proxy', proxy_url: 'http://127.0.0.1:7897', no_proxy: ['.example.test'],
    proxy_auth: { username: 'PRIVATE-PROXY-USER', password: 'PRIVATE-PROXY-PASSWORD' } };
  try {
    expect((await execute(['show'])).mode).toBe('inherit');
    fs.writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
    const saved = await execute(['set', '--file', file]);
    expect(saved).toEqual({ version: 1, mode: 'proxy', proxy_url: config.proxy_url, no_proxy: config.no_proxy, has_proxy_auth: true });
    const response = await fetch(f.url + '/api/agent/network');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual(saved);
    expect(networkSnapshot(f.config).route('https://api.example.test')).toBe('');
    expect(networkSnapshot(f.config).route('https://auth.openai.com')).toContain('PRIVATE-PROXY-USER');
    const change = { ...config, proxy_url: 'http://another-proxy.invalid:7897' }; delete change.proxy_auth;
    const changed = await fetch(f.url + '/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'agent.network.configure', params: { config: change } }) });
    expect(changed.status).toBe(200);
    expect((await execute(['show'])).has_proxy_auth).toBe(false);
    expect(networkSnapshot(f.config).route('https://auth.openai.com')).toBe('http://another-proxy.invalid:7897/');
    expect(JSON.stringify(await execute(['show']))).not.toContain('PRIVATE-');
    expect(fs.statSync(path.join(f.config.home, 'network.json')).mode & 0o777).toBe(0o600);
    expect((await execute(['reset'])).mode).toBe('inherit');
    expect((await (await fetch(f.url + '/api/agent/network')).json()).has_proxy_auth).toBe(false);
    expect(f.store.get('SELECT COUNT(*) AS n FROM events').n).toBe(0);
  } finally { await f.close(); }
});
