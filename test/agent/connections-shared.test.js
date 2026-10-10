import { test, expect, afterEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { ConnectionManager } from '../../src/agent/connections.js';
import { ConnectionFile } from '../../src/agent/connections-file.js';
import { saveNetworkConfiguration } from '../../src/agent/network.js';
import { acquireConfigurationLock } from '../../src/core/device-config.js';
import { temp, gate } from '../helpers.js';

const fixtures = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    await Promise.all(f.managers.map(manager => manager.stop()));
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});
function setup(options = {}) {
  const root = temp(), deviceHome = path.join(root, 'device', 'shared');
  const configs = ['one', 'two'].map(name => {
    const project = path.join(root, name), home = path.join(project, '.lush');
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    return { project, home, deviceHome, env: {} };
  });
  const managers = configs.map(config => new ConnectionManager(config, options));
  const f = { root, configs, managers, a: managers[0], b: managers[1], device: managers[0].forScope('device') };
  fixtures.push(f); return f;
}
const config = (provider = 'deepseek', extra = {}) => ({ label: 'Same label', provider,
  auth_type: provider === 'openai-codex' ? 'oauth' : 'api_key', enabled: true, models: [], ...extra });
const editable = ({ credential, storage_scope, ...row }) => row;
const tokens = { access_token: `e30.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'shared-account' } })).toString('base64url')}.signature`,
  refresh_token: 'shared-refresh-secret', expires_in: 3600 };
async function login(manager, row) {
  const started = manager.loginStart(row.id), state = new URL(started.url).searchParams.get('state');
  return manager.loginFinish(row.id, started.login_id, `${started.redirect_uri}?code=private-code&state=${state}`);
}

test('project managers read and write device-only sources while old project files remain inactive', async () => {
  const f = setup(), shared = f.device.save(config(), { api_key: 'shared-key-secret' });
  const legacy = new ConnectionManager({ ...f.configs[0], deviceHome: null }); f.managers.push(legacy);
  const local = legacy.save(config(), { api_key: 'local-key-secret' });
  for (const manager of [f.a, f.b, f.device]) {
    expect(manager.config().connections.map(row => row.id)).toEqual([shared.id]);
    expect(manager.config().configuration_scope).toMatchObject({ selected: 'device', source: 'device', project_override: false });
  }
  expect((await f.b.prepareRuntime(shared.id)).credential.key).toBe('shared-key-secret');
  await expect(f.a.prepareRuntime(local.id)).rejects.toThrow('connection not found');
  expect(fs.existsSync(path.join(f.configs[1].home, 'credentials', 'agent-connections.json'))).toBe(false);
  expect(JSON.stringify(f.a.config())).not.toContain('key-secret');
  expect(() => f.device.save(config(), { api_key: 'bad\nkey' })).toThrow();
  expect(() => f.a.forScope('project')).toThrow('no longer');
  expect(() => f.a.forScope('all')).toThrow();
  expect(() => new ConnectionManager({ home: f.configs[0].home }).forScope('device')).toThrow('unavailable');
});

test('same-UUID project shadows never replace or resurrect shared credentials', async () => {
  const f = setup(), shared = f.device.save(config(), { api_key: 'shared-key-secret' });
  const source = new ConnectionFile(f.configs[0].home);
  source.transaction(data => { data.connections.push({ ...f.device.file.read().connections[0], credential: { type: 'api_key', key: 'local-key-secret' } }); });
  const before = fs.readFileSync(source.file);
  expect((await f.a.prepareRuntime(shared.id)).credential.key).toBe('shared-key-secret');
  f.device.save({ ...editable(shared), label: 'Shared renamed' });
  expect(f.a.config().connections[0].label).toBe('Shared renamed');
  expect(fs.readFileSync(source.file)).toEqual(before);
  f.device.remove(shared.id); expect(f.a.config().connections).toEqual([]);
  await expect(f.a.prepareRuntime(shared.id)).rejects.toThrow('connection not found');
});

