import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from 'bun:test';
import { CLI_COMMANDS, CLI_EXECUTABLES, cliCommands, cliHelp } from '../src/cli/catalog.js';
import { HELP } from '../src/cli/help.js';
import { cliCatalog } from '../src/rpc/cli-catalog.js';
import { HANDLERS } from '../src/rpc/dispatcher.js';
import { PARAMS, USER_ONLY, AGENT_ONLY, assertAllowed } from '../src/rpc/registry.js';
import { managementPolicy, managementAllowedAccess } from '../src/rpc/management-policy.js';
import { run as worker } from '../src/cli/commands/task.js';
import { run as hooks } from '../src/cli/commands/hooks.js';
import { run as agent } from '../src/cli/commands/agent.js';
import { run as config } from '../src/cli/commands/config.js';
import { run as notice } from '../src/cli/commands/notice.js';
import { run as branch } from '../src/cli/commands/branch.js';
import { run as progress } from '../src/cli/commands/progress.js';
import { run as order } from '../src/cli/commands/intent.js';
import { fixture } from './helpers.js';

const handlers = { worker, hooks, agent, config, notice, branch, progress, order };
const uuid = '11111111-1111-4111-8111-111111111111';
function tokens(command) {
  return [...command.matchAll(/'([^']*)'|([^\s]+)/g)].map(match => match[1] ?? match[2]);
}

test('CLI registration/help/hierarchy and user-visible RPC parameter/permission projection share code-owned sources', () => {
  const catalog = cliCatalog(), commands = catalog.commands;
  expect(new Set(commands.map(item => item.path)).size).toBe(commands.length);
  expect(commands.filter(item => !item.parent).map(item => item.path).sort()).toEqual(CLI_EXECUTABLES.flatMap(executable => cliCommands(executable)
    .filter(item => !item.parent).map(item => `${executable} ${item.path}`)).sort());
  for (const item of commands) {
    if (item.parent) expect(commands.find(parent => parent.path === item.parent)?.directory).toBe(true);
    else expect(item.command_path).not.toContain(' ');
    expect(item.path).toBe(`${item.executable} ${item.command_path}`);
    if (!item.directory) { expect(cliHelp(item.executable)).toContain(item.usage.slice(item.executable.length + 1)); expect(item.example.startsWith(item.path)).toBe(true); expect(item.risk.length).toBeGreaterThan(10); }
    for (const rpc of item.rpc) {
      expect(typeof HANDLERS[rpc.method]).toBe('function'); expect(rpc.parameters).toEqual(PARAMS[rpc.method]);
      const base = managementPolicy(rpc.method); expect(rpc.base_access).toBe(base.access); expect(rpc.reason).toBe(base.reason);
      expect(rpc.allowed_access).toEqual(managementAllowedAccess(base.access, rpc.method));
      expect(rpc.audience).toBe(USER_ONLY.has(rpc.method) ? 'user' : AGENT_ONLY.has(rpc.method) ? 'agent' : 'user-and-agent');
    }
  }
  for (const retired of ['task','say','intent','plan','candidate','config route','hooks command run','branch merge-all']) expect(commands.some(item => item.command_path === retired)).toBe(false);
  expect(PARAMS['cli.catalog']).toEqual([]); expect(typeof HANDLERS['cli.catalog']).toBe('function');
  expect(() => assertAllowed('cli.catalog', {}, null)).not.toThrow();
  expect(() => assertAllowed('cli.catalog', { q: 'x' }, null)).toThrow('unknown parameter');
  expect(() => assertAllowed('cli.catalog', {}, { id: 5 })).toThrow('user approval');
  expect(managementPolicy('cli.catalog').access).toBe('unavailable');
});

test('CLI learning follows Valet serial admission and actual stop/deletion settlement boundaries', () => {
  const commands = new Map(cliCatalog().commands.filter(item => item.executable === 'lush').map(item => [item.command_path, item]));
  for (const command of ['order', 'hooks management create']) {
    expect(commands.get(command).risk).toContain('当前项目');
    expect(commands.get(command).risk).toContain('未触发');
    expect(commands.get(command).risk).toContain('不占位');
  }
  expect(commands.get('hooks management disable').risk).toContain('不强杀模型');
  expect(commands.get('worker cancel').risk).toContain('不证明实际退出');
  expect(commands.get('worker delete').risk).toContain('unknown 副作用阻止删除');
  expect(commands.get('worker delete').risk).toContain('不删除其创建的开发 Worker 或时间信号');
  expect(HELP).toContain('cancelled 只表示停止已请求');
  expect(HELP).toContain('安全收口的 waiting 管家无需开发验收');
});

