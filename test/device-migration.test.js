import { test, expect, afterEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { previewDeviceMigration, migrateDeviceSettings } from '../src/core/device-migration.js';
import { ConnectionManager } from '../src/agent/connections.js';
import { ConnectionFile } from '../src/agent/connections-file.js';
import { acquireConfigurationLock } from '../src/core/device-config.js';
import { DEFAULT_INPUT_ROUTES } from '../src/core/input-routes.js';
import { temp } from './helpers.js';

const fixtures = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    await Promise.all(f.managers.map(manager => manager.stop()));
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});
function fixture() {
  const root = temp(), project = path.join(root, 'project-one'), home = path.join(project, '.lush');
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const config = { project, home, deviceHome: path.join(root, 'device', 'shared'), provider: 'pi', env: { HOME: root } };
  // Create old files through an explicitly isolated legacy reader, never a production project override.
  const options = {}, manager = new ConnectionManager({ ...config, deviceHome: null }, options);
  const runtime = new ConnectionManager(config, options);
  const legacyScope = manager.forScope.bind(manager);
  manager.forScope = scope => scope === 'device' ? runtime : legacyScope(scope);
  const f = { root, config, manager, runtime, managers: [manager, runtime] }; fixtures.push(f); return f;
}
function write(home, relative, value) {
  const file = path.join(home, relative); fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  return file;
}
const read = (home, relative) => JSON.parse(fs.readFileSync(path.join(home, relative), 'utf8'));
const sourceConnection = (provider = 'deepseek') => ({ label: 'Same account label', provider,
  auth_type: provider === 'openai-codex' ? 'oauth' : 'api_key', enabled: true, models: [] });
const profile = extra => ({ agent: 'pi', model: '', thinking: '', default_prompt: '', append_prompt: '', extensions: [], skills: [], ...extra });
function populate(f, { oauth = false } = {}) {
  const row = f.manager.save(sourceConnection(oauth ? 'openai-codex' : 'deepseek'), oauth ? null : { api_key: 'private-api-key' });
  if (oauth) f.manager.file.transaction(data => {
    data.connections[0].credential = { type: 'oauth', access: 'private-access', refresh: 'private-refresh',
      expires: Date.now() + 3600000, accountId: 'private-account' };
  });
  write(f.config.home, 'settings.json', { version: 1, concurrency: 3, call_timeout: 120,
    input_routes: DEFAULT_INPUT_ROUTES, progress_reporting: false });
  write(f.config.home, 'agent.json', { version: 1, default: profile({ model: `${oauth ? 'openai-codex' : 'deepseek'}/test-model`, connection_id: row.id,
    extensions: ['./extension.mjs'], skills: ['~/skills/demo'], env: { PRIVATE_TOKEN: 'private-profile-env' } }), roles: {} });
  write(f.config.home, 'network.json', { version: 1, mode: 'proxy', proxy_url: 'https://proxy.example', no_proxy: ['example.test'],
    proxy_auth: { username: 'private-proxy-user', password: 'private-proxy-password' } });
  write(f.config.home, 'quick-explanation.json', { version: 1, connection_id: row.id, model: 'test-model', prompt: 'Explain briefly.' });
  write(f.config.home, path.join('agent', 'agent.env'), 'PRIVATE_TOKEN="private-env-token"\nPUBLIC_VALUE="ok"\n');
  write(f.config.home, path.join('agent', 'worker.env'), 'ROLE_VALUE="worker"\n');
  write(f.config.home, path.join('pi', 'settings.json'), { packages: ['npm:test-pkg@1.0.0'] });
  return row;
}
function apply(f, preview = previewDeviceMigration(f.config)) {
  expect(preview.can_migrate).toBe(true);
  return migrateDeviceSettings(f.config, { revision: preview.revision, confirm: true });
}
function noSecrets(value) {
  const text = JSON.stringify(value);
  for (const secret of ['private-api-key', 'private-access', 'private-refresh', 'private-account',
    'private-profile-env', 'private-proxy-user', 'private-proxy-password', 'private-env-token']) expect(text).not.toContain(secret);
}
function failOnce(method, match, { after = false } = {}) {
  const original = fs[method]; let fired = false;
  fs[method] = function (...args) {
    if (!fired && match(...args)) {
      fired = true; if (after) original.apply(this, args);
      throw new Error('private-api-key private-refresh injected filesystem failure');
    }
    return original.apply(this, args);
  };
  return { restore: () => { fs[method] = original; }, fired: () => fired };
}

