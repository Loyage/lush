import { test, expect } from 'bun:test';
import { PARAMS, USER_ONLY, assertAllowed } from '../src/rpc/registry.js';
import { Dispatcher, HANDLERS } from '../src/rpc/dispatcher.js';
import { run as branch } from '../src/cli/commands/branch.js';
import { HELP } from '../src/cli/help.js';

const revision = 'branch-main:opaque-v1', commandId = 'ee2f98f1-fc9a-46b1-a37c-67d8595c0649';
const validation = { command_id: commandId, command_version: 2 };
const cases = [
  ['branch.convergence', ['branch'], { branch: 'main' }, 'branchConvergence', ['main']],
  ['branch.convergence_list', [], {}, 'branchConvergenceList', []],
  ['branch.convergence_set', ['branch','enabled','validation','expected_revision','mounted'],
    { branch: 'main', enabled: true, validation, expected_revision: revision }, 'setBranchConvergence', ['main', true, { command_id: commandId }, revision, true]],
  ['branch.convergence_runs', ['branch','before','limit'], { branch: 'main', before: 15, limit: 3 }, 'branchConvergenceRuns', ['main', 15, 3]],
  ['branch.convergence_retry', ['id','expected_revision'], { id: 9, expected_revision: revision }, 'retryBranchConvergence', [9, revision]],
  ['branch.convergence_defaults', [], {}, 'branchConvergenceDefaults', []],
  ['branch.convergence_defaults_set', ['mounted','enabled','expected_revision','scope'], { mounted: true, enabled: true, expected_revision: revision }, 'setBranchConvergenceDefaults', [true, true, revision]],
];
for (const [method, keys, params, target, expected] of cases) {
  test(`${method}: exact user-only registry and forwarding`, async () => {
    expect(PARAMS[method]).toEqual(keys); expect(USER_ONLY.has(method)).toBe(true);
    expect(assertAllowed(method, params, null)).toBeNull();
    expect(() => assertAllowed(method, params, 7)).toThrow('requires user approval');
    const calls = [], result = { version: 1, revision, target };
    const project = { actor: token => token ? 7 : null, [target](...args) { calls.push(args); return result; } };
    const dispatcher = new Dispatcher(project);
    expect(await dispatcher.dispatch(method, params)).toBe(result); expect(calls).toEqual([expected]);
    await expect(dispatcher.dispatch(method, { ...params, _token: 'agent' })).rejects.toThrow('requires user approval');
    for (const key of ['force','ref','cwd','project','worker_id','profile']) {
      await expect(dispatcher.dispatch(method, { ...params, [key]: 'forged' })).rejects.toThrow('unknown parameter');
    }
    expect(calls).toHaveLength(1);
  });
}

test('convergence RPC validates exact branch names before runtime calls', async () => {
  const calls = [], p = { actor: () => null, branchConvergence(name) { calls.push(name); } };
  for (const branch of [undefined, null, 1, [], {}, '', ' padded ', 'a b', 'line\nbreak', 'main^', 'main~1', 'main:thing',
    'refs/heads/main', 'refs/tags/v1', 'a'.repeat(40), '../main', 'a..b', 'a//b', '.secret', 'a/.secret', 'a.lock', 'a/b.lock',
    'main@{1}', '/', '-option', '@', 'ends.', 'a/', 'x'.repeat(513)]) {
    await expect(new Dispatcher(p).dispatch('branch.convergence', { branch })).rejects.toThrow('exact local branch');
  }
  expect(calls).toEqual([]);
  for (const name of ['main', 'feature/ui', 'lush/abc/5-worker', '界面/修改']) {
    await new Dispatcher(p).dispatch('branch.convergence', { branch: name });
  }
  expect(calls).toEqual(['main', 'feature/ui', 'lush/abc/5-worker', '界面/修改']);
});

