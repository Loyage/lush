import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setup, fetch } from './harness.js';
import { startWeb } from '../../src/ui/web/server.js';
import { projectRouteId } from '../../src/host/registry.js';
import { check } from '../../src/core/types.js';

const revision = 'hooks-revision';
const hook = { name: '通知', trigger: 'agent.returned', mode: 'once', enabled: true,
  actions: [{ type: 'notify', title: '结果', body: '查看 Worker' }] };
const projectView = { version: 1, revision, triggers: [], actions: [], templates: [] };
const workerView = { version: 1, worker_id: 7, revision, mounts: [] };
const targets = ['hooksList','saveHookTemplate','removeHookTemplate','taskHooks','attachTaskHook','updateTaskHook','removeTaskHook','setTaskCompletion'];
function mocks(project) {
  const calls = [];
  for (const method of targets) project[method] = (...args) => {
    calls.push({ method, args });
    return method === 'hooksList' || method.endsWith('Template') ? projectView : workerView;
  };
  return calls;
}
function post(url, method, params, headers = {}) {
  return fetch(url + '/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ method, params }) });
}
const mutations = [
  ['hooks.save', { template: hook, expected_revision: revision }, 'saveHookTemplate', [hook, revision], projectView],
  ['hooks.remove', { id: 'template-1', expected_revision: revision }, 'removeHookTemplate', ['template-1', revision], projectView],
  ['worker.hook_attach', { id: 7, hook, expected_revision: revision }, 'attachTaskHook', [7, hook, revision], workerView],
  ['worker.hook_update', { id: 7, hook_id: 'hook-1', enabled: false, expected_revision: revision }, 'updateTaskHook', [7, 'hook-1', false, revision], workerView],
  ['worker.hook_remove', { id: 7, hook_id: 'hook-1', expected_revision: revision }, 'removeTaskHook', [7, 'hook-1', revision], workerView],
  ['worker.completion', { id: 7, level: 'accept', expected_revision: revision }, 'setTaskCompletion', [7, 'accept', revision], workerView],
];

test('Hooks HTTP reads and all mutations reach user RPC with exact revisions and no implicit actions', async () => {
  const f = await setup(), calls = mocks(f.project);
  try {
    expect(await (await fetch(f.url + '/api/hooks')).json()).toEqual(projectView);
    expect(await (await fetch(f.url + '/api/worker/7/hooks')).json()).toEqual(workerView);
    expect(calls).toEqual([{ method: 'hooksList', args: [] }, { method: 'taskHooks', args: [7] }]);
    for (const [method, params, target, args, view] of mutations) {
      const response = await post(f.url, method, params);
      expect(response.status).toBe(200); expect(await response.json()).toEqual(view);
      expect(calls.at(-1)).toEqual({ method: target, args });
    }
    expect(calls).toHaveLength(2 + mutations.length);
    for (const route of ['/api/hooks?force=true','/api/hooks?_token=agent','/api/worker/7/hooks?revision=forged',
      '/api/worker/7/hooks?id=8','/api/worker/7/hooks?enabled=true']) {
      expect((await fetch(f.url + route)).status).toBe(400);
    }
    for (const route of ['/api/hooks/save','/api/worker/7/hook_attach','/api/worker/0/hooks']) expect((await fetch(f.url + route)).status).toBe(404);
    expect(calls).toHaveLength(2 + mutations.length);
  } finally { await f.close(); }
});

test('HTTP preserves a template reference mount and draft hook_mount without exposing a profile', async () => {
  const f = await setup(), calls = mocks(f.project);
  const reference = { template_id: '931d1b67-11b1-4b39-b4be-6d07611f697e' };
  const mount = { parent_id: 7, hook_id: 'hook-1', state: 'waiting' };
  f.project.inputGet = (kind, id) => ({ kind, id, content: 'reserved draft', hook_mount: mount });
  try {
    const response = await post(f.url, 'worker.hook_attach', { id: 7, hook: reference, expected_revision: revision });
    expect(response.status).toBe(200); expect(await response.json()).toEqual(workerView);
    expect(calls).toEqual([{ method: 'attachTaskHook', args: [7, reference, revision] }]);
    const draft = await fetch(f.url + '/api/input/draft/2');
    expect(draft.status).toBe(200);
    const result = await draft.json();
    expect(result).toEqual({ kind: 'draft', id: 2, content: 'reserved draft', hook_mount: mount });
    expect(result.profile).toBeUndefined();
    expect((await post(f.url, 'worker.hook_attach', { id: 7, hook: reference, expected_revision: revision, _token: 'agent' })).status).toBe(400);
    expect(calls).toHaveLength(1);
  } finally { await f.close(); }
});

test('Hooks HTTP refuses tokens, extra arguments, invalid revisions/types and cross-origin requests before writes', async () => {
  const f = await setup(), calls = mocks(f.project);
  try {
    for (const [method, params] of mutations) {
      for (const invalid of [{ ...params, _token: 'agent' }, { ...params, force: true }, { ...params, expected_revision: 7 },
        { ...params, expected_revision: '' }, { ...params, expected_revision: null }, Object.fromEntries(Object.entries(params).filter(([key]) => key !== 'expected_revision'))]) {
        expect((await post(f.url, method, invalid)).status).toBe(400);
      }
      expect((await post(f.url, method, params, { Origin: 'https://evil.invalid' })).status).toBe(403);
      expect((await fetch(f.url + '/api/action', { method: 'POST', body: JSON.stringify({ method, params }) })).status).toBe(400);
    }
    expect((await post(f.url, 'worker.hook_update', { id: 7, hook_id: 'x', enabled: 'false', expected_revision: revision })).status).toBe(400);
    expect((await post(f.url, 'hooks.save', { template: [], expected_revision: revision })).status).toBe(400);
    expect((await post(f.url, 'hooks.list', {})).status).toBe(400);
    expect((await post(f.url, 'worker.hooks', { id: 7 })).status).toBe(400);
    expect(calls).toEqual([]);
  } finally { await f.close(); }
});

test('Hooks HTTP preserves stale revision errors without a mutation retry', async () => {
  const f = await setup(); let calls = 0;
  f.project.updateTaskHook = (id, hookId, enabled, expected) => {
    calls += 1; expect(expected).toBe('stale');
    check(false, 'Worker Hooks changed; reload the latest revision');
  };
  try {
    const response = await post(f.url, 'worker.hook_update', { id: 7, hook_id: 'hook-1', enabled: true, expected_revision: 'stale' });
    expect(response.status).toBe(400); expect((await response.json()).error).toContain('reload'); expect(calls).toBe(1);
  } finally { await f.close(); }
});

test('Hooks routes and mutations require the normal authenticated session', async () => {
  const f = await setup({ auth: { username: 'owner', password: 'hook-password' } }), calls = mocks(f.project);
  try {
    expect((await fetch(f.url + '/api/hooks')).status).toBe(401);
    expect((await fetch(f.url + '/api/worker/7/hooks')).status).toBe(401);
    expect((await post(f.url, 'worker.hook_attach', mutations[2][1])).status).toBe(401);
    expect(calls).toEqual([]);
    const login = await fetch(f.url + '/login', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'username=owner&password=hook-password&next=%2F' });
    expect(login.status).toBe(303);
    const Cookie = login.headers.get('set-cookie').split(';')[0];
    expect((await fetch(f.url + '/api/hooks', { headers: { Cookie } })).status).toBe(200);
    expect((await fetch(f.url + '/api/worker/7/hooks', { headers: { Cookie } })).status).toBe(200);
    expect((await post(f.url, 'worker.hook_attach', mutations[2][1], { Cookie, Origin: f.url })).status).toBe(200);
    expect((await post(f.url, 'worker.hook_remove', mutations[4][1], { Cookie, Origin: 'https://evil.invalid' })).status).toBe(403);
    expect(calls).toHaveLength(3);
  } finally { await f.close(); }
});