test('preview is read-only and contains scope/impact but no settings, credential or environment values', () => {
  const f = fixture(); populate(f);
  const original = fs.readFileSync(f.manager.file.file);
  const view = previewDeviceMigration(f.config);
  expect(view).toMatchObject({ version: 1, can_migrate: true, blockers: [], already_migrated: false });
  expect(view.revision).toMatch(/^[a-f0-9]{64}$/); expect(view.items).toHaveLength(7);
  expect(view.items.map(item => item.kind)).toContain('模型来源与凭证');
  expect(view.warnings.some(value => value.includes('安装库保留'))).toBe(true);
  expect(fs.existsSync(f.config.deviceHome)).toBe(false);
  expect(fs.existsSync(path.join(f.config.home, 'device-migration'))).toBe(false);
  expect(fs.readFileSync(f.manager.file.file)).toEqual(original); noSecrets(view);
});

test('successful migration preserves IDs/references and private backups, removes active overrides and preserves project facts', async () => {
  const f = fixture(), row = populate(f);
  const excluded = ['project.db', path.join('sessions', 'history.json'), path.join('agent', 'common.md')];
  for (const relative of excluded) write(f.config.home, relative, 'keep project facts');
  write(f.config.project, path.join('.lush-agent', 'common.md'), 'keep project convention');
  const result = apply(f); expect(result).toMatchObject({ version: 1, migrated: true, already_migrated: false }); noSecrets(result);
  expect(read(f.config.deviceHome, 'settings.json')).toMatchObject({ concurrency: 3, call_timeout: 120, progress_reporting: false, input_routes: DEFAULT_INPUT_ROUTES });
  const agent = read(f.config.deviceHome, 'agent.json');
  expect(agent.default.connection_id).toBe(row.id);
  expect(agent.default.extensions).toEqual([path.join(f.config.project, 'extension.mjs')]);
  expect(agent.default.skills).toEqual([path.join(f.root, 'skills', 'demo')]);
  expect(read(f.config.deviceHome, 'quick-explanation.json').connection_id).toBe(row.id);
  expect(read(f.config.deviceHome, path.join('credentials', 'agent-connections.json')).connections[0].id).toBe(row.id);
  expect((await f.runtime.prepareRuntime(row.id)).credential.key).toBe('private-api-key');
  for (const relative of ['settings.json', 'agent.json', 'network.json', 'quick-explanation.json', path.join('agent', 'agent.env'),
    path.join('agent', 'worker.env'), path.join('credentials', 'agent-connections.json')]) {
    expect(fs.existsSync(path.join(f.config.home, relative))).toBe(false);
    expect(fs.existsSync(path.join(result.backup, relative))).toBe(true);
    expect(fs.statSync(path.join(result.backup, relative)).mode & 0o777).toBe(0o600);
  }
  expect(fs.statSync(f.config.deviceHome).mode & 0o777).toBe(0o700);
  expect(fs.statSync(result.backup).mode & 0o777).toBe(0o700);
  expect(fs.existsSync(path.join(f.config.home, 'pi', 'settings.json'))).toBe(true);
  for (const relative of excluded) expect(fs.readFileSync(path.join(f.config.home, relative), 'utf8')).toBe('keep project facts');
  expect(fs.readFileSync(path.join(f.config.project, '.lush-agent', 'common.md'), 'utf8')).toBe('keep project convention');
  const pointer = read(f.config.home, path.join('device-migration', 'current.json'));
  const journal = read(f.config.home, path.join('device-migration', pointer.id, 'journal.json'));
  expect(journal.status).toBe('complete');
  expect(journal.entries.every(entry => entry.phase === (entry.key.startsWith('prompt-') ? 'retained' : 'retired'))).toBe(true); noSecrets(journal);
  expect(fs.readFileSync(path.join(f.config.deviceHome, 'agent', 'common.md'), 'utf8')).toBe('keep project facts');
  expect(fs.readFileSync(path.join(result.backup, 'agent', 'common.md'), 'utf8')).toBe('keep project facts');
  expect(fs.existsSync(path.join(f.config.home, 'credentials', 'device-migration-active.json'))).toBe(false);
});

test('a repeat uses the completed delivery fact and cannot resurrect a subsequently deleted shared source', () => {
  const f = fixture(), row = populate(f), first = apply(f);
  f.manager.forScope('device').remove(row.id);
  const preview = previewDeviceMigration(f.config);
  expect(preview.already_migrated).toBe(true); expect(preview.items).toEqual([]);
  const second = apply(f, preview);
  expect(second).toMatchObject({ migrated: false, already_migrated: true, backup: first.backup });
  expect(f.manager.config().connections).toEqual([]);
});