test('convergence setter rejects invalid flags, revisions and nested command fields without a runtime call', async () => {
  let writes = 0;
  const p = { actor: () => null, setBranchConvergence() { writes++; } }, dispatcher = new Dispatcher(p);
  const valid = cases[2][2];
  for (const enabled of [undefined, null, 'true', 'false', 1, [], {}]) {
    await expect(dispatcher.dispatch('branch.convergence_set', { ...valid, enabled })).rejects.toThrow('enabled must be a boolean');
  }
  for (const expected_revision of [undefined, null, 1, '', [], {}, ' padded ', 'bad\nrevision', 'x'.repeat(257)]) {
    await expect(dispatcher.dispatch('branch.convergence_set', { ...valid, expected_revision })).rejects.toThrow('expected_revision');
  }
  for (const value of [[], 'bun run test', 2, {}, { command_version: 2 },
    { ...validation, command: 'unsafe' }, { ...validation, authorized: true }, { ...validation, cwd: '/tmp' },
    { ...validation, command_id: 'test' }, { ...validation, command_id: 2 },
    ...[0,-1,1.1,'2',true,Number.MAX_SAFE_INTEGER + 1].map(command_version => ({ ...validation, command_version }))]) {
    await expect(dispatcher.dispatch('branch.convergence_set', { ...valid, validation: value })).rejects.toThrow();
  }
  for (const mounted of [null, 'true', 1, [], {}])
    await expect(dispatcher.dispatch('branch.convergence_set', { ...valid, mounted })).rejects.toThrow('mounted');
  await expect(dispatcher.dispatch('branch.convergence_set', { ...valid, mounted: false })).rejects.toThrow('must be mounted');
  expect(writes).toBe(0);
  await dispatcher.dispatch('branch.convergence_set', { ...valid, validation: null });
  await dispatcher.dispatch('branch.convergence_set', { branch: 'main', enabled: true, expected_revision: revision });
  await dispatcher.dispatch('branch.convergence_set', { ...valid, validation: { command_id: commandId } });
  expect(writes).toBe(3);
});

test('convergence history uses typed bounded cursors and runtime defaults', async () => {
  const calls = [], p = { actor: () => null, branchConvergenceRuns(...args) { calls.push(args); } };
  const dispatcher = new Dispatcher(p);
  await dispatcher.dispatch('branch.convergence_runs', { branch: 'main' });
  await dispatcher.dispatch('branch.convergence_runs', { branch: 'main', before: null, limit: 50 });
  expect(calls).toEqual([['main', null, 20], ['main', null, 50]]);
  for (const before of [0,-1,1.1,'2',true,Number.MAX_SAFE_INTEGER + 1]) {
    await expect(dispatcher.dispatch('branch.convergence_runs', { branch: 'main', before })).rejects.toThrow('before');
  }
  for (const limit of [null,0,-1,1.1,'2',true,51,Number.MAX_SAFE_INTEGER + 1]) {
    await expect(dispatcher.dispatch('branch.convergence_runs', { branch: 'main', limit })).rejects.toThrow('limit');
  }
  expect(calls).toHaveLength(2);
});

test('retry requires an integer run ID and explicit read revision, and runtime errors are not retried', async () => {
  let calls = 0;
  const dispatcher = new Dispatcher({ actor: () => null, retryBranchConvergence() { calls++; throw new Error('unknown landing: preserve receipt'); } });
  for (const id of [undefined, null, 0, -1, 1.1, '7', 'W7', true]) {
    await expect(dispatcher.dispatch('branch.convergence_retry', { id, expected_revision: revision })).rejects.toThrow('id');
  }
  await expect(dispatcher.dispatch('branch.convergence_retry', { id: 7 })).rejects.toThrow('expected_revision');
  expect(calls).toBe(0);
  await expect(dispatcher.dispatch('branch.convergence_retry', { id: 7, expected_revision: revision })).rejects.toThrow('unknown landing');
  expect(calls).toBe(1);
});

test('convergence protocol retains safe member data and applies the existing recursive private-column exit', async () => {
  const value = { items: [{ id: 7, members: [{ id: 8, worker_number: 'W5', title: 'member',
    retry_profile: '{secret}', auto_merge: '{secret}', hooks: '{secret}' }], integration_worker: { id: 9, management: '{secret}' } }],
  validation: { command_id: commandId, command_version: 2, name: 'checks', authorized: true } };
  const p = { actor: () => null, branchConvergenceRuns() { return value; } };
  const result = await new Dispatcher(p).dispatch('branch.convergence_runs', { branch: 'main' });
  expect(result.items[0].members).toEqual([{ id: 8, worker_number: 'W5', title: 'member' }]);
  expect(result.items[0].integration_worker).toEqual({ id: 9 }); expect(result.validation).toEqual(value.validation);
  expect(value.items[0].members[0].retry_profile).toBe('{secret}');
});

