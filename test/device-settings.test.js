import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { Config } from '../src/config.js';
import { AgentSettings } from '../src/agent/settings.js';
import { agentPrompt } from '../src/agent/prompts.js';
import { QuickExplanationSettings, DEFAULT_EXPLANATION_PROMPT } from '../src/core/quick-explanation.js';
import { readNetworkConfiguration, saveNetworkConfiguration, clearNetworkOverride, networkSnapshot, agentNetworkEnvironment } from '../src/agent/network.js';
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

test('Project adapters share one authority, reject project overrides, and retain immutable project binding', async () => {
  const global = temp(), a = projectFixture(undefined, { LUSH_GLOBAL_CONFIG: global }),
    b = projectFixture(undefined, { LUSH_GLOBAL_CONFIG: global });
  try {
    a.project.configureRuntimeSettings({ concurrency: 6, progress_reporting: false });
    expect(b.project.refreshRuntimeConfiguration()).toBe(true);
    expect(b.config.concurrency).toBe(6);
    expect(b.project.agentConfig().options.default_prompts.agent).not.toContain('lush progress');
    b.project.configureRuntimeSettings({ concurrency: 9 });
    a.project.refreshRuntimeConfiguration(); expect(a.config.concurrency).toBe(9);
    expect(a.project.runtimeSettings().concurrency.source).toBe('device');
    expect(() => b.project.configureRuntimeSettings({ concurrency: 2 }, 'project')).toThrow('no longer');
    a.project.configureAgents(profile('shared'));
    expect(b.project.agentConfig().default.model).toBe('shared');
    expect(() => b.project.configureAgents(profile('local'), 'project')).toThrow('no longer');
    expect(() => b.project.clearSettingsOverride('agent')).toThrow('no longer');
    await a.project.configureAgentNetwork(network('direct'));
    expect(b.project.agentNetwork().mode).toBe('direct');
    a.project.configureAgentEnvironment('common', { SHARED: 'yes' });
    expect(b.project.agentEnvironment('common').values.SHARED).toBe('yes');
    const file = path.join(a.config.deviceHome, 'settings.json'); fs.chmodSync(file, 0o644);
    expect(b.project.refreshRuntimeConfiguration()).toBe(false);
    expect(b.project.runtimeSettingsUnavailable).toBe(true); expect(b.config.concurrency).toBe(9);
    fs.chmodSync(file, 0o600); expect(b.project.refreshRuntimeConfiguration()).toBe(true);
    expect(a.config.env.LUSH_HOME).toBe(a.config.home); expect(b.config.env.LUSH_HOME).toBe(b.config.home);
  } finally { await Promise.all([a.close(), b.close()]); fs.rmSync(global, { recursive: true, force: true }); }
});

test('Project package adapter keeps injected runner, shared mutation lock and stop behavior', async () => {
  const f = projectFixture(), entered = gate(), finish = gate(), calls = [];
  await f.project.agentPackageManager.stop();
  f.project.agentPackageManager = new AgentPackages(f.config, { run: async options => {
    calls.push(options); if (options.args[0] === 'install') { entered.resolve(); await finish.promise; } return '';
  } });
  const manager = f.project.packageManagerForScope('device');
  try {
    expect(manager).toBe(f.project.agentPackageManager);
    const pending = manager.install('npm:fixture@1.0.0'); await entered.promise;
    expect(() => f.project.settingsMigrationApply({ revision: 'r', confirm: true })).toThrow('资源安装');
    finish.resolve(); expect((await pending).configuration_scope.selected).toBe('device');
    expect(calls[0].cwd).toBe(f.config.deviceHome);
    expect(calls[0].env.PI_CODING_AGENT_DIR).toBe(path.join(f.config.deviceHome, 'pi'));
    expect(fs.existsSync(path.join(f.config.home, 'pi'))).toBe(false);
    await manager.stop(); await expect(manager.install('npm:later@1.0.0')).rejects.toThrow('stopping');
  } finally { finish.resolve(); await f.close(); }
});

