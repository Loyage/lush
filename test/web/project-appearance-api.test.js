import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { temp, env } from '../helpers.js';
import { fetch } from './harness.js';
import { startWeb } from '../../src/ui/web/server.js';
import { createAppearance } from '../../src/ui/web/assets/appearance.js';
import { writeLauncherState, projectRouteId } from '../../src/host/registry.js';

const post = (url, body, headers = {}) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
function setup({ authenticated = false, bound = false, mock = false } = {}) {
  const root = temp(), global = path.join(root, 'global'); fs.mkdirSync(global, { mode: 0o700 });
  const projects = ['a', 'b', 'denied'].map(name => { const project = path.join(root, name); fs.mkdirSync(project); return project; });
  const environment = env({ LUSH_GLOBAL_CONFIG: global });
  for (const project of projects) writeLauncherState(project, environment);
  if (authenticated) fs.writeFileSync(path.join(global, 'web.json'), JSON.stringify({ version: 1, username: 'owner', password: 'project-appearance-password', projects: projects.slice(0, 2) }), { mode: 0o600 });
  const calls = [];
  const config = bound ? { project: projects[0], home: path.join(projects[0], '.lush'), env: environment } : null;
  const oldMock = { launcher: true, status: async () => ({ projects: [] }), projects: async () => [], hasRoute: () => false };
  const web = startWeb(config, 0, { env: environment, ...(mock ? { projectHost: oldMock } : {}),
    ...(bound ? { authConfig: null } : {}),
    openProject: async () => { calls.push('start'); throw new Error('unexpected daemon start'); },
    attachProject: async () => { calls.push('attach'); throw new Error('unexpected daemon attach'); } });
  const base = `http://127.0.0.1:${web.port}`;
  return { root, global, projects, environment, calls, web, base,
    url: (i = 0) => `${base}/api/host/projects/${projectRouteId(projects[i])}/appearance`,
    async close() { await web.stop(true); fs.rmSync(root, { recursive: true, force: true }); } };
}
const save = (appearance, patch = {}) => ({ theme: appearance.theme, color: appearance.color, expected_revision: appearance.revision, ...patch });

test('Host appearance GET is read-only; POST initializes and saves offline projects across Host clients', async () => {
  const f = setup(); let second;
  try {
    for (const route of ['/api/host', '/api/host/projects']) expect((await fetch(f.base + route)).status).toBe(200);
    const missing = await fetch(f.url());
    expect(missing.status).toBe(200); expect(missing.headers.get('cache-control')).toBe('no-store');
    expect(await missing.json()).toEqual({ id: projectRouteId(f.projects[0]), project: f.projects[0], name: 'a', appearance: null });
    expect(fs.existsSync(path.join(f.projects[0], '.lush'))).toBe(false);
    const initialized = await post(f.url(), { initialize: true }); expect(initialized.status).toBe(200);
    expect(initialized.headers.get('cache-control')).toBe('no-store');
    const first = await initialized.json(); expect(first.appearance).toMatchObject({ version: 1, theme: 'system', color: 'green' });
    const next = await (await post(f.url(1), { initialize: true })).json(); expect(next.appearance.color).toBe('blue');
    const changed = await post(f.url(), save(first.appearance, { theme: 'dark', color: 'teal' })); expect(changed.status).toBe(200);
    const saved = await changed.json(); expect(saved.appearance.revision).not.toBe(first.appearance.revision);
    expect((await post(f.url(), save(first.appearance, { color: 'rose' }))).status).toBe(400);
    expect(await (await post(f.url(), { initialize: true })).json()).toEqual(saved);
    second = startWeb(null, 0, { env: f.environment });
    const remote = `http://127.0.0.1:${second.port}/api/host/projects/${first.id}/appearance`;
    expect(await (await fetch(remote)).json()).toEqual(saved);
    const secondSave = await post(remote, save(saved.appearance, { theme: 'light' })); expect(secondSave.status).toBe(200);
    expect((await (await fetch(f.url())).json()).appearance.theme).toBe('light');
    expect(f.calls).toEqual([]);
    expect(fs.existsSync(path.join(f.projects[2], '.lush'))).toBe(false);
  } finally { if (second) await second.stop(true); await f.close(); }
});

test('frontend controller and real Host agree on initialization, full saves, revisions and synchronization', async () => {
  const f = setup(), controllers = [];
  const request = async (route, options) => {
    const response = await fetch(f.base + route, options), body = await response.json();
    if (!response.ok) throw new Error(body.error);
    return body;
  };
  const makeController = () => {
    const root = { dataset: {} };
    const controller = createAppearance({ projectId: projectRouteId(f.projects[0]), root, toggle: null,
      media: { matches: false }, request, setInterval: null });
    controllers.push(controller); return { controller, root };
  };
  try {
    const first = makeController(), second = makeController();
    await first.controller.load(false);
    expect(first.controller.snapshot().appearance).toBeNull();
    expect(fs.existsSync(path.join(f.projects[0], '.lush'))).toBe(false);
    await first.controller.load(true); await second.controller.load(true);
    const initial = first.controller.snapshot().appearance;
    expect(initial).toEqual(second.controller.snapshot().appearance);
    expect(initial.revision).toMatch(/^[a-f0-9]{32}$/);
    await first.controller.save({ theme: 'dark', color: 'rose' });
    expect(first.root.dataset).toEqual({ theme: 'dark', projectColor: 'rose' });
    await expect(second.controller.save({ color: 'teal' })).rejects.toThrow('revision conflict');
    expect(second.controller.snapshot().appearance).toEqual(initial);
    await second.controller.load(false);
    expect(second.controller.snapshot().appearance).toEqual(first.controller.snapshot().appearance);
    expect(second.root.dataset).toEqual(first.root.dataset);
    await second.controller.save({ theme: 'light' }); await first.controller.load(false);
    expect(first.root.dataset).toEqual({ theme: 'light', projectColor: 'rose' });
    expect(first.controller.snapshot().appearance).toEqual(second.controller.snapshot().appearance);
    expect(f.calls).toEqual([]);
  } finally { for (const controller of controllers) controller.destroy(); await f.close(); }
});

