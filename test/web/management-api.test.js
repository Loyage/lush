import { test, expect } from 'bun:test';
import { setup, fetch } from './harness.js';

const revision = 'signal:a1', signal = { name: '额度更新时间已到', schedule: { kind: 'daily', time: '00:05', timezone: 'Asia/Shanghai' } };
const request = { name: '夜间重试', instruction: '重试失败的 W17', signal_id: 'signal-id', client_request_id: 'same-dialog-attempt' };
const management = { version: 1, revision: 'binding:a1', signal_id: 'signal-id', mode: 'once', enabled: true, state: 'waiting' };
const row = { id: 9, worker_number: 'V1', role: 'manager', task_kind: 'management', goal: request.instruction, management,
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

test('HTTP Valet creation, list, inspect and strict lookup preserve integer endpoint authority', async () => {
  const f = await setup(); f.project.kick = () => {};
  try {
    const definition = { instruction: 'query only', client_request_id: 'http-valet' };
    const created = await (await post(f, 'management.submit', definition)).json();
    expect(created.task.worker_number).toBe('V1');
    expect((await (await post(f, 'management.submit', definition)).json()).task.id).toBe(created.task.id);
    expect(await (await fetch(f.url + '/api/worker-lookup?number=V1')).json()).toEqual({ id: created.task.id, worker_number: 'V1' });
    expect((await (await fetch(f.url + '/api/hooks')).json()).management_workers[0].worker_number).toBe('V1');
    const inspected = await (await fetch(f.url + `/api/worker/${created.task.id}`)).json();
    expect(inspected.worker_number).toBe('V1'); expect(inspected.retry_profile).toBeUndefined();
    for (const number of ['V0', 'V01', 'V1-1', 'V9007199254740992', 'V2'])
      expect((await fetch(f.url + `/api/worker-lookup?number=${number}`)).status).toBe(400);
    expect((await fetch(f.url + '/api/worker/V1')).status).toBe(404);
    expect((await post(f, 'management.binding_update', { id: 'V1', enabled: false, expected_revision: created.task.management.revision })).status).toBe(400);
  } finally { await f.close(); }
});

test('overview and snapshot include persisted Valets from both layers with bounded shared history and safe profiles', async () => {
  const f = await setup(); f.project.kick = () => {};
  try {
    const records = f.store.transaction(() => Array.from({ length: 106 }, (_, index) => {
      const task = f.store.create({ role: 'manager', task_kind: 'management', goal: `finished management ${index}` });
      f.store.update(task.id, { status: 'completed', retry_profile: JSON.stringify({ env: { SECRET: 'private-profile' } }) });
      return task;
    }));
    const active = f.store.create({ role: 'manager', task_kind: 'management', goal: 'legacy control-layer manager' });
    // Historical control-plane rows must be readable without migrating their persisted layer or identity.
    f.store.run("UPDATE tasks SET layer='intent',worker_number=NULL WHERE id=?", active.id);
    for (const endpoint of ['overview', 'snapshot']) {
      const response = await fetch(`${f.url}/api/${endpoint}`); expect(response.status).toBe(200);
      const snapshot = await response.json();
      expect(snapshot.tasks.filter(task => task.task_kind === 'management')).toHaveLength(101);
      expect(snapshot.tasks.find(task => task.id === active.id)).toMatchObject({ layer: 'intent', worker_number: null });
      expect(snapshot.tasks.some(task => task.id === records[0].id)).toBe(false);
      expect(snapshot.tasks.find(task => task.id === records.at(-1).id).worker_number).toBe('V106');
      expect(snapshot.task_page).toMatchObject({ cursor: records[6].id, has_more: true, historical: 106, shown: 100 });
      expect(JSON.stringify(snapshot)).not.toContain('private-profile');
      const older = await (await fetch(`${f.url}/api/workers?scope=all&before=${snapshot.task_page.cursor}&limit=50`)).json();
      expect(older.tasks.map(task => task.id)).toEqual(records.slice(0, 6).map(task => task.id));
      expect(older.has_more).toBe(false);
    }
    expect(f.store.task(active.id)).toMatchObject({ layer: 'intent', worker_number: null });
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
