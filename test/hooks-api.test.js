import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PARAMS, USER_ONLY, assertAllowed } from '../src/rpc/registry.js';
import { HANDLERS, Dispatcher } from '../src/rpc/dispatcher.js';
import { run as hooks } from '../src/cli/commands/hooks.js';
import { run as worker } from '../src/cli/commands/task.js';
import { run as order } from '../src/cli/commands/intent.js';
import { HELP } from '../src/cli/help.js';

const definition = { name: '结束后提醒', trigger: 'agent.returned', mode: 'once', enabled: true,
  actions: [{ type: 'notify', title: '结束', body: '检查结果' }] };
const revision = 'opaque-revision:a1';
const cases = [
  ['hooks.list', [], {}, 'hooksList', []],
  ['hooks.auto_select', ['enabled','expected_revision'], { enabled: true, expected_revision: revision }, 'setDaemonAutoSelect', [true, revision]],
  ['hooks.completion_defaults', ['enabled','level','expected_revision'], { enabled: true, level: 'archive', expected_revision: revision }, 'setCompletionDefaults', [true, 'archive', revision]],
  ['hooks.save', ['template','expected_revision'], { template: definition, expected_revision: revision }, 'saveHookTemplate', [definition, revision]],
  ['hooks.remove', ['id','expected_revision'], { id: 'template-1', expected_revision: revision }, 'removeHookTemplate', ['template-1', revision]],
  ['worker.hooks', ['id'], { id: 7 }, 'taskHooks', [7]],
  ['worker.completion', ['id','level','expected_revision'], { id: 7, level: 'archive', expected_revision: revision }, 'setTaskCompletion', [7, 'archive', revision]],
  ['worker.hook_attach', ['id','hook','expected_revision'], { id: 7, hook: definition, expected_revision: revision }, 'attachTaskHook', [7, definition, revision]],
  ['worker.hook_update', ['id','hook_id','enabled','hook','expected_revision'], { id: 7, hook_id: 'hook-1', enabled: false, expected_revision: revision }, 'updateTaskHook', [7, 'hook-1', false, revision]],
  ['worker.hook_remove', ['id','hook_id','expected_revision'], { id: 7, hook_id: 'hook-1', expected_revision: revision }, 'removeTaskHook', [7, 'hook-1', revision]],
];

for (const [method, keys, params, target, args] of cases) {
  test(`${method}: user-only whitelist, exact arguments and result`, async () => {
    expect(PARAMS[method]).toEqual(keys);
    expect(USER_ONLY.has(method)).toBe(true);
    expect(assertAllowed(method, params, null)).toBeNull();
    expect(() => assertAllowed(method, params, 8)).toThrow('requires user approval');
    expect(() => assertAllowed(method, { ...params, force: true }, null)).toThrow('unknown parameter');
    const calls = [], result = { version: 1, revision, result: target };
    const project = { actor: token => token ? 8 : null, [target](...actual) { calls.push(actual); return result; } };
    const dispatcher = new Dispatcher(project);
    expect(await dispatcher.dispatch(method, params)).toBe(result);
    expect(calls).toEqual([args]);
    await expect(dispatcher.dispatch(method, { ...params, _token: 'agent' })).rejects.toThrow('requires user approval');
    expect(calls).toHaveLength(1);
  });
}

test('Hook mutations require explicit opaque read revisions even before runtime validation', async () => {
  for (const [method, , params, target] of cases.filter(entry => entry[1].includes('expected_revision'))) {
    let called = false;
    const project = { [target]() { called = true; } };
    for (const invalid of [undefined, null, 1, '', [], {}, ' padded ', 'line\nbreak', 'x'.repeat(257)]) {
      await expect(Promise.resolve().then(() => HANDLERS[method](project, { ...params, expected_revision: invalid }))).rejects.toThrow('expected_revision');
    }
    expect(called).toBe(false);
  }
});

