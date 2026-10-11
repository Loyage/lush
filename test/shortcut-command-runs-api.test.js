import { test, expect } from 'bun:test';
import { Dispatcher } from '../src/rpc/dispatcher.js';
import { run as hooks } from '../src/cli/commands/hooks.js';
import { UIClient } from '../src/ui/client.js';
import { RPCClient } from '../src/rpc/client.js';

const uuid = 'ee2f98f1-fc9a-46b1-a37c-67d8595c0649';
const params = { id: uuid, version: 2, worker_id: 7, expected_revision: 'revision' };
function fixture() {
  const calls = [], project = { actor: token => token ? 7 : null,
    startShortcutCommand(...args) { calls.push(['start', ...args]); return { execution_id: uuid, execution: { id: uuid, status: 'pending' } }; },
    shortcutCommandHistory(...args) { calls.push(['history', ...args]); return { version: 1, items: [], has_more: false, next_before: null }; },
    removeShortcutCommandHistory(...args) { calls.push(['remove', ...args]); return { removed_count: 1 }; },
  };
  return { calls, project, dispatcher: new Dispatcher(project) };
}

test('async start and history are user-only, strictly validated and never retried by dispatcher', async () => {
  const f = fixture();
  for (const [method, value] of [['hooks.command_start', params], ['hooks.command_history', {}]]) {
    await expect(f.dispatcher.dispatch(method, { ...value, _token: 'agent' })).rejects.toThrow('requires user approval');
    await expect(f.dispatcher.dispatch(method, { ...value, force: true })).rejects.toThrow('unknown parameter');
  }
  for (const value of [0, -1, '2', 1.5, Number.MAX_SAFE_INTEGER + 1, null])
    await expect(f.dispatcher.dispatch('hooks.command_history', { before: value })).rejects.toThrow();
  for (const value of [0, 101, '2', 1.5, null])
    await expect(f.dispatcher.dispatch('hooks.command_history', { limit: value })).rejects.toThrow();
  for (const value of ['', 'not-an-execution', 3, null])
    await expect(f.dispatcher.dispatch('hooks.command_history', { execution_id: value })).rejects.toThrow();
  await expect(f.dispatcher.dispatch('hooks.command_history', { execution_id: uuid, before: 3 })).rejects.toThrow('cannot be combined');
  for (const value of [0, 'W192', null])
    await expect(f.dispatcher.dispatch('hooks.command_start', { ...params, worker_id: value })).rejects.toThrow();
  await expect(f.dispatcher.dispatch('hooks.command_start', { ...params, expected_revision: '' })).rejects.toThrow();
  expect(f.calls).toEqual([]);
  expect(await f.dispatcher.dispatch('hooks.command_start', params)).toMatchObject({ execution_id: uuid, execution: { status: 'pending' } });
  await f.dispatcher.dispatch('hooks.command_history', { before: 20, limit: 5 });
  await f.dispatcher.dispatch('hooks.command_history', { execution_id: uuid });
  expect(f.calls).toEqual([['start', uuid, 2, 7, 'revision'], ['history', { before: 20, limit: 5 }], ['history', { execution_id: uuid }]]);
  f.project.startShortcutCommand = () => { f.calls.push(['failed']); throw new Error('revision changed'); };
  await expect(f.dispatcher.dispatch('hooks.command_start', params)).rejects.toThrow('revision changed');
  expect(f.calls.filter(c => c[0] === 'failed')).toHaveLength(1);
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

test('CLI async start and paged or identity history preserve fixed identities and reject invalid options', async () => {
  const calls = [], client = { request(method, value) { calls.push([method, value]); return method === 'worker.lookup' ? { id: 7, worker_number: 'W192' } : {}; } };
  const invoke = args => hooks('hooks', ['command', ...args], { client });
  await invoke(['start', uuid, '--version', '2', '--worker', 'W192', '--revision', 'revision']);
  await invoke(['history', '--before', '20', '--limit', '5']);
  await invoke(['history', '--execution', uuid]);
  await invoke(['history']);
  expect(calls).toEqual([['worker.lookup', { number: 'W192' }], ['hooks.command_start', params],
    ['hooks.command_history', { before: 20, limit: 5 }], ['hooks.command_history', { execution_id: uuid }], ['hooks.command_history', {}]]);
  const count = calls.length;
  for (const args of [['history', '--before', '0'], ['history', '--limit', '101'], ['history', '--limit', '1e2'],
    ['history', '--before', '20', '--execution', uuid], ['history', '--execution', 'bad'], ['history', '--revision', 'revision'],
    ['start', uuid, '--version', '2', '--revision', 'revision']]) await expect(invoke(args)).rejects.toThrow();
  expect(calls).toHaveLength(count);
  client.token = 'agent';
  await expect(invoke(['history'])).rejects.toThrow('user only');
});

test('legacy synchronous Shell waits beyond its 60s budget without increasing other UI RPC timeouts', async () => {
  const original = RPCClient.prototype.request, calls = [];
  RPCClient.prototype.request = async function (method, value) { calls.push({ method, timeout: this.timeout, value }); return {}; };
  try {
    const client = new UIClient({ socket: '/unused' });
    await client.request('hooks.command_run', params);
    await client.request('hooks.command_start', params);
    await client.request('hooks.command_history');
    expect(calls.map(c => c.timeout)).toEqual([75, 30, 30]);
    expect(calls[0].value).toEqual(params);
  } finally { RPCClient.prototype.request = original; }
});
