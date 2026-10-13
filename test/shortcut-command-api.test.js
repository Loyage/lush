import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Dispatcher } from '../src/rpc/dispatcher.js';
import { run as hooks } from '../src/cli/commands/hooks.js';
import { HELP } from '../src/cli/help.js';

const commandId = 'ee2f98f1-fc9a-46b1-a37c-67d8595c0649';
const revision = 'commands:revision';
const command = { name: 'safe fixture', command: 'printf fixture' };
function project() {
  const calls = [];
  const p = { actor: token => token ? 7 : null };
  for (const name of ['saveShortcutCommand','exportShortcutCommand','removeShortcutCommand','shortcutCommandHistory','importLegacyHookCommands'])
    p[name] = (...args) => { calls.push({ name, args }); return { ok: true }; };
  return { p, calls, dispatcher: new Dispatcher(p) };
}
function client() {
  const calls = [];
  return { calls, request(method, params) { calls.push({ method, params }); return method === 'worker.lookup' ? { id: 7, worker_number: 'W151-1' } : { ok: true }; } };
}
function file(value) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lush-shortcut-cli-'));
  const filename = path.join(root, 'definition.json');
  fs.writeFileSync(filename, JSON.stringify(value), { mode: 0o600 });
  return { root, filename, close: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('shortcut RPC retires authorization and rejects invalid export versions, IDs and nested authority before runtime', async () => {
  const f = project();
  await expect(f.dispatcher.dispatch('hooks.command_authorize', { id: commandId, version: 3, authorized: true, expected_revision: revision })).rejects.toThrow('unknown method');
  for (const version of [undefined, null, 0, -1, 1.5, '3', Number.MAX_SAFE_INTEGER + 1, [], {}])
    await expect(f.dispatcher.dispatch('hooks.command_export', { id: commandId, version })).rejects.toThrow('version');
  for (const id of [undefined, null, 7, '', 'bad', commandId + ' ', 'a\nb'])
    await expect(f.dispatcher.dispatch('hooks.command_remove', { id, expected_revision: revision })).rejects.toThrow('command id');
  for (const worker_id of [undefined, null, 0, -1, 'W151-1', 1.5, [], {}])
    await expect(f.dispatcher.dispatch('hooks.command_run', { id: commandId, version: 3, worker_id, expected_revision: revision })).rejects.toThrow();
  for (const value of [null, [], 'text', {}, { ...command, authorized: true }, { ...command, version: 1 },
    { ...command, cwd: '/tmp' }, { ...command, id: 'invalid' }, { ...command, command: '' },
    { ...command, command: 'echo\0bad' }, { ...command, command: 'x'.repeat(16001) }, { ...command, name: 'x'.repeat(121) }])
    await expect(f.dispatcher.dispatch('hooks.command_save', { command: value, expected_revision: revision })).rejects.toThrow();
  for (const source of [null, [], 'text', {}, { template_id: 't', worker_id: 7 }, { worker_id: 7 },
    { worker_id: 7, hook_id: 'h', force: true }, { template_id: 't', hook_id: 'h' },
    { worker_id: 'W151-1', hook_id: 'h' }, { template_id: '' }])
    await expect(f.dispatcher.dispatch('hooks.command_import', { source, expected_revision: revision })).rejects.toThrow();
  expect(f.calls).toEqual([]);
});

test('default Worker is optional, numeric or null, passed intact by RPC and private-file CLI', async () => {
  const f = project();
  for (const default_worker_id of [0, -1, '7', 'W211', 1.5, true, {}, Number.MAX_SAFE_INTEGER + 1])
    await expect(f.dispatcher.dispatch('hooks.command_save', { command: { ...command, default_worker_id }, expected_revision: revision })).rejects.toThrow('default_worker_id');
  expect(f.calls).toEqual([]);
  for (const default_worker_id of [7, null]) {
    const value = { ...command, default_worker_id }, c = client(), definition = file(value);
    try {
      await f.dispatcher.dispatch('hooks.command_save', { command: value, expected_revision: revision });
      expect(f.calls.at(-1)).toEqual({ name: 'saveShortcutCommand', args: [value, revision] });
      await hooks('hooks', ['command', 'save', '--file', definition.filename, '--revision', revision], { client: c });
      expect(c.calls).toEqual([{ method: 'hooks.command_save', params: { command: value, expected_revision: revision } }]);
    } finally { definition.close(); }
  }
});

test('shortcut RPC supports imports and revisioned saves, preserving safe result and stale failures', async () => {
  const f = project();
  await f.dispatcher.dispatch('hooks.command_import', { source: { template_id: 'old-template' }, expected_revision: revision });
  await f.dispatcher.dispatch('hooks.command_save', { command: { id: commandId, ...command }, expected_revision: revision });
  expect(f.calls).toEqual([
    { name: 'importLegacyHookCommands', args: [{ template_id: 'old-template' }, revision] },
    { name: 'saveShortcutCommand', args: [{ id: commandId, ...command }, revision] },
  ]);
  let attempts = 0;
  f.p.saveShortcutCommand = () => { attempts++; throw new Error('Command revision changed'); };
  await expect(f.dispatcher.dispatch('hooks.command_save', { command, expected_revision: 'stale' })).rejects.toThrow('revision changed');
  expect(attempts).toBe(1);
});

test('shortcut CLI forwards revisioned edits and resolves Worker numbers only at the CLI boundary', async () => {
  const c = client(), definition = file(command), source = file({ worker_id: 'W151-1', hook_id: 'legacy' });
  try {
    const invoke = args => hooks('hooks', ['command', ...args], { client: c });
    await invoke(['list']);
    await invoke(['save','--file',definition.filename,'--revision',revision]);
    for (const verb of ['authorize','revoke'])
      await expect(invoke([verb,commandId,'--version','3','--revision',revision])).rejects.toThrow('requires');
    await invoke(['remove',commandId,'--revision',revision]);
    await invoke(['import','--file',source.filename,'--revision','worker:revision']);
    expect(c.calls).toEqual([
      { method: 'hooks.list', params: undefined },
      { method: 'hooks.command_save', params: { command, expected_revision: revision } },
      { method: 'hooks.command_remove', params: { id: commandId, expected_revision: revision } },
      { method: 'worker.lookup', params: { number: 'W151-1' } },
      { method: 'hooks.command_import', params: { source: { worker_id: 7, hook_id: 'legacy' }, expected_revision: 'worker:revision' } },
    ]);
    expect(HELP).toContain('commands.revision');
    expect(HELP).not.toContain('hooks command run ');
    expect(HELP).not.toContain('hooks command authorize');
    expect(HELP).not.toContain('修改即撤权');
  } finally { definition.close(); source.close(); }
});

test('shortcut CLI rejects absent versions/revisions, extra options and unsafe private files without a call', async () => {
  const c = client(), f = file(command);
  const invoke = args => hooks('hooks', ['command', ...args], { client: c });
  try {
    for (const args of [['list','--revision',revision], ['save','--file',f.filename], ['save','--revision',revision],
      ['run',commandId,'--worker','7','--revision',revision], ['run',commandId,'--version','3','--revision',revision],
      ['authorize',commandId,'--version','3'], ['remove',commandId,'--revision',revision,'--force'],
      ['run',commandId,'--version','3','--worker','W01','--revision',revision]]) await expect(invoke(args)).rejects.toThrow();
    for (const version of ['0','-1','1.5','03','1e3','9007199254740992'])
      await expect(invoke(['export',commandId,'--version',version])).rejects.toThrow('version');
    fs.chmodSync(f.filename, 0o644);
    await expect(invoke(['save','--file',f.filename,'--revision',revision])).rejects.toThrow('private shortcut command');
    fs.chmodSync(f.filename, 0o600);
    const link = path.join(f.root, 'link'); fs.symlinkSync(f.filename, link);
    await expect(invoke(['save','--file',link,'--revision',revision])).rejects.toThrow('private shortcut command');
    for (const value of [{ ...command, authorized: true }, { template_id: 't', worker_id: 'W151-1', hook_id: 'h' }]) {
      fs.writeFileSync(f.filename, JSON.stringify(value));
      await expect(invoke([value.name ? 'save' : 'import','--file',f.filename,'--revision',revision])).rejects.toThrow();
    }
    expect(c.calls).toEqual([]);
    c.token = 'agent';
    for (const args of [['list'], ['run',commandId,'--version','3','--worker','7','--revision',revision], ['import','--file',f.filename,'--revision',revision]])
      await expect(invoke(args)).rejects.toThrow('user only');
    expect(c.calls).toEqual([]);
  } finally { f.close(); }
});
