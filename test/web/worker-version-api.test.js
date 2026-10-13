import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { repo, git, temp } from '../helpers.js';
import { setup, fetch } from './harness.js';
import { RPCClient } from '../../src/rpc/client.js';
import { Dispatcher } from '../../src/rpc/dispatcher.js';
import { USER_ONLY, assertAllowed } from '../../src/rpc/registry.js';
import { managementPolicy } from '../../src/rpc/management-policy.js';
import { startTestWeb } from './auth-fixture.js';
import { projectRouteId } from '../../src/host/registry.js';

const methods = ['worker.version_graph', 'worker.version_deliveries', 'worker.version_commit'];
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('real HTTP → RPC registration → user permission → SQLite/Git returns compact snapshot and lazy details without writes', async () => {
  const f = await setup(); f.project.stopping = true; f.project.kick = () => {}; f.project.scheduleTaskMerge = () => {};
  try {
    await repo(f.root); const { task } = await f.project.order('public order');
    fs.writeFileSync(path.join(task.workspace, 'new.txt'), 'development'); await git(task.workspace, 'add', '.');
    await git(task.workspace, 'commit', '-m', '真实开发\n\nlong body'); const tip = await git(task.workspace, 'rev-parse', 'HEAD');
    f.store.update(task.id, { retry_profile: JSON.stringify({ secret: 'never expose' }) });
    const before = await git(task.workspace, 'status', '--porcelain'), eventCount = f.store.get('SELECT COUNT(*) AS n FROM events').n;
    const graphResponse = await fetch(`${f.url}/api/worker/${task.id}/version-graph?limit=1`);
    expect(graphResponse.status).toBe(200); expect(graphResponse.headers.get('cache-control')).toBe('no-store');
    const graph = await graphResponse.json(); expect(graph).toMatchObject({ scope: 'current', tip, worker: { id: task.id, worker_number: task.worker_number } });
    expect(graph.commits[0].tasks[0].goal).toBeUndefined(); expect(JSON.stringify(graph)).not.toContain('public order');
    const detail = await (await fetch(`${f.url}/api/worker/${task.id}/version-commit?snapshot=${encodeURIComponent(graph.snapshot)}&commit=${tip}`)).json();
    expect(detail.commit.message).toBe('真实开发\n\nlong body'); expect(detail.commit.tasks[0].input.content).toBe('public order');
    expect(JSON.stringify(detail)).not.toContain('never expose');
    expect(await (await fetch(`${f.url}/api/worker/${task.id}/version-deliveries?limit=1`)).json()).toMatchObject({ deliveries: [], has_more: false });
    const client = new RPCClient(f.config.socket);
    expect((await client.request('worker.version_graph', { id: task.id })).tip).toBe(tip);
    expect((await client.request('worker.version_commit', { id: task.id, snapshot: graph.snapshot, commit: tip })).commit.commit).toBe(tip);
    expect(await client.request('worker.version_deliveries', { id: task.id })).toMatchObject({ deliveries: [] });
    for (const method of methods) {
      expect(USER_ONLY.has(method)).toBe(true); expect(managementPolicy(method).access).toBe('unavailable');
      expect(() => assertAllowed(method, { id: task.id }, task.id)).toThrow('requires user approval');
      await expect(client.request(method, { id: task.id, branch: task.branch })).rejects.toThrow('unknown parameter');
    }
    expect(await git(task.workspace, 'status', '--porcelain')).toBe(before); expect(f.store.get('SELECT COUNT(*) AS n FROM events').n).toBe(eventCount);
    const tree = await git(task.workspace, 'rev-parse', `${tip}^{tree}`), landed = await git(f.root, 'commit-tree', tree, '-p', task.base_commit, '-m', 'fixed landing');
    await git(f.root, 'update-ref', 'refs/heads/main', landed);
    const delivery = f.store.event(task.id, 'task.merge_integrated', { source_commit: tip, commit: landed, parent_id: task.parent_id, squash: true });
    const fixed = await (await fetch(`${f.url}/api/worker/${task.id}/version-graph?delivery=${delivery}`)).json(); expect(fixed).toMatchObject({ scope: 'delivery', delivery, tip });
    const list = await (await fetch(`${f.url}/api/worker/${task.id}/version-deliveries`)).json(); expect(list.deliveries[0]).toMatchObject({ delivery_id: delivery, source_commit: tip, commit: landed, delivery_available: true });
    expect(typeof list.deliveries[0].delivered_at).toBe('string');
  } finally { await f.close(); }
});

