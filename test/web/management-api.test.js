import { test, expect } from 'bun:test';
import { setup, fetch } from './harness.js';

const revision = 'signal:a1', signal = { name: '额度更新时间已到', schedule: { kind: 'daily', time: '00:05', timezone: 'Asia/Shanghai' } };
const request = { name: '夜间重试', instruction: '重试失败的 W17', signal_id: 'signal-id', client_request_id: 'same-dialog-attempt' };
const management = { version: 1, revision: 'binding:a1', signal_id: 'signal-id', mode: 'once', enabled: true, state: 'waiting' };
const row = { id: 9, role: 'manager', task_kind: 'management', goal: request.instruction, management,
  retry_profile: JSON.stringify({ env: { SECRET: 'never-public' } }) };
const view = { version: 1, revision: 'templates:a1', templates: [], actions: [], triggers: [],
  signals: { version: 1, revision, items: [{ id: 'signal-id', ...signal }] }, management_workers: [row] };
const safeRow = { ...row }; delete safeRow.retry_profile;
const safeView = { ...view, management_workers: [safeRow] };
function post(f, method, params, headers = {}) {
  return fetch(f.url + '/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ method, params }) });
}
function mocks(p) {
  const calls = [];
  p.hooksList = () => view;
  for (const method of ['saveHookSignal','removeHookSignal','createManagementWorker','updateManagementBinding']) p[method] = (...args) => {
    calls.push({ method, args }); return method.includes('Signal') ? view : row;
  };
  return calls;
}
const mutations = [
  ['hooks.signal_save', { signal, expected_revision: revision }, 'saveHookSignal', [signal, revision], safeView],
  ['hooks.signal_remove', { id: 'signal-id', expected_revision: revision }, 'removeHookSignal', ['signal-id', revision], safeView],
  ['management.create', request, 'createManagementWorker', [request], { task: safeRow }],
  ['management.binding_update', { id: 9, enabled: false, expected_revision: management.revision }, 'updateManagementBinding', [9, false, management.revision], safeRow],
];

test('HTTP Hooks catalogue and management actions use current project RPC and filter private profiles', async () => {
  const f = await setup(), calls = mocks(f.project);
  try {
    expect(await (await fetch(f.url + '/api/hooks')).json()).toEqual(safeView);
    for (const [method, params, target, args, result] of mutations) {
      const response = await post(f, method, params);
      expect(response.status).toBe(200); expect(await response.json()).toEqual(result);
      expect(calls.at(-1)).toEqual({ method: target, args });
    }
    expect(calls).toHaveLength(4);
    expect(row.retry_profile).toContain('never-public');
  } finally { await f.close(); }
});

test('HTTP rejects forged tokens, extra fields, missing revisions, manager tools and configuration GETs before any management action', async () => {
  const f = await setup(), calls = mocks(f.project);
  try {
    for (const [method, params] of mutations) {
      expect((await post(f, method, { ...params, _token: 'pretend-manager' })).status).toBe(400);
      expect((await post(f, method, { ...params, scope: 'device' })).status).toBe(400);
      if (Object.hasOwn(params, 'expected_revision')) {
        const missing = { ...params }; delete missing.expected_revision;
        expect((await post(f, method, missing)).status).toBe(400);
      }
    }
    for (const method of ['manager.query','manager.start','manager.retry']) expect((await post(f, method, { id: 17 })).status).toBe(400);
    for (const url of ['/api/hooks/signal_save', '/api/management/create', '/api/manager/start', '/api/hooks?signal=signal-id']) {
      expect([400,404]).toContain((await fetch(f.url + url)).status);
    }
    expect(calls).toEqual([]);
  } finally { await f.close(); }
});

test('management configuration obeys login and same-Origin user boundary', async () => {
  const f = await setup({ auth: { username: 'owner', password: 'management-test-password' } }), calls = mocks(f.project);
  try {
    for (const [method, params] of mutations) expect((await post(f, method, params)).status).toBe(401);
    const login = await fetch(f.url + '/login', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'username=owner&password=management-test-password&next=%2F' });
    expect(login.status).toBe(303);
    const Cookie = login.headers.get('set-cookie').split(';')[0];
    for (const [method, params] of mutations) {
      expect((await post(f, method, params, { Cookie, Origin: 'https://evil.invalid' })).status).toBe(403);
      expect((await post(f, method, params, { Cookie, Origin: f.url })).status).toBe(200);
    }
    expect(calls).toHaveLength(4);
  } finally { await f.close(); }
});