test('order.submit HTTP explicitly forwards defer, start and profile without creating a phantom Worker', async () => {
  const f = await setup(), calls = [];
  const result = { deferred: true, parent_id: 1, hook_id: 'deferred-1', hooks: workerView };
  f.project.order = (...args) => { calls.push(args); return result; };
  f.project.submitBufferedDraft = (...args) => { calls.push(args); return result; };
  try {
    const profile = { agent: 'pi', config_mode: 'pi' };
    const response = await post(f.url, 'order.submit', { content: 'goal', branch: 'main', start: false, profile, defer: true });
    expect(response.status).toBe(200); expect(await response.json()).toEqual(result);
    expect(calls[0]).toEqual(['goal','main',[],null,false,undefined,profile,true]);
    expect((await post(f.url, 'order.submit', { draft_id: 2, expected_revision: 3, defer: true })).status).toBe(200);
    expect(calls[1]).toEqual([2,3,true,true,null]);
    const deferredDraft = await post(f.url, 'order.submit', { draft_id: 2, expected_revision: 3, profile, start: false, defer: true });
    expect(deferredDraft.status).toBe(200); expect(await deferredDraft.json()).toEqual(result);
    expect(calls[2]).toEqual([2,3,false,true,profile]);
    expect((await post(f.url, 'order.submit', { draft_id: 2, expected_revision: 3, profile })).status).toBe(400);
    expect((await post(f.url, 'order.submit', { draft_id: 2, expected_revision: 3, profile, defer: false })).status).toBe(400);
    expect((await post(f.url, 'order.submit', { draft_id: 2, expected_revision: 3, profile: [], defer: true })).status).toBe(400);
    expect((await post(f.url, 'order.submit', { draft_id: 2, expected_revision: 3, content: 'changed', profile, defer: true })).status).toBe(400);
    expect((await post(f.url, 'order.submit', { content: 'goal', defer: 'true' })).status).toBe(400);
    expect((await post(f.url, 'order.submit', { content: 'goal', defer: true, _token: 'agent' })).status).toBe(400);
    expect(calls).toHaveLength(3);
  } finally { await f.close(); }
});

