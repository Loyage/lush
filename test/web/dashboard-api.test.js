import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { startWeb } from '../../src/ui/web/server.js';
import { env, temp } from '../helpers.js';
import { fetch, startTestWeb } from './auth-fixture.js';

const card = () => ({ type: 'account', connection_id: randomUUID() });
const post = (url, body, headers = {}) => fetch(url, { method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
function fixture({ authenticated = false, dashboardService, bound = false } = {}) {
  const root = temp(), global = path.join(root, 'device'), calls = [];
  const environment = env({ LUSH_GLOBAL_CONFIG: global });
  if (authenticated) {
    fs.mkdirSync(global, { mode: 0o700 });
    fs.writeFileSync(path.join(global, 'web.json'), JSON.stringify({ version: 2, username: 'owner',
      password: 'dashboard-test-password' }), { mode: 0o600 });
  }
  const projectHost = { launcher: !bound,
    async require() { calls.push('require'); throw new Error('must not attach/start daemon'); },
    async openRoute() { calls.push('openRoute'); throw new Error('must not attach/start daemon'); } };
  const options = { env: environment, projectHost, userServiceOptions: { dashboardService } };
  const config = bound ? { project: path.join(root, 'project'), home: path.join(root, 'project', '.lush'), env: environment } : null;
  const webs = [];
  function open() { const web = (authenticated ? startWeb : startTestWeb)(config, 0, options); webs.push(web); return `http://127.0.0.1:${web.port}`; }
  const url = open();
  return { url, root, global, calls, open, webs,
    async close() { await Promise.all(webs.map(web => web.stop(true))); fs.rmSync(root, { recursive: true, force: true }); } };
}

test('two Hosts and a restarted bound Host share only device card identities without a project daemon', async () => {
  const f = fixture({ bound: true });
  try {
    const second = f.open(), route = '/api/host/dashboard';
    const response = await fetch(f.url + route);
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    const initial = await response.json(); expect(initial).toMatchObject({ version: 1, cards: [] });
    expect(fs.existsSync(path.join(f.global, 'shared'))).toBe(false);
    const selected = card();
    const save = await post(f.url + route, { cards: [selected, selected], expected_revision: initial.revision });
    expect(save.status).toBe(200); const next = await save.json(); expect(next.cards).toEqual([selected]);
    expect(await (await fetch(second + route)).json()).toEqual(next);
    const stale = await post(second + route, { cards: [], expected_revision: initial.revision });
    expect(stale.status).toBe(400); const conflict = (await stale.json()).error;
    expect(conflict).toContain('可能版本已变更'); expect(conflict).toContain('重新读取');
    expect(conflict).toContain('保留编辑');
    await f.webs[0].stop(true); const restarted = f.open();
    expect(await (await fetch(restarted + route)).json()).toEqual(next);
    expect(fs.readdirSync(path.join(f.global, 'shared'))).toEqual(['dashboard.json']);
    // Mandatory login may provision .lush/web.json, but no project daemon state.
    expect(fs.readdirSync(path.join(f.root, 'project'))).toEqual(['.lush']);
    expect(fs.readdirSync(path.join(f.root, 'project', '.lush'))).toEqual(['web.json']);
    expect(f.calls).toEqual([]);
  } finally { await f.close(); }
});

test('dashboard HTTP rejects all query, token, unknown field and malformed card inputs before dependency initialization', async () => {
  let initialized = 0;
  const root = temp(), global = path.join(root, 'device');
  const web = startTestWeb(null, 0, { env: env({ LUSH_GLOBAL_CONFIG: global }), projectHost: {},
    userServiceOptions: { dashboardService: {
      get() { initialized++; throw new Error('PRIVATE'); }, save() { initialized++; throw new Error('PRIVATE'); },
    } } });
  const url = `http://127.0.0.1:${web.port}/api/host/dashboard`, selected = card();
  try {
    for (const query of ['?scope=device', '?scope=project', '?_token=abc', '?x=1&x=2', '?project_id=abc']) {
      expect((await fetch(url + query)).status).toBe(400);
      expect((await post(url + query, { cards: [], expected_revision: 'v1' })).status).toBe(400);
    }
    for (const body of [null, [], {}, { cards: [] }, { expected_revision: 'v1' }, { cards: [], expected_revision: null },
      { cards: [], expected_revision: 'v1', _token: 'private' }, { cards: [], expected_revision: 'v1', project: '/tmp' },
      { cards: [], expected_revision: 'v1', scope: 'device' }, { cards: [], expected_revision: 'v1', positions: [] },
      { cards: [null], expected_revision: 'v1' }, { cards: [{ ...selected, token: 'private' }], expected_revision: 'v1' },
      { cards: [{ ...selected, type: 'project' }], expected_revision: 'v1' },
      { cards: [{ ...selected, connection_id: 'not-uuid' }], expected_revision: 'v1' },
      { cards: Array.from({ length: 101 }, () => selected), expected_revision: 'v1' }]) {
      expect((await post(url, body)).status).toBe(400);
    }
    expect((await fetch(url, { method: 'POST', body: '{}' })).status).toBe(400);
    expect((await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'INVALID' })).status).toBe(400);
    expect((await fetch(url, { method: 'DELETE' })).status).toBe(404);
    expect((await fetch(url, { method: 'PUT' })).status).toBe(404);
    expect(initialized).toBe(0); expect(fs.readdirSync(global)).toEqual(['web.json']);
  } finally { await web.stop(true); fs.rmSync(root, { recursive: true, force: true }); }
});

