import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setup, fetch } from './harness.js';
import { startWeb } from '../../src/ui/web/server.js';
import { projectRouteId } from '../../src/host/registry.js';
import { check } from '../../src/core/types.js';

const revision = 'completion-hooks:opaque-revision';
const params = { id: 7, level: 'archive', expected_revision: revision };
const view = level => ({ version: 1, worker_id: 7, revision: 'next-revision',
  completion: { level, min_level: 'off', locked: false, editable: true, reason: null,
    phase: null, state: 'idle', last_execution: null }, mounts: [] });
function post(url, value = params, headers = {}) {
  return fetch(url + '/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ method: 'worker.completion', params: value }) });
}

test('completion HTTP forwards four exact grades and returns the Hooks read model', async () => {
  const f = await setup(), calls = [];
  f.project.setTaskCompletion = (...args) => { calls.push(args); return view(args[1]); };
  f.project.taskHooks = id => ({ ...view('accept'), worker_id: id });
  try {
    expect(await (await fetch(f.url + '/api/worker/7/hooks')).json()).toEqual(view('accept'));
    expect(calls).toEqual([]);
    for (const level of ['off','merge','accept','archive']) {
      const response = await post(f.url, { ...params, level }, { Origin: f.url });
      expect(response.status).toBe(200); expect(await response.json()).toEqual(view(level));
      expect(calls.at(-1)).toEqual([7, level, revision]);
    }
    expect(calls).toHaveLength(4);
    for (const route of ['/api/worker/7/completion','/api/worker/7/completion?level=archive','/api/completion']) {
      expect((await fetch(f.url + route)).status).toBe(404);
    }
    expect((await fetch(f.url + '/api/worker/7/completion', { method: 'POST' })).status).toBe(404);
    expect((await fetch(f.url + '/api/worker/7/hooks?level=archive')).status).toBe(400);
    expect(calls).toHaveLength(4);
  } finally { await f.close(); }
});

test('completion HTTP rejects malformed grades, revisions, privileged flags and cross-origin writes', async () => {
  const f = await setup(), calls = [];
  f.project.setTaskCompletion = (...args) => { calls.push(args); return view('archive'); };
  try {
    for (const level of [undefined, true, [], '', 'Accept', 'shell']) {
      expect((await post(f.url, { ...params, level })).status).toBe(400);
    }
    for (const expected_revision of [undefined, '', ' padded ', 'x'.repeat(257)]) {
      expect((await post(f.url, { ...params, expected_revision })).status).toBe(400);
    }
    for (const extra of [{ _token: 'agent' }, { force: true }, { discard_worktree: true }, { inherit: true }, { actor: null }]) {
      expect((await post(f.url, { ...params, ...extra })).status).toBe(400);
    }
    for (const id of [0, -1, 1.5, 'W1', 'other-project']) expect((await post(f.url, { ...params, id })).status).toBe(400);
    expect((await post(f.url, params, { Origin: 'https://evil.invalid' })).status).toBe(403);
    expect((await fetch(f.url + '/api/action', { method: 'POST', body: JSON.stringify({ method: 'worker.completion', params }) })).status).toBe(400);
    expect(calls).toEqual([]);
  } finally { await f.close(); }
});

test('completion HTTP preserves revision conflicts and runtime gating failures without retry', async () => {
  const f = await setup(), calls = [];
  f.project.setTaskCompletion = (...args) => {
    calls.push(args); check(false, args[2] === 'stale' ? 'Worker Hooks changed; reload the latest revision' : 'delivery is frozen');
  };
  try {
    const stale = await post(f.url, { ...params, expected_revision: 'stale' });
    expect(stale.status).toBe(400); expect((await stale.json()).error).toContain('reload');
    expect(calls).toEqual([[7, 'archive', 'stale']]);
    const frozen = await post(f.url);
    expect(frozen.status).toBe(400); expect((await frozen.json()).error).toBe('delivery is frozen');
    expect(calls).toEqual([[7, 'archive', 'stale'], [7, 'archive', revision]]);
  } finally { await f.close(); }
});

test('completion HTTP requires an authenticated owner session and same-origin submission', async () => {
  const f = await setup({ auth: { username: 'owner', password: 'completion-password' } }), calls = [];
  f.project.setTaskCompletion = (...args) => { calls.push(args); return view('archive'); };
  try {
    expect((await post(f.url)).status).toBe(401); expect(calls).toEqual([]);
    const login = await fetch(f.url + '/login', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'username=owner&password=completion-password&next=%2F' });
    expect(login.status).toBe(303);
    const Cookie = login.headers.get('set-cookie').split(';')[0];
    expect((await post(f.url, params, { Cookie, Origin: 'https://evil.invalid' })).status).toBe(403);
    expect(calls).toEqual([]);
    const response = await post(f.url, params, { Cookie, Origin: f.url });
    expect(response.status).toBe(200); expect(await response.json()).toEqual(view('archive'));
    expect(calls).toEqual([[7, 'archive', revision]]);
  } finally { await f.close(); }
});

test('project-prefixed completion mutation stays on its explicit Host project', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lush-completion-host-'));
  const a = path.join(root, 'a'), b = path.join(root, 'b'); fs.mkdirSync(a); fs.mkdirSync(b);
  const calls = [], web = startWeb(null, 0, { env: { HOME: root, XDG_CONFIG_HOME: path.join(root, 'config') },
    async openProject(project) { return { config: { project, home: path.join(project, '.lush') }, client: {
      request(method, value) { calls.push({ project, method, params: value }); return { project, ...view(value?.level) }; },
    } }; } });
  const url = `http://127.0.0.1:${web.port}`;
  try {
    for (const project of [a,b]) {
      const selected = await fetch(url + '/api/host/select', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project }) });
      expect(selected.status).toBe(200);
    }
    for (const project of [a,b]) {
      const response = await post(url + `/p/${projectRouteId(fs.realpathSync(project))}`);
      expect(response.status).toBe(200); expect((await response.json()).project).toBe(project);
    }
    expect(calls.filter(entry => entry.method === 'worker.completion')).toEqual([
      { project: a, method: 'worker.completion', params }, { project: b, method: 'worker.completion', params },
    ]);
    expect((await post(url)).status).toBe(400);
  } finally { web.stop(true); fs.rmSync(root, { recursive: true, force: true }); }
});