test('only the selected project is migrated; other legacy project config and credentials remain untouched', () => {
  const f = fixture(); populate(f);
  const otherProject = path.join(f.root, 'project-two'), otherHome = path.join(otherProject, '.lush');
  write(otherHome, 'settings.json', { version: 1, concurrency: 9 });
  const other = new ConnectionManager({ ...f.config, project: otherProject, home: otherHome, deviceHome: null }); f.managers.push(other);
  const otherRow = other.save(sourceConnection(), { api_key: 'other-private-key' });
  const before = fs.readFileSync(other.file.file); apply(f);
  expect(fs.readFileSync(other.file.file)).toEqual(before);
  expect(read(otherHome, 'settings.json').concurrency).toBe(9);
  expect(other.storageScope(otherRow.id)).toBe('project');
});

test('conflicting shared ordinary settings reject the whole migration without creating backups or overwriting values', () => {
  const f = fixture(); populate(f);
  write(f.config.deviceHome, 'settings.json', { version: 1, concurrency: 9 });
  const preview = previewDeviceMigration(f.config); noSecrets(preview);
  expect(preview.can_migrate).toBe(false); expect(preview.blockers.some(value => value.includes('系统运行参数'))).toBe(true);
  expect(() => migrateDeviceSettings(f.config, { revision: preview.revision, confirm: true })).toThrow('未开始迁移');
  expect(read(f.config.deviceHome, 'settings.json').concurrency).toBe(9);
  expect(fs.existsSync(f.manager.file.file)).toBe(true);
  expect(fs.existsSync(path.join(f.config.home, 'device-migration'))).toBe(false);
});

test('equivalent settings tolerate JSON key order/default normalization without overwriting an existing shared value', () => {
  const f = fixture(); write(f.config.home, 'settings.json', { concurrency: 3, version: 1, call_timeout: null });
  const destination = write(f.config.deviceHome, 'settings.json', '{"concurrency":3,"version":1}\n');
  const original = fs.readFileSync(destination, 'utf8'), result = apply(f);
  expect(fs.readFileSync(destination, 'utf8')).toBe(original);
  expect(fs.existsSync(path.join(f.config.home, 'settings.json'))).toBe(false);
  expect(result.items[0].action).toContain('复用');
});

test('distinct source IDs append without name-based merging; an equivalent same UUID keeps the existing revision', () => {
  const f = fixture(), source = f.manager.save(sourceConnection(), { api_key: 'private-api-key' });
  const device = f.manager.forScope('device'), other = device.save(sourceConnection(), { api_key: 'other-private-key' });
  apply(f);
  expect(device.config().connections.map(row => row.id)).toEqual([other.id, source.id]);
  expect(device.config().connections.map(row => row.label)).toEqual(['Same account label', 'Same account label']);
  const f2 = fixture(); f2.manager.save(sourceConnection(), { api_key: 'private-api-key' });
  const original = f2.manager.file.read(); const existingRevision = '11111111-1111-4111-8111-111111111111';
  const target = new ConnectionFile(f2.config.deviceHome);
  target.transaction(data => { Object.assign(data, original); data.connections[0].revision = existingRevision; });
  apply(f2); expect(target.read().connections).toHaveLength(1); expect(target.read().connections[0].revision).toBe(existingRevision);
});

test('same UUID with different credentials/endpoint/config rejects rather than replacing account identity', () => {
  for (const change of ['key', 'endpoint', 'label']) {
    const f = fixture(); f.manager.save(sourceConnection(), { api_key: 'private-api-key' });
    const original = f.manager.file.read();
    const target = new ConnectionFile(f.config.deviceHome);
    target.transaction(data => {
      Object.assign(data, original);
      if (change === 'key') data.connections[0].credential.key = 'other-private-key';
      if (change === 'endpoint') data.connections[0].endpoint = 'https://another.example';
      if (change === 'label') data.connections[0].label = 'Different label';
    });
    const before = fs.readFileSync(target.file);
    const preview = previewDeviceMigration(f.config); expect(preview.can_migrate).toBe(false); noSecrets(preview);
    expect(() => migrateDeviceSettings(f.config, { revision: preview.revision, confirm: true })).toThrow();
    expect(fs.readFileSync(target.file)).toEqual(before); expect(fs.existsSync(f.manager.file.file)).toBe(true);
  }
});

test('a known reused OAuth refresh credential under another ID cannot become two active shared refresh sources', () => {
  const f = fixture(); populate(f, { oauth: true });
  const source = f.manager.file.read().connections[0], device = f.manager.forScope('device');
  const row = device.save(sourceConnection('openai-codex'));
  device.file.transaction(data => { data.connections.find(value => value.id === row.id).credential = source.credential; });
  const preview = previewDeviceMigration(f.config); expect(preview.can_migrate).toBe(false); noSecrets(preview);
  expect(fs.existsSync(f.manager.file.file)).toBe(true);
});