test('new RPC handlers reject live/expired Agent identity, HTTP rejects unknown/duplicate/type/action/Origin/Host escapes', async () => {
  const f = await setup(), calls = [];
  for (const [name, method] of [['workerVersionGraph', methods[0]], ['workerVersionDeliveries', methods[1]], ['workerVersionCommit', methods[2]]])
    f.project[name] = params => { calls.push({ method, params }); return params; };
  try {
    const rpc = new Dispatcher({ actor(token) { if (token === 'live') return 2; if (token) throw new Error('expired token'); return null; } });
    for (const method of methods) {
      await expect(rpc.dispatch(method, { id: 2, _token: 'live' })).rejects.toThrow('requires user approval');
      await expect(rpc.dispatch(method, { id: 2, _token: 'expired' })).rejects.toThrow('expired token');
    }
    const paths = ['version-graph','version-deliveries','version-commit'];
    for (const suffix of paths) {
      const url = `${f.url}/api/worker/2/${suffix}`;
      expect((await fetch(url)).status).toBe(200);
      for (const q of ['?id=3','?ref=main','?_token=live','?limit=1&limit=2','?limit=01','?limit=1.0','?limit=-1','?limit=9007199254740992', '?cursor=x&cursor=y', '?snapshot=x&snapshot=y'])
        expect((await fetch(url + q)).status).toBe(400);
      expect((await fetch(url, { headers: { Origin: 'https://attacker.invalid' } })).status).toBe(403);
      expect((await fetch(url, { headers: { Host: 'attacker.invalid' } })).status).toBe(403);
      expect((await post(url, {})).status).toBe(404);
      expect((await post(f.url + '/api/action', { method: 'worker.' + suffix.replace('-', '_'), params: { id: 2 } })).status).toBe(400);
    }
    expect(calls).toHaveLength(3);
  } finally { await f.close(); }
});

test('Worker version reads require a logged-in Web session', async () => {
  const f = await setup({ auth: { username: 'owner', password: 'test-only-password' } }); let reads = 0;
  f.project.workerVersionGraph = f.project.workerVersionDeliveries = f.project.workerVersionCommit = () => { reads++; return {}; };
  try {
    for (const suffix of ['version-graph','version-deliveries','version-commit']) expect((await fetch(`${f.url}/api/worker/2/${suffix}`)).status).toBe(401);
    expect(reads).toBe(0);
    const login = await fetch(f.url + '/login', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'username=owner&password=test-only-password&next=%2F' });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    for (const suffix of ['version-graph','version-deliveries','version-commit']) expect((await fetch(`${f.url}/api/worker/2/${suffix}`, { headers: { Cookie: cookie } })).status).toBe(200);
    expect(reads).toBe(3);
  } finally { await f.close(); }
});

test('Host Worker version routing preserves explicit project identity across tabs', async () => {
  const a = temp(), b = temp(), global = temp(), calls = [];
  const web = startTestWeb(null, 0, { env: { ...process.env, LUSH_GLOBAL_CONFIG: global }, openProject: async project => ({
    config: { project, home: path.join(project, '.lush') }, client: { async request(method, params) { calls.push({ project, method, params }); return { project }; } },
  }) });
  const url = `http://127.0.0.1:${web.port}`;
  try {
    await post(url + '/api/host/select', { project: a }); await post(url + '/api/host/select', { project: b }); calls.length = 0;
    for (const project of [a, b]) for (const suffix of ['version-graph','version-deliveries','version-commit'])
      expect(await (await fetch(`${url}/p/${projectRouteId(project)}/api/worker/2/${suffix}`)).json()).toEqual({ project });
    expect(calls).toHaveLength(6); expect(calls[0]).toEqual({ project: a, method: methods[0], params: { id: 2 } });
    expect(calls[5]).toEqual({ project: b, method: methods[2], params: { id: 2 } });
    expect((await fetch(url + '/api/worker/2/version-graph')).status).toBe(400);
    expect((await fetch(`${url}/p/${'0'.repeat(16)}/api/worker/2/version-deliveries`)).status).toBe(400);
  } finally { web.stop(true); for (const dir of [a, b, global]) fs.rmSync(dir, { recursive: true, force: true }); }
});
