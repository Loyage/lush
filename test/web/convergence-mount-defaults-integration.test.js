import { test, expect } from 'bun:test';
import fs from 'node:fs';
import { repo, env, temp } from '../helpers.js';
import { setup, fetch } from './harness.js';
import { run as branchCLI } from '../../src/cli/commands/branch.js';
import { UIClient } from '../../src/ui/client.js';
import { startTestWeb } from './auth-fixture.js';
import { projectRouteId, writeLauncherState } from '../../src/host/registry.js';

async function request(f, route, status = 200, options = {}) {
  const response = await fetch(f.url + route, options);
  const body = await response.text();
  if (response.status !== status) throw new Error(`HTTP ${response.status} expected ${status}: ${body}`);
  if (status === 200) expect(response.headers.get('cache-control')).toBe('no-store');
  return response.headers.get('content-type')?.includes('application/json') ? JSON.parse(body) : body;
}
const post = (f, method, params, status = 200, headers = {}, extra = {}) => request(f, '/api/action', status, { method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ method, params, ...extra }) });
const policy = f => request(f, '/api/branch-convergence?branch=main');
const defaults = f => request(f, '/api/branch-convergence/defaults');

async function prepare(options) {
  const f = await setup(options);
  f.project.kick = () => {}; f.project.scheduleTaskMerge = () => {}; f.project.scheduleConvergence = () => {};
  await repo(f.root); await f.project.bootstrapMain(); return f;
}

test('real HTTP and CLI expose read-only retired policy and cannot reinstall mounts or defaults', async () => {
  const f = await prepare();
  const cli = args => branchCLI('branch', ['convergence', ...args], { client: new UIClient(f.config), json: true });
  try {
    const initial = await policy(f), initialDefaults = await defaults(f);
    expect(initial).toMatchObject({ mounted: false, enabled: false, retired: true, editable: false });
    expect(initialDefaults).toMatchObject({ mounted: false, scope: 'none', enabled: false, retired: true, editable: false });
    const list = await request(f, '/api/branch-convergence'); expect(list.defaults).toEqual(initialDefaults);
    const before = f.store.all('SELECT * FROM meta ORDER BY key');
    for (const verb of ['on','off','mount','remove']) await expect(cli([verb, 'main', '--revision', initial.revision])).rejects.toThrow('retired');
    expect(await cli(['show', 'main'])).toEqual(initial);
    expect(await cli(['defaults', 'show'])).toEqual(initialDefaults);
    await expect(cli(['defaults', 'set', '--mounted', 'true', '--enabled', 'true', '--revision', initialDefaults.revision])).rejects.toThrow('retired');
    expect((await post(f, 'branch.convergence_set', { branch: 'main', mounted: true, enabled: true, expected_revision: initial.revision }, 400)).error).toContain('retired');
    expect((await post(f, 'branch.convergence_defaults_set', { mounted: false, enabled: false, expected_revision: initialDefaults.revision }, 400)).error).toContain('retired');
    expect(f.store.all('SELECT * FROM meta ORDER BY key')).toEqual(before);
    const { task } = await post(f, 'order.submit', { content: 'no automatic convergence mount', start: false });
    expect((await request(f, `/api/worker/${task.id}/hooks`)).convergence).toMatchObject({ branch: task.branch, mounted: false, enabled: false, retired: true });
    expect(f.store.all("SELECT * FROM events WHERE type='command.execution_started'")).toHaveLength(0);
  } finally { await f.close(); }
});

test('defaults HTTP strict envelope, parameters, user privileges and Origin guard reject without writes', async () => {
  const f = await prepare({ auth: { username: 'owner', password: 'test-only-password' } });
  try {
    const before = f.project.branchConvergenceDefaults();
    await request(f, '/api/branch-convergence/defaults', 401);
    await post(f, 'branch.convergence_defaults_set', { mounted: true, enabled: true, expected_revision: before.revision }, 401);
    const login = await fetch(f.url + '/login', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'username=owner&password=test-only-password&next=%2F' });
    const Cookie = login.headers.get('set-cookie').split(';')[0], headers = { Cookie, Origin: f.url };
    expect(await request(f, '/api/branch-convergence/defaults', 200, { headers })).toEqual(before);
    for (const query of ['?mounted=true','?branch=main','?revision=x','?_token=','?mounted=true&mounted=false'])
      await request(f, '/api/branch-convergence/defaults' + query, 400, { headers });
    const valid = { mounted: true, enabled: true, expected_revision: before.revision };
    for (const params of [{ ...valid, mounted: null }, { ...valid, mounted: 'true' }, { ...valid, enabled: 1 }, { ...valid, expected_revision: '' },
      { ...valid, validation: null }, { ...valid, cwd: '/tmp' }, ...[null,'',false,0,'agent',{}].map(_token => ({ ...valid, _token }))])
      await post(f, 'branch.convergence_defaults_set', params, 400, headers);
    await post(f, 'branch.convergence_defaults_set', valid, 400, headers, { project: '/tmp' });
    await post(f, 'branch.convergence_defaults', {}, 400, headers);
    await post(f, 'branch.convergence_defaults_set', valid, 403, { Cookie, Origin: 'https://evil.invalid' });
    await request(f, '/api/branch-convergence/defaults', 403, { headers: { Cookie, Host: 'evil.invalid', Origin: f.url } });
    await request(f, '/api/action?mounted=true', 400, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'branch.convergence_defaults_set', params: valid }) });
    expect(f.project.branchConvergenceDefaults()).toEqual(before);
  } finally { await f.close(); }
});

test('Host defaults routes attach only and never start a stopped daemon or route without fixed project', async () => {
  const f = await prepare(), global = temp(), launcherEnv = env({ LUSH_GLOBAL_CONFIG: global });
  writeLauncherState(f.root, launcherEnv); let starts = 0;
  const web = startTestWeb(null, 0, { env: launcherEnv,
    openProject: async () => { starts++; throw new Error('must not start a daemon'); },
    attachProject: async () => ({ config: f.config, client: new UIClient(f.config) }) });
  const base = { url: `http://127.0.0.1:${web.port}` }, selected = { url: `${base.url}/p/${projectRouteId(f.root)}` };
  try {
    const current = await defaults(selected);
    expect((await post(selected, 'branch.convergence_defaults_set', { mounted: true, enabled: true, expected_revision: current.revision }, 400)).error).toContain('retired');
    await request(base, '/api/branch-convergence/defaults', 400);
    await f.rpc.close();
    await request(selected, '/api/branch-convergence/defaults', 400);
    await post(selected, 'branch.convergence_defaults_set', { mounted: false, enabled: false, expected_revision: current.revision }, 400);
    expect(starts).toBe(0);
  } finally { await web.stop(true); await f.close(); fs.rmSync(global, { recursive: true, force: true }); }
});
