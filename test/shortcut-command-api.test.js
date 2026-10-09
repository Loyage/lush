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
  for (const name of ['saveShortcutCommand','authorizeShortcutCommand','removeShortcutCommand','runShortcutCommand','importLegacyHookCommands'])
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

test('shortcut RPC rejects invalid versions, IDs and nested authority before any runtime call', async () => {
  const f = project();
  for (const version of [undefined, null, 0, -1, 1.5, '3', Number.MAX_SAFE_INTEGER + 1, [], {}]) {
    for (const method of ['hooks.command_authorize','hooks.command_run']) {
      const params = method.endsWith('run') ? { id: commandId, version, worker_id: 7, expected_revision: revision }
        : { id: commandId, version, authorized: true, expected_revision: revision };
      await expect(f.dispatcher.dispatch(method, params)).rejects.toThrow('version');
    }
  }
  for (const id of [undefined, null, 7, '', 'bad', commandId + ' ', 'a\nb'])
    await expect(f.dispatcher.dispatch('hooks.command_remove', { id, expected_revision: revision })).rejects.toThrow('command id');
  for (const authorized of [undefined, null, 0, 'true', [], {}])
    await expect(f.dispatcher.dispatch('hooks.command_authorize', { id: commandId, version: 3, authorized, expected_revision: revision })).rejects.toThrow('authorized');
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

test('shortcut RPC supports revoke and both import sources, preserving safe result and stale failures', async () => {
  const f = project();
  await f.dispatcher.dispatch('hooks.command_authorize', { id: commandId, version: 3, authorized: false, expected_revision: revision });
  await f.dispatcher.dispatch('hooks.command_import', { source: { template_id: 'old-template' }, expected_revision: revision });
  await f.dispatcher.dispatch('hooks.command_save', { command: { id: commandId, ...command }, expected_revision: revision });
  expect(f.calls).toEqual([
    { name: 'authorizeShortcutCommand', args: [commandId, 3, false, revision] },
    { name: 'importLegacyHookCommands', args: [{ template_id: 'old-template' }, revision] },
    { name: 'saveShortcutCommand', args: [{ id: commandId, ...command }, revision] },
  ]);
  const view = { execution_id: 'execution', command_result: { status: 'succeeded', exit_code: 0 }, commands: { revision, items: [{ id: commandId, ...command, version: 3, authorized: true }] } };
  f.p.runShortcutCommand = () => view;
  expect(await f.dispatcher.dispatch('hooks.command_run', { id: commandId, version: 3, worker_id: 7, expected_revision: revision })).toEqual(view);
  let attempts = 0;
  f.p.runShortcutCommand = () => { attempts++; throw new Error('Command revision changed'); };
  await expect(f.dispatcher.dispatch('hooks.command_run', { id: commandId, version: 3, worker_id: 7, expected_revision: 'stale' })).rejects.toThrow('revision changed');
  expect(attempts).toBe(1);
});

test('shortcut CLI forwards versioned authority and resolves Worker numbers only at the CLI boundary', async () => {
  const c = client(), definition = file(command), source = file({ worker_id: 'W151-1', hook_id: 'legacy' });
  try {
    const invoke = args => hooks('hooks', ['command', ...args], { client: c });
    await invoke(['list']);
    await invoke(['save','--file',definition.filename,'--revision',revision]);
    await invoke(['authorize',commandId,'--version','3','--revision',revision]);
    await invoke(['revoke',commandId,'--version','3','--revision',revision]);
    await invoke(['remove',commandId,'--revision',revision]);
    await invoke(['run',commandId,'--version','3','--worker','W151-1','--revision',revision]);
    await invoke(['import','--file',source.filename,'--revision','worker:revision']);
    expect(c.calls).toEqual([
      { method: 'hooks.list', params: undefined },
      { method: 'hooks.command_save', params: { command, expected_revision: revision } },
      { method: 'hooks.command_authorize', params: { id: commandId, version: 3, authorized: true, expected_revision: revision } },
      { method: 'hooks.command_authorize', params: { id: commandId, version: 3, authorized: false, expected_revision: revision } },
      { method: 'hooks.command_remove', params: { id: commandId, expected_revision: revision } },
      { method: 'worker.lookup', params: { number: 'W151-1' } },
      { method: 'hooks.command_run', params: { id: commandId, version: 3, worker_id: 7, expected_revision: revision } },
      { method: 'worker.lookup', params: { number: 'W151-1' } },
      { method: 'hooks.command_import', params: { source: { worker_id: 7, hook_id: 'legacy' }, expected_revision: 'worker:revision' } },
    ]);
    expect(HELP).toContain('commands.revision');
    expect(HELP).toContain('hooks command run ID --version N --worker ID --revision REV');
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
      await expect(invoke(['authorize',commandId,'--version',version,'--revision',revision])).rejects.toThrow('version');
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
