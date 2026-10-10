import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { startWeb } from '../../src/ui/web/server.js';
import { projectRouteId } from '../../src/host/registry.js';
import { DeviceSettingsService } from '../../src/host/device-settings.js';
import { temp, env } from '../helpers.js';
import { fetch } from './harness.js';

const post = (url, body, headers = {}) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
const action = (url, method, params) => post(`${url}/api/host/settings/action`, { method, params: { ...params, scope: 'device' } });

function host(options = {}) {
  const root = temp(), global = path.join(root, 'global'); let opened = 0;
  const web = startWeb(null, 0, { env: env({ LUSH_GLOBAL_CONFIG: global }),
    openProject: async () => { opened++; throw new Error('unexpected project startup'); }, ...options });
  return { root, global, web, url: `http://127.0.0.1:${web.port}`, opened: () => opened,
    async close() { await web.stop(true); fs.rmSync(root, { recursive: true, force: true }); } };
}

test('unselected Host edits runtime, Agent, sources, network and explanation without a Project or daemon', async () => {
  const f = host();
  try {
    const runtime = await fetch(`${f.url}/api/host/settings/runtime`);
    expect(runtime.status).toBe(200); expect(runtime.headers.get('cache-control')).toBe('no-store');
    expect((await runtime.json()).configuration_scope).toMatchObject({ selected: 'device', project_home: null });
    expect((await action(f.url, 'system.configure', { settings: { concurrency: 3 } })).status).toBe(200);
    expect((await (await fetch(`${f.url}/api/host/settings/runtime`)).json()).concurrency).toMatchObject({ value: 3, source: 'device' });
    const agent = await action(f.url, 'agent.configure', { config: { version: 1, default: { agent: 'pi', config_mode: 'pi' }, roles: {} } });
    expect(agent.status).toBe(200);
    expect((await (await fetch(`${f.url}/api/host/settings/agent/config`)).json()).default.config_mode).toBe('pi');
    const saved = await action(f.url, 'agent.connections.save', { connection: { label: 'shared', provider: 'deepseek', auth_type: 'api_key', models: ['deepseek-chat'] },
      credential: { api_key: 'PRIVATE-ACTUAL-API-KEY' } });
    expect(saved.status).toBe(200); const source = await saved.json();
    expect(source.storage_scope).toBe('device'); expect(JSON.stringify(source)).not.toContain('PRIVATE');
    const list = await (await fetch(`${f.url}/api/host/settings/agent/connections`)).json();
    expect(list.connections[0].id).toBe(source.id); expect(list.connections[0].consumers).toEqual([]);
    expect(list.history_available).toBe(false); expect(JSON.stringify(list)).not.toContain('PRIVATE');
    const explanation = await action(f.url, 'quick_explain.configure', { config: { connection_id: source.id, model: 'deepseek-chat', prompt: '简洁解释' } });
    expect(explanation.status).toBe(200); expect((await explanation.json()).ready).toBe(true);
    const proxy = await action(f.url, 'agent.network.configure', { config: { version: 1, mode: 'proxy', proxy_url: 'http://127.0.0.1:7897', no_proxy: [],
      proxy_auth: { username: 'PRIVATE-USER', password: 'PRIVATE-PASSWORD' } } });
    expect(proxy.status).toBe(200); expect(await proxy.text()).not.toContain('PRIVATE');
    expect((await (await fetch(`${f.url}/api/host/settings/agent/network`)).json()).has_proxy_auth).toBe(true);
    expect(f.opened()).toBe(0); expect(fs.existsSync(path.join(f.root, '.lush'))).toBe(false);
    expect(fs.statSync(path.join(f.global, 'shared', 'credentials', 'agent-connections.json')).mode & 0o777).toBe(0o600);
    expect((await (await fetch(`${f.url}/api/host/projects`)).json()).projects).toEqual([]);
  } finally { await f.close(); }
});

test('Host settings cannot become a Worker, model-call, migration, arbitrary-path or token gateway', async () => {
  const f = host();
  try {
    for (const method of ['order.submit', 'worker.configure', 'quick_explain.start', 'settings.migration.apply', 'settings.clear_override', 'agent.connections.history']) {
      expect((await action(f.url, method, {})).status).toBe(400);
    }
    for (const params of [{ scope: 'project', config: {} }, { scope: 'device', config: {}, _token: '' }, { scope: 'device', config: {}, project: '/tmp/elsewhere' }]) {
      expect((await post(`${f.url}/api/host/settings/action`, { method: 'agent.configure', params })).status).toBe(400);
    }
    for (const suffix of ['runtime?scope=project', 'runtime?scope=device&scope=device', 'agent/config?project=/tmp', 'worker/1', 'quick-explain/history']) {
      const response = await fetch(`${f.url}/api/host/settings/${suffix}`); expect([400, 404]).toContain(response.status);
    }
    expect((await fetch(`${f.url}/api/host/settings/runtime`, { headers: { Origin: 'https://evil.invalid' } })).status).toBe(403);
    expect((await post(`${f.url}/api/host/settings/action`, { method: 'system.configure', params: { settings: { concurrency: 2 }, scope: 'device' } }, { Origin: 'https://evil.invalid' })).status).toBe(403);
    expect((await fetch(`${f.url}/api/host/settings/action`, { method: 'POST', body: '{}' })).status).toBe(400);
    expect(f.opened()).toBe(0);
  } finally { await f.close(); }
});