test('Hook handler rejects non-object definitions, invalid IDs and non-boolean enable', async () => {
  const noCalls = new Proxy({}, { get() { return () => { throw new Error('runtime must not be called'); }; } });
  for (const value of [null, [], 'definition']) {
    expect(() => HANDLERS['hooks.save'](noCalls, { template: value, expected_revision: revision })).toThrow('template must be an object');
    expect(() => HANDLERS['worker.hook_attach'](noCalls, { id: 7, hook: value, expected_revision: revision })).toThrow('hook must be an object');
  }
  for (const enabled of [undefined, 'false', 0, null, [], {}]) {
    expect(() => HANDLERS['worker.hook_update'](noCalls,
      { id: 7, hook_id: 'hook-1', enabled, expected_revision: revision })).toThrow('enabled must be a boolean');
    expect(() => HANDLERS['hooks.auto_select'](noCalls,
      { enabled, expected_revision: revision })).toThrow('enabled must be a boolean');
    expect(() => HANDLERS['hooks.completion_defaults'](noCalls,
      { enabled, level: 'merge', expected_revision: revision })).toThrow('enabled must be a boolean');
  }
  for (const level of [undefined, null, 'off', 'auto', 1, [], {}]) {
    expect(() => HANDLERS['hooks.completion_defaults'](noCalls,
      { enabled: true, level, expected_revision: revision })).toThrow('level must be merge|accept|archive');
  }
  for (const value of [0, -1, 'other-project', Number.MAX_SAFE_INTEGER + 1]) {
    expect(() => HANDLERS['worker.hooks'](noCalls, { id: value })).toThrow();
  }
  for (const value of ['', 7, ' bad ', 'a\nb']) expect(() => HANDLERS['hooks.remove'](noCalls,
    { id: value, expected_revision: revision })).toThrow('invalid Hook id');
});

test('full command Hook editing is user-only, revisioned and exclusive with enable', async () => {
  const command = { name: 'main push', trigger: 'worker.merge_received', mode: 'persistent', enabled: false,
    actions: [{ type: 'command', command: 'git push' }] };
  const calls = [], view = { version: 1, worker_id: 7, revision: 'next', mounts: [] };
  const project = { actor: token => token ? 8 : null, updateTaskHook(...args) { calls.push(args); return view; } };
  const dispatcher = new Dispatcher(project), params = { id: 7, hook_id: 'hook-1', hook: command, expected_revision: revision };
  expect(await dispatcher.dispatch('worker.hook_update', params)).toBe(view);
  expect(calls).toEqual([[7, 'hook-1', undefined, revision, command]]);
  await expect(dispatcher.dispatch('worker.hook_update', { ...params, _token: 'agent' })).rejects.toThrow('requires user approval');
  for (const enabled of [true, false, null, 'false']) {
    await expect(dispatcher.dispatch('worker.hook_update', { ...params, enabled })).rejects.toThrow('mutually exclusive');
  }
  for (const hook of [null, [], 'git push', 7]) {
    await expect(dispatcher.dispatch('worker.hook_update', { ...params, hook })).rejects.toThrow('hook must be an object');
  }
  await expect(dispatcher.dispatch('worker.hook_update', { ...params, expected_revision: '' })).rejects.toThrow('expected_revision');
  expect(calls).toHaveLength(1);
});

test('template reference mounting is forwarded intact for private server-side copying', async () => {
  const reference = { template_id: '931d1b67-11b1-4b39-b4be-6d07611f697e' };
  const calls = [], view = { version: 1, worker_id: 7, revision: 'new-revision', mounts: [] };
  const project = { actor: () => null, attachTaskHook(...args) { calls.push(args); return view; } };
  const params = { id: 7, hook: reference, expected_revision: revision };
  expect(await new Dispatcher(project).dispatch('worker.hook_attach', params)).toBe(view);
  expect(calls).toEqual([[7, reference, revision]]);
  const f = privateFile(reference), c = client();
  try {
    await worker('worker', ['hook','attach','7','--file',f.file,'--revision',revision], { client: c, json: true });
    expect(c.calls).toEqual([{ method: 'worker.hook_attach', params }]);
  } finally { f.close(); }
});