test('Host project-prefixed Hooks routes keep each request on its explicit project', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lush-hooks-host-'));
  const a = path.join(root, 'a'), b = path.join(root, 'b'); fs.mkdirSync(a); fs.mkdirSync(b);
  const calls = [], env = { HOME: root, XDG_CONFIG_HOME: path.join(root,'config') };
  const web = startWeb(null, 0, { env, async openProject(project) {
    return { config: { project, home: path.join(project, '.lush') }, client: {
      async request(method, params) { calls.push({ project, method, params }); return { project, method }; }
    } };
  } });
  const url = `http://127.0.0.1:${web.port}`;
  try {
    for (const project of [a,b]) {
      const select = await fetch(url + '/api/host/select', { method: 'POST', headers: { 'Content-Type':'application/json' }, body: JSON.stringify({ project }) });
      expect(select.status).toBe(200);
    }
    const pa = `/p/${projectRouteId(fs.realpathSync(a))}`, pb = `/p/${projectRouteId(fs.realpathSync(b))}`;
    expect((await (await fetch(url + pa + '/api/hooks')).json()).project).toBe(a);
    expect((await (await fetch(url + pb + '/api/worker/7/hooks')).json()).project).toBe(b);
    expect((await post(url + pa, 'hooks.save', mutations[0][1])).status).toBe(200);
    expect(calls.filter(entry => entry.method.startsWith('hooks.') || entry.method === 'worker.hooks')).toEqual([
      { project: a, method: 'hooks.list', params: undefined },
      { project: b, method: 'worker.hooks', params: { id: 7 } },
      { project: a, method: 'hooks.save', params: mutations[0][1] },
    ]);
    expect((await fetch(url + '/api/hooks')).status).toBe(400);
  } finally { web.stop(true); fs.rmSync(root,{ recursive:true, force:true }); }
});
