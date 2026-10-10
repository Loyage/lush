import { test, expect } from 'bun:test';
import { Dispatcher } from '../src/rpc/dispatcher.js';
import { assertAllowed, USER_ONLY } from '../src/rpc/registry.js';
import { run as runConfig } from '../src/cli/commands/config.js';
import { run as runAgent } from '../src/cli/commands/agent.js';
import { fixture, temp } from './helpers.js';
import fs from 'node:fs';
import path from 'node:path';

const model = { file: '/private/shared/settings.json', concurrency: { value: 3, default: 8, overridden: true },
  control_concurrency: { value: 2, default: 2, overridden: false }, call_timeout: { value: 900, default: 900, overridden: false },
  task_call_limit: { value: 24, default: 24, overridden: false }, max_depth: { value: 8, default: 8, overridden: false },
  input_routes: { value: [], default: [], overridden: false } };

test('device scope and migration APIs stay user-only and strictly scoped', () => {
  for (const method of ['system.settings', 'settings.migration.preview', 'settings.migration.apply', 'settings.clear_override']) {
    expect(USER_ONLY.has(method)).toBe(true);
    expect(() => assertAllowed(method, {}, 17)).toThrow('requires user approval');
  }
  expect(() => assertAllowed('agent.config', { scope: 'device' }, 17)).toThrow('user approval');
  expect(() => assertAllowed('agent.config', { scope: 'project' }, 17)).toThrow('user approval');
  expect(() => assertAllowed('agent.config', {}, 17)).toThrow('user approval');
  for (const scope of ['all', '', null, {}, 1]) expect(() => assertAllowed('agent.network', { scope }, null)).toThrow('scope');
  expect(() => assertAllowed('settings.migration.apply', { revision: 'r', confirm: true, project: '/elsewhere' }, null)).toThrow('unknown parameter');
  expect(() => assertAllowed('agent.connections.history', { id: 'id', scope: 'device' }, null)).toThrow('unknown parameter');
});

test('RPC forwards explicit scope separately from full profiles and credentials', async () => {
  const calls = [], p = { actor: () => null };
  for (const name of ['runtimeSettings', 'configureRuntimeSettings', 'agentConfig', 'configureAgents', 'agentNetwork',
    'configureAgentNetwork', 'agentEnvironment', 'configureAgentEnvironment', 'agentConnectionsList', 'saveAgentConnection',
    'quickExplanationConfig', 'configureQuickExplanation', 'agentPackages', 'settingsMigrationApply', 'settingsMigrationPreview', 'clearSettingsOverride']) {
    p[name] = (...args) => { calls.push({ name, args }); return { ok: true }; };
  }
  const dispatcher = new Dispatcher(p);
  const cases = [
    ['system.settings', { scope: 'device' }, 'runtimeSettings', ['device']],
    ['system.configure', { settings: { concurrency: 3 }, scope: 'device' }, 'configureRuntimeSettings', [{ concurrency: 3 }, 'device']],
    ['agent.config', { scope: 'device' }, 'agentConfig', ['device']],
    ['agent.configure', { config: { version: 1 }, scope: 'device' }, 'configureAgents', [{ version: 1 }, 'device']],
    ['agent.network.configure', { config: { mode: 'direct' }, scope: 'device' }, 'configureAgentNetwork', [{ mode: 'direct' }, 'device']],
    ['agent.environment.configure', { target: 'common', values: { FOO: 'bar' }, scope: 'device' }, 'configureAgentEnvironment', ['common', { FOO: 'bar' }, 'device']],
    ['agent.connections.list', { scope: 'device' }, 'agentConnectionsList', ['device']],
    ['agent.connections.save', { connection: { id: 'id' }, credential: { api_key: 'KEY' }, scope: 'device' }, 'saveAgentConnection', [{ id: 'id' }, { api_key: 'KEY' }, 'device']],
    ['quick_explain.config', { scope: 'device' }, 'quickExplanationConfig', ['device']],
    ['quick_explain.configure', { config: { model: 'm' }, scope: 'project' }, 'configureQuickExplanation', [{ model: 'm' }, 'project']],
    ['agent.packages.list', { scope: 'device' }, 'agentPackages', ['device']],
    ['settings.migration.apply', { revision: 'r', confirm: true }, 'settingsMigrationApply', [{ revision: 'r', confirm: true }]],
    ['settings.clear_override', { kind: 'environment', target: 'common' }, 'clearSettingsOverride', ['environment', 'common']],
  ];
  for (const [method, params, name, args] of cases) {
    await dispatcher.dispatch(method, params); expect(calls.at(-1)).toEqual({ name, args });
  }
});

