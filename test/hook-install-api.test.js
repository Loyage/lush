import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { HOOK_INSTALL_SCHEMA, HOOK_INSTALL_CAPABILITY, validateHookInstallation } from '../src/core/hook-install.js';
import { PARAMS, USER_ONLY, assertAllowed } from '../src/rpc/registry.js';
import { Dispatcher } from '../src/rpc/dispatcher.js';
import { managementCatalog, managementPolicy, managementAllowedAccess } from '../src/rpc/management-policy.js';
import { cliCatalog } from '../src/rpc/cli-catalog.js';
import { LUSHC_METHODS } from '../src/cli/catalog.js';
import { run } from '../src/cli/commands/hooks.js';
import { fixture } from './helpers.js';

const definition = () => ({ id: 7, command: { name: 'restart', kind: 'shell', command: 'bun run restart' },
  hook: { name: 'after merge', trigger: 'worker.merge_received', mode: 'persistent', enabled: true },
  expected_revisions: { commands: 'commands:1', worker_hooks: 'hooks:1' }, client_request_id: 'install-api' });

test('install registration, CLI and manager discovery agree on schema and confirmation ceiling', () => {
  expect(PARAMS['hooks.install']).toEqual(Object.keys(HOOK_INSTALL_SCHEMA.properties));
  expect(USER_ONLY.has('hooks.install')).toBe(true);
  expect(LUSHC_METHODS.has('hooks.install')).toBe(false);
  expect(managementPolicy('hooks.install').access).toBe('confirmation');
  expect(managementAllowedAccess('confirmation', 'hooks.install')).toEqual(['confirmation', 'unavailable']);
  const manager = managementCatalog().methods.find(item => item.method === 'hooks.install');
  expect(manager).toMatchObject(HOOK_INSTALL_CAPABILITY);
  const cli = cliCatalog().commands.find(item => item.command_path === 'hooks install');
  expect(cli.executable).toBe('lush');
  expect(cli.rpc.find(item => item.method === 'hooks.install').schema).toEqual(manager.schema);
  expect(cli.rpc.map(item => item.method)).toEqual(['hooks.install', 'worker.lookup']);
  expect(() => assertAllowed('hooks.install', definition(), 9)).toThrow('requires user approval');
});

test('install handler returns only the installation receipt and refuses malformed definitions before runtime', async () => {
  const requests = [], result = { installed: true, worker_id: 7, command_id: 'command', hook_id: 'hook' };
  const rpc = new Dispatcher({ actor: () => null, installCommandHook(value) { requests.push(value); return result; } });
  expect(await rpc.dispatch('hooks.install', definition())).toEqual(result);
  expect(requests).toEqual([definition()]);
  const bad = [];
  for (const field of Object.keys(definition())) { const value = definition(); delete value[field]; bad.push(value); }
  for (const [field, values] of Object.entries({ id: [0, '7', 1.5], client_request_id: ['', ' padded ', 'x\ny', 'x'.repeat(129)],
    command: [null, [], { name: 'x', kind: 'prompt', prompt: 'secret' }, { name: 'x', command: 'true', cwd: '/' },
      { name: 'x', command: 'true', id: 'existing' }, { name: 'x', command: 'true', default_worker_id: 1 }],
    hook: [{ ...definition().hook, actions: [] }, { ...definition().hook, trigger: 'worker.parent_ready' },
      { ...definition().hook, mode: 'loop' }, { ...definition().hook, enabled: 'yes' },
      { ...definition().hook, conditions: { statuses: ['unknown'] } }],
    expected_revisions: [null, { commands: 'a' }, { commands: '', worker_hooks: 'a' },
      { commands: 'a', worker_hooks: 'a', extra: true }],
  })) for (const value of values) bad.push({ ...definition(), [field]: value });
  bad.push({ ...definition(), force: true });
  for (const value of bad) await expect(rpc.dispatch('hooks.install', value)).rejects.toThrow();
  expect(requests).toHaveLength(1);
  expect(validateHookInstallation({ ...definition(), hook: { ...definition().hook, mode: 'once', enabled: false } })).toBeTruthy();
});

test('install CLI resolves the target once, validates owner-only structured input and rejects agent/file/target bypasses', async () => {
  const f = fixture();
  const file = path.join(f.root, 'automation.json'), calls = [];
  const { id, ...config } = definition();
  fs.writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
  const client = { token: null, async request(method, params) {
    calls.push({ method, params }); return method === 'worker.lookup' ? { id, worker_number: 'W7' } : { installed: true };
  } };
  const invoke = (args, override = client) => run('hooks', [...args], { client: override });
  try {
    expect(await invoke(['install', 'W7', '--file', file])).toEqual({ installed: true });
    expect(calls).toEqual([{ method: 'worker.lookup', params: { number: 'W7' } }, { method: 'hooks.install', params: definition() }]);
    calls.length = 0;
    await expect(invoke(['install', '7', '--file', file], { ...client, token: 'agent' })).rejects.toThrow('user only');
    for (const args of [['install'], ['install', '7'], ['install', '7', '--file', file, '--revision', 'x'],
      ['install', '7', '--file', file, '--file', file]]) await expect(invoke(args)).rejects.toThrow();
    fs.chmodSync(file, 0o644);
    await expect(invoke(['install', '7', '--file', file])).rejects.toThrow('owner-only');
    fs.chmodSync(file, 0o600);
    fs.writeFileSync(file, JSON.stringify({ ...config, id: 99 }));
    await expect(invoke(['install', '7', '--file', file])).rejects.toThrow('CLI Worker argument');
    expect(calls).toEqual([]);
  } finally { await f.close(); }
});