test('scheduled definitions pass through existing user-only RPC and owner-only CLI without an alternate scheduler', async () => {
  const rule = { name: 'daily Codex job', trigger: 'time.scheduled', mode: 'persistent', enabled: true,
    schedule: { kind: 'daily', time: '00:05', timezone: 'Asia/Shanghai' },
    actions: [{ type: 'retry_worker', target_id: 7, profile: { agent: 'pi', connection_id: 'chosen-codex', model: 'test/codex' } }] };
  const calls = [], view = { version: 1, worker_id: 7, can_attach: true, revision: 'next', mounts: [] };
  const project = { actor: token => token ? 8 : null,
    attachTaskHook(...args) { calls.push(args); return view; }, saveHookTemplate(...args) { calls.push(args); return view; } };
  const dispatcher = new Dispatcher(project);
  const params = { id: 7, hook: rule, expected_revision: revision };
  expect(await dispatcher.dispatch('worker.hook_attach', params)).toBe(view);
  expect(await dispatcher.dispatch('hooks.save', { template: rule, expected_revision: revision })).toBe(view);
  expect(calls).toEqual([[7, rule, revision], [rule, revision]]);
  await expect(dispatcher.dispatch('worker.hook_attach', { ...params, _token: 'agent' })).rejects.toThrow('requires user approval');
  expect(calls).toHaveLength(2);
  const f = privateFile(rule), c = client();
  try {
    await worker('worker', ['hook','attach','7','--file',f.file,'--revision',revision], { client: c, json: true });
    await hooks('hooks', ['save','--file',f.file,'--revision',revision], { client: c });
    expect(c.calls).toEqual([{ method: 'worker.hook_attach', params },
      { method: 'hooks.save', params: { template: rule, expected_revision: revision } }]);
  } finally { f.close(); }
});

function client() {
  const calls = [];
  return { calls, request(method, params) { calls.push({ method, params }); return { method, ok: true }; } };
}
function privateFile(value = definition) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lush-hooks-cli-'));
  const file = path.join(dir, 'hook.json');
  fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
  return { dir, file, close() { fs.rmSync(dir, { recursive: true, force: true }); } };
}

test('CLI Hook templates and Worker mounts forward file payloads and revisions without implicit reads', async () => {
  const f = privateFile(), c = client();
  try {
    await hooks('hooks', ['list'], { client: c });
    await hooks('hooks', ['save', '--file', f.file, '--revision', revision], { client: c });
    await hooks('hooks', ['remove', 'template-1', '--revision', revision], { client: c });
    await worker('worker', ['hooks', '7'], { client: c, json: true });
    await worker('worker', ['hook', 'attach', '7', '--file', f.file, '--revision', revision], { client: c, json: true });
    await worker('worker', ['hook', 'enable', '7', 'hook-1', '--revision', revision], { client: c, json: true });
    await worker('worker', ['hook', 'disable', '7', 'hook-1', '--revision', revision], { client: c, json: true });
    await worker('worker', ['hook', 'remove', '7', 'hook-1', '--revision', revision], { client: c, json: true });
    expect(c.calls).toEqual([
      { method: 'hooks.list', params: undefined },
      { method: 'hooks.save', params: { template: definition, expected_revision: revision } },
      { method: 'hooks.remove', params: { id: 'template-1', expected_revision: revision } },
      { method: 'worker.hooks', params: { id: 7 } },
      { method: 'worker.hook_attach', params: { id: 7, hook: definition, expected_revision: revision } },
      { method: 'worker.hook_update', params: { id: 7, hook_id: 'hook-1', enabled: true, expected_revision: revision } },
      { method: 'worker.hook_update', params: { id: 7, hook_id: 'hook-1', enabled: false, expected_revision: revision } },
      { method: 'worker.hook_remove', params: { id: 7, hook_id: 'hook-1', expected_revision: revision } },
    ]);
    expect(HELP).toContain('hooks list'); expect(HELP).toContain('worker hooks ID');
    expect(HELP).toContain('--revision REV'); expect(HELP).toContain('owner-only');
  } finally { f.close(); }
});

