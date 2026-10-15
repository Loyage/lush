import { test, expect } from 'bun:test';
import { run as worker } from '../src/cli/commands/task.js';
import { run as config } from '../src/cli/commands/config.js';
import { run as agent } from '../src/cli/commands/agent.js';
import { run as branch } from '../src/cli/commands/branch.js';
import { CLI_COMMANDS, cliHelp } from '../src/cli/catalog.js';

const cases = [
  [worker, 'worker', ['delete-preview', 'W5', '--confirm', '--revision', 'REV']],
  [worker, 'worker', ['delete-preview', 'W5', '--revision', 'REV']],
  [worker, 'worker', ['delete', 'W5']],
  [worker, 'worker', ['delete', 'W5', '--confirm']],
  [worker, 'worker', ['merge', 'W5', 'merge']],
  [worker, 'worker', ['completion', 'W5', 'archive', '--revision', 'REV']],
  [config, 'config', ['migrate-preview', '--confirm', '--revision', 'REV']],
  [config, 'config', ['migrate-preview', '--revision', 'REV']],
  [config, 'config', ['migrate']],
  [config, 'config', ['migrate', '--confirm']],
  [config, 'config', ['show', '--confirm']],
  [agent, 'agent', ['sources', 'models', 'conn-one', '--refresh']],
  [agent, 'agent', ['sources', 'models-refresh', 'conn-one', '--refresh']],
  [agent, 'agent', ['set', 'default', '--prompt', 'legacy']],
  [agent, 'agent', ['set', 'default', '--append-prompt', 'new', '--prompt', 'legacy']],
  [branch, 'branch', ['convergence', 'on', 'main', '--revision', 'REV', '--command', '11111111-1111-4111-8111-111111111111']],
  [branch, 'branch', ['convergence', 'on', 'main', '--revision', 'REV', '--version', '1']],
];

test('mixed read/write flags and retired spellings are rejected before any RPC, lookup or file payload read', async () => {
  for (const [handler, command, args] of cases) {
    const calls = [], client = { async request(...args) { calls.push(args); throw Error('unexpected RPC'); } };
    await expect(handler(command, [...args], { client, json: true })).rejects.toThrow();
    expect(calls).toEqual([]);
  }
});

test('split reads and writes have separate single-purpose registrations and help', () => {
  const entries = new Map(CLI_COMMANDS.map(item => [item.path, item]));
  for (const [read, write, readRpc, writeRpc] of [
    ['agent sources models', 'agent sources models-refresh', 'agent.connections.models', 'agent.connections.models.refresh'],
    ['worker delete-preview', 'worker delete', 'worker.delete_preview', 'worker.delete'],
    ['config migrate-preview', 'config migrate', 'settings.migration.preview', 'settings.migration.apply'],
  ]) {
    expect(entries.get(read).operation).toBe('read'); expect(entries.get(write).operation).toBe('write');
    expect(entries.get(read).rpc).toContain(readRpc); expect(entries.get(read).rpc).not.toContain(writeRpc);
    expect(entries.get(write).rpc).toContain(writeRpc); expect(entries.get(write).rpc).not.toContain(readRpc);
    expect(cliHelp('lush')).toContain(read); expect(cliHelp('lush')).toContain(write);
  }
  for (const command of ['integrate', 'resolve-child-divergence', 'resolve-divergence', 'approve-merge', 'resolve', 'reserve', 'reserve-all', 'unreserve']) {
    expect(entries.has(`worker ${command}`)).toBe(false);
  }
  for (const command of ['hooks command save', 'hooks signal save', 'hooks management create']) expect(entries.has(command)).toBe(true);
});

test('migration preview has no implicit apply and confirmed apply has no implicit preview', async () => {
  const calls = [], client = { async request(method, params) { calls.push({ method, params }); return { revision: 'REV' }; } };
  await config('config', ['migrate-preview'], { client, json: true });
  await config('config', ['migrate', '--confirm', '--revision', 'REV'], { client, json: true });
  expect(calls).toEqual([
    { method: 'settings.migration.preview', params: undefined },
    { method: 'settings.migration.apply', params: { revision: 'REV', confirm: true } },
  ]);
});
