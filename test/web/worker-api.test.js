import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { startWeb } from '../../src/ui/web/server.js';
import { projectRouteId } from '../../src/host/registry.js';
import { env, temp } from '../helpers.js';
import { setup, fetch } from './harness.js';

const post = (url, method, params, headers = {}) => fetch(url + '/api/action', {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ method, params }),
});
const reads = [
  ['workers?scope=all&before=9&limit=2', 'page', { scope: 'all', before: 9, limit: 2 }],
  ['worker-graph', 'graph', {}],
  ['worker/7', 'inspect', { id: 7 }],
  ['worker/7/history?after=2', 'history', { id: 7, after: 2 }],
  ['worker/7/history-page?before=9&limit=2', 'history_page', { id: 7, before: 9, limit: 2 }],
  ['worker/7/delete-preview', 'delete_preview', { id: 7 }],
  ['worker/7/diff', 'diff', { id: 7 }],
  ['worker/7/usage', 'usage', { id: 7 }],
  ['worker/7/transcript?after=2', 'transcript', { id: 7, after: 2 }],
  ['worker/7/transcript-latest?after=1&before=9&limit=2', 'transcript_latest', { id: 7, after: 1, before: 9, limit: 2 }],
  ['worker/7/transcript-page?seq=2&offset=3', 'transcript_page', { id: 7, seq: 2, offset: 3 }],
  ['worker/7/transcript-step?seq=2&offset=3', 'transcript_step', { id: 7, seq: 2, offset: 3 }],
  ['worker/7/transcript-search?query=exit&kind=tool&tool=bash&errors=true&after=1&limit=2', 'transcript_search',
    { id: 7, query: 'exit', kind: 'tool', tool: 'bash', errors: true, after: 1, limit: 2 }],
  ['worker/7/code-state?scope=iteration&after=1&limit=2', 'code_state', { id: 7, scope: 'iteration', after: 1, limit: 2 }],
  ['worker/7/code-tree?path=dir&query=name&changed=true&revision=abc', 'code_tree', { id: 7, path: 'dir', query: 'name', changed: true, revision: 'abc' }],
  ['worker/7/code-file?path=file.txt&side=old&view=content&offset=4&limit=20&context=6', 'code_file',
    { id: 7, path: 'file.txt', side: 'old', view: 'content', offset: 4, limit: 20, context: 6 }],
];
const mutations = ['spawn','message','auto_merge','reserve','reserve_all','resolve','accept','reopen','sync_parent',
  'resolve_sync','resolve_divergence','unreserve','approve_merge','cancel','retry','interrupt','resume','configure','cleanup','delete'];
const legacy = route => route.replace(/^workers/, 'tasks').replace(/^worker-graph/, 'task-graph').replace(/^worker\//, 'task/');

async function hostFixture() {
  const a = temp(), b = temp(), global = temp(), calls = [];
  const web = startWeb(null, 0, { env: env({ LUSH_GLOBAL_CONFIG: global }), openProject: async project => ({
    config: { project, home: path.join(project, '.lush') },
    client: { async request(method, params = {}) {
      calls.push({ project, method, params });
      if (method === 'notice.page') return { notices: [{ id: 8, task_id: 7, kind: 'questionnaire',
        body: JSON.stringify({ questions: [{ options: [{ previewHtml: '<p>safe preview</p>' }] }] }) }] };
      if (method === 'worker.inspect') return { id: 7, task_kind: 'order', role: 'verifier' };
      return { project, task_id: 7, task_kind: 'order' };
    } },
  }) });
  const url = `http://127.0.0.1:${web.port}`;
  for (const project of [a, b]) await fetch(url + '/api/host/select', { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project }) });
  calls.length = 0;
  return { a, b, web, calls, url, urlA: `${url}/p/${projectRouteId(a)}`, urlB: `${url}/p/${projectRouteId(b)}`,
    close() { web.stop(true); for (const dir of [a, b, global]) fs.rmSync(dir, { recursive: true, force: true }); } };
}

test('worker HTTP reads forward only the new namespace with unchanged typed params and project identity', async () => {
  const f = await hostFixture();
  try {
    for (const [route, verb, params] of reads) {
      const response = await fetch(`${f.urlA}/api/${route}`);
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      const body = await response.json();
      if (verb === 'inspect') expect(body.task_kind).toBe('order');
      else expect(body).toEqual({ project: f.a, task_id: 7, task_kind: 'order' });
      expect(f.calls.at(-1)).toEqual({ project: f.a, method: `worker.${verb}`, params });
      const before = f.calls.length;
      expect((await fetch(`${f.urlA}/api/${legacy(route)}`)).status).toBe(404);
      expect(f.calls).toHaveLength(before);
    }
    expect((await fetch(`${f.urlB}/api/workers`)).status).toBe(200);
    expect(f.calls.at(-1)).toEqual({ project: f.b, method: 'worker.page', params: { scope: 'work', before: null, limit: 50 } });
    const before = f.calls.length;
    expect((await fetch(`${f.url}/api/workers`)).status).toBe(400);
    expect((await fetch(`${f.url}/p/${'0'.repeat(16)}/api/workers`)).status).toBe(400);
    expect(f.calls).toHaveLength(before);
  } finally { f.close(); }
});