test('daemon auto-select CLI forwards only explicit on/off and the separate daemon read revision', async () => {
  const c = client(), daemonRevision = 'daemon-revision:a2';
  for (const state of ['on', 'off']) {
    await hooks('hooks', ['auto-select', state, '--revision', daemonRevision], { client: c });
  }
  expect(c.calls).toEqual([
    { method: 'hooks.auto_select', params: { enabled: true, expected_revision: daemonRevision } },
    { method: 'hooks.auto_select', params: { enabled: false, expected_revision: daemonRevision } },
  ]);
  c.calls.length = 0;
  for (const args of [[], ['on'], ['on','extra','--revision',daemonRevision], ['true','--revision',daemonRevision],
    ['--revision',daemonRevision], ['on','--revision',daemonRevision,'--revision',daemonRevision],
    ['off','--revision',' padded '], ['off','--revision','']]) {
    await expect(hooks('hooks', ['auto-select', ...args], { client: c })).rejects.toThrow();
  }
  c.token = 'agent';
  for (const state of ['on', 'off']) {
    await expect(hooks('hooks', ['auto-select',state,'--revision',daemonRevision], { client: c })).rejects.toThrow('user only');
  }
  expect(c.calls).toEqual([]);
  expect(HELP).toContain('hooks auto-select on|off --revision REV');
  expect(HELP).toContain('daemon_hooks.revision');
  expect(HELP).toContain('已有问题');
});

test('new Hook CLI entry points resolve W numbers once and retain integer RPC identities and user-only gates', async () => {
  const f = privateFile(), calls = [];
  const c = { request(method, params) { calls.push({ method, params }); return method === 'worker.lookup'
    ? { id: 700, worker_number: params.number } : { ok: true }; } };
  const lookup = { method: 'worker.lookup', params: { number: 'W5-2' } };
  try {
    await worker('worker', ['hooks', 'W5-2'], { client: c, json: true });
    await worker('worker', ['hook', 'attach', 'W5-2', '--file', f.file, '--revision', revision], { client: c, json: true });
    for (const verb of ['enable','disable','remove'])
      await worker('worker', ['hook', verb, 'W5-2', 'hook-1', '--revision', revision], { client: c, json: true });
    expect(calls).toEqual([
      lookup, { method: 'worker.hooks', params: { id: 700 } },
      lookup, { method: 'worker.hook_attach', params: { id: 700, hook: definition, expected_revision: revision } },
      lookup, { method: 'worker.hook_update', params: { id: 700, hook_id: 'hook-1', enabled: true, expected_revision: revision } },
      lookup, { method: 'worker.hook_update', params: { id: 700, hook_id: 'hook-1', enabled: false, expected_revision: revision } },
      lookup, { method: 'worker.hook_remove', params: { id: 700, hook_id: 'hook-1', expected_revision: revision } },
    ]);
    calls.length = 0;
    for (const invalid of ['W01','W0','W5-0','w5']) await expect(worker('worker', ['hooks', invalid], { client: c })).rejects.toThrow();
    c.token = 'agent';
    await expect(worker('worker', ['hooks','W5-2'], { client: c })).rejects.toThrow('user only');
    await expect(worker('worker', ['hook','disable','W5-2','hook-1','--revision',revision], { client: c })).rejects.toThrow('user only');
    expect(calls).toEqual([]);
  } finally { f.close(); }
});

test('CLI missing/duplicate revisions, invalid arguments and Agent calls do not send RPC', async () => {
  const c = client(), f = privateFile();
  try {
    for (const args of [['save', '--file', f.file], ['remove', 'template-1'], ['list','--revision',revision],
      ['save', '--file', f.file, '--revision',revision,'--revision',revision], ['save','--revision',revision]]) {
      await expect(hooks('hooks', args, { client: c })).rejects.toThrow();
    }
    for (const args of [['hook','attach','7','--file',f.file], ['hook','disable','7','hook-1'], ['hooks','7','extra'],
      ['hook','enable','bad','hook-1','--revision',revision], ['hook','remove','7','hook-1','--revision',revision,'force']]) {
      await expect(worker('worker', args, { client: c })).rejects.toThrow();
    }
    c.token = 'agent';
    await expect(hooks('hooks', ['list'], { client: c })).rejects.toThrow('user only');
    await expect(hooks('hooks', ['save','--file',f.file,'--revision',revision], { client: c })).rejects.toThrow('user only');
    await expect(worker('worker', ['hooks','7'], { client: c })).rejects.toThrow('user only');
    await expect(worker('worker', ['hook','attach','7','--file',f.file,'--revision',revision], { client: c })).rejects.toThrow('user only');
    expect(c.calls).toEqual([]);
  } finally { f.close(); }
});

