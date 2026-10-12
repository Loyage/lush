import { test, expect } from 'bun:test';
import { Dispatcher, HANDLERS } from '../src/rpc/dispatcher.js';
import { PARAMS, USER_ONLY } from '../src/rpc/registry.js';
import { run as hooks } from '../src/cli/commands/hooks.js';
import { HELP } from '../src/cli/help.js';
import { UIClient } from '../src/ui/client.js';
import { RPCClient } from '../src/rpc/client.js';

const uuid = 'ee2f98f1-fc9a-46b1-a37c-67d8595c0649';
const params = { id: uuid, version: 2, worker_id: 7, expected_revision: 'revision' };
function fixture() {
  const calls = [], project = { actor: token => token ? 7 : null,
    runShortcutCommand() { calls.push('run'); }, startShortcutCommand() { calls.push('start'); },
    shortcutCommandHistory(...args) { calls.push(['history', ...args]); return { version: 1, items: [], has_more: false, next_before: null }; },
    removeShortcutCommandHistory(...args) { calls.push(['remove', ...args]); return { removed_count: 1 }; },
  };
  return { calls, project, dispatcher: new Dispatcher(project) };
}

test('manual run/start are absent from every RPC registration even if an old Project exposes them', async () => {
  const f = fixture();
  for (const method of ['hooks.command_run', 'hooks.command_start']) {
    expect(PARAMS[method]).toBeUndefined(); expect(HANDLERS[method]).toBeUndefined(); expect(USER_ONLY.has(method)).toBe(false);
    for (const value of [params, {}, { ...params, _token: 'agent' }])
      await expect(f.dispatcher.dispatch(method, value)).rejects.toThrow('unknown method');
  }
  expect(f.calls).toEqual([]);
});

test('history remains user-only, strictly validated and identity/pagination queries are read-only', async () => {
  const f = fixture();
  await expect(f.dispatcher.dispatch('hooks.command_history', { _token: 'agent' })).rejects.toThrow('requires user approval');
  await expect(f.dispatcher.dispatch('hooks.command_history', { force: true })).rejects.toThrow('unknown parameter');
  for (const value of [0, -1, '2', 1.5, Number.MAX_SAFE_INTEGER + 1, null])
    await expect(f.dispatcher.dispatch('hooks.command_history', { before: value })).rejects.toThrow();
  for (const value of [0, 101, '2', 1.5, null])
    await expect(f.dispatcher.dispatch('hooks.command_history', { limit: value })).rejects.toThrow();
  for (const value of ['', 'not-an-execution', 3, null])
    await expect(f.dispatcher.dispatch('hooks.command_history', { execution_id: value })).rejects.toThrow();
  await expect(f.dispatcher.dispatch('hooks.command_history', { execution_id: uuid, before: 3 })).rejects.toThrow('cannot be combined');
  expect(f.calls).toEqual([]);
  await f.dispatcher.dispatch('hooks.command_history', { before: 20, limit: 5 });
  await f.dispatcher.dispatch('hooks.command_history', { execution_id: uuid });
  expect(f.calls).toEqual([['history', { before: 20, limit: 5 }], ['history', { execution_id: uuid }]]);
});

test('history removal is user-only, mutually exclusive, validated and not retried', async () => {
  const f = fixture(), method = 'hooks.command_history_remove';
  for (const value of [{}, { execution_id: 'bad' }, { execution_id: null }, { clear: false }, { clear: 'true' }, { clear: null },
    { clear: true, execution_id: uuid }, { clear: true, before: 1 }])
    await expect(f.dispatcher.dispatch(method, value)).rejects.toThrow();
  await expect(f.dispatcher.dispatch(method, { clear: true, _token: 'agent' })).rejects.toThrow('requires user approval');
  expect(f.calls).toEqual([]);
  expect(await f.dispatcher.dispatch(method, { execution_id: uuid })).toEqual({ removed_count: 1 });
  expect(await f.dispatcher.dispatch(method, { clear: true })).toEqual({ removed_count: 1 });
  expect(f.calls).toEqual([['remove', { execution_id: uuid }], ['remove', { clear: true }]]);
  f.project.removeShortcutCommandHistory = () => { f.calls.push(['failed']); throw new Error('history uncertain'); };
  await expect(f.dispatcher.dispatch(method, { clear: true })).rejects.toThrow('history uncertain');
  expect(f.calls.filter(c => c[0] === 'failed')).toHaveLength(1);
});

test('CLI rejects manual verbs before lookup/RPC and keeps paged or identity history', async () => {
  const calls = [], client = { request(method, value) { calls.push([method, value]); return {}; } };
  const invoke = args => hooks('hooks', ['command', ...args], { client });
  for (const verb of ['run', 'start']) {
    for (const args of [[verb], [verb, uuid, '--version', '2', '--worker', 'W192', '--revision', 'revision']])
      await expect(invoke(args)).rejects.toThrow('hooks command requires');
    expect(HELP).not.toContain(`hooks command ${verb} `);
  }
  expect(calls).toEqual([]);
  await invoke(['history', '--before', '20', '--limit', '5']); await invoke(['history', '--execution', uuid]); await invoke(['history']);
  expect(calls).toEqual([['hooks.command_history', { before: 20, limit: 5 }], ['hooks.command_history', { execution_id: uuid }], ['hooks.command_history', {}]]);
  const count = calls.length;
  for (const args of [['history', '--before', '0'], ['history', '--limit', '101'], ['history', '--limit', '1e2'],
    ['history', '--before', '20', '--execution', uuid], ['history', '--execution', 'bad'], ['history', '--revision', 'revision']])
    await expect(invoke(args)).rejects.toThrow();
  expect(calls).toHaveLength(count); client.token = 'agent';
  await expect(invoke(['history'])).rejects.toThrow('user only');
});

test('UI client has no legacy execution transport or extended timeout', async () => {
  const original = RPCClient.prototype.request, calls = [];
  RPCClient.prototype.request = async function (method, value) { calls.push({ method, timeout: this.timeout, value }); return {}; };
  try {
    const client = new UIClient({ socket: '/unused' });
    await client.request('hooks.command_history'); await client.request('hooks.list');
    expect(calls.map(c => c.timeout)).toEqual([30, 30]); expect(client.commandRpc).toBeUndefined();
  } finally { RPCClient.prototype.request = original; }
});
