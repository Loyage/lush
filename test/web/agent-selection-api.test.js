import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { PARAMS, USER_ONLY, assertAllowed } from '../../src/rpc/registry.js';
import { RPCClient } from '../../src/rpc/client.js';
import { startWeb } from '../../src/ui/web/server.js';
import { projectRouteId } from '../../src/host/registry.js';
import { temp } from '../helpers.js';
import { setup, fetch } from './harness.js';
import { install, connection, ManagerStub } from '../project/agent-connection-fixture.js';

const method = 'agent.selection.resources', route = '/api/agent/selection/resources';
const post = (url, body, headers = {}) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
const generic = () => new ManagerStub([connection({ provider: 'openai-compatible', endpoint: 'https://custom.invalid/v1', models: ['chat'] })]);

test('selection resource RPC is a narrow user-only safe read, not a way to install or run a strategy', () => {
  expect(PARAMS[method]).toEqual([]); expect(USER_ONLY.has(method)).toBe(true);
  expect(assertAllowed(method, {}, null)).toBeNull();
  expect(() => assertAllowed(method, {}, 99)).toThrow('requires user approval');
  for (const params of [{ strategy: 'SECRET' }, { refresh: true }, { worker_id: 9 }, { connection_id: 'conn-one' }]) {
    expect(() => assertAllowed(method, params, null)).toThrow('unknown parameter');
  }
  for (const name of ['agent.selection.configure', 'agent.selection.select', 'agent.selection.strategy']) {
    expect(() => assertAllowed(name, {}, null)).toThrow('unknown method');
  }
  expect(PARAMS['worker.retry']).toEqual(['id', 'profile']);
  expect(() => assertAllowed('worker.retry', { id: 9, profile: {}, strategy: 'SECRET' }, null)).toThrow('unknown parameter');
});

test('selection resources pass through real RPC and HTTP as local no-store data without secret or balance probes', async () => {
  const f = await setup(), manager = generic(); install(f, { manager });
  try {
    const direct = await new RPCClient(f.config.socket).request(method);
    expect(direct.connections[0]).toMatchObject({ provider: 'openai-compatible', endpoint: 'https://custom.invalid/v1',
      models: ['chat'], supported_agents: ['pi'], observation: { status: 'unknown', resources: [] } });
    const response = await fetch(f.url + route);
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
    const value = await response.json();
    expect(value.connections).toEqual(direct.connections);
    expect(JSON.stringify(value)).not.toMatch(/test-secret|MUST_NOT_RETURN/);
    expect(manager.calls).toBe(0);
    expect(f.store.get('SELECT COUNT(*) AS n FROM events').n).toBe(0);
  } finally { await f.close(); }
});

test('selection resource HTTP rejects query parameters, POST action and cross-origin access', async () => {
  const f = await setup(); install(f, { manager: generic() });
  try {
    for (const query of ['?id=conn-one', '?refresh=true', '?secret=SECRET', '?id=a&id=b']) {
      expect((await fetch(f.url + route + query)).status).toBe(400);
    }
    expect((await fetch(f.url + route, { headers: { Origin: 'https://attacker.invalid' } })).status).toBe(403);
    expect((await post(f.url + '/api/action', { method, params: {} })).status).toBe(400);
    expect((await post(f.url + '/api/action', { method: 'agent.selection.configure', params: { strategy: 'SECRET' } })).status).toBe(400);
    expect((await fetch(f.url + '/api/agent/selection/credentials')).status).toBe(404);
    expect((await fetch(f.url + route, { method: 'POST' })).status).not.toBe(200);
  } finally { await f.close(); }
});

test('selection resources require the existing Web login and preserve the user session protections', async () => {
  const f = await setup({ auth: { username: 'owner', password: 'test-only-password' } }); install(f, { manager: generic() });
  try {
    expect((await fetch(f.url + route)).status).toBe(401);
    const login = await fetch(f.url + '/login', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'username=owner&password=test-only-password&next=%2F' });
    const Cookie = login.headers.get('set-cookie').split(';')[0];
    expect((await fetch(f.url + route, { headers: { Cookie } })).status).toBe(200);
    expect((await fetch(f.url + route, { headers: { Cookie, Origin: 'https://attacker.invalid' } })).status).toBe(403);
  } finally { await f.close(); }
});

test('global selection resource reads remain attached to their project identity, not the last selected page', async () => {
  const a = temp(), b = temp(), global = temp(), calls = [];
  const web = startWeb(null, 0, { env: { ...process.env, LUSH_GLOBAL_CONFIG: global }, openProject: async project => ({
    config: { project, home: path.join(project, '.lush') },
    client: { async request(method, params = {}) { calls.push({ project, method, params }); return { project, method }; } },
  }) });
  const url = `http://127.0.0.1:${web.port}`, idA = projectRouteId(fs.realpathSync(a)), idB = projectRouteId(fs.realpathSync(b));
  try {
    expect((await post(url + '/api/host/select', { project: a })).status).toBe(200);
    expect((await post(url + '/api/host/select', { project: b })).status).toBe(200); calls.length = 0;
    expect((await (await fetch(`${url}/p/${idA}${route}`)).json()).project).toBe(fs.realpathSync(a));
    expect((await (await fetch(`${url}/p/${idB}${route}`)).json()).project).toBe(fs.realpathSync(b));
    expect(calls).toEqual([
      { project: fs.realpathSync(a), method, params: {} }, { project: fs.realpathSync(b), method, params: {} },
    ]);
    expect((await fetch(url + route)).status).toBe(400);
    expect((await fetch(`${url}/p/${'0'.repeat(16)}${route}`)).status).toBe(400);
  } finally { web.stop(true); for (const dir of [a, b, global]) fs.rmSync(dir, { recursive: true, force: true }); }
});
