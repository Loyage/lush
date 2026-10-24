import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { run as runAgent } from '../../src/cli/commands/agent.js';
import { run as runConfig } from '../../src/cli/commands/config.js';
import { COMMANDS } from '../../src/cli/specs/agent-config.js';
import { parseCLI, validateCLIParameters } from '../../src/cli/parser.js';
import { Config } from '../../src/config.js';
import { AgentSettings } from '../../src/agent/settings.js';
import { ConnectionManager } from '../../src/agent/connections.js';
import { AgentPackages } from '../../src/agent/packages.js';
import { acquireConfigurationLock } from '../../src/core/device-config.js';
import { temp, env } from '../helpers.js';

// Package install/list/remove was not covered by the CLI source-management smoke below.
// Exercise the real subprocess and queue with private local inputs, without network or Pi auth.
test('package operations recover from lock contention and finish their subprocess groups', async () => {
  const root = temp(), home = path.join(root, 'device'), source = path.join(root, 'local-package');
  fs.mkdirSync(home, { mode: 0o700 }); fs.mkdirSync(source);
  const executable = path.join(root, 'controlled-package-cli');
  fs.writeFileSync(executable, `#!${process.execPath}
import fs from 'node:fs';
import path from 'node:path';
import cp from 'node:child_process';
const [action, source] = process.argv.slice(2);
const file = path.join(process.env.PI_CODING_AGENT_DIR, 'settings.json');
const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
if (action === 'list') {
  console.log('User packages:');
  for (const item of settings.packages || []) console.log('  ' + item + '\\n    ' + item);
} else {
  settings.packages = action === 'install' ? [source] : [];
  fs.writeFileSync(file, JSON.stringify(settings), { mode: 0o600 });
  // A background descendant retaining stdout used to turn a successful leader exit into timeout.
  const child = cp.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 1, 2] });
  child.unref();
}
`, { mode: 0o700 });
  const manager = new AgentPackages({ home, project: root,
    env: { PATH: process.env.PATH, HOME: root, LUSH_PI_COMMAND: executable } }, { timeoutMs: 2000 });
  let lock = acquireConfigurationLock({ home }, 'project', 'packages');
  try {
    await expect(manager.install(source)).rejects.toThrow('busy');
    expect(manager.isBusy()).toBe(false);
    lock.release(); lock = null;
    const installed = await manager.install(source);
    expect(installed).toMatchObject({ action: 'install', packages: [{ source, installed: true }] });
    expect((await manager.list()).packages).toHaveLength(1);
    expect(await manager.remove(installed.packages[0].id)).toMatchObject({ action: 'remove', packages: [] });
    expect(manager.isBusy()).toBe(false);
  } finally { lock?.release(); await manager.stop(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('device config and core model sources use narrow CLI RPCs without private reads or retired workflows', async () => {
  const root = temp(), calls = [], network = [];
  const config = new Config({ project: root, env: env({ LUSH_GLOBAL_CONFIG: path.join(root, 'device') }) });
  config.prepare();
  const settings = new AgentSettings(config), manager = new ConnectionManager(config, { fetch: async () => { network.push(true); throw new Error('unexpected network'); } });
  const source = manager.save({ label: 'fixture', provider: 'deepseek', auth_type: 'api_key', enabled: true, models: ['deepseek-chat'] }, { api_key: 'fixture-secret' });
  const devicePolicy = { version: 1, scope: 'device', revision: 'policy-revision', available: true, error: null, mounts: [] };
  const client = { config, async request(method, params) {
    calls.push({ method, params });
    if (method === 'system.settings') return config.runtimeSettings.get(params?.scope);
    if (method === 'system.configure') return config.configureRuntime(params.settings, params.scope);
    if (method === 'agent.configure') return settings.save(params.config, params.scope);
    if (method === 'agent.registered_models.list') return manager.registeredModels().list();
    if (method === 'agent.registered_models.resolve') return manager.registeredModels().resolve(params.selector);
    if (method === 'agent.connections.list' || method === 'agent.selection.resources') return manager.config();
    if (method === 'agent.connections.models' || method === 'agent.connections.models.refresh') return { version: 1, id: source.id, status: 'cached', source: 'manual', models: [] };
    if (method === 'hooks.list') return { daemon_hooks: devicePolicy };
    return { accepted: true };
  } };
  const execute = async (root, args, identity = client) => {
    const parsed = parseCLI([root, ...args], COMMANDS), spec = parsed.entry;
    if (!spec) throw new Error('removed CLI command');
    validateCLIParameters(parsed.args, spec);
    const offset = calls.length;
    parsed.args.shift();
    const result = await (root === 'agent' ? runAgent : runConfig)(root, parsed.args, { client: identity, json: true });
    for (const call of calls.slice(offset)) expect(spec.rpc).toContain(call.method);
    return result;
  };
  try {
    expect((await execute('config', ['runtime', 'set', 'max-depth', '4'])).max_depth.value).toBe(4);
    expect((await execute('config', ['runtime', 'set', '--data', '{"task_call_limit":12}', '--scope', 'device'])).task_call_limit.value).toBe(12);
    expect((await execute('config', ['runtime', 'show'])).max_depth.value).toBe(4);
    expect(calls.some(call => call.method === 'system.status')).toBe(false);
    await execute('config', ['runtime', 'reset', 'all']);
    expect(config.maxDepth).toBe(config.maxDepthDefault);
    const full = { version: 1, default: { agent: 'pi', model: 'deepseek/deepseek-chat', append_prompt: 'keep prompt',
      thinking: null, skills: null, extensions: null, soft_budget: null, env: { FIXTURE: 'keep' } }, roles: {} };
    const beforeReplace = calls.length;
    await execute('config', ['agent', 'replace', '--data', JSON.stringify(full), '--scope', 'device']);
    expect(calls.slice(beforeReplace).map(call => call.method)).toEqual(['agent.configure']);
    expect(settings.get().default).toMatchObject({ model: 'deepseek/deepseek-chat', append_prompt: 'keep prompt', env: { FIXTURE: 'keep' } });
    const sources = await execute('agent', ['source', 'list']);
    expect(sources.connections[0].id).toBe(source.id);
    expect(JSON.stringify(sources)).not.toContain('fixture-secret');
    expect((await execute('agent', ['source', 'show', source.id])).id).toBe(source.id);
    expect((await execute('agent', ['model', 'list'])).models).toEqual([]); // Old profiles are not auto-registered.
    const registered = manager.registeredModels().save({ name: 'astra', connection_id: source.id, model: 'deepseek/deepseek-chat' });
    expect((await execute('agent', ['model', 'list', '--scope', 'device'])).models[0]).toMatchObject({ id: registered.id, name: 'astra' });
    expect(calls.at(-1)).toEqual({ method: 'agent.registered_models.list', params: { scope: 'device' } });
    expect(await execute('agent', ['model', 'resolve', 'astra'])).toEqual({ id: registered.id, name: 'astra', connection_id: source.id, model: registered.model });
    await expect(execute('agent', ['model', 'resolve', 'astr'])).rejects.toThrow('not found');
    await execute('agent', ['model', 'choices']);
    await execute('agent', ['model', 'list', '--backend', 'pi']);
    expect(calls.at(-1)).toEqual({ method: 'agent.models', params: { agent: 'pi' } });
    await execute('agent', ['source', 'models', 'list', source.id]);
    expect(network).toHaveLength(0);
    await execute('agent', ['source', 'models', 'refresh', source.id]);
    expect(calls.at(-1).method).toBe('agent.connections.models.refresh');
    await execute('agent', ['source', 'refresh', source.id]);
    expect(calls.slice(-2).map(call => call.method)).toEqual(['agent.connections.query','agent.connections.list']);
    await execute('agent', ['source', 'remove', source.id]);
    expect(calls.at(-1)).toEqual({ method: 'agent.connections.remove', params: { id: source.id } });
    expect(await execute('config', ['auto-answer', 'show'])).toEqual(devicePolicy);
    const management = { ...client, token: 'fixture-token', management: true };
    await execute('config', ['auto-answer', 'set', 'off', '--revision', 'policy-revision', '--scope', 'device'], management);
    expect(calls.at(-1)).toEqual({ method: 'hooks.auto_select', params: { enabled: false, expected_revision: 'policy-revision', scope: 'device' } });
    await execute('config', ['valet-permission', 'set', 'worker.cancel', 'confirmation', '--revision', 'permission-revision', '--scope', 'device'], management);
    expect(calls.at(-1)).toEqual({ method: 'management.permission_set', params: { method: 'worker.cancel', access: 'confirmation', expected_revision: 'permission-revision', scope: 'device' } });
    const beforeInvalid = calls.length;
    await expect(execute('config', ['runtime', 'set', 'max-depth', '4', '--data', '{}'])).rejects.toThrow();
    for (const [rootName, args] of [
      ['agent', ['resource','list']], ['agent', ['package','list']], ['agent', ['usage','history']],
      ['agent', ['source','login','start',source.id]], ['agent', ['source','save','--file','must-not-open']],
      ['agent', ['source','history',source.id]], ['agent', ['source','sampling','set','--data','{}']],
      ['agent', ['prompt','init']], ['agent', ['env','show','agent']],
      ['config', ['agent','show']], ['config', ['agent','set','default','--model','x']], ['config', ['agent','reset','agent']],
      ['config', ['network','set','--file','must-not-open']], ['config', ['migration','preview']],
    ]) {
      await expect(execute(rootName, args)).rejects.toThrow();
      // Direct handlers also reject removed verbs, not just hidden parser entries.
      await expect((rootName === 'agent' ? runAgent : runConfig)(rootName, [...args], { client, json: true })).rejects.toThrow();
    }
    await expect(execute('config', ['runtime', 'show'], { ...client, token: 'worker-token' })).rejects.toThrow('requires user');
    expect(calls).toHaveLength(beforeInvalid);
  } finally { await manager.stop(); fs.rmSync(root, { recursive: true, force: true }); }
});