function addOAuth(manager, credential) {
  const row = manager.save(sourceConnection('openai-codex'));
  manager.file.transaction(data => { data.connections.find(value => value.id === row.id).credential = { ...credential }; });
  return row;
}
function expectOAuthConflict(f) {
  const source = fs.readFileSync(f.manager.file.file), targetFile = path.join(f.config.deviceHome, 'credentials', 'agent-connections.json');
  const target = fs.existsSync(targetFile) ? fs.readFileSync(targetFile) : null;
  const preview = previewDeviceMigration(f.config); expect(preview.can_migrate).toBe(false); noSecrets(preview);
  expect(preview.blockers.some(value => value.includes('模型来源与凭证'))).toBe(true);
  expect(() => migrateDeviceSettings(f.config, { revision: preview.revision, confirm: true })).toThrow('未开始迁移');
  expect(fs.readFileSync(f.manager.file.file)).toEqual(source);
  if (target === null) expect(fs.existsSync(f.config.deviceHome)).toBe(false);
  else expect(fs.readFileSync(targetFile)).toEqual(target);
  expect(fs.existsSync(path.join(f.config.home, 'settings.json'))).toBe(true);
  expect(fs.existsSync(path.join(f.config.home, 'device-migration'))).toBe(false);
  expect(fs.existsSync(path.join(f.config.home, 'credentials', 'device-migration-active.json'))).toBe(false);
}

test('source-internal duplicate OAuth credentials block migration into an absent shared root', () => {
  const f = fixture(); populate(f, { oauth: true });
  addOAuth(f.manager, f.manager.file.read().connections[0].credential);
  expectOAuthConflict(f);
});

test('duplicate OAuth credentials among this round of appended source UUIDs block a nonempty shared root', () => {
  const f = fixture(); populate(f, { oauth: true });
  f.manager.forScope('device').save(sourceConnection(), { api_key: 'other-private-key' });
  addOAuth(f.manager, f.manager.file.read().connections[0].credential);
  expectOAuthConflict(f);
});

test('existing target-internal duplicate OAuth credentials block any connection import', () => {
  const f = fixture(); populate(f);
  const device = f.manager.forScope('device');
  const credential = { type: 'oauth', access: 'private-access', refresh: 'private-refresh',
    expires: Date.now() + 3600000, accountId: 'private-account' };
  addOAuth(device, credential); addOAuth(device, credential);
  expectOAuthConflict(f);
});

test('same OAuth account with distinct refresh credentials remains separate by UUID, even with identical labels/providers', () => {
  for (const existingTarget of [false, true]) {
    const f = fixture(), first = populate(f, { oauth: true });
    const credential = f.manager.file.read().connections[0].credential;
    const second = addOAuth(f.manager, { ...credential, refresh: 'private-second-refresh' });
    const device = f.manager.forScope('device');
    const third = existingTarget ? addOAuth(device, { ...credential, refresh: 'private-third-refresh' }) : null;
    const expected = [...(third ? [third.id] : []), first.id, second.id];
    const result = apply(f); expect(result.migrated).toBe(true);
    expect(device.config().connections.map(row => row.id)).toEqual(expected);
    expect(device.config().connections.every(row => row.label === 'Same account label')).toBe(true);
    const shared = device.file.read().connections;
    expect(shared.every(row => row.credential.accountId === credential.accountId)).toBe(true);
    expect(new Set(shared.map(row => row.credential.refresh)).size).toBe(expected.length);
    expect(fs.existsSync(f.manager.file.file)).toBe(false);
    expect(read(f.config.deviceHome, 'quick-explanation.json').connection_id).toBe(first.id);
    expect(read(f.config.deviceHome, 'agent.json').default.connection_id).toBe(first.id);
    noSecrets(result);
  }
});

test('equivalent source and target OAuth credentials with the same UUID are reused once, not flagged as distinct refresh owners', () => {
  const f = fixture(), row = populate(f, { oauth: true });
  const source = f.manager.file.read(), device = f.manager.forScope('device');
  device.file.transaction(data => {
    Object.assign(data, source); data.connections[0].revision = '11111111-1111-4111-8111-111111111111';
  });
  expect(apply(f).migrated).toBe(true);
  expect(device.file.read().connections.map(value => value.id)).toEqual([row.id]);
  expect(device.file.read().connections[0].revision).toBe('11111111-1111-4111-8111-111111111111');
  expect(fs.existsSync(f.manager.file.file)).toBe(false);
});