test('ordinary device reads do not initialize the root or consult unsafe legacy project files', async () => {
  const f = fixture();
  try {
    for (const file of ['settings.json', 'agent.json', 'network.json', 'quick-explanation.json'])
      fs.writeFileSync(path.join(f.a.home, file), 'LEGACY PRIVATE invalid JSON');
    new AgentSettings(f.a).get(); new QuickExplanationSettings(f.a).read();
    readNetworkConfiguration(f.a); readAgentEnvironment(f.a, 'common');
    expect(f.a.runtimeSettings.get().concurrency.value).toBe(3);
    expect(fs.existsSync(f.a.deviceHome)).toBe(false);
    expect(f.a.deviceHome).toBe(f.b.deviceHome); expect(f.a.home).not.toBe(f.b.home);
    for (const read of [() => f.a.runtimeSettings.get('project'), () => new AgentSettings(f.a).get('project'),
      () => new QuickExplanationSettings(f.a).read('project'), () => readNetworkConfiguration(f.a, 'project'),
      () => readAgentEnvironment(f.a, 'common', 'project')]) expect(read).toThrow('no longer');
    await expect(discoverAgentResources(f.a, {}, 'project')).rejects.toThrow('no longer');
    await expect(discoverAgentModels(f.a, 'pi', 'project')).rejects.toThrow('no longer');
    expect(() => new AgentPackages(f.a).forScope('project')).toThrow('no longer');
  } finally { f.close(); }
});

test('runtime settings reload device edits, legacy source stays untouched and null restores defaults', () => {
  const f = fixture();
  try {
    const legacy = path.join(f.b.home, 'settings.json'); json(legacy, { version: 1, concurrency: 2 });
    f.a.configureRuntime({ concurrency: 7, call_timeout: 60, progress_reporting: false });
    f.b.refreshRuntimeSettings(); expect(f.b.concurrency).toBe(7); expect(f.b.timeout).toBe(60);
    expect(f.b.runtimeSettings.get().concurrency).toMatchObject({ value: 7, default: 3, source: 'device', overridden: true });
    f.b.configureRuntime({ concurrency: 9 }); f.a.refreshRuntimeSettings(); expect(f.a.concurrency).toBe(9);
    f.b.configureRuntime({ concurrency: null }); expect(f.b.concurrency).toBe(3);
    expect(JSON.parse(fs.readFileSync(legacy)).concurrency).toBe(2);
    expect(f.b.runtimeSettings.get().configuration_scope.project_override).toBe(false);
  } finally { f.close(); }
});

test('device Agent profiles preserve full role parameters and normalize explicit resource paths', () => {
  const f = fixture();
  try {
    const a = new AgentSettings(f.a), b = new AgentSettings(f.b);
    a.save({ ...profile('shared', { extensions: ['./ext.ts'], skills: ['./skills'], env: { PROFILE: 'value' } }),
      roles: { agent: { agent: 'codex', model: 'full-model', thinking: 'high', default_prompt: 'rules', append_prompt: 'style',
        env: { WORKER_VALUE: 'retained' }, extensions: [], skills: [] } } });
    expect(b.resolve('planner').extensions).toEqual([path.join(f.a.project, 'ext.ts')]);
    expect(b.resolve('agent')).toMatchObject({ agent: 'codex', model: 'full-model', thinking: 'high',
      default_prompt: 'rules', append_prompt: 'style', env: { WORKER_VALUE: 'retained' } });
    expect(b.get().configuration_scope).toMatchObject({ selected: 'device', source: 'device', project_override: false });
    expect(agentPrompt(f.b, 'agent', b.resolve('agent')).customization.settings).toBe(b.get().file);
    expect(() => b.clearOverride()).toThrow('no longer');
  } finally { f.close(); }
});

test('Prompt profile sources remain device-owned when a legacy project agent.json still exists', () => {
  const f = fixture();
  try {
    const a = new AgentSettings(f.a), b = new AgentSettings(f.b);
    a.save(profile('device', { default_prompt: 'DEVICE REPLACEMENT', append_prompt: 'DEVICE APPEND' }));
    const legacyFile = path.join(f.b.home, 'agent.json');
    json(legacyFile, profile('legacy', { default_prompt: 'LEGACY REPLACEMENT', append_prompt: 'LEGACY APPEND' }));
    const before = fs.readFileSync(legacyFile);
    const view = agentPrompt(f.b, 'worker', b.resolve('worker'));
    const deviceFile = path.join(f.b.deviceHome, 'agent.json');
    expect(view.customization.settings).toBe(deviceFile);
    expect(view.parts.filter(part => part.name.startsWith('settings.')).map(part => part.source)).toEqual([deviceFile, deviceFile]);
    expect(view.text).toContain('DEVICE REPLACEMENT'); expect(view.text).toContain('DEVICE APPEND');
    expect(view.text).not.toContain('LEGACY'); expect(fs.readFileSync(legacyFile)).toEqual(before);
    const legacy = { ...f.b, deviceHome: null, runtimeSettings: null };
    expect(agentPrompt(legacy, 'worker').customization.settings).toBe(legacyFile);
  } finally { f.close(); }
});