test('mutating an inherited source uses its actual root, with device writer/migration coordination', () => {
  const f = setup(), shared = f.device.save(config(), { api_key: 'shared-key-secret' });
  f.b.save({ ...editable(shared), label: 'Changed via effective project view' });
  expect(f.device.config().connections[0].label).toBe('Changed via effective project view');
  expect(fs.existsSync(path.join(f.configs[1].home, 'credentials', 'agent-connections.json'))).toBe(false);
  const lock = acquireConfigurationLock(f.configs[0], 'device');
  try {
    expect(() => f.device.save(config(), { api_key: 'another-key' })).toThrow('Connection operation unavailable');
    expect(f.device.config().connections).toHaveLength(1);
  } finally { lock.release(); }
  f.device.configureSampling({ enabled: true, interval_minutes: 10, retention_days: 30 });
  expect(f.b.config().sampling).toMatchObject({ enabled: true, interval_minutes: 10 });
  f.b.configureSampling({ enabled: false, interval_minutes: 5, retention_days: 7 });
  expect(f.b.config().sampling.enabled).toBe(false);
  expect(f.device.config().sampling.enabled).toBe(false);
});

test('full connection edits discard read-only storage metadata and cannot redirect writes between roots', () => {
  const f = setup(), shared = f.device.save(config(), { api_key: 'shared-key-secret' });
  const local = f.a.save(config(), { api_key: 'local-key-secret' });
  const { credential: sharedCredential, ...sharedInput } = shared;
  const { credential: localCredential, ...localInput } = local;
  f.a.save({ ...sharedInput, storage_scope: 'project', label: 'Shared edited' });
  f.a.save({ ...localInput, storage_scope: 'device', label: 'Local edited' });
  expect(f.device.config().connections[0]).toMatchObject({ label: 'Shared edited', storage_scope: 'device' });
  expect(f.a.file.read().connections).toHaveLength(2);
  expect(f.a.file.read().connections[1]).toMatchObject({ id: local.id, label: 'Local edited' });
  expect(f.device.file.read().connections.every(row => !Object.hasOwn(row, 'storage_scope'))).toBe(true);
  expect(f.a.file.read().connections.every(row => !Object.hasOwn(row, 'storage_scope'))).toBe(true);
  expect(() => f.a.save({ ...localInput, storage_scope: 'all' })).toThrow('storage scope');
  expect(() => f.a.save({ ...localInput, configuration_scope: { selected: 'device' } })).toThrow('fields');
  expect(() => f.device.save({ ...localInput, storage_scope: 'device' })).not.toThrow();
});

test('inherited model catalog refresh writes beside the shared connection and another project reads it locally', async () => {
  let calls = 0;
  const f = setup({ fetch: async () => { calls++; return Response.json({ data: [{ id: 'shared-model' }] }); } });
  const shared = f.device.save(config(), { api_key: 'shared-key-secret' });
  await f.a.catalogRefresh(shared.id);
  expect(f.b.catalog(shared.id)).toMatchObject({ status: 'fresh', models: [{ id: 'deepseek/shared-model' }] });
  expect(calls).toBe(1);
  expect(fs.existsSync(path.join(f.configs[0].home, 'credentials', 'agent-models.json'))).toBe(false);
  expect(fs.existsSync(f.device.catalogs.file)).toBe(true);
  expect(fs.statSync(f.device.catalogs.file).mode & 0o777).toBe(0o600);
});

