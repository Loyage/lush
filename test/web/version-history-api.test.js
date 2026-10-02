import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { assertAllowed, USER_ONLY } from '../../src/rpc/registry.js';
import { startWeb } from '../../src/ui/web/server.js';
import { projectRouteId } from '../../src/host/registry.js';
import { temp } from '../helpers.js';
import { setup, fetch } from './harness.js';

const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
test('branch.history is user-only with narrow cursor/limit parameters', () => {
  expect(USER_ONLY.has('branch.history')).toBe(true);
  expect(assertAllowed('branch.history', { limit: 1 }, null)).toBeNull();
  expect(() => assertAllowed('branch.history', {}, 3)).toThrow('requires user approval');
  for (const key of ['branch', 'ref', 'cwd', 'project', 'commit']) expect(() => assertAllowed('branch.history', { [key]: 'main' }, null)).toThrow('unknown parameter');
});
test('version HTTP route is on-demand, no-store, typed and rejects extra or duplicate parameters and mutations', async () => {
  const f = await setup(), calls = [];
  f.project.branchHistory = options => { calls.push(options); return { options }; };
  try {
    await fetch(f.url + '/api/overview'); expect(calls).toHaveLength(0);
    const r = await fetch(f.url + '/api/versions?limit=2&cursor=page');
    expect(r.status).toBe(200); expect(r.headers.get('cache-control')).toBe('no-store'); expect(await r.json()).toEqual({ options: { limit: 2, cursor: 'page' } });
    for (const query of ['?limit=1&limit=2', '?branch=main', '?_token=escape', '?cursor=a&cursor=b']) expect((await fetch(f.url + '/api/versions' + query)).status).toBe(400);
    expect((await fetch(f.url + '/api/versions', { headers: { Origin: 'https://attacker.invalid' } })).status).toBe(403);
    expect((await post(f.url + '/api/action', { method: 'branch.history', params: {} })).status).toBe(400);
    expect(calls).toHaveLength(1);
  } finally { await f.close(); }
});
test('version history requires existing Web session', async () => {
  const f = await setup({ auth: { username: 'owner', password: 'test-only-password' } }); let reads = 0;
  f.project.branchHistory = () => { reads++; return {}; };
  try {
    expect((await fetch(f.url + '/api/versions')).status).toBe(401); expect(reads).toBe(0);
    const login = await fetch(f.url + '/login', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'username=owner&password=test-only-password&next=%2F' });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    expect((await fetch(f.url + '/api/versions', { headers: { Cookie: cookie } })).status).toBe(200); expect(reads).toBe(1);
  } finally { await f.close(); }
});
test('version history multi-project routes keep project identity across tabs', async () => {
  const a = temp(), b = temp(), global = temp(), calls = [];
  const web = startWeb(null, 0, { env: { ...process.env, LUSH_GLOBAL_CONFIG: global }, openProject: async project => ({
    config: { project, home: path.join(project, '.lush') }, client: { async request(method, params = {}) { calls.push({ project, method, params }); return { project }; } },
  }) });
  const url = `http://127.0.0.1:${web.port}`;
  try {
    await post(url + '/api/host/select', { project: a }); await post(url + '/api/host/select', { project: b }); calls.length = 0;
    expect(await (await fetch(`${url}/p/${projectRouteId(a)}/api/versions?limit=1`)).json()).toEqual({ project: a });
    expect(await (await fetch(`${url}/p/${projectRouteId(b)}/api/versions`)).json()).toEqual({ project: b });
    expect(calls).toEqual([{ project: a, method: 'branch.history', params: { limit: 1 } }, { project: b, method: 'branch.history', params: {} }]);
    expect((await fetch(url + '/api/versions')).status).toBe(400);
    expect((await fetch(`${url}/p/${'0'.repeat(16)}/api/versions`)).status).toBe(400);
  } finally { web.stop(true); for (const dir of [a, b, global]) fs.rmSync(dir, { recursive: true, force: true }); }
});
