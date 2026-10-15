import { test, expect } from 'bun:test';
import { PARAMS, USER_ONLY, INTEGRATION_METHODS } from '../src/rpc/registry.js';
import { Dispatcher, HANDLERS } from '../src/rpc/dispatcher.js';
import { run as branch } from '../src/cli/commands/branch.js';
import { cliCatalog } from '../src/rpc/cli-catalog.js';
import { cliCommands } from '../src/cli/catalog.js';
import { RPCServer } from '../src/rpc/server.js';
import { createSignal } from '../src/signal.js';
import { fixture, env } from './helpers.js';

const revision = 'integration:opaque-v1';
const cases = [
  ['branch.integrate_plan', ['branch'], { branch: 'main' }, 'branchIntegratePlan', ['main']],
  ['branch.integrate_start', ['branch','expected_revision'], { branch: 'main', expected_revision: revision }, 'branchIntegrateStart', ['main',revision]],
  ['branch.integration', ['id'], { id: 9 }, 'branchIntegration', [9]],
  ['branch.integrate_cancel', ['id','expected_revision'], { id: 9, expected_revision: revision }, 'branchIntegrateCancel', [9,revision]],
  ['branch.integrate_retry', ['id','expected_revision'], { id: 9, expected_revision: revision }, 'branchIntegrateRetry', [9,revision]],
];
for (const [method, keys, params, target, expected] of cases) {
  test(`${method}: registered user-only forwarding, ordinary/management/integration agents denied`, async () => {
    expect(PARAMS[method]).toEqual(keys); expect(USER_ONLY.has(method)).toBe(true);
    expect(INTEGRATION_METHODS.has(method)).toBe(false); expect(typeof HANDLERS[method]).toBe('function');
    const calls = [], result = { version: 1, revision, target };
    const p = { actor: token => token ? 7 : null, [target](...args) { calls.push(args); return result; } };
    const dispatcher = new Dispatcher(p);
    expect(await dispatcher.dispatch(method, params)).toBe(result); expect(calls).toEqual([expected]);
    for (const task_kind of ['order','management','integration']) {
      p.store = { task: () => ({ task_kind }) };
      await expect(dispatcher.dispatch(method, { ...params, _token: 'valid-invocation' })).rejects.toThrow('requires user approval');
    }
    for (const key of ['force','ref','cwd','project','worker_id','profile','members','authorized','baseline']) {
      await expect(dispatcher.dispatch(method, { ...params, [key]: 'forged' })).rejects.toThrow('unknown parameter');
    }
    for (const invalid of [null, [], 'text', true]) await expect(dispatcher.dispatch(method, invalid)).rejects.toThrow('params must be an object');
    expect(calls).toHaveLength(1);
  });
}

test('integration RPC rejects invalid exact branches, integer IDs and revisions before runtime calls', async () => {
  let calls = 0;
  const p = { actor: () => null };
  for (const [, , , target] of cases) p[target] = () => { calls++; };
  const dispatcher = new Dispatcher(p);
  for (const branch of [undefined, null, 1, [], {}, '', ' padded ', 'a b', 'line\nbreak', 'main^', 'main~1', 'main:thing',
    'refs/heads/main', 'refs/tags/v1', 'a'.repeat(40), '../main', 'a..b', 'a//b', '.secret', 'a/.secret', 'a.lock', 'a/b.lock',
    'main@{1}', '/', '-option', '@', 'ends.', 'a/', 'x'.repeat(513)]) {
    for (const method of ['branch.integrate_plan','branch.integrate_start']) {
      await expect(dispatcher.dispatch(method, { branch, ...(method.endsWith('start') ? { expected_revision: revision } : {}) }))
        .rejects.toThrow('exact local branch');
    }
  }
  for (const id of [undefined, null, 0, -1, 1.1, '9', 'W9', true, [], {}, Number.MAX_SAFE_INTEGER + 1]) {
    for (const method of ['branch.integration','branch.integrate_cancel','branch.integrate_retry']) {
      await expect(dispatcher.dispatch(method, { id, ...(method === 'branch.integration' ? {} : { expected_revision: revision }) }))
        .rejects.toThrow('id must be a positive integer');
    }
  }
  for (const expected_revision of [undefined, null, 1, '', [], {}, ' padded ', 'bad\nrevision', 'x'.repeat(257)]) {
    for (const method of ['branch.integrate_start','branch.integrate_cancel','branch.integrate_retry']) {
      await expect(dispatcher.dispatch(method, { ...(method.endsWith('start') ? { branch: 'main' } : { id: 9 }), expected_revision }))
        .rejects.toThrow('expected_revision');
    }
  }
  expect(calls).toBe(0);
  for (const branch of ['main','feature/ui','lush/abc/5-worker','界面/修改']) await dispatcher.dispatch('branch.integrate_plan', { branch });
  expect(calls).toBe(4);
});

test('integration adapters preserve runtime failures without retry, fallback or revision replacement', async () => {
  for (const [method, , params, target] of cases) {
    let calls = 0;
    const dispatcher = new Dispatcher({ actor: () => null, [target]() { calls++; throw new Error('revision changed; unknown landing'); } });
    await expect(dispatcher.dispatch(method, params)).rejects.toThrow('revision changed; unknown landing');
    expect(calls).toBe(1);
  }
});