// Run every code-owned example for RPC-backed command handlers against a recording
// client. This checks real CLI parsing and emitted registry params, not just strings
// that happen to occur somewhere in legacy, unreachable implementation branches.
// Local process/TTY/filesystem commands are covered by their existing isolated tests.
test('all RPC-backed CLI examples reach real parser dispatch and emit only their declared registered calls', async () => {
  const f = fixture(); f.project.kick = () => {};
  const configuration = { version: 1, default: { agent: 'pi', config_mode: 'pi' }, roles: {}, resolved: { agent: { agent: 'pi', config_mode: 'pi' } } };
  const makeFile = (name, value) => { const file = path.join(f.root, name); fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 }); return file; };
  const files = {
    'hook.json': makeFile('hook.json', {}), 'template.json': makeFile('template.json', {}),
    'automation.json': makeFile('automation.json', { command: { name: 'fixture', command: 'true' },
      hook: { name: 'merge command', trigger: 'worker.merge_received', mode: 'persistent', enabled: true },
      expected_revisions: { commands: 'REV', worker_hooks: 'REV' }, client_request_id: 'catalog-install-example' }),
    'command.json': makeFile('command.json', { name: 'fixture', kind: 'shell', command: 'true' }),
    'source.json': makeFile('source.json', { template_id: uuid }), 'signal.json': makeFile('signal.json', {}),
    'valet.json': makeFile('valet.json', { name: 'fixture', instruction: '只读查询', signal_id: uuid }),
    'connection.json': makeFile('connection.json', { connection: { label: 'fixture' } }),
    'network.json': makeFile('network.json', { version: 1, mode: 'inherit', proxy_url: null, no_proxy: [], proxy_auth: null }),
  };
  const checked = [];
  try {
    for (const item of CLI_EXECUTABLES.flatMap(executable => cliCommands(executable)).filter(item => !item.directory && item.rpc.length && handlers[item.path.split(' ')[0]])) {
      const argv = tokens(item.example).slice(1), command = argv.shift(), calls = [];
      // No terminal waiting/watch loop: map these read-only local capabilities with
      // the existing worker-watch CLI suite instead of pretending a TTY is an RPC.
      if (item.path === 'worker watch') continue;
      const args = argv.map(value => files[value] ?? ({ COMMAND_ID: uuid, CONNECTION_ID: uuid, PACKAGE_ID: uuid, HOOK_ID: uuid, TEMPLATE_ID: uuid, SIGNAL_ID: uuid, COMMIT: 'a'.repeat(40), BASELINE: 'b'.repeat(40) }[value] ?? value));
      const client = { config: f.config, token: item.rpc.some(method => AGENT_ONLY.has(method)) ? 'fixture-identity' : null,
        async request(method, params = {}) {
          calls.push({ method, params }); assertAllowed(method, params, this.token ? { id: 5 } : null);
          expect(item.rpc).toContain(method);
          if (['system.settings','system.configure','system.status'].includes(method)) {
            const settings = { call_timeout: {}, task_call_limit: {}, max_depth: {}, input_routes: { value: [], default: [] } };
            return method === 'system.status' ? { settings } : settings;
          }
          if (method === 'worker.lookup') return { id: 5, worker_number: params.number };
          if (method === 'worker.inspect') return { id: 5, status: 'completed' };
          if (method === 'agent.config') return configuration;
          if (method === 'agent.network' || method === 'agent.network.configure') return { version: 1, mode: 'inherit', proxy_url: null, no_proxy: [], has_proxy_auth: false };
          if (method === 'agent.connections.list') return { connections: [{ id: uuid, label: 'fixture' }] };
          if (method.startsWith('agent.connections.models')) return { version: 1, id: uuid, status: 'cached', source: 'manual', models: [] };
          if (method === 'agent.connections.save' || method === 'agent.connections.device.start') return { id: uuid };
          if (method === 'agent.selection.resources') return { connections: [] };
          if (method === 'branch.convergence') return { branch: params.branch, revision: 'REV', enabled: false, mounted: true, validation: null };
          return {};
        } };
      await handlers[command](command, args, { client, json: true, executable: item.executable }); expect(calls.length).toBeGreaterThan(0); checked.push(item.path);
    }
    expect(checked.length).toBeGreaterThan(85);
  } finally { await f.close(); }
});
