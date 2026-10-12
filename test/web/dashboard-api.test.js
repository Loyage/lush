import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { startWeb } from '../../src/ui/web/server.js';
import { env, temp } from '../helpers.js';
import { fetch, startTestWeb } from './auth-fixture.js';

const card = () => ({ type: 'account', connection_id: randomUUID() });
const dashboardRevision = 'a'.repeat(64);
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
    const initial = await response.json(); expect(initial).toMatchObject({ version: 5, diagnostics: true, cards: [], hidden_projects: [], layout: [], content: [], account_view: 'list', widgets: null });
    expect(fs.existsSync(path.join(f.global, 'shared'))).toBe(false);
    const selected = card();
    const save = await post(f.url + route, { cards: [selected, selected], expected_revision: initial.revision });
    expect(save.status).toBe(200); let next = await save.json(); expect(next.cards).toEqual([selected]);
    expect(await (await fetch(second + route)).json()).toEqual(next);
    const id = '0123456789abcdef', layout = [{ id, x: 11, y: 4095, w: 1, h: 80 }];
    const customized = await post(second + route, { hidden_projects: [id, id], layout,
      content: [{ id, sections: ['messages', 'shortcuts'] }], expected_revision: next.revision });
    expect(customized.status).toBe(200); next = await customized.json();
    expect(next).toMatchObject({ version: 5, diagnostics: true, cards: [selected], hidden_projects: [id], layout, account_view: 'list', widgets: null,
      content: [{ id, sections: ['messages', 'shortcuts'] }] });
    expect(await (await fetch(f.url + route)).json()).toEqual(next);
    const contentOnly = await post(f.url + route, { content: [{ id, sections: [] }], expected_revision: next.revision });
    expect(contentOnly.status).toBe(200); next = await contentOnly.json();
    expect(next).toMatchObject({ cards: [selected], hidden_projects: [id], layout, content: [{ id, sections: [] }] });
    const cardsOnly = await post(second + route, { cards: [], expected_revision: next.revision });
    expect(cardsOnly.status).toBe(200); next = await cardsOnly.json();
    expect(next).toMatchObject({ cards: [], hidden_projects: [id], layout, content: [{ id, sections: [] }], account_view: 'list' });
    const accountsLayout = [...layout, { id: 'accounts', x: 0, y: 0, w: 12, h: 6 }];
    const unified = await post(f.url + route, { account_view: 'tiles', layout: accountsLayout,
      content: [...next.content, { id: 'accounts', sections: ['quota', 'balance', 'reset'] }], expected_revision: next.revision });
    expect(unified.status).toBe(200); next = await unified.json();
    expect(next).toMatchObject({ version: 5, diagnostics: true, cards: [], hidden_projects: [id], layout: accountsLayout, account_view: 'tiles', widgets: null,
      content: [{ id, sections: [] }, { id: 'accounts', sections: ['quota', 'balance', 'reset'] }] });
    expect(await (await fetch(second + route)).json()).toEqual(next);
    const switched = await post(second + route, { account_view: 'list', expected_revision: next.revision });
    expect(switched.status).toBe(200); const switchedModel = await switched.json();
    expect(switchedModel).toMatchObject({ ...next, account_view: 'list', revision: switchedModel.revision });
    expect(switchedModel.revision).not.toBe(next.revision); next = switchedModel;
    const diagnosticToggle = await post(second + route, { diagnostics: false, expected_revision: next.revision });
    expect(diagnosticToggle.status).toBe(200); const toggled = await diagnosticToggle.json();
    expect(toggled).toEqual({ ...next, diagnostics: false, revision: toggled.revision }); expect(toggled.revision).not.toBe(next.revision);
    expect(await (await fetch(f.url + route)).json()).toEqual(toggled); next = toggled;
    const invalidDiagnostic = await post(second + route, { diagnostics: 'false', expected_revision: next.revision });
    expect(invalidDiagnostic.status).toBe(400); expect(await (await fetch(f.url + route)).json()).toEqual(next);
    const staleDiagnostic = await post(f.url + route, { diagnostics: true, expected_revision: initial.revision });
    expect(staleDiagnostic.status).toBe(400); expect(await (await fetch(second + route)).json()).toEqual(next);
    const stale = await post(second + route, { account_view: 'tiles', expected_revision: initial.revision });
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

