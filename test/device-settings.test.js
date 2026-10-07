import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { Config } from '../src/config.js';
import { AgentSettings } from '../src/agent/settings.js';
import { agentPrompt } from '../src/agent/prompts.js';
import { QuickExplanationSettings, DEFAULT_EXPLANATION_PROMPT } from '../src/core/quick-explanation.js';
import { readNetworkConfiguration, saveNetworkConfiguration, clearNetworkOverride, networkSnapshot } from '../src/agent/network.js';
import { readAgentEnvironment, saveAgentEnvironment, clearAgentEnvironmentOverride, agentEnvironment } from '../src/agent/environment.js';
import { ensurePiConfiguration } from '../src/agent/pi-config.js';
import { discoverAgentResources } from '../src/agent/resources.js';
import { discoverAgentModels } from '../src/agent/models.js';
import { AgentPackages } from '../src/agent/packages.js';
import { acquireConfigurationLock, scopedConfiguration } from '../src/core/device-config.js';
import { temp, env, gate, fixture as projectFixture } from './helpers.js';

function fixture() {
  const root = temp(), global = path.join(root, 'user-config');
  const make = name => {
    const project = path.join(root, name); fs.mkdirSync(project, { mode: 0o700 });
    const config = new Config({ project, env: env({ LUSH_GLOBAL_CONFIG: global, LUSH_CONCURRENCY: '3' }) });
    config.prepare(); return config;
  };
  const a = make('project-a'), b = make('project-b');
  return { root, a, b, close: () => fs.rmSync(root, { recursive: true, force: true }) };
}
const profile = (model, extra = {}) => ({ version: 1, default: { agent: 'pi', model, ...extra }, roles: {} });
const network = (mode = 'proxy', extra = {}) => ({ version: 1, mode, proxy_url: mode === 'proxy' ? 'http://proxy.example:8123' : null, no_proxy: [], ...extra });
const json = (file, value) => fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });

test('Project adapters refresh shared runtime limits while scoped reads and clears preserve local overrides', async () => {
  const global = temp(), a = projectFixture(undefined, { LUSH_GLOBAL_CONFIG: global }),
    b = projectFixture(undefined, { LUSH_GLOBAL_CONFIG: global });
  try {
    a.project.configureRuntimeSettings({ concurrency: 6, progress_reporting: false }, 'device');
    expect(b.project.refreshRuntimeConfiguration()).toBe(true);
    expect(b.config.concurrency).toBe(6);
    expect(b.project.agentConfig().options.default_prompts.agent).not.toContain('lush progress');
    b.project.configureRuntimeSettings({ concurrency: 2 });
    expect(b.project.configureRuntimeSettings({ concurrency: 9 }, 'device').concurrency.source).toBe('device');
    expect(b.config.concurrency).toBe(2);
    expect(a.project.runtimeSettings().concurrency).toMatchObject({ value: 9, source: 'device' });
    expect(b.project.runtimeSettings('device').configuration_scope.selected).toBe('device');
    a.project.configureAgents(profile('shared'), 'device');
    b.project.configureAgents(profile('local'));
    expect(b.project.agentConfig('device').default.model).toBe('shared');
    expect(b.project.agentConfig().default.model).toBe('local');
    expect((await b.project.clearSettingsOverride('agent')).default.model).toBe('shared');
    await a.project.configureAgentNetwork(network('direct'), 'device');
    await b.project.configureAgentNetwork(network());
    expect(b.project.agentNetwork('device').mode).toBe('direct');
    expect((await b.project.clearSettingsOverride('network')).configuration_scope.source).toBe('device');
    a.project.configureAgentEnvironment('common', { SHARED: 'yes' }, 'device');
    b.project.configureAgentEnvironment('common', { SHARED: 'local' });
    expect(b.project.agentEnvironment('common', 'device').values.SHARED).toBe('yes');
    expect((await b.project.clearSettingsOverride('environment', 'common')).values.SHARED).toBe('yes');
    const runtimeFile = path.join(a.config.deviceHome, 'settings.json');
    fs.chmodSync(runtimeFile, 0o644);
    expect(b.project.refreshRuntimeConfiguration()).toBe(false);
    expect(b.project.runtimeSettingsUnavailable).toBe(true);
    expect(b.config.concurrency).toBe(2); // Fail closed without changing an existing call's limits.
    fs.chmodSync(runtimeFile, 0o600);
    expect(b.project.refreshRuntimeConfiguration()).toBe(true);
    expect(b.project.runtimeSettingsUnavailable).toBe(false);
    expect(a.config.env.LUSH_HOME).toBe(a.config.home);
    expect(b.config.env.LUSH_HOME).toBe(b.config.home);
  } finally { await Promise.all([a.close(), b.close()]); fs.rmSync(global, { recursive: true, force: true }); }
});