test('bound Web exposes one stable ID and appearance without a running daemon', async () => {
  const f = setup({ bound: true });
  try {
    const host = await (await fetch(f.base + '/api/host')).json();
    expect(host.projects.map(row => row.id)).toEqual([projectRouteId(f.projects[0])]);
    expect((await fetch(f.url())).status).toBe(200);
    expect((await post(f.url(), { initialize: true })).status).toBe(200);
    expect((await fetch(f.url(1))).status).toBe(400);
    expect(f.calls).toEqual([]);
  } finally { await f.close(); }
});

test('appearance boundaries reject arbitrary identities, queries, partial updates, tokens, bad types and cross-origin', async () => {
  const f = setup();
  try {
    const initial = await (await post(f.url(), { initialize: true })).json();
    for (const body of [null, [], {}, { initialize: false }, { initialize: true, _token: '' }, { initialize: true, token: 'x' },
      { initialize: true, project: f.projects[0] }, { initialize: true, extra: 1 }, { theme: 'dark' },
      save(initial.appearance, { color: '#fff' }), save(initial.appearance, { theme: 'sepia' }),
      save(initial.appearance, { expected_revision: 1 }), save(initial.appearance, { _token: '' })]) {
      const response = await post(f.url(), body); expect(response.status).toBe(400);
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
    for (const suffix of ['?token=x', '?_token=', '?project=/tmp', '?theme=dark']) {
      expect((await fetch(f.url() + suffix)).status).toBe(400);
      expect((await post(f.url() + suffix, { initialize: true })).status).toBe(400);
    }
    expect((await fetch(f.base + '/api/host/projects/' + '0'.repeat(16) + '/appearance')).status).toBe(400);
    expect((await fetch(f.url(), { method: 'POST', body: '{}' })).status).toBe(400);
    expect((await fetch(f.url(), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' })).status).toBe(400);
    expect((await fetch(f.url(), { headers: { Origin: 'https://evil.invalid' } })).status).toBe(403);
    expect((await post(f.url(), { initialize: true }, { Origin: 'https://evil.invalid' })).status).toBe(403);
    expect((await fetch(f.url(), { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status).toBe(403);
    const malformed = await fetch(f.base + '/api/host/projects/not-an-id/appearance'); expect(malformed.status).not.toBe(200);
    expect(await (await fetch(f.url())).json()).toEqual(initial);
    expect(f.calls).toEqual([]);
  } finally { await f.close(); }
});

test('public appearance routes require login and reject registered paths outside whitelist', async () => {
  const f = setup({ authenticated: true });
  try {
    expect((await fetch(f.url())).status).toBe(401);
    expect((await post(f.url(), { initialize: true })).status).toBe(401);
    const login = await fetch(f.base + '/login', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'username=owner&password=project-appearance-password' }); expect(login.status).toBe(303);
    const headers = { Cookie: login.headers.get('set-cookie').split(';')[0] };
    const denied = await post(f.url(2), { initialize: true }, headers); expect(denied.status).toBe(400);
    expect((await fetch(f.url(2), { headers })).status).toBe(400);
    expect(fs.existsSync(path.join(f.projects[2], '.lush'))).toBe(false);
    expect((await post(f.url(), { initialize: true }, headers)).status).toBe(200);
    expect((await fetch(f.url(), { headers })).status).toBe(200);
    expect(f.calls).toEqual([]);
  } finally { await f.close(); }
});

test('legacy projectHost mocks need no appearance methods unless the new route is requested', async () => {
  const f = setup({ mock: true });
  try {
    expect((await fetch(f.base + '/api/host')).status).toBe(200);
    expect((await fetch(f.base + '/api/host/projects')).status).toBe(200);
    expect((await fetch(f.base + '/')).status).toBe(200);
    const unavailable = await fetch(f.url()); expect(unavailable.status).toBe(400);
    expect((await unavailable.json()).error).toContain('unavailable');
  } finally { await f.close(); }
});

test('HTTP returns safe errors for malformed configuration and does not reset it', async () => {
  const f = setup();
  try {
    await post(f.url(), { initialize: true });
    const appearanceFile = path.join(f.projects[0], '.lush', 'appearance.json');
    fs.writeFileSync(appearanceFile, 'PRIVATE-FILE-CONTENT');
    const response = await fetch(f.url()); expect(response.status).toBe(400); expect(await response.text()).not.toContain('PRIVATE');
    expect((await post(f.url(), { initialize: true })).status).toBe(400);
    expect(fs.readFileSync(appearanceFile, 'utf8')).toBe('PRIVATE-FILE-CONTENT');
  } finally { await f.close(); }
});
