import { test, expect } from 'bun:test';
import { Dispatcher } from '../src/rpc/dispatcher.js';
import { PARAMS } from '../src/rpc/registry.js';
import { run as order } from '../src/cli/commands/intent.js';
import { run as worker } from '../src/cli/commands/task.js';
import { managementFixture } from './runner-management-fixture.js';
import { repo } from './helpers.js';

const node = '11111111-1111-4111-8111-111111111111';
// Adapter-contract tests only: actual Project creation/freezing is integrated by W298-6.
function adapter() {
  const calls = [];
  const project = { actor: () => null, store: { task: () => ({ task_kind: 'order' }) },
    order(...args) { calls.push(['order', args]); return { adapter: true }; },
    spawn(...args) { calls.push(['spawn', args]); return { adapter: true }; },
    emitBufferedInput(...args) { calls.push(['emit', args]); return { adapter: true }; } };
  return { calls, rpc: new Dispatcher(project) };
}

test('placement registry/handlers preserve explicit UUID/local at ninth order and seventh spawn argument', async () => {
  const { calls, rpc } = adapter();
  expect(PARAMS['order.submit']).toContain('runner_node_id'); expect(PARAMS['worker.spawn']).toContain('runner_node_id');
  for (const value of [node, 'local']) {
    await rpc.dispatch('order.submit', { content: 'goal', start: false, runner_node_id: value });
    expect(calls.pop()).toEqual(['order', ['goal', null, [], null, false, undefined, undefined, false, value]]);
    await rpc.dispatch('worker.spawn', { parent: 7, goal: 'child', runner_node_id: value });
    expect(calls.pop()).toEqual(['spawn', [7, 'child', 'agent', [], null, undefined, value]]);
  }
  await rpc.dispatch('order.submit', { content: 'goal', start: false });
  expect(calls.pop()[1]).toHaveLength(8);
  await rpc.dispatch('worker.spawn', { parent: 7, goal: 'child' });
  expect(calls.pop()[1]).toHaveLength(5);
  for (const value of [null, '', ' LOCAL ', 'node-alias', 1, false, {}, []]) {
    await expect(rpc.dispatch('order.submit', { content: 'goal', start: false, runner_node_id: value })).rejects.toThrow('runner_node_id');
    await expect(rpc.dispatch('worker.spawn', { parent: 7, goal: 'child', runner_node_id: value })).rejects.toThrow('runner_node_id');
  }
  expect(calls).toEqual([]);
});

test('placement enters reliable emission but cannot override a saved draft or legacy deferred Hook', async () => {
  const { calls, rpc } = adapter();
  for (const params of [{ content: 'goal', defer: true }, { content: 'goal', start: false, defer: true },
    { draft_id: 1, expected_revision: 0 }, { draft_id: 1, expected_revision: 0, start: false }])
    await expect(rpc.dispatch('order.submit', { ...params, runner_node_id: node })).rejects.toThrow('cannot override');
  expect(calls).toEqual([]);
  for (const method of ['order.submit', 'input.emit']) {
    await rpc.dispatch(method, { content: 'goal', runner_node_id: node });
    expect(calls.pop()).toEqual(['emit', [{ content: 'goal', runner_node_id: node }]]);
  }
  await rpc.dispatch('order.submit', { content: 'goal' });
  expect(calls.pop()).toEqual(['emit', [{ content: 'goal' }]]);
});

test('order and spawn CLI preserve placement and reject unsupported combinations before lookup or submission', async () => {
  const calls = [], client = { token: null, request(method, params) { calls.push([method, params]); return { adapter: true }; } };
  for (const value of [node, 'local']) {
    await order('order', ['goal', '--runner-node', value], { client, json: true });
    expect(calls.pop()).toEqual(['order.submit', { content: 'goal', runner_node_id: value }]);
    await worker('worker', ['spawn', 'child', '--parent', '7', '--runner-node', value], { client, json: true });
    expect(calls.pop()).toEqual(['worker.spawn', { parent: 7, goal: 'child', runner_node_id: value }]);
  }
  for (const extra of [['--defer'], ['--append', 'W7'], ['--management'], ['--runner-node', node]])
    await expect(order('order', ['goal', '--runner-node', node, ...extra], { client, json: true })).rejects.toThrow();
  for (const value of ['', 'not-a-node', 'LOCAL']) {
    await expect(order('order', ['goal', '--runner-node', value], { client })).rejects.toThrow('runner_node_id');
    await expect(worker('worker', ['spawn', 'goal', '--parent', '7', '--runner-node', value], { client })).rejects.toThrow('runner_node_id');
  }
  expect(calls).toEqual([]);
});

test('actual CLI/RPC persist selected local node with default emission and conditional/buffered input', async () => {
  const f = await managementFixture(); f.project.stopping = true;
  try {
    await repo(f.root);
    for (const extra of [[], ['--quiet'], ['--exclusive'], ['--buffer']]) {
      const result = await f.cli(['order', 'goal', '--runner-node', 'local', ...extra]);
      expect(result.code).toBe(0); expect(result.err).toBe('');
      const returned = JSON.parse(result.out), draft = f.store.draft(returned.draft_id ?? returned.id);
      expect(JSON.parse(draft.input_options).runner_node_id).toBe('local');
      expect(returned.runner_node_id).toBe('local');
      expect(returned.task).toBeUndefined();
    }
    expect(f.store.all("SELECT id FROM tasks WHERE task_kind='order'")).toEqual([]);
    expect(f.connections()).toBe(0);
  } finally { await f.close(); }
});