test('confirm and opaque revision are required, unknown parameters/paths are rejected and stale file changes are not accepted', () => {
  const f = fixture(); populate(f); const preview = previewDeviceMigration(f.config);
  expect(() => migrateDeviceSettings(f.config, { revision: preview.revision, confirm: false })).toThrow();
  expect(() => migrateDeviceSettings(f.config, { revision: 'private-api-key', confirm: true })).toThrow();
  expect(() => migrateDeviceSettings(f.config, { revision: preview.revision, confirm: true, project: '/tmp/other' })).toThrow();
  write(f.config.home, 'settings.json', { version: 1, concurrency: 4 });
  expect(() => migrateDeviceSettings(f.config, { revision: preview.revision, confirm: true })).toThrow('过期');
  expect(fs.existsSync(f.config.deviceHome)).toBe(false);
  const next = previewDeviceMigration(f.config); expect(next.revision).not.toBe(preview.revision);
  write(f.config.deviceHome, 'quick-explanation.json', { version: 1, model: 'different', prompt: 'Other' });
  expect(() => migrateDeviceSettings(f.config, { revision: next.revision, confirm: true })).toThrow('过期');
});

test('new source files and credential changes between preview and apply invalidate confirmation without leaking secret digests', () => {
  const f = fixture(); f.manager.save(sourceConnection(), { api_key: 'private-api-key' });
  const first = previewDeviceMigration(f.config);
  const raw = fs.readFileSync(f.manager.file.file, 'utf8');
  expect(first.revision).not.toBe(createHash('sha256').update(raw).digest('hex'));
  f.manager.file.transaction(data => { data.connections[0].credential.key = 'replacement-private-key'; });
  expect(() => migrateDeviceSettings(f.config, { revision: first.revision, confirm: true })).toThrow('过期');
  const second = previewDeviceMigration(f.config); write(f.config.home, 'agent.json', { default: profile(), roles: {} });
  expect(() => migrateDeviceSettings(f.config, { revision: second.revision, confirm: true })).toThrow('过期');
});

test('restarting the process invalidates old revision tokens and requires a fresh preview', async () => {
  const f = fixture(); populate(f); const preview = previewDeviceMigration(f.config);
  const module = path.resolve('src/core/device-migration.js');
  const child = Bun.spawn([process.execPath, '--eval', `
    import {migrateDeviceSettings} from ${JSON.stringify(module)};
    try { migrateDeviceSettings(${JSON.stringify(f.config)}, {revision:${JSON.stringify(preview.revision)},confirm:true}); process.exitCode=1; }
    catch(error) { console.log(error.message); }
  `], { stdout: 'pipe', stderr: 'pipe' });
  const [code, output, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code).toBe(0); expect(output).toContain('过期'); expect(stderr).toBe('');
  expect(fs.existsSync(f.config.deviceHome)).toBe(false); noSecrets(output);
});

test('unsafe root, symlink, hardlink, wrong modes, oversize and corrupt documents fail closed without copying or repairing', () => {
  for (const problem of ['file-mode', 'root-mode', 'symlink', 'hardlink', 'oversize', 'json', 'unknown-field']) {
    const f = fixture(), file = write(f.config.home, 'settings.json', { version: 1, concurrency: 3 });
    if (problem === 'file-mode') fs.chmodSync(file, 0o644);
    if (problem === 'root-mode') fs.chmodSync(f.config.home, 0o755);
    if (problem === 'symlink') { fs.renameSync(file, path.join(f.root, 'real')); fs.symlinkSync(path.join(f.root, 'real'), file); }
    if (problem === 'hardlink') fs.linkSync(file, path.join(f.root, 'alias'));
    if (problem === 'oversize') fs.writeFileSync(file, 'x'.repeat(8193));
    if (problem === 'json') fs.writeFileSync(file, 'private-api-key broken JSON');
    if (problem === 'unknown-field') fs.writeFileSync(file, JSON.stringify({ version: 1, concurrency: 3, PRIVATE: 'private-api-key' }));
    const preview = previewDeviceMigration(f.config); expect(preview.can_migrate).toBe(false); noSecrets(preview);
    expect(fs.existsSync(f.config.deviceHome)).toBe(false);
    expect(() => migrateDeviceSettings(f.config, { revision: preview.revision, confirm: true })).toThrow();
  }
});

test('invalid env/reserved LUSH variables and unsafe source or target credentials are never migrated', () => {
  const f = fixture(); populate(f);
  write(f.config.home, path.join('agent', 'agent.env'), 'LUSH_HOME="/tmp/hijack"\nPRIVATE_TOKEN="private-env-token"\n');
  const envPreview = previewDeviceMigration(f.config); expect(envPreview.can_migrate).toBe(false); noSecrets(envPreview);
  const f2 = fixture(); populate(f2); fs.chmodSync(f2.manager.file.file, 0o644);
  expect(previewDeviceMigration(f2.config).can_migrate).toBe(false);
  const f3 = fixture(); populate(f3);
  const target = write(f3.config.deviceHome, path.join('credentials', 'agent-connections.json'), 'private-api-key bad JSON');
  expect(previewDeviceMigration(f3.config).can_migrate).toBe(false); expect(fs.readFileSync(target, 'utf8')).toBe('private-api-key bad JSON');
});