test('network saves share private auth while in-flight snapshots stay frozen', () => {
  const f = fixture();
  try {
    json(path.join(f.b.home, 'network.json'), network('direct'));
    saveNetworkConfiguration(f.a, network('proxy', { proxy_auth: { username: 'DEVICE-PRIVATE', password: 'TOKEN-PRIVATE' } }));
    const before = networkSnapshot(f.b);
    expect(before.route('https://remote.example')).toContain('DEVICE-PRIVATE:TOKEN-PRIVATE@');
    expect(JSON.stringify(readNetworkConfiguration(f.b))).not.toContain('PRIVATE');
    saveNetworkConfiguration(f.b, network()); expect(readNetworkConfiguration(f.a).has_proxy_auth).toBe(true);
    saveNetworkConfiguration(f.a, network('direct')); expect(networkSnapshot(f.b).route('https://remote.example')).toBe('');
    expect(before.route('https://remote.example')).toContain('DEVICE-PRIVATE');
    expect(() => clearNetworkOverride(f.b)).toThrow('no longer');
  } finally { f.close(); }
});

test('quick explanation and environment use device authority; Worker env remains highest precedence', () => {
  const f = fixture();
  try {
    const a = new QuickExplanationSettings(f.a), b = new QuickExplanationSettings(f.b);
    a.save({ connection_id: null, model: 'one', prompt: 'Shared' }); expect(b.read().model).toBe('one');
    expect(b.configurationScope()).toMatchObject({ selected: 'device', project_override: false });
    expect(() => b.clearOverride()).toThrow('no longer');
    saveAgentEnvironment(f.a, 'common', { VALUE: 'common', SHARED: 'yes' });
    saveAgentEnvironment(f.a, 'agent', { VALUE: 'role' });
    fs.mkdirSync(path.join(f.b.home, 'agent'), { mode: 0o700 });
    fs.writeFileSync(path.join(f.b.home, 'agent', 'agent.env'), 'VALUE=legacy\n');
    expect(agentEnvironment(f.b, 'agent').values.VALUE).toBe('role');
    expect(agentNetworkEnvironment(f.b, agentEnvironment(f.b, 'agent').values, { VALUE: 'worker' }).VALUE).toBe('worker');
    expect(() => clearAgentEnvironmentOverride(f.b, 'common')).toThrow('no longer');
    expect(() => saveAgentEnvironment(f.a, 'common', { LUSH_HOME: 'reserved' })).toThrow('reserved');
  } finally { f.close(); }
});

test('Pi baseline and resource discovery are exclusively device-owned but runtime/session roots stay project-owned', async () => {
  const f = fixture();
  try {
    const shared = ensurePiConfiguration(f.a); json(path.join(shared.dir, 'settings.json'), { transport: 'sse' });
    fs.mkdirSync(path.join(f.b.home, 'pi'), { mode: 0o700 }); json(path.join(f.b.home, 'pi', 'settings.json'), { transport: 'legacy' });
    expect(ensurePiConfiguration(f.b).settings.transport).toBe('sse');
    const ext = path.join(shared.dir, 'extensions'); fs.mkdirSync(ext, { mode: 0o700 });
    fs.writeFileSync(path.join(ext, 'shared.ts'), 'throw new Error("never execute");');
    const local = path.join(f.b.project, '.pi', 'extensions'); fs.mkdirSync(local, { recursive: true });
    fs.writeFileSync(path.join(local, 'ignored.ts'), 'throw new Error("never execute");');
    const resources = await discoverAgentResources(f.b);
    expect(resources.extensions.map(row => row.label)).toEqual(['shared.ts']);
    expect(f.b.env.LUSH_HOME).toBe(f.b.home); expect(fs.existsSync(path.join(f.b.deviceHome, 'sessions'))).toBe(false);
  } finally { f.close(); }
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
    const local = { ...f.a, deviceHome: null, runtimeSettings: null };
    new AgentSettings(local).save(profile('project-only'));
    expect(new AgentSettings(local).resolve('agent').model).toBe('project-only');
    expect(() => new AgentSettings(local).get('device')).toThrow('unavailable');
    expect(() => f.a.runtimeSettings.get('other')).toThrow();
    expect(() => new QuickExplanationSettings(local).read('device')).toThrow();
    expect(() => saveAgentEnvironment(local, 'common', {}, 'device')).toThrow('unavailable');
    expect(fs.existsSync(f.a.deviceHome)).toBe(false);
  } finally { f.close(); }
});