test('dashboard requires login and preserves Origin/Host gates before service reads or writes', async () => {
  const calls = [], f = fixture({ authenticated: true, dashboardService: {
    get() { calls.push('get'); return { version: 1, revision: 'v1', cards: [] }; },
    save(cards) { calls.push('save'); return { version: 1, revision: 'v2', cards }; },
  } });
  try {
    const url = f.url + '/api/host/dashboard';
    const read = await fetch(url); expect(read.status).toBe(401); expect(read.headers.get('cache-control')).toBe('no-store');
    expect((await post(url, { cards: [], expected_revision: 'v1', _token: 'agent' })).status).toBe(401);
    expect((await fetch(url, { headers: { Origin: 'https://evil.invalid' } })).status).toBe(403);
    expect((await post(url, {}, { Origin: 'https://evil.invalid' })).status).toBe(403);
    expect(calls).toEqual([]);
    const login = await fetch(f.url + '/login', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'username=owner&password=dashboard-test-password' });
    expect(login.status).toBe(303); const Cookie = login.headers.get('set-cookie').split(';')[0];
    expect((await fetch(url, { headers: { Cookie } })).status).toBe(200);
    expect((await post(url, { cards: [], expected_revision: 'v1' }, { Cookie })).status).toBe(200);
    expect((await fetch(url, { headers: { Cookie, Origin: 'https://evil.invalid' } })).status).toBe(403);
    expect(calls).toEqual(['get', 'save']);
  } finally { await f.close(); }
  const local = fixture({ authenticated: true, dashboardService: { get() { throw new Error('must not reach service'); } } });
  try {
    expect((await fetch(local.url + '/api/host/dashboard', { headers: { Host: 'evil.invalid' } })).status).toBe(403);
    expect(fs.readdirSync(local.global)).toEqual(['web.json']);
  } finally { await local.close(); }
});

test('dashboard injected service failures are safely projected and Host stop closes only an instantiated dashboard service', async () => {
  const calls = [], f = fixture({ dashboardService: {
    get() { calls.push('get'); throw new Error('PRIVATE-CREDENTIAL-RESPONSE'); },
    save() { calls.push('save'); throw new Error('PRIVATE-CREDENTIAL-RESPONSE'); },
    close() { calls.push('close'); },
  } });
  try {
    const url = f.url + '/api/host/dashboard';
    const read = await fetch(url); expect(read.status).toBe(400); expect(await read.text()).not.toContain('PRIVATE');
    const save = await post(url, { cards: [], expected_revision: 'v1' });
    expect(save.status).toBe(400); const body = await save.json(); expect(body.error).not.toContain('PRIVATE');
    expect(body.error).toContain('操作未确认'); expect(body.error).toContain('可能版本已变更');
    expect(body.error).toContain('保留编辑');
    await f.webs[0].stop(true); expect(calls).toEqual(['get', 'save', 'close']);
    expect(fs.readdirSync(f.global)).toEqual(['web.json']);
  } finally { await f.close(); }
});
