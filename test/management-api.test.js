import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PARAMS, USER_ONLY, AGENT_ONLY, MANAGER_METHODS, assertAllowed } from '../src/rpc/registry.js';
import { Dispatcher, HANDLERS } from '../src/rpc/dispatcher.js';
import { publicResult } from '../src/rpc/public-result.js';
import { run as hooks } from '../src/cli/commands/hooks.js';
import { HELP } from '../src/cli/help.js';

const revision = 'signal-config:a1';
const signal = { name: 'Codex 额度更新时间已到', schedule: { kind: 'daily', time: '00:05', timezone: 'Asia/Shanghai' } };
const creation = { name: '夜间开始', instruction: '开始 W17', signal_id: 'signal-id' };
const task = { id: 9, role: 'manager', task_kind: 'management', goal: creation.instruction,
  management: { version: 1, signal_id: creation.signal_id, enabled: true, mode: 'once', revision: 'binding:a1', state: 'waiting' } };
const cases = [
  ['hooks.signal_save', ['signal','expected_revision'], { signal, expected_revision: revision }, 'saveHookSignal', [signal, revision]],
  ['hooks.signal_remove', ['id','expected_revision'], { id: 'signal-id', expected_revision: revision }, 'removeHookSignal', ['signal-id', revision]],
  ['management.create', ['name','instruction','signal_id','mode','profile','client_request_id'], creation, 'createManagementWorker', [creation]],
  ['management.binding_update', ['id','enabled','expected_revision'], { id: 9, enabled: false, expected_revision: 'binding:a1' },
    'updateManagementBinding', [9, false, 'binding:a1']],
];
for (const [method, keys, params, target, args] of cases) {
  test(`${method} is a strictly user-only configuration with no immediate model action`, async () => {
    expect(PARAMS[method]).toEqual(keys); expect(USER_ONLY.has(method)).toBe(true);
    expect(assertAllowed(method, params, null)).toBeNull();
    expect(() => assertAllowed(method, params, 8)).toThrow('requires user approval');
    expect(() => assertAllowed(method, { ...params, project: '/another-project' }, null)).toThrow('unknown parameter');
    const calls = [], result = target === 'createManagementWorker' || target === 'updateManagementBinding' ? task : { version: 1, signals: { revision, items: [signal] } };
    const project = { actor: token => token ? 8 : null, [target](...actual) { calls.push(actual); return result; } };
    const d = new Dispatcher(project);
    expect(await d.dispatch(method, params)).toEqual(method === 'management.create' ? { task: result } : result);
    expect(calls).toEqual([args]);
    await expect(d.dispatch(method, { ...params, _token: 'development-token' })).rejects.toThrow('requires user approval');
    expect(calls).toHaveLength(1);
  });
}