test('migration refuses a device directory inside the source project and does not follow root aliases', () => {
  const f = fixture(); populate(f); f.config.deviceHome = path.join(f.config.project, '.shared');
  expect(previewDeviceMigration(f.config).can_migrate).toBe(false);
  f.config.deviceHome = path.join(f.root, 'alias'); fs.symlinkSync(f.config.home, f.config.deviceHome);
  expect(previewDeviceMigration(f.config).can_migrate).toBe(false);
});

test('busy settings/credential/OAuth locks reject immediately and never steal the existing lock', () => {
  const f = fixture(); populate(f, { oauth: true });
  const lock = acquireConfigurationLock(f.config, 'device');
  try {
    const preview = previewDeviceMigration(f.config); expect(preview.can_migrate).toBe(false);
    expect(() => migrateDeviceSettings(f.config, { revision: preview.revision, confirm: true })).toThrow();
    lock.assert();
  } finally { lock.release(); }
  const row = f.manager.file.read().connections[0], refresh = f.manager.file.lock(`refresh-${row.id}.lock`);
  try {
    const preview = previewDeviceMigration(f.config); expect(preview.can_migrate).toBe(false);
    expect(preview.blockers.some(value => value.includes('OAuth'))).toBe(true); refresh.assert();
  } finally { refresh.release(); }
  const preview = previewDeviceMigration(f.config), late = f.manager.file.lock('agent-connections.lock');
  try {
    expect(() => migrateDeviceSettings(f.config, { revision: preview.revision, confirm: true })).toThrow('未开始迁移');
    late.assert(); expect(fs.existsSync(path.join(f.config.home, '.settings-write.lock'))).toBe(false);
  } finally { late.release(); }
});

for (const failure of ['backup', 'publish-before', 'publish-after', 'retire-before', 'retire-after', 'complete-after']) {
  test(`injected ${failure} failure preserves originals/backup and can be resumed only by a fresh explicit preview`, () => {
    const f = fixture(); populate(f, { oauth: true }); const preview = previewDeviceMigration(f.config);
    let injection;
    if (failure === 'backup') injection = failOnce('renameSync', (_source, destination) => String(destination).includes(`${path.sep}files${path.sep}settings.json`));
    if (failure.startsWith('publish')) injection = failOnce('renameSync', (_source, destination) => destination === path.join(f.config.deviceHome, 'settings.json'), { after: failure === 'publish-after' });
    if (failure.startsWith('retire')) injection = failOnce('unlinkSync', source => source === path.join(f.config.home, 'credentials', 'agent-connections.json'), { after: failure === 'retire-after' });
    if (failure === 'complete-after') injection = failOnce('renameSync', (source, destination) => String(destination).endsWith('journal.json') && readTempStatus(source) === 'complete', { after: true });
    try {
      let message;
      try { migrateDeviceSettings(f.config, { revision: preview.revision, confirm: true }); }
      catch (error) { message = error.message; }
      expect(injection.fired()).toBe(true); expect(message).toContain('迁移'); noSecrets(message);
    } finally { injection.restore(); }
    expect(fs.existsSync(path.join(f.config.home, '.settings-write.lock'))).toBe(false);
    expect(fs.existsSync(path.join(f.config.deviceHome, '.settings-write.lock'))).toBe(false);
    if (failure === 'backup') {
      expect(fs.existsSync(f.manager.file.file)).toBe(true);
      expect(fs.existsSync(path.join(f.config.home, 'credentials', 'device-migration-active.json'))).toBe(false);
    } else {
      expect(fs.existsSync(path.join(f.config.home, 'credentials', 'device-migration-active.json'))).toBe(true);
      expect(fs.existsSync(path.join(f.config.home, 'device-migration', 'current.json'))).toBe(true);
    }
    const recovery = previewDeviceMigration(f.config); expect(recovery.can_migrate).toBe(true); noSecrets(recovery);
    expect(() => migrateDeviceSettings(f.config, { revision: preview.revision, confirm: true })).toThrow('过期');
    const done = apply(f, recovery); expect(done.migrated).toBe(true);
    expect(fs.existsSync(f.manager.file.file)).toBe(false);
    expect(fs.existsSync(path.join(f.config.home, 'credentials', 'device-migration-active.json'))).toBe(false);
    const shared = new ConnectionFile(f.config.deviceHome).read();
    expect(shared.connections).toHaveLength(1); expect(shared.connections[0].credential.refresh).toBe('private-refresh');
  });
}
function readTempStatus(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')).status; } catch { return null; }
}

