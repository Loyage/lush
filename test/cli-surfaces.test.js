import { test, expect } from 'bun:test';
import { CLI_COMMANDS, cliCommands, LUSHW_PATHS, SHARED_CLI_PATHS, LUSHW_METHODS } from '../src/cli/catalog.js';
import { PARAMS, AGENT_ONLY } from '../src/rpc/registry.js';
import { CONTEXT_PARAMETERS, CONTEXT_CAPABILITIES } from '../src/core/worker-context.js';
import { MANAGEMENT_CODE_METHODS } from '../src/rpc/management-code-methods.js';
import { managementPolicy } from '../src/rpc/management-policy.js';

test('relation CLI, registered context schema and actual Worker/Valet callable sets remain separate', () => {
  const leaves = CLI_COMMANDS.filter(entry => !entry.directory);
  for (const path of LUSHW_PATHS) expect(leaves.some(entry => entry.path === path)).toBe(true);
  expect([...SHARED_CLI_PATHS]).toEqual(['help']);
  expect([...LUSHW_METHODS].sort()).toEqual([...new Set(leaves.filter(entry => LUSHW_PATHS.has(entry.path)).flatMap(entry => entry.rpc))].sort());
  expect([...LUSHW_METHODS].sort()).toEqual(Object.keys(CONTEXT_PARAMETERS).sort());
  for (const method of LUSHW_METHODS) {
    expect(PARAMS[method]).toEqual(Object.keys(CONTEXT_CAPABILITIES[method].schema.properties));
    expect(AGENT_ONLY.has(method)).toBe(true);
    expect(MANAGEMENT_CODE_METHODS.has(method)).toBe(false);
    expect(managementPolicy(method).access).toBe('unavailable');
  }
  const worker = cliCommands('lushw').filter(entry => !entry.directory).map(entry => entry.path);
  for (const path of worker) expect(/^(self|parent|children|skills) |^notice (example|check)$|^help$/.test(path)).toBe(true);
  const management = cliCommands('lush').filter(entry => !entry.directory).map(entry => entry.path);
  expect(worker.filter(path => management.includes(path))).toEqual(['help']);
  for (const path of ['worker spawn','worker message','worker accept','worker inspect','worker list','worker tree','branch tree','status']) {
    expect(management).toContain(path); expect(worker).not.toContain(path);
  }
  for (const method of ['worker.spawn','worker.message','worker.accept','notice.post','worker.auto_title','progress.plan','progress.complete']) {
    expect(MANAGEMENT_CODE_METHODS.has(method)).toBe(true);
    expect(managementPolicy(method).access).toBe('automatic');
  }
  for (const method of ['worker.inspect','worker.history','worker.transcript','worker.lookup','worker.list','worker.tree'])
    expect(managementPolicy(method).access).toBe('read');
});
