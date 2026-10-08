import { test, expect } from 'bun:test';
import { publicResult } from '../src/rpc/public-result.js';
import { Dispatcher } from '../src/rpc/dispatcher.js';

const privateProfile = JSON.stringify({ env: { API_KEY: 'private-worker-env' }, append_prompt: 'private-worker-prompt' });
const privateHooks = JSON.stringify({ version: 1, mounts: [{ actions: [{ profile: { env: { TOKEN: 'private-hook-env' } } }] }] });
const publicHooks = { version: 1, worker_id: 7, revision: 'public-revision', mounts: [] };
const privateAutoMerge = JSON.stringify({ version: 1, enabled: true, level: 'archive', completion: { authorization: 'private-completion-receipt' } });
const publicAutoMerge = { enabled: true, locked: false, editable: true, reason: null };
const publicCompletion = { level: 'archive', min_level: 'off', phase: 'accept', state: 'waiting', last_execution: null };
function row(hooks = privateHooks) { return { id: 7, status: 'paused', task_kind: 'order', goal: 'goal', retry_profile: privateProfile, hooks, auto_merge: privateAutoMerge }; }
function freezeTree(value) {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freezeTree(child); Object.freeze(value); }
  return value;
}
function assertPrivateAbsent(value) {
  const json = JSON.stringify(value);
  for (const secret of ['private-worker-env','private-worker-prompt','private-hook-env','private-completion-receipt','retry_profile']) expect(json).not.toContain(secret);
}

test('RPC output projection recursively strips private columns through task/child/arrays without mutating the source', () => {
  const raw = row(), safeRaw = row(publicHooks);
  const source = freezeTree({ task: raw, child: safeRaw, nested: [{ child: raw }, [raw, null, 'text', 1]],
    values: { child: raw }, env: { child: safeRaw }, preserved: { ok: true } });
  const before = JSON.stringify(source), result = publicResult(source);
  expect(result).not.toBe(source); expect(result.task).not.toBe(raw);
  expect(result.task).toEqual({ id: 7, status: 'paused', task_kind: 'order', goal: 'goal' });
  expect(result.child.hooks).toBe(publicHooks); expect(result.child.retry_profile).toBeUndefined();
  expect(result.nested[0].child).toBe(result.task); expect(result.nested[1][0]).toBe(result.task);
  expect(result.values.child).toBe(result.task); expect(result.env.child).toBe(result.child);
  expect(result.preserved).toBe(source.preserved);
  assertPrivateAbsent(result); expect(JSON.stringify(source)).toBe(before);
  expect(raw.retry_profile).toBe(privateProfile); expect(raw.hooks).toBe(privateHooks); expect(raw.auto_merge).toBe(privateAutoMerge);
});

test('safe read objects and authorized Agent profiles/env dictionaries retain their exact fields', () => {
  const env = { API_KEY: 'authorized-config-value', hooks: 'legitimate-variable', auto_merge: 'legitimate-completion-variable', retry_profile: 'another-variable' };
  const profile = { agent: 'pi', config_mode: 'lush', append_prompt: 'authorized prompt', default_prompt: 'authorized default', env };
  const config = freezeTree({ version: 1, default: profile, roles: { agent: profile }, resolved: { agent: profile } });
  expect(publicResult(config, 'agent.config')).toBe(config);
  expect(publicResult({ profile, explicit: true }, 'worker.run_settings')).toEqual({ profile, explicit: true });
  expect(publicResult({ target: 'common', values: env }, 'agent.environment').values).toBe(env);
  expect(publicResult({ agent_config: config }, 'system.status')).toEqual({ agent_config: config });
  // Same names in arbitrary mutation envelopes are not an authorization bypass.
  expect(publicResult({ env, values: env }, 'worker.retry')).toEqual({
    env: { API_KEY: 'authorized-config-value' }, values: { API_KEY: 'authorized-config-value' },
  });
  expect(publicResult(publicHooks)).toBe(publicHooks);
  expect(publicResult({ hooks: publicHooks })).toEqual({ hooks: publicHooks });
  const safe = { auto_merge: publicAutoMerge, completion: publicCompletion, hooks: publicHooks };
  expect(publicResult(safe, 'worker.auto_merge')).toBe(safe);
  expect(publicResult({ task: { ...row(publicHooks), auto_merge: publicAutoMerge, completion: publicCompletion } }).task)
    .toEqual({ id: 7, status: 'paused', task_kind: 'order', goal: 'goal', hooks: publicHooks, auto_merge: publicAutoMerge, completion: publicCompletion });
  expect(publicResult({ auto_merge: null })).toEqual({ auto_merge: null });
  expect(publicResult({ hooks: null })).toEqual({ hooks: null });
  expect(publicResult(null)).toBeNull(); expect(publicResult('text')).toBe('text');
  const date = new Date('2026-01-01'); expect(publicResult(date)).toBe(date);
});

