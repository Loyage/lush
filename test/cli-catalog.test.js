import { test, expect } from 'bun:test';
import { CLI_EXECUTABLES, cliCommands, cliHelp } from '../src/cli/catalog.js';
import { cliCatalog } from '../src/rpc/cli-catalog.js';
import { HANDLERS } from '../src/rpc/dispatcher.js';
import { PARAMS, USER_ONLY, AGENT_ONLY } from '../src/rpc/registry.js';
import { managementPolicy, managementAllowedAccess } from '../src/rpc/management-policy.js';

test('CLI registration/help/hierarchy and user-visible RPC parameter/permission projection share code-owned sources', () => {
  const commands = cliCatalog().commands;
  expect(new Set(commands.map(item => item.path)).size).toBe(commands.length);
  expect(commands.filter(item => !item.parent).map(item => item.path).sort()).toEqual(CLI_EXECUTABLES.flatMap(executable => cliCommands(executable)
    .filter(item => !item.parent).map(item => `${executable} ${item.path}`)).sort());
  for (const item of commands) {
    if (item.parent) expect(commands.find(parent => parent.path === item.parent)?.directory).toBe(true);
    expect(item.path).toBe(`${item.executable} ${item.command_path}`);
    if (!item.directory) expect(cliHelp(item.executable)).toContain(item.usage.slice(item.executable.length + 1));
    for (const rpc of item.rpc) {
      expect(typeof HANDLERS[rpc.method]).toBe('function'); expect(rpc.parameters).toEqual(PARAMS[rpc.method]);
      const policy = managementPolicy(rpc.method);
      expect(rpc.base_access).toBe(policy.access);
      expect(rpc.allowed_access).toEqual(managementAllowedAccess(policy.access, rpc.method));
      expect(rpc.audience).toBe(USER_ONLY.has(rpc.method) ? 'user' : AGENT_ONLY.has(rpc.method) ? 'agent' : 'user-and-agent');
    }
  }
});