test('integration results retain complete member identities but recursively remove private columns', async () => {
  const value = { id: 9, state: 'resolving', member_count: 12, members_truncated: false,
    members: Array.from({ length: 12 }, (_, i) => ({ id: i + 20, worker_number: `W5-${i + 1}`, title: 'member',
      source_commit: 'a'.repeat(40), base_commit: 'b'.repeat(40), retry_profile: '{secret}', hooks: '{secret}' })),
    worker: { id: 7, worker_number: 'W5-13', status: 'running', management: '{secret}' } };
  const result = await new Dispatcher({ actor: () => null, branchIntegration: () => value }).dispatch('branch.integration', { id: 9 });
  expect(result.members).toHaveLength(12); expect(result.members_truncated).toBe(false);
  expect(result.members[11]).toEqual({ id: 31, worker_number: 'W5-12', title: 'member', source_commit: 'a'.repeat(40), base_commit: 'b'.repeat(40) });
  expect(result.worker).toEqual({ id: 7, worker_number: 'W5-13', status: 'running' });
  expect(value.members[0].retry_profile).toBe('{secret}');
});

const cli = (args, client) => branch('branch', ['integrate', ...args], { client, json: true });
function clientStub() {
  const calls = [], result = { id: 9, revision, state: 'resolving' };
  return { calls, result, async request(method, params) { calls.push({ method, params }); return result; } };
}
test('integration CLI forwards all user commands and returns results without implicit reads or retries', async () => {
  const c = clientStub();
  for (const args of [['plan','main'], ['start','main','--revision',revision], ['show','9'],
    ['cancel','9','--revision',revision], ['retry','9','--revision',revision]]) {
    expect(await cli(args, c)).toBe(c.result);
  }
  expect(c.calls).toEqual(cases.map(([method, , params]) => ({ method, params })));
  const failure = { calls: 0, async request() { this.calls++; throw new Error('unknown landing'); } };
  await expect(cli(['retry','9','--revision',revision], failure)).rejects.toThrow('unknown landing');
  expect(failure.calls).toBe(1);
});

test('integration CLI rejects missing, unknown and duplicate options and wrong identifier types locally', async () => {
  const c = clientStub();
  for (const args of [[], ['unknown'], ['plan'], ['plan','main','extra'], ['plan','main','--revision',revision],
    ['plan','main^'], ['plan','refs/heads/main'], ['start','main'], ['start','main','--revision'],
    ['start','main','--revision',revision,'--revision',revision], ['start','main','--revision',revision,'--force'],
    ['start','main','--revision',' padded '], ['start','main','--revision',''], ['start','main','--revision','bad\nrevision'],
    ['start','main','--revision','x'.repeat(257)], ['show','9','--revision',revision], ['show','W9'], ['show','0'],
    ['show','01'], ['show','1e2'], ['show','1.1'], ['show','9007199254740992'], ['cancel','9'], ['retry','9'],
    ['cancel','9','--revision',revision,'--revision',revision], ['retry','9','--revision',revision,'--branch','main'],
    ['retry','9','--revision',revision,'extra']]) {
    await expect(cli(args, c)).rejects.toThrow();
  }
  expect(c.calls).toEqual([]);
});

test('integration CLI catalogue and registry share methods, parameters and user-only audience', () => {
  const commands = cliCatalog().commands;
  for (const [index, verb] of ['plan','start','show','cancel','retry'].entries()) {
    const path = `branch integrate ${verb}`, [method, parameters] = cases[index];
    const entry = commands.find(item => item.path === `lush ${path}`);
    expect(entry.rpc).toHaveLength(1);
    expect(entry.rpc[0]).toMatchObject({ method, parameters, audience: 'user' });
    expect(cliCommands('lushc').some(item => item.path === path)).toBe(false);
  }
});

test('real user CLI binaries forward all integration verbs through the registered Unix RPC transport', async () => {
  const f = fixture(); f.project.kick = () => {};
  const calls = [], result = { id: 9, revision, state: 'resolving' };
  for (const [, , , name] of cases) f.project[name] = (...args) => { calls.push({ name, args }); return result; };
  const rpc = new RPCServer(f.config.socket, new Dispatcher(f.project, createSignal(), {}));
  const commands = [['plan','main'], ['start','main','--revision',revision], ['show','9'],
    ['cancel','9','--revision',revision], ['retry','9','--revision',revision]];
  try {
    await rpc.start();
    for (const args of commands) {
      const proc = Bun.spawn([process.execPath, `${import.meta.dir}/../bin/lush`, 'branch', 'integrate', ...args, '--json'], {
        cwd: f.root, env: env({ ...f.config.env, LUSH_PROJECT: f.root, LUSH_HOME: f.config.home }), stdout: 'pipe', stderr: 'pipe',
      });
      const [out, error, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      expect(code, error).toBe(0); expect(JSON.parse(out)).toEqual(result);
    }
    expect(calls).toEqual(cases.map(([, , , name, args]) => ({ name, args })));
  } finally { await rpc.close(); await f.close(); }
});

test('integration CLI rejects every Agent command, including read-only plan/show', async () => {
  const c = clientStub(); c.token = 'invocation-token';
  for (const args of [['plan','main'], ['start','main','--revision',revision], ['show','9'],
    ['cancel','9','--revision',revision], ['retry','9','--revision',revision]]) {
    await expect(cli(args, c)).rejects.toThrow('user only');
  }
  expect(c.calls).toEqual([]);
});