test('shared OAuth refresh is coordinated across different project managers and does not copy refresh credentials', async () => {
  let now = Date.parse('2026-10-03T06:00:00Z'), refreshes = 0;
  const f = setup({ now: () => now, fetch: async (_url, init) => {
    if (init.body.get('grant_type') === 'refresh_token') refreshes++;
    return Response.json(tokens);
  } });
  const shared = f.device.save(config('openai-codex'));
  await login(f.device, shared); now += 3601000;
  const [a, b] = await Promise.all([f.a.prepareRuntime(shared.id), f.b.prepareRuntime(shared.id)]);
  expect(refreshes).toBe(1);
  expect(a.account_key).toBe(b.account_key);
  expect(f.a.identity(shared.id).revision).toBe(f.b.identity(shared.id).revision);
  expect(fs.existsSync(path.join(f.configs[0].home, 'credentials', 'agent-connections.json'))).toBe(false); expect(fs.existsSync(path.join(f.configs[1].home, 'credentials', 'agent-connections.json'))).toBe(false);
  expect(JSON.stringify(f.a.config())).not.toContain('shared-refresh-secret');
});

test('cross-process OAuth locking uses the device root even when projects have different homes', async () => {
  let now = Date.parse('2026-10-03T06:00:00Z');
  const f = setup({ now: () => now, fetch: async () => Response.json(tokens) });
  const shared = f.device.save(config('openai-codex')); await login(f.device, shared); now += 3601000;
  const count = path.join(f.root, 'refresh-count'), module = path.resolve('src/agent/connections.js');
  const children = f.configs.map(configuration => Bun.spawn([process.execPath, '--eval', `
    import fs from 'node:fs'; import {ConnectionManager} from ${JSON.stringify(module)};
    const m = new ConnectionManager(${JSON.stringify(configuration)}, { now: () => ${now}, fetch: async () => {
      fs.appendFileSync(${JSON.stringify(count)}, 'refresh\\n');
      await new Promise(resolve => setTimeout(resolve, 40)); return Response.json(${JSON.stringify(tokens)});
    }});
    try { console.log((await m.prepareRuntime(${JSON.stringify(shared.id)})).account_key); } finally { await m.stop(); }
  `], { stdout: 'pipe', stderr: 'pipe' }));
  const results = await Promise.all(children.map(async child => ({ code: await child.exited,
    out: await new Response(child.stdout).text(), error: await new Response(child.stderr).text() })));
  expect(results.map(row => row.code)).toEqual([0, 0]); expect(results.map(row => row.error)).toEqual(['', '']);
  expect(results[0].out).toBe(results[1].out); expect(fs.readFileSync(count, 'utf8')).toBe('refresh\n');
}, 10000);

test('adding a legacy shadow during OAuth refresh does not redirect or invalidate device publication', async () => {
  let now = Date.parse('2026-10-03T06:00:00Z'); const entered = gate(), release = gate();
  const f = setup({ now: () => now, fetch: async (_url, init) => {
    if (init.body.get('grant_type') === 'refresh_token') { entered.resolve(); await release.promise; } return Response.json(tokens);
  } });
  const shared = f.device.save(config('openai-codex')); await login(f.device, shared); now += 3601000;
  const pending = f.a.prepareRuntime(shared.id); await entered.promise;
  const source = new ConnectionFile(f.configs[0].home);
  source.transaction(data => { data.connections.push(f.device.file.read().connections[0]); });
  const before = fs.readFileSync(source.file); release.resolve();
  expect((await pending).credential.expires).toBeGreaterThan(now);
  expect(fs.readFileSync(source.file)).toEqual(before);
});

test('stop cancels the scoped manager family and refuses future scoped mutation; read-only config remains available', async () => {
  const f = setup(); const shared = f.device.save(config('openai-codex'));
  f.device.loginStart(shared.id); expect(f.a.isBusy()).toBeTruthy();
  await f.a.stop();
  expect(f.device.closed).toBe(true); expect(f.device.logins.size).toBe(0);
  expect(() => f.device.save(config())).toThrow();
  expect(() => f.b.forScope('device').save(config(), { api_key: 'other-key' })).not.toThrow();
  expect(f.a.config().connections).toHaveLength(2);
});