test('Project device package adapters retain mock options, block migration while busy and stop their managers', async () => {
  const f = projectFixture(), entered = gate(), finish = gate(), calls = [];
  await f.project.agentPackageManager.stop();
  f.project.agentPackageManager = new AgentPackages(f.config, { run: async options => {
    calls.push(options);
    if (options.args[0] === 'install') { entered.resolve(); await finish.promise; }
    return '';
  } });
  const manager = f.project.packageManagerForScope('device');
  try {
    const pending = manager.install('npm:fixture@1.0.0');
    await entered.promise;
    expect(f.project.agentPackageManager.isBusy()).toBe(true);
    expect(() => f.project.settingsMigrationApply({ revision: 'r', confirm: true })).toThrow('资源安装');
    finish.resolve();
    expect((await pending).configuration_scope.selected).toBe('device');
    expect((await f.project.installAgentPackage('npm:fixture@2.0.0', 'device')).configuration_scope.selected).toBe('device');
    expect(calls[0].cwd).toBe(f.config.deviceHome);
    expect(calls[0].env.PI_CODING_AGENT_DIR).toBe(path.join(f.config.deviceHome, 'pi'));
    expect(fs.existsSync(path.join(f.config.home, 'pi'))).toBe(false);
    expect(f.project.agentPackageManager.isBusy()).toBe(false);
    await f.project.agentPackageManager.stop();
    await expect(manager.install('npm:later@1.0.0')).rejects.toThrow('stopping');
  } finally { finish.resolve(); await f.close(); }
});

 test('device root is separate from immutable project binding and ordinary reads never create it', () => {
  const f = fixture();
  try {
    expect(f.a.deviceHome).toBe(f.b.deviceHome);
    expect(f.a.home).not.toBe(f.b.home);
    expect(f.a.env.LUSH_HOME).toBe(f.a.home);
    expect(f.b.env.LUSH_PROJECT).toBe(f.b.project);
    new AgentSettings(f.a).get(); new QuickExplanationSettings(f.b).read(); readNetworkConfiguration(f.a); readAgentEnvironment(f.a, 'common');
    expect(fs.existsSync(f.a.deviceHome)).toBe(false);
    expect(f.a.runtimeSettings.get().concurrency).toMatchObject({ value: 3, source: 'default', overridden: false });
    expect(() => f.a.runtimeSettings.get('other')).toThrow('scope');
  } finally { f.close(); }
});

 test('runtime settings inherit per key, keep local overrides and refresh later consumers without rewriting', () => {
  const f = fixture();
  try {
    const first = f.a.configureRuntime({ concurrency: 7, call_timeout: 60, progress_reporting: false }, 'device');
    expect(first.concurrency).toMatchObject({ value: 7, default: 3, source: 'device', overridden: true });
    expect(first.configuration_scope.selected).toBe('device');
    expect(f.b.concurrency).toBe(3); f.b.refreshRuntimeSettings(); expect(f.b.concurrency).toBe(7);
    expect(f.b.runtimeSettings.get().concurrency).toMatchObject({ value: 7, default: 7, source: 'device', overridden: false });
    f.b.configureRuntime({ concurrency: 2 });
    f.a.configureRuntime({ concurrency: 9 }, 'device'); f.b.refreshRuntimeSettings();
    expect(f.b.concurrency).toBe(2); expect(f.b.timeout).toBe(60); expect(f.b.progressReporting).toBe(false);
    expect(f.b.runtimeSettings.get().concurrency).toMatchObject({ value: 2, default: 9, source: 'project', overridden: true });
    f.b.configureRuntime({ concurrency: null }); expect(f.b.concurrency).toBe(9);
    expect(f.b.runtimeSettings.get('device').concurrency.value).toBe(9);
    expect(JSON.parse(fs.readFileSync(path.join(f.b.home, 'settings.json')))).toEqual({ version: 1 });
    expect(fs.statSync(path.join(f.a.deviceHome, 'settings.json')).mode & 0o777).toBe(0o600);
    expect(new Config({ project: f.b.project, env: f.b.env }).concurrency).toBe(9);
    f.b.configureRuntime({ concurrency: 4 });
    expect(f.b.configureRuntime({ concurrency: 10 }, 'device').concurrency.value).toBe(10);
    expect(f.b.concurrency).toBe(4); // A device edit never masquerades as the local effective value.
  } finally { f.close(); }
});

 test('Agent settings use whole-document overrides and shared profiles normalize resource paths', () => {
  const f = fixture();
  try {
    const a = new AgentSettings(f.a), b = new AgentSettings(f.b);
    a.save(profile('shared-one', { extensions: ['./ext.ts'], skills: ['./skills'], append_prompt: 'Shared style' }), 'device');
    expect(b.resolve('agent').model).toBe('shared-one');
    expect(b.resolve('agent').extensions).toEqual([path.join(f.a.project, 'ext.ts')]);
    expect(b.get().configuration_scope).toMatchObject({ selected: 'project', source: 'device', project_override: false });
    expect(b.get().file).toBe(path.join(f.a.deviceHome, 'agent.json'));
    expect(agentPrompt(f.b, 'agent', b.resolve('agent')).customization.settings).toBe(b.get().file);
    b.save({ ...profile('local'), roles: { agent: { agent: 'codex', model: 'local-role' } } });
    a.save(profile('shared-two'), 'device');
    expect(b.resolve('agent').model).toBe('local-role');
    expect(b.get('device').default.model).toBe('shared-two');
    expect(b.clearOverride().resolved.agent.model).toBe('shared-two');
    expect(fs.existsSync(b.file)).toBe(false);
    expect(b.get().configuration_scope.project_override).toBe(false);
    expect(() => a.save(profile('bad', { extensions: [] }), 'unknown')).toThrow('scope');
  } finally { f.close(); }
});

 test('network scope saves the intended layer, preserves private inherited auth and freezes in-flight snapshots', () => {
  const f = fixture();
  try {
    saveNetworkConfiguration(f.a, network('proxy', { proxy_auth: { username: 'DEVICE-PRIVATE', password: 'TOKEN-PRIVATE' } }), 'device');
    const before = networkSnapshot(f.b);
    expect(before.route('https://remote.example')).toContain('DEVICE-PRIVATE:TOKEN-PRIVATE@');
    const read = readNetworkConfiguration(f.b);
    expect(read.configuration_scope).toMatchObject({ source: 'device', project_override: false });
    expect(JSON.stringify(read)).not.toContain('PRIVATE');
    saveNetworkConfiguration(f.b, network()); // Explicit project override can retain the inherited proxy auth.
    expect(readNetworkConfiguration(f.b).has_proxy_auth).toBe(true);
    saveNetworkConfiguration(f.a, network('direct'), 'device');
    expect(networkSnapshot(f.b).route('https://remote.example')).toContain('DEVICE-PRIVATE');
    expect(readNetworkConfiguration(f.b, 'device').mode).toBe('direct');
    expect(clearNetworkOverride(f.b).mode).toBe('direct');
    expect(before.route('https://remote.example')).toContain('DEVICE-PRIVATE');
    expect(networkSnapshot(f.b).route('https://remote.example')).toBe('');
  } finally { f.close(); }
});

 test('quick explanation profiles stay metadata-free while configuration scope and inheritance are explicit', () => {
  const f = fixture();
  try {
    const a = new QuickExplanationSettings(f.a), b = new QuickExplanationSettings(f.b);
    a.save(a.preview({ connection_id: 'conn-device', model: 'shared-model', prompt: 'Shared explanation' }, 'device'), 'device');
    expect(b.read()).toEqual({ connection_id: 'conn-device', model: 'shared-model', prompt: 'Shared explanation' });
    expect(b.configurationScope()).toMatchObject({ source: 'device', project_override: false });
    b.save(b.preview({ model: 'local-model' }));
    a.save(a.preview({ model: 'shared-next' }, 'device'), 'device');
    expect(b.read().model).toBe('local-model'); expect(b.read('device').model).toBe('shared-next');
    expect(b.clearOverride().model).toBe('shared-next');
    a.save(a.preview({ prompt: null }, 'device'), 'device'); expect(b.read().prompt).toBe(DEFAULT_EXPLANATION_PROMPT);
    expect(fs.existsSync(path.join(f.b.home, 'quick-explanation.json'))).toBe(false);
  } finally { f.close(); }
});

 test('Agent environment precedence is device common/role then project common/role with reserved names protected', () => {
  const f = fixture();
  try {
    saveAgentEnvironment(f.a, 'common', { LEVEL: 'device-common', SHARED: 'yes', HTTPS_PROXY: 'http://device-common' }, 'device');
    saveAgentEnvironment(f.a, 'research', { LEVEL: 'device-role', ROLE: 'yes', HTTPS_PROXY: 'http://device-role' }, 'device');
    saveAgentEnvironment(f.b, 'common', { LEVEL: 'project-common', https_proxy: 'http://project-common' });
    expect(agentEnvironment(f.b, 'research').values).toEqual({ LEVEL: 'project-common', SHARED: 'yes', ROLE: 'yes', https_proxy: 'http://project-common' });
    saveAgentEnvironment(f.b, 'research', { LEVEL: 'project-role', HTTPS_PROXY: 'http://project-role' });
    expect(agentEnvironment(f.b, 'research').values).toEqual({ LEVEL: 'project-role', SHARED: 'yes', ROLE: 'yes', HTTPS_PROXY: 'http://project-role' });
    expect(readAgentEnvironment(f.b, 'research', 'device').values.LEVEL).toBe('device-role');
    expect(clearAgentEnvironmentOverride(f.b, 'research').configuration_scope.project_override).toBe(false);
    expect(agentEnvironment(f.b, 'research').values.LEVEL).toBe('project-common');
    clearAgentEnvironmentOverride(f.b, 'common'); expect(agentEnvironment(f.b, 'research').values.LEVEL).toBe('device-role');
    expect(() => saveAgentEnvironment(f.a, 'common', { LUSH_HOME: '/different' }, 'device')).toThrow('reserved');
    expect(f.b.env.LUSH_HOME).toBe(f.b.home);
    expect(fs.statSync(path.join(f.a.deviceHome, 'agent', 'agent.env')).mode & 0o777).toBe(0o600);
  } finally { f.close(); }
});

 test('shared Pi baseline is inherited without moving project snapshots or importing external Pi defaults', () => {
  const f = fixture();
  try {
    const shared = ensurePiConfiguration(f.a, 'device');
    json(path.join(shared.dir, 'settings.json'), { transport: 'sse', packages: ['never-autoload'], defaultProjectTrust: 'always' });
    const first = ensurePiConfiguration(f.b);
    expect(first.dir).toBe(path.join(f.b.home, 'pi')); expect(first.settings.transport).toBe('sse');
    expect(first.settings.packages).toBeUndefined(); expect(first.settings.defaultProjectTrust).toBe('never');
    json(path.join(shared.dir, 'settings.json'), { transport: 'websocket' });
    expect(first.settings.transport).toBe('sse'); expect(ensurePiConfiguration(f.b).settings.transport).toBe('websocket');
    json(path.join(first.dir, 'settings.json'), { transport: 'local-transport' });
    expect(ensurePiConfiguration(f.b).settings.transport).toBe('local-transport');
    expect(fs.existsSync(path.join(shared.dir, 'auth.json'))).toBe(false);
  } finally { f.close(); }
});

 test('shared resource discovery is available to both projects while explicit device scope excludes project resources', async () => {
  const f = fixture();
  try {
    const shared = ensurePiConfiguration(f.a, 'device');
    fs.mkdirSync(path.join(shared.dir, 'extensions'), { mode: 0o700 });
    fs.writeFileSync(path.join(shared.dir, 'extensions', 'shared.ts'), 'throw new Error("must not execute");');
    const local = path.join(f.b.project, '.pi', 'extensions'); fs.mkdirSync(local, { recursive: true });
    fs.writeFileSync(path.join(local, 'project.ts'), 'throw new Error("must not execute");');
    const effective = await discoverAgentResources(f.b, { packages: [] });
    expect(effective.extensions.map(row => row.label)).toEqual(['shared.ts', 'project.ts']);
    const device = await discoverAgentResources(f.b, { packages: [] }, 'device');
    expect(device.extensions.map(row => row.label)).toEqual(['shared.ts']);
  } finally { f.close(); }
});