test('selected project routes forward device scope without losing project identity or moving history', async () => {
  const a = temp(), b = temp(), global = temp(), calls = [];
  const web = startWeb(null, 0, { env: env({ LUSH_GLOBAL_CONFIG: global }), openProject: async project => ({
    config: { project, home: path.join(project, '.lush') }, client: { async request(method, params = {}) { calls.push({ project, method, params }); return { ok: true }; } },
  }) });
  const url = `http://127.0.0.1:${web.port}`, idA = projectRouteId(a), idB = projectRouteId(b);
  try {
    await post(`${url}/api/host/select`, { project: a }); await post(`${url}/api/host/select`, { project: b }); calls.length = 0;
    for (const [project, route, method, params] of [
      [a, `/p/${idA}/api/settings/runtime?scope=device`, 'system.settings', { scope: 'device' }],
      [b, `/p/${idB}/api/agent/config?scope=device`, 'agent.config', { scope: 'device' }],
      [a, `/p/${idA}/api/agent/environment?scope=device&target=common`, 'agent.environment', { scope: 'device', target: 'common' }],
      [b, `/p/${idB}/api/quick-explain/config?scope=device`, 'quick_explain.config', { scope: 'device' }],
      [a, `/p/${idA}/api/settings/migration`, 'settings.migration.preview', {}],
    ]) {
      expect((await fetch(url + route)).status).toBe(200); expect(calls.at(-1)).toEqual({ project, method, params });
    }
    const count = calls.length;
    expect((await fetch(`${url}/p/${idA}/api/agent/config?scope=project`)).status).toBe(400);
    expect((await fetch(`${url}/p/${idA}/api/agent/config?scope=all`)).status).toBe(400);
    expect((await fetch(`${url}/p/${idA}/api/agent/config?scope=device&scope=project`)).status).toBe(400);
    expect((await fetch(`${url}/p/${idA}/api/quick-explain/history?scope=device`)).status).toBe(400);
    expect((await fetch(`${url}/p/${idA}/api/agent/connections/history?id=id&scope=device`)).status).toBe(400);
    expect(calls.length).toBe(count);
  } finally { await web.stop(true); for (const dir of [a, b, global]) fs.rmSync(dir, { recursive: true, force: true }); }
});

test('shared management requires Host authentication even when no project is selected', async () => {
  const root = temp(), global = path.join(root, 'global'); fs.mkdirSync(global, { mode: 0o700 });
  fs.writeFileSync(path.join(global, 'web.json'), JSON.stringify({ version: 1, username: 'owner', password: 'test-device-settings-password', projects: [root] }), { mode: 0o600 });
  const web = startWeb(null, 0, { env: env({ LUSH_GLOBAL_CONFIG: global }), openProject: async () => { throw new Error('no startup'); } });
  const url = `http://127.0.0.1:${web.port}`;
  try {
    expect((await fetch(`${url}/api/host/settings/runtime`)).status).toBe(401);
    expect((await action(url, 'system.configure', { settings: { concurrency: 2 } })).status).toBe(401);
    const login = await fetch(`${url}/login`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'username=owner&password=test-device-settings-password' });
    const Cookie = login.headers.get('set-cookie').split(';')[0];
    expect((await fetch(`${url}/api/host/settings/runtime`, { headers: { Cookie } })).status).toBe(200);
  } finally { await web.stop(true); fs.rmSync(root, { recursive: true, force: true }); }
});

test('Host saves use current shared runtime defaults and reject project-relative resources without a project', async () => {
  const root = temp(), service = new DeviceSettingsService(env({ LUSH_GLOBAL_CONFIG: root }));
  try {
    await service.request('agent.config');
    const runtime = await service.request('system.configure', { settings: { progress_reporting: false } });
    expect(runtime.configuration_scope).toMatchObject({ selected: 'device', source: 'mixed', project_override: false });
    const profile = { version: 1, default: { agent: 'pi', config_mode: 'lush', extensions: [], skills: [] }, roles: {} };
    const saved = await service.request('agent.configure', { config: profile });
    expect(saved.options.default_prompts.agent).not.toContain('lush progress');
    const file = path.join(root, 'shared', 'agent.json'), before = fs.readFileSync(file, 'utf8');
    await expect(service.request('agent.configure', { config: { ...profile,
      default: { ...profile.default, extensions: ['./needs-project.mjs'] } } })).rejects.toThrow('设备设置操作失败');
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    expect(service.config.project).toBeNull();
  } finally { await service.stop(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('Host readers refuse an unsafe shared root before exposing configuration contents', async () => {
  const root = temp(), shared = path.join(root, 'shared'); fs.mkdirSync(shared, { mode: 0o700 }); fs.chmodSync(shared, 0o755);
  fs.writeFileSync(path.join(shared, 'agent.json'), JSON.stringify({ version: 1, default: { agent: 'pi', append_prompt: 'PRIVATE-PROMPT' }, roles: {} }), { mode: 0o600 });
  const service = new DeviceSettingsService(env({ LUSH_GLOBAL_CONFIG: root }));
  try {
    try { await service.request('agent.config'); throw new Error('expected rejection'); }
    catch (error) { expect(error.message).toBe('设备设置操作失败，请检查配置、私有文件权限或重试。'); expect(error.message).not.toContain('PRIVATE'); }
    expect(fs.statSync(shared).mode & 0o777).toBe(0o755);
  } finally { await service.stop(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('stopping Host settings closes its scoped service without creating resources on read', async () => {
  const root = temp(), service = new DeviceSettingsService(env({ LUSH_GLOBAL_CONFIG: root }));
  try {
    expect((await service.request('agent.config', { scope: 'device' })).configuration_scope.project_home).toBeNull();
    expect(fs.existsSync(path.join(root, 'shared'))).toBe(false);
    await service.stop();
    await expect(service.request('agent.config')).rejects.toThrow('stopping');
  } finally { await service.stop(); fs.rmSync(root, { recursive: true, force: true }); }
});
