import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { RPCClient } from '../../src/rpc/client.js';
import { PARAMS, USER_ONLY, assertAllowed } from '../../src/rpc/registry.js';
import { startWeb } from '../../src/ui/web/server.js';
import { projectRouteId } from '../../src/host/registry.js';
import { temp } from '../helpers.js';
import { setup, fetch } from './harness.js';

const methods = ['task.code_state', 'task.code_tree', 'task.code_file'];
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const projection = (task_id, options) => ({ version: 1, task_id, ...options });

test('code reads are strictly user-only and reject arbitrary filesystem/ref inputs', () => {
  for (const method of methods) {
    expect(USER_ONLY.has(method)).toBe(true); expect(assertAllowed(method, { id: 7 }, null)).toBeNull();
    expect(() => assertAllowed(method, { id: 7 }, 3)).toThrow('requires user approval');
    for (const key of ['cwd', 'project', 'ref', 'commit']) expect(() => assertAllowed(method, { id: 7, [key]: '/other' }, null)).toThrow('unknown parameter');
  }
  expect(PARAMS['task.code_file']).toContain('revision');
});

test('code HTTP routes preserve narrow typed params, no-store/auth/Origin and never run via overview', async () => {
  const f = await setup(), calls = [];
  for (const [method, fn] of [['state','codeState'], ['tree','codeTree'], ['file','codeFile']]) f.project[fn] = (id, options) => { calls.push({ method, id, options }); return projection(id, options); };
  try {
    const client = new RPCClient(f.config.socket);
    expect(await client.request('task.code_state', { id: 7, scope: 'working' })).toEqual(projection(7, { scope: 'working' }));
    calls.length = 0;
    await fetch(f.url + '/api/overview'); expect(calls).toHaveLength(0);
    const state = await fetch(f.url + '/api/task/7/code-state?scope=iteration&after=1&limit=2');
    expect(state.status).toBe(200); expect(state.headers.get('cache-control')).toBe('no-store');
    expect(await state.json()).toEqual(projection(7, { scope: 'iteration', after: 1, limit: 2 }));
    const filename = 'dir/a\tname\n.txt';
    const tree = await fetch(f.url + '/api/task/7/code-tree?' + new URLSearchParams({ path: 'dir', query: 'name', changed: 'true', revision: 'a'.repeat(64) }));
    expect(await tree.json()).toEqual(projection(7, { path: 'dir', query: 'name', changed: true, revision: 'a'.repeat(64) }));
    const file = await fetch(f.url + '/api/task/7/code-file?' + new URLSearchParams({ path: filename, side: 'old', view: 'content', offset: '4', limit: '20', context: '6' }));
    expect(await file.json()).toEqual(projection(7, { path: filename, side: 'old', view: 'content', offset: 4, limit: 20, context: 6 }));
    const before = calls.length;
    for (const suffix of ['code-tree?changed=maybe', 'code-file?path=a&path=b', 'code-file?cwd=/etc', 'code-state?_token=secret']) expect((await fetch(f.url + '/api/task/7/' + suffix)).status).toBe(400);
    expect((await fetch(f.url + '/api/task/7/code-state', { headers: { Origin: 'https://attacker.invalid' } })).status).toBe(403);
    expect((await post(f.url + '/api/action', { method: 'task.code_file', params: { id: 7, path: 'a' } })).status).toBe(400);
    expect(calls).toHaveLength(before);
  } finally { await f.close(); }
});

test('code routes require the existing Web session', async () => {
  const f = await setup({ auth: { username: 'owner', password: 'test-only-password' } });
  let reads = 0; f.project.codeState = () => { reads++; return { version: 1 }; };
  try {
    expect((await fetch(f.url + '/api/task/7/code-state')).status).toBe(401); expect(reads).toBe(0);
    const login = await fetch(f.url + '/login', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'username=owner&password=test-only-password&next=%2F' });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    expect((await fetch(f.url + '/api/task/7/code-state', { headers: { Cookie: cookie } })).status).toBe(200); expect(reads).toBe(1);
  } finally { await f.close(); }
});

test('multi-project code route is bound to URL project, not last selected project', async () => {
  const a = temp(), b = temp(), global = temp(), calls = [];
  const web = startWeb(null, 0, { env: { ...process.env, LUSH_GLOBAL_CONFIG: global }, openProject: async project => ({
    config: { project, home: path.join(project, '.lush') }, client: { async request(method, params = {}) { calls.push({ project, method, params }); return { project }; } },
  }) });
  const url = `http://127.0.0.1:${web.port}`, idA = projectRouteId(a), idB = projectRouteId(b);
  try {
    await post(url + '/api/host/select', { project: a }); await post(url + '/api/host/select', { project: b }); calls.length = 0;
    expect(await (await fetch(`${url}/p/${idA}/api/task/7/code-state`)).json()).toEqual({ project: a });
    expect(await (await fetch(`${url}/p/${idB}/api/task/7/code-file?path=file.txt`)).json()).toEqual({ project: b });
    expect(calls).toEqual([{ project: a, method: 'task.code_state', params: { id: 7 } }, { project: b, method: 'task.code_file', params: { id: 7, path: 'file.txt' } }]);
    expect((await fetch(url + '/api/task/7/code-state')).status).toBe(400);
    expect((await fetch(`${url}/p/${'0'.repeat(16)}/api/task/7/code-state`)).status).toBe(400); expect(calls).toHaveLength(2);
  } finally { web.stop(true); for (const dir of [a, b, global]) fs.rmSync(dir, { recursive: true, force: true }); }
});
