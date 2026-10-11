import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { assertAllowed, USER_ONLY } from '../../src/rpc/registry.js';
import { Dispatcher } from '../../src/rpc/dispatcher.js';
import { RPCClient } from '../../src/rpc/client.js';
import { startTestWeb as startWeb } from './auth-fixture.js';
import { projectRouteId } from '../../src/host/registry.js';
import { temp, repo, git } from '../helpers.js';
import { setup, fetch } from './harness.js';

const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
test('version_graph RPC is user-only, narrow and read-only through real Dispatcher including live/expired Agent identity', async () => {
  expect(USER_ONLY.has('branch.version_graph')).toBe(true);
  expect(assertAllowed('branch.version_graph', { delivery: 12, cursor: 'page', limit: 2 }, null)).toBeNull();
  expect(() => assertAllowed('branch.version_graph', {}, 3)).toThrow('requires user approval');
  for (const key of ['branch', 'ref', 'cwd', 'project', 'commit', 'source_commit', 'base', 'event_max'])
    expect(() => assertAllowed('branch.version_graph', { [key]: 'main' }, null)).toThrow('unknown parameter');
  const calls = [], project = { actor(token) { if (token === undefined) return null; if (token !== 'live') throw new Error('expired token'); return 3; },
    branchVersionGraph(options) { calls.push(options); return { options }; } };
  const rpc = new Dispatcher(project);
  expect(await rpc.dispatch('branch.version_graph', { delivery: 12 })).toEqual({ options: { delivery: 12 } });
  await expect(rpc.dispatch('branch.version_graph', { _token: 'live' })).rejects.toThrow('requires user approval');
  await expect(rpc.dispatch('branch.version_graph', { _token: 'expired' })).rejects.toThrow('expired token');
  await expect(rpc.dispatch('branch.version_graph', { ref: 'main' })).rejects.toThrow('unknown parameter'); expect(calls).toHaveLength(1);
});

test('HTTP graph is on-demand/no-store with strict typed query, Origin/Host and action/token/method boundaries', async () => {
  const f = await setup(), calls = [];
  f.project.branchVersionGraph = options => { calls.push(options); return { options }; };
  try {
    await fetch(f.url + '/api/overview'); expect(calls).toHaveLength(0);
    const result = await fetch(f.url + '/api/version-graph?delivery=123&limit=2&cursor=page');
    expect(result.status).toBe(200); expect(result.headers.get('cache-control')).toBe('no-store');
    expect(await result.json()).toEqual({ options: { delivery: 123, limit: 2, cursor: 'page' } });
    for (const query of ['?delivery=1&delivery=2', '?cursor=a&cursor=b', '?limit=1&limit=2', '?ref=main', '?branch=main', '?_token=escape',
      '?delivery=0', '?delivery=-1', '?delivery=01', '?delivery=', '?delivery=1.0', '?delivery=1e2', '?delivery=9007199254740992', '?limit=', '?limit=1.5'])
      expect((await fetch(f.url + '/api/version-graph' + query)).status).toBe(400);
    expect((await fetch(f.url + '/api/version-graph', { headers: { Origin: 'https://attacker.invalid' } })).status).toBe(403);
    expect((await fetch(f.url + '/api/version-graph', { headers: { Host: 'attacker.invalid' } })).status).toBe(403);
    expect((await post(f.url + '/api/action', { method: 'branch.version_graph', params: {} })).status).toBe(400);
    expect((await post(f.url + '/api/version-graph', {})).status).toBe(404); expect(calls).toHaveLength(1);
  } finally { await f.close(); }
});

test('graph HTTP needs Web authentication and never reads data until an existing session is authorized', async () => {
  const f = await setup({ auth: { username: 'owner', password: 'test-only-password' } }); let reads = 0;
  f.project.branchVersionGraph = () => { reads++; return {}; };
  try {
    expect((await fetch(f.url + '/api/version-graph')).status).toBe(401); expect(reads).toBe(0);
    const login = await fetch(f.url + '/login', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'username=owner&password=test-only-password&next=%2F' });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    expect((await fetch(f.url + '/api/version-graph', { headers: { Cookie: cookie } })).status).toBe(200); expect(reads).toBe(1);
  } finally { await f.close(); }
});