test('a published-but-unretired OAuth handoff blocks source refresh until explicit recovery switches it to shared storage', async () => {
  const f = fixture(), row = populate(f, { oauth: true }); let refreshes = 0;
  f.manager.file.transaction(data => { data.connections[0].credential.expires = Date.now() - 1000; });
  const access = `e30.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'private-account' } })).toString('base64url')}.signature`;
  f.manager.options.fetch = async (_url, request) => {
    expect(request.body.get('grant_type')).toBe('refresh_token'); refreshes++;
    return Response.json({ access_token: access, refresh_token: 'rotated-shared-refresh', expires_in: 3600 });
  };
  const injection = failOnce('renameSync', (_source, destination) => destination === path.join(f.config.deviceHome, 'credentials', 'agent-connections.json'), { after: true });
  try { expect(() => apply(f)).toThrow('未完成'); expect(injection.fired()).toBe(true); }
  finally { injection.restore(); }
  expect(fs.existsSync(f.manager.file.file)).toBe(true);
  expect(() => f.manager.config()).toThrow('Connection operation unavailable');
  expect(() => f.manager.save(sourceConnection(), { api_key: 'must-not-write' })).toThrow();
  const blocked = await f.manager.prepareRuntime(row.id).then(() => null, error => error);
  expect(blocked?.connectionCode).toBe('auth_locked'); expect(refreshes).toBe(0);
  const trusted = new ConnectionFile(f.config.home, { privateRoot: true, migrationRead: true });
  expect(trusted.read().connections[0].credential.refresh).toBe('private-refresh');
  expect(f.manager.forScope('device').config().connections[0].id).toBe(row.id);
  const preview = previewDeviceMigration(f.config); expect(preview.can_migrate).toBe(true);
  expect(apply(f, preview).migrated).toBe(true);
  expect(fs.existsSync(f.manager.file.file)).toBe(false);
  expect(fs.existsSync(path.join(f.config.home, 'credentials', 'device-migration-active.json'))).toBe(false);
  expect(f.runtime.storageScope(row.id)).toBe('device');
  expect((await f.runtime.prepareRuntime(row.id)).credential.access).toBe(access);
  expect(refreshes).toBe(1);
  expect(new ConnectionFile(f.config.deviceHome).read().connections[0].credential.refresh).toBe('rotated-shared-refresh');
  expect(f.manager.file.read().connections).toEqual([]);
});

test('Markdown retention during a mixed OAuth handoff never releases the source guard or changes credential retirement', async () => {
  const f = fixture(), row = populate(f, { oauth: true });
  const markdown = write(f.config.home, 'agent/common.md', 'private-api-key personal Markdown');
  const injection = failOnce('unlinkSync', source => source === f.manager.file.file);
  try { expect(() => apply(f)).toThrow('未完成'); expect(injection.fired()).toBe(true); }
  finally { injection.restore(); }
  expect(fs.readFileSync(markdown, 'utf8')).toBe('private-api-key personal Markdown');
  expect(fs.readFileSync(path.join(f.config.deviceHome, 'agent/common.md'), 'utf8')).toBe('private-api-key personal Markdown');
  expect(() => f.manager.config()).toThrow('Connection operation unavailable');
  expect((await f.manager.prepareRuntime(row.id).catch(error => error)).connectionCode).toBe('auth_locked');
  const preview = previewDeviceMigration(f.config); expect(preview.can_migrate).toBe(true); noSecrets(preview);
  const result = apply(f, preview); noSecrets(result);
  expect(fs.existsSync(f.manager.file.file)).toBe(false);
  expect(fs.existsSync(path.join(f.config.home, 'credentials/device-migration-active.json'))).toBe(false);
  expect(fs.readFileSync(markdown, 'utf8')).toBe('private-api-key personal Markdown');
  expect((await f.runtime.prepareRuntime(row.id)).credential.access).toBe('private-access');
});

test('an interrupted migration does not accept modified originals, missing backups, newly added source files or changed shared targets', () => {
  for (const conflict of ['source', 'backup', 'new-file', 'target']) {
    const f = fixture(); populate(f); const injection = failOnce('renameSync', (_source, destination) => destination === path.join(f.config.deviceHome, 'settings.json'));
    try { expect(() => apply(f)).toThrow(); } finally { injection.restore(); }
    const pointer = read(f.config.home, path.join('device-migration', 'current.json'));
    if (conflict === 'source') write(f.config.home, 'settings.json', { version: 1, concurrency: 4 });
    if (conflict === 'backup') fs.unlinkSync(path.join(f.config.home, 'device-migration', pointer.id, 'files', 'settings.json'));
    if (conflict === 'new-file') write(f.config.home, path.join('agent', 'research.env'), 'VALUE="new"\n');
    if (conflict === 'target') write(f.config.deviceHome, 'settings.json', { version: 1, concurrency: 7 });
    const view = previewDeviceMigration(f.config); expect(view.can_migrate).toBe(false); noSecrets(view);
    expect(fs.existsSync(path.join(f.config.home, 'credentials', 'device-migration-active.json'))).toBe(true);
    expect(fs.existsSync(f.manager.file.file)).toBe(true);
  }
});