test('explicit model discovery uses the selected network scope without changing project identity', async () => {
  const f = fixture();
  try {
    const command = path.join(f.root, 'model-catalog');
    fs.writeFileSync(command, `#!${process.execPath}\nconsole.log(JSON.stringify({models:[{slug:'fixture-model',display_name:process.cwd(),description:process.env.HTTPS_PROXY || 'direct'}]}));`, { mode: 0o700 });
    f.b.env.LUSH_CODEX_COMMAND = command;
    saveNetworkConfiguration(f.a, network('direct'), 'device');
    saveNetworkConfiguration(f.b, network());
    const device = await discoverAgentModels(f.b, 'codex', 'device');
    const project = await discoverAgentModels(f.b, 'codex');
    expect(device.models[0].description).toBe('direct');
    expect(device.models[0].label).toBe(f.b.deviceHome);
    expect(project.models[0].description).toBe('http://proxy.example:8123/');
    expect(project.models[0].label).toBe(f.b.project);
    expect(device.configuration_scope.selected).toBe('device');
    expect(f.b.env.LUSH_HOME).toBe(f.b.home);
  } finally { f.close(); }
});

 test('package scopes share an actual root and a cross-instance lock without enabling installed resources', async () => {
  const f = fixture(), entered = gate(), finish = gate(), calls = [];
  const run = async options => {
    calls.push(options);
    if (options.args[0] === 'install') {
      entered.resolve(); await finish.promise;
      json(path.join(options.env.PI_CODING_AGENT_DIR, 'settings.json'), { packages: [options.args[1]] });
    }
    return '';
  };
  const a = new AgentPackages(f.a, { run }), b = new AgentPackages(f.b, { run });
  try {
    const deviceA = a.forScope('device'), deviceB = b.forScope('device');
    expect(deviceA.directory()).toBe(deviceB.directory());
    const pending = deviceA.install('npm:device-tools@1.0.0'); await entered.promise;
    expect(a.isBusy()).toBe(true);
    await expect(deviceB.install('npm:other-tools@1.0.0')).rejects.toThrow('busy');
    finish.resolve(); const result = await pending;
    expect(a.isBusy()).toBe(false);
    expect(result.configuration_scope.selected).toBe('device');
    expect((await deviceB.list()).packages[0].source).toBe('npm:device-tools@1.0.0');
    expect(calls[0].env.PI_CODING_AGENT_DIR).toBe(path.join(f.a.deviceHome, 'pi'));
    expect(calls[0].cwd).toBe(f.a.deviceHome);
    expect(fs.existsSync(path.join(f.a.home, 'pi'))).toBe(false);
    expect(fs.existsSync(path.join(f.a.deviceHome, 'agent.json'))).toBe(false);
    await a.stop(); await expect(deviceA.install('npm:more@1.0.0')).rejects.toThrow('stopping');
  } finally { finish.resolve(); await a.stop(); await b.stop(); f.close(); }
});