test('CLI explicit scope is opt-in and migration confirmation carries the preflight revision', async () => {
  const calls = [], client = { token: null, request: async (method, params) => { calls.push({ method, params }); return model; } };
  await runConfig('config', ['show', '--scope', 'device'], { client, json: true });
  expect(calls.pop()).toEqual({ method: 'system.settings', params: { scope: 'device' } });
  await runConfig('config', ['set', 'concurrency', '3', '--scope', 'device'], { client, json: true });
  expect(calls.pop()).toEqual({ method: 'system.configure', params: { settings: { concurrency: 3 }, scope: 'device' } });
  await runConfig('config', ['migrate'], { client, json: true });
  expect(calls.pop()).toEqual({ method: 'settings.migration.preview', params: undefined });
  await runConfig('config', ['migrate', '--confirm', '--revision', 'fixed-revision'], { client, json: true });
  expect(calls.pop()).toEqual({ method: 'settings.migration.apply', params: { revision: 'fixed-revision', confirm: true } });
  for (const args of [['migrate', '--confirm'], ['migrate', '--revision', 'r'], ['show', '--scope', 'all'], ['show', '--scope', 'project']]) {
    await expect(runConfig('config', args, { client, json: true })).rejects.toThrow();
  }
  await runAgent('agent', ['show', '--scope', 'device'], { client, json: true });
  expect(calls.pop()).toEqual({ method: 'agent.config', params: { scope: 'device' } });
  await runAgent('agent', ['sources', 'list', '--scope', 'device'], { client, json: true });
  expect(calls.pop()).toEqual({ method: 'agent.connections.list', params: { scope: 'device' } });
  await runAgent('agent', ['packages', 'list', '--scope', 'device'], { client, json: true });
  expect(calls.pop()).toEqual({ method: 'agent.packages.list', params: { scope: 'device' } });
  expect(calls).toEqual([]);
});

test('fixtures isolate device storage by default and only share an explicitly selected temporary root', async () => {
  const a = fixture(), b = fixture(), shared = temp(), c = fixture(undefined, { LUSH_GLOBAL_CONFIG: shared });
  try {
    expect(a.config.env.LUSH_GLOBAL_CONFIG).not.toBe(b.config.env.LUSH_GLOBAL_CONFIG);
    expect(a.config.env.LUSH_GLOBAL_CONFIG.startsWith(`${a.root}/`)).toBe(false);
    fs.writeFileSync(path.join(a.config.env.LUSH_GLOBAL_CONFIG, 'sentinel'), 'a');
    expect(fs.existsSync(path.join(b.config.env.LUSH_GLOBAL_CONFIG, 'sentinel'))).toBe(false);
    expect(c.config.env.LUSH_GLOBAL_CONFIG).toBe(shared);
  } finally {
    await Promise.all([a.close(), b.close(), c.close()]);
    expect(fs.existsSync(a.config.env.LUSH_GLOBAL_CONFIG)).toBe(false);
    expect(fs.existsSync(shared)).toBe(true);
    fs.rmSync(shared, { recursive: true, force: true });
  }
});

test('source project migration refuses live calls, Git work, writes and account operations before reading files', async () => {
  const f = fixture();
  try {
    f.project.running.set(999, {});
    expect(() => f.project.settingsMigrationApply({ revision: 'r', confirm: true })).toThrow('活动');
    f.project.running.clear(); f.project.writing = 1;
    expect(() => f.project.settingsMigrationApply({ revision: 'r', confirm: true })).toThrow('写入');
    f.project.writing = 0; f.project.workspaces.pending = 1;
    expect(() => f.project.settingsMigrationApply({ revision: 'r', confirm: true })).toThrow('Git');
    f.project.workspaces.pending = 0;
    f.project.agentConnections.isBusy = () => true;
    expect(() => f.project.settingsMigrationApply({ revision: 'r', confirm: true })).toThrow('登录');
    f.project.settingsMigrationApplying = true;
    expect(() => f.project.configureRuntimeSettings({ concurrency: 1 })).toThrow('migration');
    f.project.settingsMigrationApplying = false;
  } finally { f.project.running.clear(); f.project.writing = 0; f.project.workspaces.pending = 0; await f.close(); }
});

test('Agent RPC cannot read device settings through omitted scope; status remains a narrow projection', async () => {
  let includeProfile = null;
  const p = { actor: () => 17, status: include => { includeProfile = include; return include ? { agent_config: { model: 'private' } } : { running: 0 }; } };
  const dispatcher = new Dispatcher(p);
  for (const [method, params] of [['agent.config', {}], ['agent.models', { agent: 'pi' }], ['agent.resources', {}],
    ['agent.selection.resources', {}], ['agent.config', { scope: 'project' }]])
    await expect(dispatcher.dispatch(method, params)).rejects.toThrow('user approval');
  expect(await dispatcher.dispatch('system.status')).not.toHaveProperty('agent_config');
  expect(includeProfile).toBe(false);
});

test('user summary projects device policy evidence and safe errors without exposing Hook internals', async () => {
  let actor = null, reads = 0;
  const model = { revision: 'hooks-revision', policy_revision: 'device-policy-revision', error: null,
    mounts: [{ id: 'auto-select', enabled: true, editable: true, last_execution: { private: 'not projected' } }] };
  const dispatcher = new Dispatcher({ actor: () => actor, summary: () => ({ running: 0 }),
    daemonHooks: () => { reads++; return model; } });
  const initial = await dispatcher.dispatch('system.summary');
  expect(initial.auto_select).toEqual({ enabled: true, revision: 'hooks-revision', editable: true,
    scope: 'device', policy_revision: 'device-policy-revision', available: true, error: null });
  expect(initial.auto_select).not.toHaveProperty('mounts');
  expect(initial.auto_select).not.toHaveProperty('last_execution');
  model.error = '设备策略无法安全读取'; model.mounts[0].enabled = false; model.mounts[0].editable = false;
  expect((await dispatcher.dispatch('system.summary')).auto_select).toMatchObject({
    enabled: false, editable: false, available: false, error: '设备策略无法安全读取' });
  delete model.policy_revision;
  expect((await dispatcher.dispatch('system.summary')).auto_select.policy_revision).toBe('hooks-revision');
  actor = 17; const before = reads;
  expect(await dispatcher.dispatch('system.summary')).not.toHaveProperty('auto_select');
  expect(reads).toBe(before);
});
