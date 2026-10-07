import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { RPCClient } from '../../src/rpc/client.js';
import { PARAMS, USER_ONLY, assertAllowed } from '../../src/rpc/registry.js';
import { startWeb } from '../../src/ui/web/server.js';
import { projectRouteId } from '../../src/host/registry.js';
import { temp } from '../helpers.js';
import { setup, fetch } from './harness.js';

const post = (url, body, headers = {}) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
const action = (url, config, headers) => post(url + '/api/action', { method: 'agent.usage.configure', params: { config } }, headers);

test('all usage RPCs are user-only and expose only declared parameters', () => {
  for (const [method, parameters] of Object.entries({ 'agent.usage.config': [], 'agent.usage.configure': ['config'],
    'agent.usage.history': ['provider','account_key','days'] })) {
    expect(PARAMS[method]).toEqual(parameters); expect(USER_ONLY.has(method)).toBe(true);
    expect(assertAllowed(method, {}, null)).toBeNull();
    expect(() => assertAllowed(method, {}, 99)).toThrow('requires user approval');
    expect(() => assertAllowed(method, { command: 'echo secret' }, null)).toThrow('unknown parameter');
  }
});

test('legacy config/history remain no-store reads; authenticated configure is explicitly retired', async () => {
  const f = await setup(); let queried = 0;
  f.project.agentUsage.discoverUsage = async () => { queried++; throw new Error('must not query'); };
  f.project.agentUsage.discoverStatus = async () => { queried++; throw new Error('must not query'); };
  try {
    const client = new RPCClient(f.config.socket);
    expect((await client.request('agent.usage.config')).enabled).toBe(false);
    const config = await fetch(f.url + '/api/agent/usage/config');
    expect(config.status).toBe(200); expect(config.headers.get('cache-control')).toBe('no-store');
    expect((await config.json()).retention_days).toBe(90);
    const save = await action(f.url, { retention_days: 30, providers: ['deepseek'] });
    expect(save.status).toBe(400); expect(JSON.stringify(await save.json())).toContain('retired');
    await expect(client.request('agent.usage.configure', { config: { enabled: true } })).rejects.toThrow('retired');
    expect(f.project.agentUsageConfig().providers).toEqual([]);
    expect(fs.existsSync(path.join(f.config.home, 'agent-usage.json'))).toBe(false);
    const history = await fetch(f.url + '/api/agent/usage/history?provider=deepseek&account_key=account_one&days=30');
    expect(history.status).toBe(200); expect(history.headers.get('cache-control')).toBe('no-store');
    expect((await history.json()).series).toEqual([]); expect(queried).toBe(0);
    expect((await fetch(f.url + '/api/agent/usage/history?days=2')).status).toBe(400);
    expect((await action(f.url, { enabled: 'yes' })).status).toBe(400);
    expect((await fetch(f.url + '/api/agent/usage/config', { headers: { Origin: 'https://attacker.invalid' } })).status).toBe(403);
    expect((await action(f.url, {}, { Origin: 'https://attacker.invalid' })).status).toBe(403);
    expect((await post(f.url + '/api/action', { method: 'agent.usage.history', params: {} })).status).toBe(400);
    expect((await fetch(f.url + '/api/overview')).status).toBe(200); expect(queried).toBe(0);
  } finally { await f.close(); }
});

test('usage configuration and history require the existing login session', async () => {
  const f = await setup({ auth: { username: 'owner', password: 'test-only-password' } });
  try {
    expect((await fetch(f.url + '/api/agent/usage/config')).status).toBe(401);
    expect((await fetch(f.url + '/api/agent/usage/history')).status).toBe(401);
    expect((await action(f.url, {})).status).toBe(401);
    const login = await fetch(f.url + '/login', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'username=owner&password=test-only-password&next=%2F' });
    const Cookie = login.headers.get('set-cookie').split(';')[0];
    expect((await fetch(f.url + '/api/agent/usage/config', { headers: { Cookie } })).status).toBe(200);
    const result = await action(f.url, { retention_days: 365 }, { Cookie });
    expect(result.status).toBe(400); expect(JSON.stringify(await result.json())).toContain('retired');
  } finally { await f.close(); }
});

test('global usage routes target the project in their URL, including writes', async () => {
  const a = temp(), b = temp(), global = temp(), calls = [];
  const web = startWeb(null, 0, { env: { ...process.env, LUSH_GLOBAL_CONFIG: global }, openProject: async project => ({
    config: { project, home: path.join(project, '.lush') }, client: { async request(method, params = {}) {
      calls.push({ project, method, params }); return { project, method, params };
    } },
  }) });
  const url = `http://127.0.0.1:${web.port}`, idA = projectRouteId(fs.realpathSync(a)), idB = projectRouteId(fs.realpathSync(b));
  try {
    expect((await post(url + '/api/host/select', { project: a })).status).toBe(200);
    expect((await post(url + '/api/host/select', { project: b })).status).toBe(200); calls.length = 0;
    expect((await (await fetch(`${url}/p/${idA}/api/agent/usage/config`)).json()).project).toBe(fs.realpathSync(a));
    expect((await (await fetch(`${url}/p/${idB}/api/agent/usage/history?days=7`)).json()).project).toBe(fs.realpathSync(b));
    expect((await action(`${url}/p/${idA}`, { enabled: false })).status).toBe(200);
    expect(calls).toEqual([
      { project: fs.realpathSync(a), method: 'agent.usage.config', params: {} },
      { project: fs.realpathSync(b), method: 'agent.usage.history', params: { days: 7 } },
      { project: fs.realpathSync(a), method: 'agent.usage.configure', params: { config: { enabled: false } } },
    ]);
    expect((await fetch(url + '/api/agent/usage/config')).status).toBe(400);
    expect((await fetch(`${url}/p/${'0'.repeat(16)}/api/agent/usage/history`)).status).toBe(400);
  } finally { web.stop(true); for (const dir of [a,b,global]) fs.rmSync(dir, { recursive: true, force: true }); }
});
