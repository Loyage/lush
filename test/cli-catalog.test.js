import { test, expect } from 'bun:test';
import { CLI_EXECUTABLES, cliCommands, cliHelp, managementCLICommandPolicy } from '../src/cli/catalog.js';
import { CLI_WORKFLOWS } from '../src/cli/discovery.js';
import { cliCatalog } from '../src/rpc/cli-catalog.js';
import { HANDLERS } from '../src/rpc/dispatcher.js';
import { PARAMS, USER_ONLY, AGENT_ONLY } from '../src/rpc/registry.js';
import { managementPolicy, managementAllowedAccess } from '../src/rpc/management-policy.js';
import { CLI_MIGRATIONS } from '../src/cli/migrations.js';

test('CLI registration/help/hierarchy and user-visible RPC parameter/permission projection share code-owned sources', () => {
  const catalogue = cliCatalog(), commands = catalogue.commands;
  expect(catalogue.catalog_version).toBeTruthy();
  for (const migration of CLI_MIGRATIONS) {
    expect(commands.some(item => !item.directory && item.command_path === migration.path)).toBe(false);
  }
  const management = cliCommands('lush').filter(item => !item.directory);
  const localExceptions = new Set(['help','doctor','daemon start','daemon stop','daemon restart','daemon log','host start','host stop','host restart','host status']);
  expect(management.filter(item => !managementCLICommandPolicy(item).available).map(item => item.path).sort())
    .toEqual([...localExceptions].filter(item => item !== 'help').sort());
  for (const item of management) {
    expect(item.parameters.options).not.toHaveProperty('--file');
    expect(Object.keys(item.parameters.options).some(flag => /-file$/.test(flag))).toBe(false);
    expect(item.rpc).not.toContain('worker.accept_force');
  }
  const allLeaves = CLI_EXECUTABLES.flatMap(executable => cliCommands(executable)).filter(item => !item.directory);
  for (const flow of CLI_WORKFLOWS) for (const steps of [flow.steps, flow.workerSteps, flow.valetSteps].filter(Boolean))
    for (const [id] of steps) expect(allLeaves.some(item => item.id === id)).toBe(true);
  expect(cliCommands('lushw').filter(item => !item.directory)).toHaveLength(24);
  expect(new Set(commands.map(item => item.path)).size).toBe(commands.length);
  expect(commands.filter(item => !item.parent).map(item => item.path).sort()).toEqual(CLI_EXECUTABLES.flatMap(executable => cliCommands(executable)
    .filter(item => !item.parent).map(item => `${executable} ${item.path}`)).sort());
  for (const item of commands) {
    if (item.parent) expect(commands.find(parent => parent.path === item.parent)?.directory).toBe(true);
    expect(item.path).toBe(`${item.executable} ${item.command_path}`);
    if (!item.directory) {
      expect(cliHelp(item.executable, item.command_path)).toContain(item.usage);
      expect(cliHelp(item.executable, item.command_path)).toContain('CLI 参数');
    }
    for (const rpc of item.rpc) {
      expect(typeof HANDLERS[rpc.method]).toBe('function'); expect(rpc.parameters).toEqual(PARAMS[rpc.method]);
      const policy = managementPolicy(rpc.method);
      expect(rpc.base_access).toBe(policy.access);
      expect(rpc.allowed_access).toEqual(managementAllowedAccess(policy.access, rpc.method));
      expect(rpc.audience).toBe(USER_ONLY.has(rpc.method) ? 'user' : AGENT_ONLY.has(rpc.method) ? 'agent' : 'user-and-agent');
    }
  }
});
