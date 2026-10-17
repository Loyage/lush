import { test, expect } from 'bun:test';
import { CLI_COMMANDS, LUSHW_PATHS, SHARED_CLI_PATHS, LUSHW_METHODS } from '../src/cli/catalog.js';
import { PARAMS } from '../src/rpc/registry.js';

test('development CLI capabilities derive from the single registered command catalogue', () => {
  const leaves = CLI_COMMANDS.filter(entry => !entry.directory);
  for (const path of LUSHW_PATHS) expect(leaves.some(entry => entry.path === path)).toBe(true);
  for (const path of SHARED_CLI_PATHS) expect(LUSHW_PATHS.has(path)).toBe(true);
  expect([...LUSHW_METHODS].sort()).toEqual([...new Set(leaves.filter(entry => LUSHW_PATHS.has(entry.path)).flatMap(entry => entry.rpc))].sort());
  for (const method of LUSHW_METHODS) expect(Object.hasOwn(PARAMS, method)).toBe(true);
  expect(LUSHW_METHODS.has('worker.spawn')).toBe(true);
  expect(LUSHW_METHODS.has('worker.accept')).toBe(true);
  for (const method of ['agent.configure', 'worker.delete', 'management.permissions_update', 'system.stop']) {
    expect(LUSHW_METHODS.has(method)).toBe(false);
  }
});