test('management tools pass only validated actor/action/target; Project must enforce manager capability', async () => {
  const calls = [], result = { status: 'waiting', target_id: 17, target_worker_number: 'W17', receipt_id: 'receipt', reason: '目标尚在收尾' };
  const p = { actor: token => token ? 9 : null,
    managementQuery(...args) { calls.push(['query', ...args]); return { tasks: [] }; },
    requestManagementAction(...args) { calls.push(['action', ...args]); return result; } };
  const d = new Dispatcher(p);
  for (const method of ['manager.query','manager.start','manager.retry']) {
    expect(AGENT_ONLY.has(method)).toBe(true); expect(USER_ONLY.has(method)).toBe(false);
    expect(() => assertAllowed(method, { id: 17 }, null)).toThrow('agent only');
    expect(() => assertAllowed(method, { id: 17, profile: {} }, 9)).toThrow('unknown parameter');
    await expect(d.dispatch(method, { id: 17 })).rejects.toThrow('agent only');
    for (const id of [null, -1, 'W17', 0, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(d.dispatch(method, { id, _token: 'management-token' })).rejects.toThrow('positive integer');
    }
  }
  expect(calls).toEqual([]);
  expect(await d.dispatch('manager.query', { _token: 'management-token' })).toEqual({ tasks: [] });
  await d.dispatch('manager.query', { id: 17, _token: 'management-token' });
  expect(await d.dispatch('manager.start', { id: 17, _token: 'management-token' })).toEqual(result);
  expect(await d.dispatch('manager.retry', { id: 17, _token: 'management-token' })).toEqual(result);
  expect(calls).toEqual([['query',9,undefined], ['query',9,17], ['action',9,'start',17], ['action',9,'retry',17]]);
  p.actor = () => { throw new Error('invocation expired'); };
  await expect(d.dispatch('manager.start', { id: 17, _token: 'expired' })).rejects.toThrow('invocation expired');
  expect(calls).toHaveLength(4);
});

test('Dispatcher narrows every manager token to four methods without changing ordinary development Agents', async () => {
  expect([...MANAGER_METHODS]).toEqual(['manager.query','manager.start','manager.retry','worker.lookup']);
  const calls = [];
  let identity = { role: 'manager', task_kind: 'management' };
  const p = {
    actor: token => token ? 9 : null,
    store: { task: id => { expect(id).toBe(9); return identity; },
      lookupWorker: number => { calls.push(['lookup', number]); return { id: 17, worker_number: number }; } },
    managementQuery: actor => { calls.push(['query', actor]); return { tasks: [] }; },
    requestManagementAction: (...args) => { calls.push(['action', ...args]); return { status: 'succeeded' }; },
    reportProgressPlan: (...args) => { calls.push(['progress', ...args]); return { ok: true }; },
  };
  const d = new Dispatcher(p);
  for (const task of [{ role: 'manager', task_kind: 'management' }, { role: 'manager', task_kind: 'child' },
    { role: 'agent', task_kind: 'management' }]) {
    identity = task;
    for (const method of Object.keys(PARAMS).filter(method => !USER_ONLY.has(method) && !MANAGER_METHODS.has(method))) {
      await expect(d.dispatch(method, { _token: 'manager-token' })).rejects.toThrow('management agents can only');
    }
  }
  expect(calls).toEqual([]);
  identity = { role: 'manager', task_kind: 'management' };
  await d.dispatch('manager.query', { _token: 'manager-token' });
  await d.dispatch('manager.start', { id: 17, _token: 'manager-token' });
  await d.dispatch('manager.retry', { id: 17, _token: 'manager-token' });
  await d.dispatch('worker.lookup', { number: 'W17', _token: 'manager-token' });
  expect(calls).toEqual([['query',9], ['action',9,'start',17], ['action',9,'retry',17], ['lookup','W17']]);
  identity = { role: 'agent', task_kind: 'order' };
  expect(await d.dispatch('progress.plan', { steps: ['inspect'], _token: 'development-token' })).toEqual({ ok: true });
  expect(calls.at(-1)).toEqual(['progress',9,['inspect']]);
});

test('management user handlers reject malformed definition, mode, profile, binding and revision before runtime', async () => {
  const noCalls = new Proxy({}, { get() { return () => { throw new Error('runtime must not be called'); }; } });
  for (const bad of [null, [], 'signal']) expect(() => HANDLERS['hooks.signal_save'](noCalls,
    { signal: bad, expected_revision: revision })).toThrow('signal must be an object');
  for (const expected_revision of [undefined, null, '', ' padded ', 'x\ny', 'x'.repeat(257)]) {
    for (const method of ['hooks.signal_save','hooks.signal_remove','management.binding_update']) {
      expect(() => HANDLERS[method](noCalls, { signal, id: 'signal-id', enabled: false, expected_revision })).toThrow('expected_revision');
    }
  }
  for (const field of ['name','instruction','signal_id']) {
    for (const bad of [null, '', 7, []]) await expect(HANDLERS['management.create'](noCalls,
      { ...creation, [field]: bad })).rejects.toThrow();
  }
  for (const mode of [null, 'daily', 1, {}, []]) await expect(HANDLERS['management.create'](noCalls,
    { ...creation, mode })).rejects.toThrow('mode must be once|persistent');
  for (const profile of [null, [], 'source']) await expect(HANDLERS['management.create'](noCalls,
    { ...creation, profile })).rejects.toThrow('profile must be an object');
  for (const client_request_id of [null, '', ' padded ', 'a\nb', 7, [], 'x'.repeat(129)]) await expect(HANDLERS['management.create'](noCalls,
    { ...creation, client_request_id })).rejects.toThrow('invalid client_request_id');
  for (const enabled of [null, undefined, 'false', 0]) expect(() => HANDLERS['management.binding_update'](noCalls,
    { id: 9, enabled, expected_revision: revision })).toThrow('enabled must be a boolean');
});

test('management profiles and private JSON cannot escape any ordinary RPC envelope; safe binding objects remain', async () => {
  const privateRow = { ...task, management: JSON.stringify({ env: { SECRET: 'hidden' }, current: { receipts: [] } }), retry_profile: '{"env":{"SECRET":"hidden"}}' };
  for (const method of ['management.create','management.binding_update','worker.inspect','worker.list','hooks.list','manager.query']) {
    expect(publicResult({ task: privateRow, nested: [privateRow, task] }, method)).toEqual({
      task: { id: 9, role: 'manager', task_kind: 'management', goal: creation.instruction },
      nested: [{ id: 9, role: 'manager', task_kind: 'management', goal: creation.instruction }, task],
    });
  }
  expect(privateRow.management).toContain('hidden'); expect(task.management.enabled).toBe(true);
  const env = { management: 'legitimate-environment-value', retry_profile: 'legitimate-environment-value' };
  expect(publicResult({ values: env }, 'agent.environment')).toEqual({ values: env });
  expect(publicResult({ common: { env } }, 'agent.config')).toEqual({ common: { env } });
});

function client(token = null) { const calls = []; return { token, calls, request(method, params) { calls.push({ method, params }); return { ok: true }; } }; }
function file(value) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lush-management-api-')), filename = path.join(root, 'private.json');
  fs.writeFileSync(filename, JSON.stringify(value), { mode: 0o600 });
  return { filename, close() { fs.rmSync(root, { recursive: true, force: true }); } };
}
test('Hooks CLI saves signals and creates dormant management bindings from owner-only definitions', async () => {
  const s = file(signal), m = file({ ...creation, mode: 'persistent', profile: { agent: 'pi', config_mode: 'pi' } }), c = client();
  try {
    await hooks('hooks', ['signal','save','--file',s.filename,'--revision',revision], { client: c });
    await hooks('hooks', ['signal','remove','signal-id','--revision',revision], { client: c });
    await hooks('hooks', ['management','create','--file',m.filename], { client: c });
    for (const verb of ['enable','disable']) await hooks('hooks', ['management',verb,'9','--revision','binding:a1'], { client: c });
    expect(c.calls).toEqual([
      { method: 'hooks.signal_save', params: { signal, expected_revision: revision } },
      { method: 'hooks.signal_remove', params: { id: 'signal-id', expected_revision: revision } },
      { method: 'management.create', params: { ...creation, mode: 'persistent', profile: { agent: 'pi', config_mode: 'pi' } } },
      { method: 'management.binding_update', params: { id: 9, enabled: true, expected_revision: 'binding:a1' } },
      { method: 'management.binding_update', params: { id: 9, enabled: false, expected_revision: 'binding:a1' } },
    ]);
    expect(HELP).toContain('signals.revision'); expect(HELP).toContain('management.revision'); expect(HELP).toContain('到信号时才调用 Agent');
  } finally { s.close(); m.close(); }
});

