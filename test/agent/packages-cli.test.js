import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { runPackages } from '../../src/cli/commands/agent-packages.js';
import { run as runAgent } from '../../src/cli/commands/agent.js';
import { run as runConfig } from '../../src/cli/commands/config.js';
import { COMMANDS } from '../../src/cli/specs/agent-config.js';
import { parseCLI, validateCLIParameters } from '../../src/cli/parser.js';
import { cliArguments } from '../../src/cli/args.js';
import { Config } from '../../src/config.js';
import { AgentSettings } from '../../src/agent/settings.js';
import { ConnectionManager } from '../../src/agent/connections.js';
import { temp, env } from '../helpers.js';

test('device config and agent resources use new CLI paths and original narrow RPCs without widening private access', async () => {
  const root = temp(), calls = [], network = [];
  const config = new Config({ project: root, env: env({ LUSH_GLOBAL_CONFIG: path.join(root, 'device') }) });
  config.prepare();
  const settings = new AgentSettings(config), manager = new ConnectionManager(config, { fetch: async () => { network.push(true); throw new Error('unexpected network'); } });
  const view = { version: 1, packages: [], resources: { extensions: [], skills: [] }, truncated: false };
  const source = manager.save({ label: 'fixture', provider: 'deepseek', auth_type: 'api_key', enabled: true, models: ['deepseek-chat'] }, { api_key: 'fixture-secret' });
  const devicePolicy = { version: 1, scope: 'device', revision: 'policy-revision', available: true, error: null, mounts: [] };
  const client = { config, async request(method, params) {
    calls.push({ method, params });
    if (method === 'system.settings') return config.runtimeSettings.get(params?.scope);
    if (method === 'system.configure') return config.configureRuntime(params.settings, params.scope);
    if (method === 'agent.config') return settings.get(params?.scope);
    if (method === 'agent.configure') return settings.save(params.config, params.scope);
    if (method === 'agent.connections.list') return manager.config();
    if (method === 'agent.connections.save') return manager.save(params.connection, params.credential);
    if (method === 'agent.connections.models' || method === 'agent.connections.models.refresh') return { version: 1, id: source.id, status: 'cached', source: 'manual', models: [] };
    if (method === 'agent.selection.resources') return manager.config();
    if (method === 'agent.connections.device.start') return { login_id: 'device-login', user_code: 'fixture-code' };
    if (method === 'agent.connections.login.start') return { login_id: 'callback-login', url: 'https://example.invalid/auth' };
    if (method === 'agent.connections.login.finish') return source;
    if (method === 'agent.connections.device.poll' || method === 'agent.connections.device.cancel') return { id: source.id, login_id: params.login_id, status: 'pending' };
    if (method === 'hooks.list') return { daemon_hooks: devicePolicy };
    if (method === 'agent.network' || method === 'agent.network.configure') return { version: 1, mode: 'inherit', proxy_url: null, no_proxy: [], has_proxy_auth: false };
    return view;
  } };
  const execute = async (root, args, identity = client) => {
    const parsed = parseCLI([root, ...args], COMMANDS), spec = parsed.entry;
    expect(spec).toBeDefined();
    validateCLIParameters(parsed.args, spec);
    const offset = calls.length;
    parsed.args.shift();
    const result = await (root === 'agent' ? runAgent : runConfig)(root, parsed.args, { client: identity, json: true });
    for (const call of calls.slice(offset)) expect(spec.rpc).toContain(call.method);
    return result;
  };
  try {
    expect(await runPackages(['list'], { client, json: true })).toEqual(view);
    await execute('agent', ['package', 'install', 'npm:@scope/tools@1.0.0', '--scope', 'device']);
    await execute('agent', ['package', 'update', 'pkg-0123456789abcdef']);
    await execute('agent', ['package', 'remove', 'pkg-0123456789abcdef']);
    expect(calls.slice(0, 4)).toEqual([
      { method: 'agent.packages.list', params: {} },
      { method: 'agent.packages.install', params: { source: 'npm:@scope/tools@1.0.0', scope: 'device' } },
      { method: 'agent.packages.update', params: { id: 'pkg-0123456789abcdef' } },
      { method: 'agent.packages.remove', params: { id: 'pkg-0123456789abcdef' } },
    ]);
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
    await execute('config', ['agent', 'set', 'default', '--model', 'deepseek/next']);
    expect(settings.get().default).toMatchObject({ model: 'deepseek/next', append_prompt: 'keep prompt', env: { FIXTURE: 'keep' } });
    await execute('config', ['agent', 'set', 'agent', '--model', 'deepseek/role']);
    await execute('config', ['agent', 'reset', 'agent']);
    expect(settings.get().roles).toEqual({});

    const sources = await execute('agent', ['source', 'list']);
    expect(sources.connections[0].id).toBe(source.id);
    expect(JSON.stringify(sources)).not.toContain('fixture-secret');
    expect((await execute('agent', ['source', 'show', source.id])).id).toBe(source.id);
    await execute('agent', ['model', 'choices']);
    await execute('agent', ['model', 'list', '--backend', 'pi']);
    await execute('agent', ['resource', 'list']);
    expect(calls.at(-1).method).toBe('agent.resources');
    await execute('agent', ['source', 'models', 'list', source.id]);
    expect(network).toHaveLength(0);
    await execute('agent', ['source', 'models', 'refresh', source.id]);
    expect(calls.at(-1).method).toBe('agent.connections.models.refresh');

    const started = await execute('agent', ['source', 'login', 'start', source.id, '--method', 'device']);
    expect(started.login_id).toBe('device-login');
    await execute('agent', ['source', 'login', 'poll', source.id, started.login_id]);
    await execute('agent', ['source', 'login', 'cancel', source.id, started.login_id]);
    const callback = await execute('agent', ['source', 'login', 'start', source.id, '--method', 'callback']);
    const callbackFile = path.join(root, 'callback.txt');
    fs.writeFileSync(callbackFile, 'https://example.invalid/callback?code=fixture-private-callback', { mode: 0o600 });
    const finished = await execute('agent', ['source', 'login', 'finish', source.id, callback.login_id, '--url-file', callbackFile]);
    expect(JSON.stringify(finished)).not.toContain('fixture-private-callback');
    expect(calls.at(-1).params.redirect_url).toContain('fixture-private-callback');

    const sourceFile = path.join(root, 'source.json');
    fs.writeFileSync(sourceFile, JSON.stringify({ connection: { label: 'second', provider: 'deepseek', auth_type: 'api_key', models: [] }, credential: { api_key: 'second-secret' } }), { mode: 0o600 });
    expect(JSON.stringify(await execute('agent', ['source', 'save', '--file', sourceFile]))).not.toContain('second-secret');
    const networkFile = path.join(root, 'network.json');
    fs.writeFileSync(networkFile, JSON.stringify({ version: 1, mode: 'inherit', proxy_url: null, no_proxy: [] }), { mode: 0o600 });
    await execute('config', ['network', 'set', '--file', networkFile]);
    expect(await execute('config', ['auto-answer', 'show'])).toEqual(devicePolicy);
    const management = { ...client, token: 'fixture-token', management: true };
    await execute('config', ['auto-answer', 'set', 'off', '--revision', 'policy-revision', '--scope', 'device'], management);
    expect(calls.at(-1)).toEqual({ method: 'hooks.auto_select', params: { enabled: false, expected_revision: 'policy-revision', scope: 'device' } });
    await execute('config', ['valet-permission', 'set', 'worker.cancel', 'confirmation', '--revision', 'permission-revision', '--scope', 'device'], management);
    expect(calls.at(-1)).toEqual({ method: 'management.permission_set', params: { method: 'worker.cancel', access: 'confirmation', expected_revision: 'permission-revision', scope: 'device' } });

    const beforeInvalid = calls.length;
    await expect(execute('config', ['runtime', 'set', 'max-depth', '4', '--data', '{}'])).rejects.toThrow();
    await expect(execute('agent', ['source', 'login', 'start', source.id, '--poll', 'old-login'])).rejects.toThrow();
    await expect(execute('agent', ['source', 'save', '--file', sourceFile], management)).rejects.toThrow('cannot read');
    await expect(execute('config', ['network', 'set', '--file', networkFile], management)).rejects.toThrow('local user');
    expect(calls).toHaveLength(beforeInvalid);
    // A nested router must not turn literal --local back into a write flag.
    await expect(runAgent('agent', cliArguments(['prompt', 'init', '--', '--local']), { client, json: true })).rejects.toThrow('role must be');
    expect(fs.existsSync(path.join(root, '.lush-agent'))).toBe(false);
    for (const [rootName, args] of [['agent', ['sources', 'list']], ['agent', ['configure', '--data', '{}']], ['config', ['show']]]) {
      await expect((rootName === 'agent' ? runAgent : runConfig)(rootName, args, { client, json: true })).rejects.toThrow();
    }
    await expect(execute('config', ['runtime', 'show'], { ...client, token: 'worker-token' })).rejects.toThrow('requires user');
    expect(calls).toHaveLength(beforeInvalid);
  } finally { await manager.stop(); fs.rmSync(root, { recursive: true, force: true }); }
});