test('both configuration and runtime ignore old project network settings', () => {
  const f = setup(); f.device.save(config(), { api_key: 'shared-key-secret' });
  saveNetworkConfiguration(f.configs[0], { version: 1, mode: 'direct', no_proxy: [] });
  saveNetworkConfiguration({ ...f.configs[0], deviceHome: null }, { version: 1, mode: 'proxy', proxy_url: 'https://project-proxy.example:8443', no_proxy: [] });
  const target = 'https://api.deepseek.com/models';
  expect(f.device.networkSnapshot().route(target)).toBe(''); expect(f.a.networkSnapshot().route(target)).toBe('');
  expect(f.device.networkConfig.home).toBe(f.configs[0].deviceHome); expect(f.a.networkConfig.home).toBe(f.configs[0].deviceHome);
});

test('no-project Host connection management uses an explicit private device root and never constructs a project view', async () => {
  const f = setup(), shared = f.device.save(config(), { api_key: 'shared-key-secret' });
  const hostConfig = { project: null, home: f.configs[0].deviceHome, deviceHome: null, env: {} };
  const host = new ConnectionManager(hostConfig); f.managers.push(host);
  expect(host.forScope('device')).toBe(host);
  expect(() => host.forScope('project')).toThrow('no longer');
  expect(host.config().configuration_scope).toMatchObject({ selected: 'device', source: 'device', project_home: null });
  expect(host.config().connections[0]).toMatchObject({ id: shared.id, storage_scope: 'device' });
  expect((await host.prepareRuntime(shared.id)).credential.key).toBe('shared-key-secret');
  expect(hostConfig.deviceHome).toBeNull(); expect(hostConfig.project).toBeNull();
  fs.chmodSync(hostConfig.home, 0o755); expect(() => host.config()).toThrow();
  fs.chmodSync(hostConfig.home, 0o700);
});

test('source handoff guards still block old-root refresh owners but never become a runtime fallback', async () => {
  const f = setup(), legacy = new ConnectionManager({ ...f.configs[0], deviceHome: null }); f.managers.push(legacy);
  const local = legacy.save(config(), { api_key: 'local-key-secret' }); f.device.save(config(), { api_key: 'shared-key-secret' });
  const marker = path.join(legacy.file.dir, 'device-migration-active.json');
  fs.writeFileSync(marker, JSON.stringify({ version: 1, id: 'test-handoff' }), { mode: 0o600 });
  expect(() => legacy.config()).toThrow(); expect(() => legacy.save({ ...editable(local), label: 'Changed' })).toThrow();
  await expect(legacy.prepareRuntime(local.id)).rejects.toThrow();
  const trusted = new ConnectionFile(f.configs[0].home, { privateRoot: true, migrationRead: true });
  expect(trusted.read().connections[0].id).toBe(local.id); expect(f.a.config().connections).toHaveLength(1);
  fs.unlinkSync(marker); fs.symlinkSync(path.join(f.root, 'missing-target'), marker); expect(() => legacy.config()).toThrow();
  fs.unlinkSync(marker); fs.writeFileSync(marker, 'not JSON', { mode: 0o644 }); expect(() => legacy.config()).toThrow();
  fs.unlinkSync(marker); expect(legacy.config().connections).toHaveLength(1); expect(f.a.config().connections).toHaveLength(1);
});

test('unsafe shared roots/files never fall back to a local or external credential store', () => {
  const f = setup(); f.device.save(config(), { api_key: 'shared-key-secret' });
  fs.chmodSync(f.configs[0].deviceHome, 0o755);
  expect(() => f.a.config()).toThrow(); expect(() => f.device.config()).toThrow();
  fs.chmodSync(f.configs[0].deviceHome, 0o700);
  fs.chmodSync(f.device.file.file, 0o644);
  expect(() => f.a.config()).toThrow();
  expect(fs.existsSync(path.join(f.configs[0].home, 'credentials', 'agent-connections.json'))).toBe(false);
});