test('no-project package installation resolves relative paths and subprocess cwd from the private configuration root', async () => {
  const f = fixture(), calls = [];
  const scoped = { ...scopedConfiguration(f.a, 'device'), project: null };
  const manager = new AgentPackages(scoped, { run: async options => {
    calls.push(options);
    if (options.args[0] === 'install') json(path.join(options.env.PI_CODING_AGENT_DIR, 'settings.json'), { packages: [options.args[1]] });
    return '';
  } });
  try {
    ensurePiConfiguration(scoped);
    const source = path.join(scoped.home, 'local-tools'); fs.mkdirSync(source, { mode: 0o700 });
    json(path.join(source, 'package.json'), { name: 'local-tools', version: '1.0.0' });
    const result = await manager.install('./local-tools');
    expect(calls[0].args).toEqual(['install', source, '--no-approve']);
    expect(calls[0].cwd).toBe(scoped.home);
    expect(calls[0].env.PI_CODING_AGENT_DIR).toBe(path.join(scoped.home, 'pi'));
    expect(result.packages[0].source).toBe(source);
    expect(scoped.project).toBeNull(); expect(f.a.project).not.toBeNull();
    expect(scoped.env.LUSH_HOME).toBe(f.a.home);
  } finally { await manager.stop(); f.close(); }
});