test('HTTP v1 reads do not migrate, inspect credentials or attach a project and explicit v4 save preserves deleted sources', async () => {
  const f = fixture(), selected = card(), home = path.join(f.global, 'shared'), file = path.join(home, 'dashboard.json');
  try {
    fs.mkdirSync(home, { mode: 0o700 });
    fs.mkdirSync(path.join(home, 'credentials'), { mode: 0o700 });
    const credentialFile = path.join(home, 'credentials', 'agent-connections.json');
    fs.writeFileSync(credentialFile, 'PRIVATE MALFORMED CREDENTIALS', { mode: 0o600 });
    const source = JSON.stringify({ version: 1, cards: [selected] });
    fs.writeFileSync(file, source, { mode: 0o600 });
    const before = fs.statSync(file), url = f.url + '/api/host/dashboard';
    const response = await fetch(url); expect(response.status).toBe(200);
    const model = await response.json();
    expect(model).toMatchObject({ version: 5, diagnostics: true, cards: [selected], hidden_projects: [], layout: [], content: [], account_view: 'list', widgets: null });
    expect(fs.readFileSync(file, 'utf8')).toBe(source);
    expect(fs.statSync(file).ino).toBe(before.ino); expect(fs.statSync(file).mtimeMs).toBe(before.mtimeMs);
    const id = `account:${selected.connection_id}`;
    const saved = await post(url, { layout: [{ id, x: 0, y: 0, w: 12, h: 6 }],
      content: [{ id, sections: ['quota', 'balance', 'reset'] }], expected_revision: model.revision });
    expect(saved.status).toBe(200); const next = await saved.json(); expect(next.cards).toEqual([selected]);
    expect(next.content).toEqual([{ id, sections: ['quota', 'balance', 'reset'] }]);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).version).toBe(5);
    expect(fs.readFileSync(credentialFile, 'utf8')).toBe('PRIVATE MALFORMED CREDENTIALS');
    expect(f.calls).toEqual([]);
  } finally { await f.close(); }
});

test('HTTP v2 files retain legacy account layout/content and map read-only to shared v4 views', async () => {
  const f = fixture(), second = f.open(), selected = card(), id = `account:${selected.connection_id}`;
  try {
    const home = path.join(f.global, 'shared'), file = path.join(home, 'dashboard.json');
    fs.mkdirSync(home, { mode: 0o700 });
    const data = { version: 2, cards: [selected], hidden_projects: ['0123456789abcdef'],
      layout: [{ id, x: 0, y: 5, w: 4, h: 6 }], content: [{ id, sections: ['history', 'provenance'] }] };
    const source = JSON.stringify(data); fs.writeFileSync(file, source, { mode: 0o600 });
    const stat = fs.statSync(file), route = '/api/host/dashboard';
    const response = await fetch(f.url + route); expect(response.status).toBe(200);
    const current = await response.json(); expect(current).toMatchObject({ ...data, version: 5, diagnostics: true, account_view: 'list', widgets: null });
    expect(await (await fetch(second + route)).json()).toEqual(current);
    expect(fs.readFileSync(file, 'utf8')).toBe(source);
    expect(fs.statSync(file).mtimeMs).toBe(stat.mtimeMs); expect(fs.statSync(file).ino).toBe(stat.ino);
    const saved = await post(second + route, { account_view: 'tiles', expected_revision: current.revision });
    expect(saved.status).toBe(200); const next = await saved.json();
    expect(next).toMatchObject({ ...data, version: 5, diagnostics: true, account_view: 'tiles', widgets: null });
    expect(await (await fetch(f.url + route)).json()).toEqual(next);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ ...data, version: 5, diagnostics: true, account_view: 'tiles', widgets: null });
    const cleared = await post(f.url + route, { cards: [], expected_revision: next.revision });
    expect(cleared.status).toBe(200); const clearedModel = await cleared.json();
    expect(clearedModel).toMatchObject({ ...next, revision: clearedModel.revision, cards: [] });
    expect(await (await fetch(second + route)).json()).toEqual(clearedModel);
    expect(f.calls).toEqual([]);
  } finally { await f.close(); }
});