function clientStub(view = { branch: 'main', revision, validation: { ...validation, name: 'checks', authorized: false } }) {
  const calls = [];
  return { calls, async request(method, params) { calls.push({ method, params }); return method === 'branch.convergence' ? view : { ok: true }; } };
}
const cli = (args, client) => branch('branch', ['convergence', ...args], { client, json: true });

test('convergence CLI forwards list, show, on, history and retry without creating or authorizing commands', async () => {
  const c = clientStub();
  await cli(['list'], c); await cli(['show','main'], c);
  await cli(['on','main','--revision',revision], c);
  await cli(['runs','main'], c); await cli(['runs','main','--before','15','--limit','3'], c);
  await cli(['retry','9','--revision',revision], c);
  expect(c.calls).toEqual([
    { method: 'branch.convergence_list', params: undefined }, { method: 'branch.convergence', params: { branch: 'main' } },
    { method: 'branch.convergence_set', params: { branch: 'main', enabled: true, expected_revision: revision } }, { method: 'branch.convergence_runs', params: { branch: 'main' } },
    { method: 'branch.convergence_runs', params: cases[3][2] }, { method: 'branch.convergence_retry', params: cases[4][2] },
  ]);
  expect(HELP).toContain('branch convergence on BRANCH'); expect(HELP).toContain('挂载且关闭');
  expect(HELP).toContain('不接受旧 command/version 参数'); expect(HELP).toContain('整合 Agent');
});

test('CLI off preserves only the saved command reference and explicit revision, including an unavailable version', async () => {
  for (const current of [{ branch: 'main', revision, validation: { ...validation, name: 'old checks', authorized: false } },
    { branch: 'main', revision, validation: null }]) {
    const c = clientStub(current); await cli(['off','main','--revision',revision], c);
    expect(c.calls).toEqual([{ method: 'branch.convergence', params: { branch: 'main' } },
      { method: 'branch.convergence_set', params: { branch: 'main', enabled: false,
        validation: current.validation ? { command_id: commandId } : null, expected_revision: revision } }]);
  }
  const stale = clientStub({ branch: 'main', revision: 'new', validation });
  await expect(cli(['off','main','--revision',revision], stale)).rejects.toThrow('revision changed');
  expect(stale.calls).toEqual([{ method: 'branch.convergence', params: { branch: 'main' } }]);
});

test('CLI rejects missing/duplicate/foreign options, invalid revisions and numeric identifiers before requests', async () => {
  const c = clientStub(), on = ['on','main','--command',commandId,'--version','2','--revision',revision];
  for (const args of [[], ['unknown'], ['list','main'], ['list','--revision',revision], ['show'], ['show','--version'],
    ['show','main','--revision',revision], ['off','main'], ['off','main','--revision',revision,'--command',commandId],
    ['off','main','--revision',revision,'--version','2'], [...on,'--revision',revision], [...on,'--command',commandId],
    [...on,'--version','2'], ['on','main','--version','2','--revision',revision], ['on','main','--command','test','--version','2','--revision',revision],
    ['runs','main','--before','0'], ['runs','main','--limit','51'], ['runs','main','--limit','2','--limit','3'],
    ['runs','main','--before','1e2'], ['retry','W9','--revision',revision], ['retry','1.1','--revision',revision],
    ['retry','9','--revision',' padded '], ['retry','9','--revision',''], ['retry','9','--revision',revision,'--limit','2'],
    ['show','main^'], ['show','refs/heads/main']]) {
    await expect(cli(args, c)).rejects.toThrow();
  }
  expect(c.calls).toEqual([]);
});

test('all convergence CLI verbs reject Agent clients locally, including reads', async () => {
  const c = clientStub(); c.token = 'invocation-token';
  for (const args of [['list'], ['show','main'], ['on','main','--command',commandId,'--version','2','--revision',revision],
    ['off','main','--revision',revision], ['mount','main','--revision',revision], ['remove','main','--revision',revision],
    ['defaults','show'], ['defaults','set','--mounted','true','--enabled','true','--revision',revision], ['runs','main'], ['retry','9','--revision',revision]]) {
    await expect(cli(args, c)).rejects.toThrow('user only');
  }
  expect(c.calls).toEqual([]);
});