test('unsafe or forged journals/markers fail closed and cannot select arbitrary backup paths', () => {
  const f = fixture(); populate(f);
  write(f.config.home, path.join('device-migration', 'current.json'), { version: 1, id: '../../private-api-key' });
  expect(previewDeviceMigration(f.config).can_migrate).toBe(false);
  const f2 = fixture(); populate(f2);
  write(f2.config.home, path.join('credentials', 'device-migration-active.json'), { version: 1, id: '11111111-1111-4111-8111-111111111111' });
  expect(previewDeviceMigration(f2.config).can_migrate).toBe(false);
  const f3 = fixture(); populate(f3); write(f3.config.home, path.join('device-migration', 'current.json'), '');
  expect(previewDeviceMigration(f3.config).can_migrate).toBe(false);
});

test('the guard is not removed until the terminal journal and all source retirements are reverified', () => {
  for (const problem of ['journal', 'source']) {
    const f = fixture(); populate(f, { oauth: true });
    const sourceBody = fs.readFileSync(f.manager.file.file, 'utf8'), original = fs.renameSync; let changed = false;
    fs.renameSync = function (source, destination) {
      const terminal = !changed && String(destination).endsWith('journal.json') && readTempStatus(source) === 'complete';
      const result = original.call(this, source, destination);
      if (terminal) {
        changed = true;
        if (problem === 'journal') {
          const value = JSON.parse(fs.readFileSync(destination, 'utf8')); value.status = 'retiring';
          fs.writeFileSync(destination, JSON.stringify(value), { mode: 0o600 });
        } else fs.writeFileSync(f.manager.file.file, sourceBody, { mode: 0o600 });
      }
      return result;
    };
    try { expect(() => apply(f)).toThrow('未完成'); expect(changed).toBe(true); }
    finally { fs.renameSync = original; }
    expect(fs.existsSync(path.join(f.config.home, 'credentials', 'device-migration-active.json'))).toBe(true);
    const preview = previewDeviceMigration(f.config); expect(preview.can_migrate).toBe(true);
    expect(apply(f, preview).migrated).toBe(true);
    expect(fs.existsSync(path.join(f.config.home, 'credentials', 'device-migration-active.json'))).toBe(false);
  }
});

test('a destination created during publication is not overwritten and the source stays recoverable', () => {
  const f = fixture(); populate(f); const original = fs.writeFileSync; let changed = false;
  fs.writeFileSync = function (file, body, ...rest) {
    const result = original.call(this, file, body, ...rest);
    if (!changed && typeof file === 'number' && typeof body === 'string' && body.includes('"concurrency": 3')
      && fs.existsSync(path.join(f.config.home, 'credentials', 'device-migration-active.json'))) {
      changed = true;
      original.call(this, path.join(f.config.deviceHome, 'settings.json'), '{"version":1,"concurrency":7}\n', { mode: 0o600 });
    }
    return result;
  };
  try { expect(() => apply(f)).toThrow('未完成'); expect(changed).toBe(true); }
  finally { fs.writeFileSync = original; }
  expect(read(f.config.deviceHome, 'settings.json').concurrency).toBe(7);
  expect(fs.existsSync(f.manager.file.file)).toBe(true);
  expect(previewDeviceMigration(f.config).can_migrate).toBe(false);
});

test('a completed project can explicitly migrate a new compatible override without losing the previous backup', () => {
  const f = fixture(); write(f.config.home, 'settings.json', { version: 1, concurrency: 3 });
  const first = apply(f);
  write(f.config.home, 'settings.json', { version: 1, concurrency: 3 });
  const preview = previewDeviceMigration(f.config); expect(preview.already_migrated).toBe(false);
  const second = apply(f, preview);
  expect(second.backup).not.toBe(first.backup);
  expect(fs.existsSync(path.join(first.backup, 'settings.json'))).toBe(true);
  expect(fs.existsSync(path.join(second.backup, 'settings.json'))).toBe(true);
});

test('no-source preview/apply never creates a device root or pretends that a migration occurred', () => {
  const f = fixture(), preview = previewDeviceMigration(f.config);
  expect(preview.can_migrate).toBe(true); expect(preview.items).toEqual([]);
  expect(apply(f, preview)).toMatchObject({ migrated: false, already_migrated: false, backup: null });
  expect(fs.existsSync(f.config.deviceHome)).toBe(false);
});
