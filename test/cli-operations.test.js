import { test, expect } from 'bun:test';
import { CLI_OPERATIONS, CLI_COMMANDS, CLI_EXECUTABLES, cliCommands } from '../src/cli/catalog.js';
import { cliCatalog } from '../src/rpc/cli-catalog.js';

test('CLI read/write classification is separate from authorization and shared with the browser', () => {
  expect(CLI_OPERATIONS).toEqual(['read', 'write']);
  const projected = cliCatalog().commands;
  for (const executable of CLI_EXECUTABLES) {
    const commands = cliCommands(executable), leaves = commands.filter(item => !item.directory);
    for (const item of commands) {
      const expected = item.directory ? CLI_OPERATIONS.filter(operation => leaves.some(leaf => leaf.path.startsWith(`${item.path} `) && leaf.operation === operation)) : [item.operation];
      expect(item.operations).toEqual(expected);
      expect(item.directory ? item.operation === null : CLI_OPERATIONS.includes(item.operation)).toBe(true);
      const browser = projected.find(row => row.path === `${executable} ${item.path}`);
      expect(browser.operation).toBe(item.operation); expect(browser.operations).toEqual(expected);
    }
  }
  for (const path of ['help', 'worker inspect', 'skills get', 'branch integrate plan', 'branch integrate show']) expect(CLI_COMMANDS.find(row => row.path === path).operation).toBe('read');
  for (const path of ['worker auto-title', 'order', 'worker accept', 'daemon start', 'branch integrate start', 'branch integrate cancel', 'branch integrate retry']) expect(CLI_COMMANDS.find(row => row.path === path).operation).toBe('write');
});