test('idempotency identities pass through RPC and private CLI files unchanged on repeated submissions', async () => {
  const definition = { ...creation, client_request_id: 'dialog-identity-1', profile: { agent: 'pi', config_mode: 'pi' } };
  const received = [], project = { actor: () => null, createManagementWorker(options) { received.push(options); return task; } };
  const d = new Dispatcher(project);
  for (let n = 0; n < 2; n++) expect(await d.dispatch('management.create', definition)).toEqual({ task });
  expect(received).toEqual([definition, definition]);
  const f = file(definition), c = client();
  try {
    for (let n = 0; n < 2; n++) await hooks('hooks', ['management','create','--file',f.filename], { client: c });
    expect(c.calls).toEqual([0,1].map(() => ({ method: 'management.create', params: definition })));
  } finally { f.close(); }
});

test('Hooks management CLI refuses Agent configuration, unsafe files, extra fields and malformed verbs without sending RPC', async () => {
  const f = file(creation), c = client();
  try {
    const badArgs = [['signal'], ['signal','save','--file',f.filename], ['signal','remove','signal-id'], ['signal','emit','signal-id'],
      ['management'], ['management','start','9'], ['management','create'], ['management','create','--file',f.filename,'extra'],
      ['management','disable','W17','--revision',revision], ['management','enable','9']];
    for (const args of badArgs) await expect(hooks('hooks', [...args], { client: c })).rejects.toThrow();
    for (const args of [['signal','save','--file',f.filename,'--revision',revision], ['management','create','--file',f.filename],
      ['management','disable','9','--revision',revision]]) await expect(hooks('hooks', args, { client: client('agent-token') })).rejects.toThrow('user only');
    fs.chmodSync(f.filename, 0o644);
    await expect(hooks('hooks', ['management','create','--file',f.filename], { client: c })).rejects.toThrow('owner-only');
    fs.chmodSync(f.filename, 0o600); fs.writeFileSync(f.filename, JSON.stringify({ ...creation, _token: 'bypass' }));
    await expect(hooks('hooks', ['management','create','--file',f.filename], { client: c })).rejects.toThrow('unknown management parameter');
    expect(c.calls).toEqual([]);
  } finally { f.close(); }
});