test('Hook CLI private JSON rejects symlinks, public files, invalid and oversized input without leaking contents', async () => {
  const f = privateFile(), c = client(), secret = 'private-profile-secret';
  const submit = file => hooks('hooks', ['save','--file',file,'--revision',revision], { client: c });
  try {
    const linked = path.join(f.dir, 'linked.json'); fs.symlinkSync(f.file, linked);
    const malformed = path.join(f.dir, 'malformed.json'); fs.writeFileSync(malformed, secret + '{', { mode: 0o600 });
    const huge = path.join(f.dir, 'huge.json'); fs.writeFileSync(huge, 'x'.repeat(256 * 1024 + 1), { mode: 0o600 });
    const array = path.join(f.dir, 'array.json'); fs.writeFileSync(array, '[]', { mode: 0o600 });
    fs.chmodSync(f.file, 0o644);
    for (const file of [f.file, linked, malformed, huge, array, f.dir]) {
      try { await submit(file); throw new Error('unexpected success'); }
      catch (error) {
        expect(error.message).toContain('cannot safely read private Hook');
        expect(error.message).not.toContain(secret); expect(error.message).not.toContain(file);
      }
    }
    expect(c.calls).toEqual([]);
  } finally { f.close(); }
});

test('order --defer is explicit and preserves a complete private profile', async () => {
  const profile = { agent: 'pi', config_mode: 'lush', model: 'demo/model', thinking: 'high', env: { API_KEY: 'not-on-command-line' } };
  const f = privateFile(profile), c = client();
  try {
    await order('order', ['goal'], { client: c });
    await order('order', ['goal','--branch','main','--profile-file',f.file,'--defer'], { client: c });
    expect(c.calls).toEqual([
      { method: 'order.submit', params: { content: 'goal' } },
      { method: 'order.submit', params: { content: 'goal', branch: 'main', profile, defer: true } },
    ]);
    await expect(order('order', ['goal','--defer','--defer'], { client: c })).rejects.toThrow();
    c.token = 'agent';
    await expect(order('order', ['goal','--defer'], { client: c })).rejects.toThrow('agents cannot submit');
    expect(c.calls).toHaveLength(2);
  } finally { f.close(); }
});

test('order.submit validates defer and forwards it for direct and versioned draft submission', () => {
  const calls = [], project = { order(...args) { calls.push(['order', args]); return { deferred: args.at(-1) }; },
    submitBufferedDraft(...args) { calls.push(['draft', args]); return { deferred: args.at(-1) }; } };
  const profile = { agent: 'pi', config_mode: 'pi' };
  expect(HANDLERS['order.submit'](project, { content: 'goal', profile, start: false, defer: true })).toEqual({ deferred: true });
  expect(calls.at(-1)).toEqual(['order', ['goal', null, [], null, false, undefined, profile, true]]);
  HANDLERS['order.submit'](project, { draft_id: 2, expected_revision: 3, start: false, defer: true });
  expect(calls.at(-1)).toEqual(['draft', [2, 3, false, true, null]]);
  HANDLERS['order.submit'](project, { content: 'plain' }); expect(calls.at(-1)[1].at(-1)).toBe(false);
  for (const defer of ['true', null, 1, {}, []]) expect(() => HANDLERS['order.submit'](project, { content: 'x', defer })).toThrow('defer must be boolean');
  HANDLERS['order.submit'](project, { draft_id: 2, expected_revision: 3, profile, defer: true });
  expect(calls.at(-1)).toEqual(['draft', [2, 3, true, true, profile]]);
  for (const defer of [undefined, false]) expect(() => HANDLERS['order.submit'](project,
    { draft_id: 2, expected_revision: 3, profile, defer })).toThrow('draft_id cannot be combined');
  for (const forbidden of [{ content: 'new' }, { references: [] }, { branch: 'other' }]) expect(() => HANDLERS['order.submit'](project,
    { draft_id: 2, expected_revision: 3, profile, defer: true, ...forbidden })).toThrow('draft_id cannot be combined');
  for (const invalidProfile of [null, [], 'profile']) expect(() => HANDLERS['order.submit'](project,
    { draft_id: 2, expected_revision: 3, profile: invalidProfile, defer: true })).toThrow('invalid profile');
  expect(() => assertAllowed('order.submit', { content: 'x', defer: true, force: true }, null)).toThrow('unknown parameter');
  expect(() => assertAllowed('order.submit', { content: 'x', defer: true }, 7)).toThrow('requires user approval');
  expect(calls).toHaveLength(4);
});