test('HTTP v4 publishes independent widgets and empty boards without removing old fields or contacting sources', async () => {
  const f = fixture();
  try {
    const route = f.url + '/api/host/dashboard', initial = await (await fetch(route)).json();
    const connection = randomUUID(), project = '0123456789abcdef';
    const legacy = { cards: [card()], hidden_projects: [project], content: [{ id: project, sections: ['messages'] }], account_view: 'tiles' };
    const oldResponse = await post(route, { ...legacy, expected_revision: initial.revision });
    expect(oldResponse.status).toBe(200); const old = await oldResponse.json();
    const widgets = [
      { id: 'widget:account-a', type: 'accounts', project_id: null, connection_ids: [connection.toUpperCase(), connection], links: [], sections: ['quota'] },
      { id: 'widget:status-a', type: 'status', project_id: project, connection_ids: [], links: [], sections: [] },
      { id: 'widget:status-b', type: 'status', project_id: project, connection_ids: [], links: [], sections: ['metrics'] },
      { id: 'widget:links', type: 'shortcuts', project_id: null, connection_ids: [], links: [{ scope: 'global', target: 'docs', project_id: null }], sections: ['shortcuts'] },
    ];
    const layout = widgets.map(({ id }) => ({ id, x: 0, y: 0, w: 12, h: 6 }));
    const response = await post(route, { widgets, layout, expected_revision: old.revision });
    expect(response.status).toBe(200); const saved = await response.json();
    expect(saved).toMatchObject({ ...legacy, version: 5, diagnostics: true, layout });
    expect(saved.widgets).toEqual(widgets.map((widget, i) => i ? widget : { ...widget, connection_ids: [connection] }));
    expect(await (await fetch(f.open() + '/api/host/dashboard')).json()).toEqual(saved);
    expect((await post(route, { widgets: [], expected_revision: old.revision })).status).toBe(400);
    const emptyResponse = await post(route, { widgets: [], expected_revision: saved.revision });
    expect(emptyResponse.status).toBe(200); const empty = await emptyResponse.json();
    expect(empty).toMatchObject({ ...legacy, widgets: [], layout });
    expect(await (await fetch(route)).json()).toEqual(empty);
    const projected = await post(route, { widgets: null, expected_revision: empty.revision });
    expect(projected.status).toBe(200); expect((await projected.json()).widgets).toBeNull();
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
    const row = { id: '0123456789abcdef', x: 0, y: 0, w: 12, h: 6 };
    for (const patch of [{}, { widgets: {} }, { widgets: [null] }, { widgets: Array(101).fill({}) },
      { widgets: [{ id: 'widget:a', type: 'accounts', project_id: null, connection_ids: [], links: [], sections: [], secret: 'PRIVATE' }] }, ...[null, true, 1, '', 'LIST', 'grid', [], {}].map(account_view => ({ account_view })),
      { layout: [{ ...row, id: 'Accounts' }] }, { hidden_projects: ['accounts'] },
      { content: [{ id: 'accounts', sections: ['metrics'] }] },
      { content: [{ id: 'accounts', sections: [] }, { id: 'accounts', sections: [] }] },
      { hidden_projects: null }, { hidden_projects: ['0123456789ABCDEF'] },
      { hidden_projects: Array(301).fill(row.id) }, { layout: [row, row] }, { layout: [{ ...row, h: 5 }] },
      { layout: [{ ...row, y: 4096 }] }, { layout: [{ ...row, x: 11, w: 2 }] },
      { layout: [{ ...row, id: 'account:invalid' }] }, { layout: [{ ...row, credential: 'PRIVATE' }] },
      { content: [{ id: row.id, sections: ['quota'] }] }, { content: [{ id: `account:${selected.connection_id}`, sections: ['metrics'] }] },
      { content: [{ id: row.id, sections: [null] }] }, { content: [{ id: row.id, sections: [] }, { id: row.id, sections: [] }] }]) {
      expect((await post(url, { ...patch, expected_revision: dashboardRevision })).status).toBe(400);
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
    get() { calls.push('get'); return { version: 4, revision: dashboardRevision, cards: [], hidden_projects: [], layout: [], content: [], account_view: 'list', widgets: null }; },
    save(patch) { calls.push('save'); return { version: 4, revision: dashboardRevision, cards: [], hidden_projects: [], layout: [], content: [], account_view: 'list', widgets: null, ...patch }; },
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
    expect((await post(url, { account_view: 'tiles', expected_revision: dashboardRevision }, { Cookie })).status).toBe(200);
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
    const save = await post(url, { cards: [], expected_revision: dashboardRevision });
    expect(save.status).toBe(400); const body = await save.json(); expect(body.error).not.toContain('PRIVATE');
    expect(body.error).toContain('操作未确认'); expect(body.error).toContain('可能版本已变更');
    expect(body.error).toContain('保留编辑');
    await f.webs[0].stop(true); expect(calls).toEqual(['get', 'save', 'close']);
    expect(fs.readdirSync(f.global)).toEqual(['web.json']);
  } finally { await f.close(); }
});