test('output projection handles null-prototype objects and prototype keys without pollution', () => {
  const source = Object.assign(Object.create(null), { retry_profile: {}, hooks: privateHooks, child: row() });
  Object.defineProperty(source, '__proto__', { value: { marker: 'data-only' }, enumerable: true });
  const result = publicResult(source);
  expect(Object.getPrototypeOf(result)).toBeNull(); expect(result.retry_profile).toBeUndefined();
  expect(result.hooks).toBeUndefined(); expect(result.__proto__).toEqual({ marker: 'data-only' });
  expect({}.marker).toBeUndefined(); expect(source.retry_profile).toEqual({});
});

const mutations = [
  ['worker.retry', { id: 7 }, 'retry'], ['worker.cancel', { id: 7 }, 'cancel'],
  ['worker.interrupt', { id: 7 }, 'interrupt'], ['worker.resume', { id: 7 }, 'resumeTask'],
  ['worker.configure', { id: 7 }, 'configureTask'], ['worker.clear_override', { id: 7 }, 'clearTaskProfile'],
  ['worker.accept', { id: 7 }, 'acceptTask'], ['worker.reopen', { id: 7 }, 'reopenTask'],
  ['worker.auto_merge', { id: 7, enabled: true }, 'setTaskAutoMerge'],
  ['worker.completion', { id: 7, level: 'archive', expected_revision: 'revision' }, 'setTaskCompletion'],
  ['worker.reserve', { id: 7, kind: 'merge' }, 'reserveTask'],
  ['worker.hook_attach', { id: 7, hook: { template_id: 'template-1' }, expected_revision: 'revision' }, 'attachTaskHook'],
];
for (const [method, params, target] of mutations) {
  test(`${method} filters raw Store rows even in legacy mutation envelopes`, async () => {
    const raw = freezeTree({ task: row(), child: row(publicHooks), workers: [row(), row()] });
    const p = { actor: () => null, [target]: async () => raw };
    const result = await new Dispatcher(p).dispatch(method, params);
    assertPrivateAbsent(result); expect(result.child.hooks).toEqual(publicHooks);
    expect(raw.task.retry_profile).toBe(privateProfile); expect(raw.task.hooks).toBe(privateHooks); expect(raw.task.auto_merge).toBe(privateAutoMerge);
  });
}

test('order.submit and worker.inspect use the same final output boundary', async () => {
  const rawTask = row(), rawInspect = row(publicHooks);
  const result = { id: 1, content: 'goal', task: rawTask, nested: { child: rawTask } };
  const p = { actor: () => null, order: () => result, inspect: () => rawInspect };
  const dispatcher = new Dispatcher(p);
  const order = await dispatcher.dispatch('order.submit', { content: 'goal' });
  assertPrivateAbsent(order); expect(order.task).toEqual(order.nested.child);
  const inspect = await dispatcher.dispatch('worker.inspect', { id: 7 });
  assertPrivateAbsent(inspect); expect(inspect.hooks).toBe(publicHooks);
  expect(result.task.retry_profile).toBe(privateProfile); expect(rawInspect.retry_profile).toBe(privateProfile);
});

test('user Agent config and environment RPCs retain authorized Prompt/env values and collisions', async () => {
  const env = { API_KEY: 'authorized env', hooks: 'env-value', auto_merge: 'env-completion', retry_profile: 'env-value-2' };
  const profile = { agent: 'pi', config_mode: 'lush', append_prompt: 'prompt', default_prompt: 'default', env };
  const config = { version: 1, default: profile, roles: {}, resolved: { agent: profile } };
  const environment = { target: 'common', values: env };
  const p = { actor: () => null, agentConfig: () => config, configureAgents: () => config,
    agentEnvironment: () => environment, configureAgentEnvironment: () => environment };
  const dispatcher = new Dispatcher(p);
  for (const [method, params, expected] of [['agent.config', {}, config], ['agent.configure', { config }, config],
    ['agent.environment', { target: 'common' }, environment], ['agent.environment.configure', { target: 'common', values: env }, environment]]) {
    expect(await dispatcher.dispatch(method, params)).toEqual(expected);
  }
});
