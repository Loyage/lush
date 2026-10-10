import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { startWeb } from '../../src/ui/web/server.js';
import { createUserServices } from '../../src/host/user-services.js';
import { projectRouteId } from '../../src/host/registry.js';
import { env, temp } from '../helpers.js';
import { fetch } from './harness.js';

const post = (url, body, headers = {}) => fetch(url, { method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

function fixture({ authenticated = false, failing = false, bound = false } = {}) {
  const root = temp(), global = path.join(root, 'device'), projects = [path.join(root, 'a'), path.join(root, 'b')];
  for (const project of projects) fs.mkdirSync(project);
  const ids = projects.map(projectRouteId), calls = [], closed = [];
  const item = (project_id, id) => ({ project_id, project_name: project_id === ids[0] ? 'a' : 'b',
    project: projects[ids.indexOf(project_id)], online: true, checked_at: '2026-10-09T10:00:00Z',
    notice: { id, task_id: 7, task_worker_number: 'W3', kind: 'question', status: 'open', title: '需要决定',
      sync_identity: `identity-${project_id}-${id}`, sync_revision: 1, sync_epoch: 'test-epoch' } });
  const preferences = { version: 1, revision: 'prefs-v1', values: { theme: 'system' } };
  const automation = { version: 1, revision: 'auto-v1', auto_select: { enabled: false }, completion_defaults: { enabled: false, level: 'merge' } };
  const preferencesService = {
    get() { calls.push(['preferences.get']); if (failing) throw new Error('PRIVATE-CREDENTIAL-response'); return preferences; },
    save(patch, revision) { calls.push(['preferences.save', patch, revision]); if (revision !== preferences.revision) throw new Error('stale revision');
      preferences.values = { ...preferences.values, ...patch }; preferences.revision = 'prefs-v2'; return preferences; },
    close() { closed.push('preferences'); },
  };
  const automationService = {
    get() { calls.push(['automation.get']); return automation; },
    save(patch, revision) { calls.push(['automation.save', patch, revision]); if (revision !== automation.revision) throw new Error('stale revision');
      for (const [key, value] of Object.entries(patch)) automation[key] = { ...automation[key], ...value };
      automation.revision = 'auto-v2'; return automation; },
    close() { closed.push('automation'); },
  };
  const inboxService = {
    list(query) { calls.push(['inbox.list', query]); return { version: 1, items: ids.map(id => item(id, 1)), cursor: null,
      has_more: false, complete: true, projects: ids.map(id => ({ id, online: true, complete: true })) }; },
    get(projectId, noticeId) { calls.push(['inbox.get', projectId, noticeId]); return item(projectId, noticeId); },
    action(body) { calls.push(['inbox.action', body]); if (failing) throw new Error('PRIVATE-RAW-UPSTREAM');
      if (body.expected_identity !== undefined && body.expected_identity !== item(body.project_id, body.id).notice.sync_identity) throw new Error('record identity changed');
      return { ...item(body.project_id, body.id), notice: { ...item(body.project_id, body.id).notice, status: body.method === 'notice.answer' ? 'answered' : 'sent' } }; },
    close() { closed.push('inbox'); },
  };
  const projectHost = {
    launcher: !bound,
    hasRoute(id) { return ids.includes(id); },
    async status() { return { mode: bound ? 'bound' : 'host', projects: ids.map((id, i) => ({ id, project: projects[i] })) }; },
    async require() { calls.push(['unexpected.project']); throw new Error('no project'); },
    async openRoute() { calls.push(['unexpected.attach']); throw new Error('no project API'); },
  };
  if (authenticated) {
    fs.mkdirSync(global, { mode: 0o700 });
    fs.writeFileSync(path.join(global, 'web.json'), JSON.stringify({ version: 1, username: 'owner',
      password: 'user-workspace-test-password', projects }), { mode: 0o600 });
  }
  const environment = env({ LUSH_GLOBAL_CONFIG: global });
  const config = bound ? { project: projects[0], home: path.join(projects[0], '.lush'), env: environment } : null;
  const web = startWeb(config, 0, { env: environment, projectHost,
    userServiceOptions: { preferencesService, automationService, inboxService } });
  return { web, root, global, ids, calls, closed, url: `http://127.0.0.1:${web.port}`,
    async close() { await web.stop(true); fs.rmSync(root, { recursive: true, force: true }); } };
}

test('Host preferences and automation are independent of a current project and return uncached safe JSON', async () => {
  const f = fixture();
  try {
    for (const suffix of ['preferences', 'automation']) {
      const response = await fetch(`${f.url}/api/host/${suffix}`);
      expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect((await response.json()).version).toBe(1);
    }
    const saved = await post(`${f.url}/api/host/preferences`, { patch: { theme: 'dark', markdown: false }, expected_revision: 'prefs-v1' });
    expect(saved.status).toBe(200); expect((await saved.json()).values).toEqual({ theme: 'dark', markdown: false });
    const enabled = await post(`${f.url}/api/host/automation`, { patch: { auto_select: { enabled: true },
      completion_defaults: { enabled: true, level: 'archive' } }, expected_revision: 'auto-v1' });
    expect(enabled.status).toBe(200); expect((await enabled.json()).completion_defaults).toEqual({ enabled: true, level: 'archive' });
    expect(f.calls.some(row => row[0].startsWith('unexpected'))).toBe(false);
    expect(fs.existsSync(path.join(f.global, 'shared'))).toBe(false);
  } finally { await f.close(); }
});

test('bound single-project Host exposes device services without attaching its project daemon', async () => {
  const f = fixture({ bound: true });
  try {
    for (const suffix of ['preferences', 'automation', 'inbox']) {
      expect((await fetch(`${f.url}/api/host/${suffix}`)).status).toBe(200);
    }
    expect((await post(`${f.url}/api/host/automation`, { patch: { auto_select: { enabled: true } }, expected_revision: 'auto-v1' })).status).toBe(200);
    expect(f.calls.some(row => row[0].startsWith('unexpected'))).toBe(false);
    expect(fs.existsSync(path.join(f.root, 'a', '.lush'))).toBe(false);
  } finally { await f.close(); }
});

test('global Inbox separates equal local Notice ids and forwards only the fixed source identity', async () => {
  const f = fixture();
  try {
    const response = await fetch(`${f.url}/api/host/inbox?status=open&limit=12&before=opaque-cursor`);
    expect(response.status).toBe(200); const page = await response.json();
    expect(page.items.map(row => row.notice.id)).toEqual([1, 1]); expect(page.items.map(row => row.project_id)).toEqual(f.ids);
    expect(f.calls.at(-1)).toEqual(['inbox.list', { status: 'open', before: 'opaque-cursor', limit: 12 }]);
    const single = await fetch(`${f.url}/api/host/inbox/notice?project_id=${f.ids[1]}&id=1`);
    expect((await single.json()).project_id).toBe(f.ids[1]);
    const body = { project_id: f.ids[1], id: 1, method: 'notice.answer', answer: '只回答 B' };
    const answered = await post(`${f.url}/api/host/inbox/action`, body);
    expect(answered.status).toBe(200); expect((await answered.json()).notice.status).toBe('answered');
    expect(f.calls.at(-1)).toEqual(['inbox.action', body]);
    for (const method of ['notice.read', 'notice.dismiss']) {
      expect((await post(`${f.url}/api/host/inbox/action`, { project_id: f.ids[0], id: 1, method })).status).toBe(200);
    }
    expect(f.calls.some(row => row[0].startsWith('unexpected'))).toBe(false);
  } finally { await f.close(); }
});

test('Inbox actions forward the viewed record identity and reject stale or malformed identity evidence', async () => {
  const f = fixture();
  try {
    const record = await (await fetch(`${f.url}/api/host/inbox/notice?project_id=${f.ids[1]}&id=1`)).json();
    const body = { project_id: f.ids[1], id: 1, method: 'notice.answer', answer: '只答当前记录', expected_identity: record.notice.sync_identity };
    const response = await post(`${f.url}/api/host/inbox/action`, body);
    expect(response.status).toBe(200); expect((await response.json()).notice.sync_identity).toBe(record.notice.sync_identity);
    expect(f.calls.at(-1)).toEqual(['inbox.action', body]);
    expect((await post(`${f.url}/api/host/inbox/action`, { ...body, expected_identity: 'retired-record' })).status).toBe(400);
    const before = f.calls.length;
    for (const expected_identity of [null, 1, {}, '', 'x'.repeat(201)]) {
      expect((await post(`${f.url}/api/host/inbox/action`, { ...body, expected_identity })).status).toBe(400);
    }
    expect(f.calls.length).toBe(before);
  } finally { await f.close(); }
});

test('workspace writes reject stale revisions without claiming the requested change happened', async () => {
  const f = fixture();
  try {
    expect((await post(`${f.url}/api/host/preferences`, { patch: { theme: 'dark' }, expected_revision: 'prefs-v1' })).status).toBe(200);
    expect((await post(`${f.url}/api/host/preferences`, { patch: { theme: 'light' }, expected_revision: 'prefs-v1' })).status).toBe(400);
    expect((await (await fetch(`${f.url}/api/host/preferences`)).json()).values.theme).toBe('dark');
    expect((await post(`${f.url}/api/host/automation`, { patch: { auto_select: { enabled: true } }, expected_revision: 'auto-v1' })).status).toBe(200);
    expect((await post(`${f.url}/api/host/automation`, { patch: { completion_defaults: { level: 'archive' } }, expected_revision: 'auto-v1' })).status).toBe(400);
    expect((await (await fetch(`${f.url}/api/host/automation`)).json()).completion_defaults.level).toBe('merge');
  } finally { await f.close(); }
});

test('workspace query parsing rejects unknown, duplicate, malformed and project-scoped parameters before service reads', async () => {
  const f = fixture();
  try {
    for (const suffix of ['preferences?scope=project', 'automation?_token=abc', 'inbox?scope=device', 'inbox?status=open&status=all',
      'inbox?limit=0', 'inbox?limit=101', 'inbox?limit=1e1', 'inbox?limit=', 'inbox?before=', 'inbox?status=sent',
      `inbox/notice?project_id=${f.ids[0]}&id=1&id=2`, `inbox/notice?project_id=${f.ids[0]}&id=1e2`,
      `inbox/notice?project_id=${f.ids[0]}&id=9007199254740993`, 'inbox/notice?project_id=ffffffffffffffff&id=1']) {
      expect((await fetch(`${f.url}/api/host/${suffix}`)).status).toBe(400);
    }
    expect(f.calls).toEqual([]);
    expect((await fetch(`${f.url}/p/${f.ids[0]}/api/host/inbox`)).status).toBe(404);
  } finally { await f.close(); }
});

test('workspace mutation surfaces cannot become an arbitrary path, token, Worker or model-call gateway', async () => {
  const f = fixture();
  try {
    for (const body of [null, [], { patch: {}, expected_revision: 'prefs-v1' }, { patch: { project: '/tmp' }, expected_revision: 'prefs-v1' },
      { patch: { theme: 'dark' }, expected_revision: 'prefs-v1', scope: 'project' },
      { patch: { theme: 'dark' }, expected_revision: 'prefs-v1', _token: '' },
      { patch: { theme: 'dark' } }]) {
      expect((await post(`${f.url}/api/host/preferences`, body)).status).toBe(400);
    }
    for (const patch of [{}, { auto_select: { enabled: 'true' } }, { auto_select: { enabled: true, project: '/tmp' } },
      { completion_defaults: { level: 'off' } }, { completion_defaults: {} }, { completion_defaults: { enabled: 1 } },
      { auto_merge: true }, { auto_select: { enabled: true }, _token: '' }]) {
      expect((await post(`${f.url}/api/host/automation`, { patch, expected_revision: 'auto-v1' })).status).toBe(400);
    }
    const base = { project_id: f.ids[0], id: 1, method: 'notice.read' };
    for (const body of [{ ...base, project: '/tmp' }, { ...base, _token: '' }, { ...base, method: 'worker.retry' },
      { ...base, method: 'quick_explain.start' }, { ...base, answer: '' }, { ...base, method: 'notice.answer' },
      { ...base, id: '1' }, { ...base, project_id: '/tmp' }, { ...base, project_id: 'ffffffffffffffff' }]) {
      expect((await post(`${f.url}/api/host/inbox/action`, body)).status).toBe(400);
    }
    expect(f.calls).toEqual([]);
  } finally { await f.close(); }
});

test('all workspace mutations require JSON without query parameters and preserve the shared Origin gate', async () => {
  const f = fixture();
  try {
    for (const suffix of ['preferences', 'automation', 'inbox/action']) {
      expect((await fetch(`${f.url}/api/host/${suffix}`, { method: 'POST', body: '{}' })).status).toBe(400);
      expect((await post(`${f.url}/api/host/${suffix}?scope=device`, {})).status).toBe(400);
      expect((await post(`${f.url}/api/host/${suffix}`, {}, { Origin: 'https://evil.invalid' })).status).toBe(403);
    }
    for (const suffix of ['preferences', 'automation', 'inbox', `inbox/notice?project_id=${f.ids[0]}&id=1`]) {
      expect((await fetch(`${f.url}/api/host/${suffix}`, { headers: { Origin: 'https://evil.invalid' } })).status).toBe(403);
    }
    expect(f.calls).toEqual([]);
  } finally { await f.close(); }
});

test('global workspace APIs require authentication before reading or invoking any service', async () => {
  const f = fixture({ authenticated: true });
  try {
    for (const suffix of ['preferences', 'automation', 'inbox', `inbox/notice?project_id=${f.ids[0]}&id=1`]) {
      expect((await fetch(`${f.url}/api/host/${suffix}`)).status).toBe(401);
    }
    for (const suffix of ['preferences', 'automation', 'inbox/action']) {
      expect((await post(`${f.url}/api/host/${suffix}`, {})).status).toBe(401);
    }
    expect(f.calls).toEqual([]);
    const login = await fetch(`${f.url}/login`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'username=owner&password=user-workspace-test-password' });
    const Cookie = login.headers.get('set-cookie').split(';')[0];
    expect((await fetch(`${f.url}/api/host/preferences`, { headers: { Cookie } })).status).toBe(200);
    expect((await fetch(`${f.url}/api/host/inbox`, { headers: { Cookie } })).status).toBe(200);
  } finally { await f.close(); }
});

test('raw dependency errors never expose credentials or pretend an uncertain action was not submitted', async () => {
  const f = fixture({ failing: true });
  try {
    const read = await fetch(`${f.url}/api/host/preferences`);
    expect(read.status).toBe(400); expect(await read.text()).not.toContain('PRIVATE');
    const action = await post(`${f.url}/api/host/inbox/action`, { project_id: f.ids[0], id: 1, method: 'notice.read' });
    expect(action.status).toBe(400); const failure = await action.json();
    expect(failure.error).not.toContain('PRIVATE'); expect(failure.error).toContain('已提交的动作');
  } finally { await f.close(); }
});

test('Host stop closes only instantiated workspace services and does not construct other resources', async () => {
  const f = fixture();
  try {
    expect((await fetch(`${f.url}/api/host/inbox`)).status).toBe(200);
    await f.web.stop(true); expect(f.closed).toEqual(['inbox']);
    expect(fs.existsSync(path.join(f.global, 'shared'))).toBe(false);
  } finally { await f.close(); }
});

test('user services validate before initialization and serialize close against an in-flight first request', async () => {
  const calls = [], projectHost = { hasRoute: () => false };
  let release, markStarted;
  const pending = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { markStarted = resolve; });
  const service = createUserServices(projectHost, { env: env({ LUSH_GLOBAL_CONFIG: '/tmp/lush-unused-workspace-root' }),
    preferencesService: { async get() { calls.push('get'); markStarted(); await pending; return {}; }, close() { calls.push('close'); } } });
  await expect(service.savePreferences({ patch: { _token: 'private' }, expected_revision: 'v1' })).rejects.toThrow('invalid');
  expect(calls).toEqual([]);
  const reading = service.readPreferences();
  await started; // Explicit signal from the controlled fake, not a timing/polling assumption.
  const closing = service.close(); release();
  await reading; await closing; await service.close();
  expect(calls).toEqual(['get', 'close']);
  await expect(service.readPreferences()).rejects.toThrow('设备偏好操作未确认');
});