test('no-project model and resource discovery uses a config-root cwd and excludes project context directories', async () => {
  const f = fixture();
  try {
    const scoped = { ...scopedConfiguration(f.a, 'device'), project: null };
    ensurePiConfiguration(scoped);
    const command = path.join(scoped.home, 'catalog');
    fs.writeFileSync(command, `#!${process.execPath}\nif(process.argv[2]==='debug') console.log(JSON.stringify({models:[{slug:'fixture-model',description:process.cwd()}]}));`, { mode: 0o700 });
    scoped.env = { ...scoped.env, LUSH_CODEX_COMMAND: './catalog', LUSH_PI_COMMAND: './catalog' };
    const extension = path.join(scoped.home, 'pi', 'extensions'); fs.mkdirSync(extension, { mode: 0o700 });
    fs.writeFileSync(path.join(extension, 'shared.ts'), 'throw new Error("never execute");');
    const context = path.join(scoped.home, '.pi', 'extensions'); fs.mkdirSync(context, { recursive: true });
    fs.writeFileSync(path.join(context, 'project-only.ts'), 'throw new Error("never discover");');
    const models = await discoverAgentModels(scoped, 'codex');
    expect(models.source).toBe('cli'); expect(models.models[0].description).toBe(scoped.home);
    const resources = await discoverAgentResources(scoped);
    expect(resources.extensions.map(row => row.label)).toEqual(['shared.ts']);
    expect(resources.warning).toBeNull();
    expect(scoped.project).toBeNull();
    expect(fs.existsSync(path.join(scoped.home, 'project.db'))).toBe(false);
  } finally { f.close(); }
});

 test('all shared writers coordinate with the same settings lock and unsafe shared roots are not repaired', () => {
  const f = fixture();
  try {
    const lock = acquireConfigurationLock(f.a, 'device');
    try {
      expect(() => f.a.runtimeSettings.save({ concurrency: 4 }, 'device')).toThrow('busy');
      expect(() => new AgentSettings(f.a).save(profile('blocked'), 'device')).toThrow('busy');
      expect(() => saveNetworkConfiguration(f.a, network(), 'device')).toThrow();
      expect(() => new QuickExplanationSettings(f.a).save({}, 'device')).toThrow();
      expect(() => saveAgentEnvironment(f.a, 'common', { KEY: 'not-written' }, 'device')).toThrow('busy');
    } finally { lock.release(); }
    expect(fs.readdirSync(f.a.deviceHome)).toEqual([]);
    fs.chmodSync(f.a.deviceHome, 0o755);
    expect(() => new AgentSettings(f.a).save(profile('bad-mode'), 'device')).toThrow();
    expect(() => f.a.runtimeSettings.get('device')).toThrow();
    expect(fs.statSync(f.a.deviceHome).mode & 0o777).toBe(0o755);
  } finally { f.close(); }
});

 test('shared Agent/env/private configuration aliases and broad permissions fail closed without revealing secrets', () => {
  const f = fixture();
  try {
    const settings = new AgentSettings(f.a); settings.save(profile('shared'), 'device');
    const file = path.join(f.a.deviceHome, 'agent.json'), external = path.join(f.root, 'external');
    fs.writeFileSync(external, '{"PRIVATE":"DO NOT READ"}', { mode: 0o600 });
    fs.unlinkSync(file); fs.symlinkSync(external, file);
    expect(() => settings.get('device')).toThrow(); expect(() => settings.save(profile('nope'), 'device')).toThrow();
    fs.unlinkSync(file); fs.linkSync(external, file); expect(() => settings.get('device')).toThrow();
    fs.unlinkSync(file); settings.save(profile('shared'), 'device'); fs.chmodSync(file, 0o644);
    expect(() => settings.get('device')).toThrow('chmod 600');
    fs.chmodSync(file, 0o600);
    saveAgentEnvironment(f.a, 'common', { API_KEY: 'PRIVATE' }, 'device');
    const environment = path.join(f.a.deviceHome, 'agent', 'agent.env'); fs.chmodSync(environment, 0o644);
    expect(() => readAgentEnvironment(f.a, 'common', 'device')).toThrow('unsafe');
    expect(fs.readFileSync(external, 'utf8')).toBe('{"PRIVATE":"DO NOT READ"}');
  } finally { f.close(); }
});

 test('minimal legacy configs remain local and never guess a real user device directory', () => {
  const f = fixture();
  try {
    const local = { ...f.a, deviceHome: null };
    new AgentSettings(local).save(profile('project-only'));
    expect(new AgentSettings(local).resolve('agent').model).toBe('project-only');
    expect(() => new AgentSettings(local).get('device')).toThrow('unavailable');
    expect(() => local.runtimeSettings.get('other')).toThrow();
    expect(() => new QuickExplanationSettings(local).read('device')).toThrow();
    expect(() => saveAgentEnvironment(local, 'common', {}, 'device')).toThrow('unavailable');
    expect(fs.existsSync(f.a.deviceHome)).toBe(false);
  } finally { f.close(); }
});