test('project graph routing stays isolated across tabs and rejects root/unknown projects without fallback', async () => {
  const a = temp(), b = temp(), global = temp(), calls = [];
  const web = startWeb(null, 0, { env: { ...process.env, LUSH_GLOBAL_CONFIG: global }, openProject: async project => ({
    config: { project, home: path.join(project, '.lush') }, client: { async request(method, params = {}) { calls.push({ project, method, params }); return { project }; } },
  }) });
  const url = `http://127.0.0.1:${web.port}`;
  try {
    await post(url + '/api/host/select', { project: a }); await post(url + '/api/host/select', { project: b }); calls.length = 0;
    expect(await (await fetch(`${url}/p/${projectRouteId(a)}/api/version-graph?delivery=17&limit=1`)).json()).toEqual({ project: a });
    expect(await (await fetch(`${url}/p/${projectRouteId(b)}/api/version-graph`)).json()).toEqual({ project: b });
    expect(calls).toEqual([{ project: a, method: 'branch.version_graph', params: { delivery: 17, limit: 1 } }, { project: b, method: 'branch.version_graph', params: {} }]);
    expect((await fetch(url + '/api/version-graph')).status).toBe(400);
    expect((await fetch(`${url}/p/${'0'.repeat(16)}/api/version-graph`)).status).toBe(400); expect(calls).toHaveLength(2);
  } finally { web.stop(true); for (const dir of [a, b, global]) fs.rmSync(dir, { recursive: true, force: true }); }
});

test('temporary real HTTP → RPC → SQLite/Git returns successful Event identity and fixed source, never private Worker settings', async () => {
  const f = await setup();
  try {
    await repo(f.root); const base = await git(f.root, 'rev-parse', 'HEAD'), main = await f.project.bootstrapMain();
    const t = f.store.create({ role: 'agent', goal: 'real graph', task_kind: 'order', parent_id: main.id });
    f.store.update(t.id, { branch: 'feature', base_commit: base, retry_profile: JSON.stringify({ secret: 'do not leak' }) });
    await git(f.root, 'checkout', '-b', 'feature'); fs.writeFileSync(path.join(f.root, 'source.txt'), 'source');
    await git(f.root, 'add', 'source.txt'); await git(f.root, 'commit', '-m', 'feature source'); const source = await git(f.root, 'rev-parse', 'HEAD');
    const tree = await git(f.root, 'rev-parse', `${source}^{tree}`), landed = await git(f.root, 'commit-tree', tree, '-p', base, '-m', 'landing'); await git(f.root, 'update-ref', 'refs/heads/main', landed);
    const delivery = f.store.event(t.id, 'task.merge_integrated', { commit: landed, source_commit: source, parent_id: main.id, delivery_id: 987654, squash: true });
    const mainResult = await (await fetch(f.url + '/api/version-graph')).json();
    expect(mainResult.commits[0].tasks[0]).toMatchObject({ id: t.id, delivery_id: delivery, delivery_available: true });
    const result = await (await fetch(f.url + `/api/version-graph?delivery=${delivery}`)).json();
    expect(result).toMatchObject({ scope: 'delivery', delivery, tip: source, base, worker: { id: t.id } }); expect(result.commits[0].commit).toBe(source);
    expect(JSON.stringify(result)).not.toContain('do not leak');
    expect((await fetch(f.url + '/api/version-graph?delivery=987654')).status).toBe(400);
    const client = new RPCClient(f.config.socket);
    expect((await client.request('branch.version_graph', { delivery })).tip).toBe(source);
    await expect(client.request('branch.version_graph', { delivery: t.id, branch: 'feature' })).rejects.toThrow('unknown parameter');
  } finally { await f.close(); }
});
