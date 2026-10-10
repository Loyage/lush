import { test, expect } from 'bun:test';
import { Dispatcher, HANDLERS } from '../src/rpc/dispatcher.js';
import { check } from '../src/core/types.js';
import { run as worker } from '../src/cli/commands/task.js';
import { HELP } from '../src/cli/help.js';

const revision = 'completion-hooks:opaque-revision';
const levels = ['off','merge','accept','archive'];
const view = level => ({ version: 1, worker_id: 7, revision: 'next-revision',
  completion: { level, min_level: 'off', locked: false, editable: true, reason: null,
    phase: null, state: 'idle', last_execution: null }, mounts: [] });

for (const level of levels) {
  test(`worker.completion forwards ${level} once and returns the safe Hooks projection`, async () => {
    const calls = [], result = view(level);
    const project = { actor: () => null, setTaskCompletion(...args) { calls.push(args); return result; } };
    expect(await new Dispatcher(project).dispatch('worker.completion', { id: 7, level, expected_revision: revision })).toBe(result);
    expect(calls).toEqual([[7, level, revision]]);
  });

  test(`CLI worker completion ${level} uses the explicit Worker revision without extra reads`, async () => {
    const calls = [], result = view(level);
    const client = { request(method, params) { calls.push({ method, params }); return result; } };
    expect(await worker('worker', ['completion','7',level,'--revision',revision], { client, json: true })).toBe(result);
    expect(calls).toEqual([{ method: 'worker.completion', params: { id: 7, level, expected_revision: revision } }]);
  });
}

test('completion handler rejects invalid levels, Worker IDs and revisions before invoking runtime', () => {
  const calls = [], project = { setTaskCompletion(...args) { calls.push(args); } };
  const call = params => HANDLERS['worker.completion'](project, { id: 7, level: 'accept', expected_revision: revision, ...params });
  for (const level of [undefined, null, true, 0, [], {}, ['archive'], '', 'Accept', ' accept', 'archive ', 'accept\n', 'delete', 'shell']) {
    expect(() => call({ level })).toThrow('level must be off|merge|accept|archive');
  }
  for (const id of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, 'W1', 'other-project', null]) {
    expect(() => call({ id })).toThrow();
  }
  for (const expected_revision of [undefined, null, 0, [], {}, '', ' padded ', 'line\nbreak', 'x'.repeat(257)]) {
    expect(() => call({ expected_revision })).toThrow('expected_revision');
  }
  expect(calls).toEqual([]);
});

test('completion uses no privileged flags and never retries a stale runtime revision', async () => {
  const calls = [], project = { actor: token => token ? 12 : null,
    setTaskCompletion(...args) { calls.push(args); check(false, 'Worker Hooks changed; reload the latest revision'); } };
  const rpc = new Dispatcher(project), params = { id: 7, level: 'archive', expected_revision: revision };
  for (const extra of [{ force: true }, { discard_worktree: true }, { actor: null }, { inherit: true }, { profile: {} }]) {
    await expect(rpc.dispatch('worker.completion', { ...params, ...extra })).rejects.toThrow('unknown parameter');
  }
  await expect(rpc.dispatch('worker.completion', { ...params, _token: 'agent' })).rejects.toThrow('requires user approval');
  expect(calls).toEqual([]);
  await expect(rpc.dispatch('worker.completion', params)).rejects.toThrow('reload the latest revision');
  expect(calls).toEqual([[7, 'archive', revision]]);
});

test('completion result retains public stage state while isolating private Hook and retry JSON', async () => {
  const result = { ...view('archive'), hooks: '{"private":"definition"}', retry_profile: 'private-profile',
    last_result: { hooks: '{"private":"nested"}', retry_profile: 'nested-profile', state: 'waiting' } };
  const rpc = new Dispatcher({ actor: () => null, setTaskCompletion: () => result });
  const actual = await rpc.dispatch('worker.completion', { id: 7, level: 'archive', expected_revision: revision });
  expect(actual).toEqual({ ...view('archive'), last_result: { state: 'waiting' } });
  expect(result.hooks).toContain('private'); expect(result.retry_profile).toBe('private-profile');
});

test('CLI completion resolves a persistent W number exactly once before sending integer identity', async () => {
  const calls = [], client = { request(method, params) {
    calls.push({ method, params });
    return method === 'worker.lookup' ? { id: 700, worker_number: 'W5-2' } : view('archive');
  } };
  await worker('worker', ['completion','W5-2','archive','--revision',revision], { client, json: true });
  expect(calls).toEqual([
    { method: 'worker.lookup', params: { number: 'W5-2' } },
    { method: 'worker.completion', params: { id: 700, level: 'archive', expected_revision: revision } },
  ]);
});

test('CLI completion refuses malformed arguments and Agent invocations before any RPC or lookup', async () => {
  const calls = [], client = { request(...args) { calls.push(args); } };
  const invalid = [
    ['completion','W5-2','archive'], ['completion','W5-2','archive','--revision'],
    ['completion','W5-2','archive','--revision',''], ['completion','W5-2','archive','--revision',' bad '],
    ['completion','W5-2','archive','--revision','line\nbreak'], ['completion','W5-2','archive','--revision','x'.repeat(257)],
    ['completion','W5-2','archive','--revision',revision,'--revision',revision],
    ['completion','W5-2','archive','--revision',revision,'--force'],
    ['completion','W5-2','archive','extra','--revision',revision],
    ['completion','W5-2','--revision',revision], ['completion','W5-2','accept ','--revision',revision],
    ['completion','W5-2','shell','--revision',revision], ['completion','bad','archive','--revision',revision],
    ...['W01','W0','W5-0','w5','0','-1'].map(id => ['completion',id,'archive','--revision',revision]),
  ];
  for (const args of invalid) await expect(worker('worker', args, { client, json: true })).rejects.toThrow();
  client.token = 'agent';
  for (const level of levels) {
    await expect(worker('worker', ['completion','W5-2',level,'--revision',revision], { client })).rejects.toThrow('user only');
  }
  expect(calls).toEqual([]);
});

test('CLI completion propagates stale-revision failure without rereading or lowering the chosen level', async () => {
  const calls = [], client = { request(method, params) {
    calls.push({ method, params }); throw new Error('Worker Hooks changed; reload the latest revision');
  } };
  await expect(worker('worker', ['completion','7','archive','--revision',revision], { client, json: true })).rejects.toThrow('reload');
  expect(calls).toEqual([{ method: 'worker.completion', params: { id: 7, level: 'archive', expected_revision: revision } }]);
  expect(HELP).toContain('worker completion ID off|merge|accept --revision REV');
  expect(HELP).toContain('旧 archive 等价 accept'); expect(HELP).toContain('不调用评审 Agent');
});
