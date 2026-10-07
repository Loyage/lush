import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { RPCClient } from '../../src/rpc/client.js';
import { PARAMS, USER_ONLY, assertAllowed } from '../../src/rpc/registry.js';
import { startWeb } from '../../src/ui/web/server.js';
import { projectRouteId } from '../../src/host/registry.js';
import { temp } from '../helpers.js';
import { setup, fetch } from './harness.js';

const model = project => ({ version: 2, checked_at: '2026-01-01T00:00:00.000Z',
  scope: { project, note: 'software versions only' }, software: ['pi', 'codex'].map(agent => ({ agent, command: agent,
    executable: `/bin/${agent}`, real_path: `/bin/${agent}`, version: '1.2.3', status: 'available', warning: null })), warnings: [] });
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('agent.status accepts only an optional configuration scope and remains user-only', () => {
  expect(PARAMS['agent.status']).toEqual(['scope']); expect(USER_ONLY.has('agent.status')).toBe(true);
  expect(assertAllowed('agent.status', {}, null)).toBeNull();
  expect(() => assertAllowed('agent.status', {}, 47)).toThrow('requires user approval');
  expect(() => assertAllowed('agent.status', { project: '/other' }, null)).toThrow('unknown parameter');
});

test('GET agent status forwards the narrow user RPC, is no-store, and never runs during overview reads', async () => {
  const f = await setup();
  let queries = 0; f.project.agentStatus = () => { queries++; return model(f.root); };
  try {
    const client = new RPCClient(f.config.socket);
    expect(await client.request('agent.status')).toEqual(model(f.root));
    queries = 0;
    expect((await fetch(f.url + '/api/overview')).status).toBe(200);
    expect((await fetch(f.url + '/api/snapshot')).status).toBe(200);
    expect(queries).toBe(0);
    const result = await fetch(f.url + '/api/agent/status');
    expect(result.status).toBe(200); expect(result.headers.get('cache-control')).toBe('no-store');
    expect(await result.json()).toEqual(model(f.root)); expect(queries).toBe(1);
    expect((await post(f.url + '/api/action', { method: 'agent.status', params: {} })).status).toBe(400);
    expect((await fetch(f.url + '/api/agent/status', { headers: { Origin: 'https://attacker.invalid' } })).status).toBe(403);
    expect(queries).toBe(1);
  } finally { await f.close(); }
});

test('status requires the existing Web login session', async () => {
  const f = await setup({ auth: { username: 'owner', password: 'test-only-password' } });
  let queries = 0; f.project.agentStatus = () => { queries++; return model(f.root); };
  try {
    expect((await fetch(f.url + '/api/agent/status')).status).toBe(401); expect(queries).toBe(0);
    const login = await fetch(f.url + '/login', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'username=owner&password=test-only-password&next=%2F' });
    expect(login.status).toBe(303);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const value = await fetch(f.url + '/api/agent/status', { headers: { Cookie: cookie } });
    expect(value.status).toBe(200); expect(await value.json()).toEqual(model(f.root)); expect(queries).toBe(1);
  } finally { await f.close(); }
});

test('global Host status route belongs to the identity in the URL, never the last-opened project', async () => {
  const a = temp(), b = temp(), global = temp(), calls = [];
  const web = startWeb(null, 0, { env: { ...process.env, LUSH_GLOBAL_CONFIG: global }, openProject: async project => ({
    config: { project, home: path.join(project, '.lush') }, client: { async request(method, params = {}) {
      calls.push({ project, method, params }); return model(project);
    } },
  }) });
  const url = `http://127.0.0.1:${web.port}`, idA = projectRouteId(fs.realpathSync(a)), idB = projectRouteId(fs.realpathSync(b));
  try {
    expect((await post(url + '/api/host/select', { project: a })).status).toBe(200);
    expect((await post(url + '/api/host/select', { project: b })).status).toBe(200);
    calls.length = 0;
    expect((await (await fetch(`${url}/p/${idA}/api/agent/status`)).json()).scope.project).toBe(fs.realpathSync(a));
    expect((await (await fetch(`${url}/p/${idB}/api/agent/status`)).json()).scope.project).toBe(fs.realpathSync(b));
    expect(calls).toEqual([{ project: fs.realpathSync(a), method: 'agent.status', params: {} },
      { project: fs.realpathSync(b), method: 'agent.status', params: {} }]);
    expect((await fetch(url + '/api/agent/status')).status).toBe(400);
    expect((await fetch(`${url}/p/${'0'.repeat(16)}/api/agent/status`)).status).toBe(400);
    expect(calls).toHaveLength(2);
  } finally {
    web.stop(true); for (const dir of [a, b, global]) fs.rmSync(dir, { recursive: true, force: true });
  }
});
