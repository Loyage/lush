import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { PARAMS, USER_ONLY, assertAllowed } from '../../src/rpc/registry.js';
import { RPCClient } from '../../src/rpc/client.js';
import { startWeb } from '../../src/ui/web/server.js';
import { projectRouteId } from '../../src/host/registry.js';
import { temp } from '../helpers.js';
import { setup, fetch } from './harness.js';

const value = (extra = {}) => ({ version: 1, mode: 'proxy', proxy_url: 'http://127.0.0.1:7897', no_proxy: [], ...extra });
const post = (url, body, headers = {}) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
const action = (url, config, headers = {}) => post(url + '/api/action', { method: 'agent.network.configure', params: { config } }, headers);

test('network RPC is narrow/user-only and real HTTP returns only safe no-store configuration', async () => {
  expect(PARAMS['agent.network']).toEqual(['scope']); expect(PARAMS['agent.network.configure']).toEqual(['config', 'scope']);
  for (const method of ['agent.network', 'agent.network.configure']) {
    expect(USER_ONLY.has(method)).toBe(true); expect(() => assertAllowed(method, {}, 42)).toThrow('requires user approval');
    expect(() => assertAllowed(method, { secret: 'PRIVATE' }, null)).toThrow('unknown parameter');
  }
  const f = await setup();
  try {
    const rpc = new RPCClient(f.config.socket);
    expect((await rpc.request('agent.network')).mode).toBe('inherit');
    const saved = await action(f.url, value({ proxy_auth: { username: 'PRIVATE-USER', password: 'PRIVATE-PASSWORD' } }));
    expect(saved.status).toBe(200); expect(await saved.text()).not.toContain('PRIVATE');
    const read = await fetch(f.url + '/api/agent/network'); expect(read.status).toBe(200);
    expect(read.headers.get('cache-control')).toBe('no-store'); expect(await read.json()).toMatchObject({ mode: 'proxy', has_proxy_auth: true });
    expect(JSON.stringify(await rpc.request('agent.network'))).not.toContain('PRIVATE');
    expect((await fetch(f.url + '/api/agent/network?token=PRIVATE')).status).toBe(400);
    expect((await fetch(f.url + '/api/agent/network', { headers: { Origin: 'https://evil.invalid' } })).status).toBe(403);
    expect((await action(f.url, value(), { Origin: 'https://evil.invalid' })).status).toBe(403);
    expect((await post(f.url + '/api/action', { method: 'agent.network', params: {} })).status).toBe(400);
    const bad = await action(f.url, value({ proxy_url: 'http://PRIVATE:PASSWORD@proxy.invalid' }));
    expect(bad.status).toBe(400); expect(await bad.text()).not.toContain('PRIVATE');
    expect(f.store.get('SELECT COUNT(*) AS n FROM events').n).toBe(0);
    expect((await rpc.request('agent.network')).has_proxy_auth).toBe(true);
  } finally { await f.close(); }
});

test('both network reads and writes require Web login, and settings stay separate across projects', async () => {
  const f = await setup({ auth: { username: 'owner', password: 'network-test-password' } }), other = await setup();
  try {
    expect((await fetch(f.url + '/api/agent/network')).status).toBe(401);
    expect((await action(f.url, value())).status).toBe(401);
    const login = await fetch(f.url + '/login', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'username=owner&password=network-test-password' });
    const Cookie = login.headers.get('set-cookie').split(';')[0];
    expect((await action(f.url, value(), { Cookie })).status).toBe(200);
    expect((await (await fetch(f.url + '/api/agent/network', { headers: { Cookie } })).json()).mode).toBe('proxy');
    expect((await (await fetch(other.url + '/api/agent/network')).json()).mode).toBe('inherit');
  } finally { await f.close(); await other.close(); }
});

test('global network routes retain registered project identity for reads and writes', async () => {
  const a = temp(), b = temp(), global = temp(), calls = [];
  const web = startWeb(null, 0, { env: { ...process.env, LUSH_GLOBAL_CONFIG: global }, openProject: async project => ({
    config: { project, home: path.join(project, '.lush') }, client: { async request(method, params = {}) { calls.push({ project, method, params }); return { project }; } },
  }) });
  const url = `http://127.0.0.1:${web.port}`, idA = projectRouteId(a), idB = projectRouteId(b);
  try {
    await post(url + '/api/host/select', { project: a }); await post(url + '/api/host/select', { project: b }); calls.length = 0;
    expect((await fetch(`${url}/p/${idA}/api/agent/network`)).status).toBe(200);
    expect((await action(`${url}/p/${idB}`, value())).status).toBe(200);
    expect(calls).toEqual([{ project: a, method: 'agent.network', params: {} }, { project: b, method: 'agent.network.configure', params: { config: value() } }]);
    expect((await fetch(url + '/api/agent/network')).status).toBe(400);
    expect((await fetch(`${url}/p/${'0'.repeat(16)}/api/agent/network`)).status).toBe(400);
  } finally { web.stop(true); for (const dir of [a, b, global]) fs.rmSync(dir, { recursive: true, force: true }); }
});