test('worker HTTP mutation whitelist accepts renamed actions, rejects every old action and agent tokens', async () => {
  const f = await hostFixture();
  try {
    for (const verb of mutations) {
      const response = await post(f.urlA, `worker.${verb}`, { id: 7 });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ project: f.a, task_id: 7, task_kind: 'order' });
      expect(f.calls.at(-1)).toEqual({ project: f.a, method: `worker.${verb}`, params: { id: 7 } });
      const before = f.calls.length;
      expect((await post(f.urlA, `task.${verb}`, { id: 7 })).status).toBe(400);
      expect((await post(f.urlA, `worker.${verb}`, { id: 7, _token: 'forged' })).status).toBe(400);
      expect(f.calls).toHaveLength(before);
    }
    for (const verb of ['integrate','resolve_child_divergence','code_file','inspect','verify','delete_preview'])
      expect((await post(f.urlA, `worker.${verb}`, { id: 7 })).status).toBe(400);
    const before = f.calls.length;
    expect((await post(f.urlA, 'worker.message', { id: 7 }, { Origin: 'https://evil.invalid' })).status).toBe(403);
    expect(f.calls).toHaveLength(before);
  } finally { f.close(); }
});

test('report and questionnaire preview routes move under worker without altering historical data or CSP', async () => {
  const f = await hostFixture();
  try {
    const reportDir = path.join(f.a, '.lush', 'verify', '7'); fs.mkdirSync(reportDir, { recursive: true });
    fs.writeFileSync(path.join(reportDir, 'report.html'), '<p>historical report</p>');
    const report = await fetch(`${f.urlA}/api/worker/7/report`);
    expect(report.status).toBe(200); expect(await report.text()).toContain('historical report');
    expect(report.headers.get('content-security-policy')).toContain('sandbox allow-scripts');
    const preview = await fetch(`${f.urlA}/api/worker/7/notice/8/preview/0/0`);
    expect(preview.status).toBe(200); expect(await preview.text()).toContain('safe preview');
    expect(preview.headers.get('content-security-policy')).toContain('sandbox');
    expect(f.calls.at(-1)).toEqual({ project: f.a, method: 'notice.page', params: { before: 9, limit: 1 } });
    const before = f.calls.length;
    for (const route of ['task/7/report','task/7/notice/8/preview/0/0','worker/7/explanations','worker/7/intros','worker/7/merge'])
      expect((await fetch(`${f.urlA}/api/${route}`)).status).toBe(404);
    expect(f.calls).toHaveLength(before);
  } finally { f.close(); }
});

test('worker reads and mutations retain Web login, Origin and narrow RPC parameter checks', async () => {
  const f = await setup({ auth: { username: 'owner', password: 'test-only-password' } });
  const calls = [];
  f.project.codeState = (id, options) => { calls.push({ id, options }); return { task_id: id, ...options }; };
  f.project.acceptTask = (id, actor) => { calls.push({ id, actor }); return { task_id: id, task_kind: 'child' }; };
  try {
    expect((await fetch(f.url + '/api/worker/7/code-state')).status).toBe(401);
    expect((await post(f.url, 'worker.accept', { id: 7 })).status).toBe(401);
    expect(calls).toHaveLength(0);
    const login = await fetch(f.url + '/login', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'username=owner&password=test-only-password&next=%2F' });
    expect(login.status).toBe(303);
    const Cookie = login.headers.get('set-cookie').split(';')[0];
    expect((await fetch(f.url + '/api/worker/7/code-state', { headers: { Cookie } })).status).toBe(200);
    expect((await post(f.url, 'worker.accept', { id: 7 }, { Cookie })).status).toBe(200);
    expect(calls).toEqual([{ id: 7, options: {} }, { id: 7, actor: null }]);
    for (const route of ['code-state?_token=forged','code-file?cwd=/etc','code-tree?path=a&path=b','code-tree?changed=maybe'])
      expect((await fetch(f.url + '/api/worker/7/' + route, { headers: { Cookie } })).status).toBe(400);
    expect((await post(f.url, 'worker.accept', { id: 7, force: true }, { Cookie })).status).toBe(400);
    expect((await post(f.url, 'worker.accept', { id: 7, _token: 'forged' }, { Cookie })).status).toBe(400);
    expect((await fetch(f.url + '/api/worker/7/code-state', { headers: { Cookie, Origin: 'https://evil.invalid' } })).status).toBe(403);
    expect(calls).toHaveLength(2);
  } finally { await f.close(); }
});
