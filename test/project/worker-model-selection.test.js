import { test, expect } from 'bun:test';
import { fixture, repo, until } from '../helpers.js';
import { Dispatcher } from '../../src/rpc/protocol.js';
import { PARAMS, USER_ONLY, assertAllowed } from '../../src/rpc/registry.js';
import { agentView } from '../../src/core/project/internal.js';
import { install, connection, ManagerStub } from './agent-connection-fixture.js';

const ID = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const selection = { connection_id: ID, model: 'deepseek/chat' };
const rich = () => ({ agent: 'pi', model: 'openai-codex/old', thinking: 'high',
  default_prompt: 'PRIVATE_PROMPT', append_prompt: 'PRIVATE_APPEND', env: { CUSTOM_KEY: 'PRIVATE_ENV' },
  extensions: ['/private/extensions/review.ts'], skills: ['/private/skills/SKILL.md'], soft_budget: { tokens: 1000, responses: 5 } });
function setup(connections = [connection({ id: ID, models: ['chat'] })]) {
  const f = fixture();
  const manager = new ManagerStub(connections);
  const { service } = install(f, { manager });
  const task = f.store.create({ parent_id: null, role: 'agent', task_kind: 'order', goal: 'model selection' });
  f.store.update(task.id, { status: 'paused' });
  // Any attempt at runtime preparation, probing, or model invocation is a test failure.
  manager.prepareRuntime = manager.query = () => { throw new Error('MUST_NOT_CALL_NETWORK_OR_AUTH'); };
  f.project.kick = () => { throw new Error('MUST_NOT_START_AGENT'); };
  return { ...f, manager, service, task, dispatcher: new Dispatcher(f.project) };
}
const stored = (f) => JSON.parse(f.store.task(f.task.id).retry_profile);
const count = (f) => f.store.get("SELECT count(*) AS n FROM events WHERE task_id=? AND type='task.configured'", f.task.id).n;
const noSecrets = (value) => {
  const text = JSON.stringify(value);
  expect(text).not.toMatch(/PRIVATE_|private\/|test-secret|MUST_NOT_RETURN|retry_profile|append_prompt|default_prompt|extensions|skills|soft_budget|CUSTOM_KEY/);
};

test('narrow update preserves all existing overrides and exposes only next-invocation choice', async () => {
  const f = setup();
  try {
    f.project.configureTask(f.task.id, rich());
    const before = stored(f), result = f.project.configureTaskModelSelection(f.task.id, selection);
    expect(stored(f)).toEqual({ ...before, ...selection });
    expect(result).toEqual({ id: f.task.id, model_selection: { agent: 'pi', config_mode: 'lush', ...selection, thinking: 'high', explicit: true } });
    noSecrets(result); noSecrets(f.project.inspect(f.task.id).model_selection);
    expect(f.project.inspect(f.task.id).retry_profile).toBeUndefined();
    expect(f.project.inspect(f.task.id).agent.connection_id).toBeNull();
    expect(f.store.task(f.task.id)).toMatchObject({ status: 'paused', calls: 0 });
    expect(f.manager.calls).toBe(0);
    expect(count(f)).toBe(2);
  } finally { await f.close(); }
});

test('without an override the effective role profile is the baseline, not the project default', async () => {
  const f = setup();
  try {
    f.project.configureAgents({ version: 1, default: { agent: 'pi', model: 'default-model' }, roles: { agent: rich() } });
    const expected = f.project.agentSettings.resolve('agent');
    const first = f.project.inspect(f.task.id).model_selection;
    expect(first).toEqual({ agent: 'pi', config_mode: 'lush', connection_id: null, model: 'openai-codex/old', thinking: 'high', explicit: false });
    noSecrets(first);
    f.project.configureTaskModelSelection(f.task.id, selection);
    expect(stored(f)).toEqual({ ...expected, ...selection });
    const oldDefaults = stored(f);
    f.project.configureAgents({ version: 1, default: { agent: 'pi', model: 'changed-default' }, roles: {} });
    expect(stored(f)).toEqual(oldDefaults);
    expect(f.project.inspect(f.task.id).model_selection).toMatchObject({ ...selection, explicit: true });
  } finally { await f.close(); }
});

test('safe inspection remains lazy and never touches managed credentials, including mock/no binding', async () => {
  const f = setup();
  try {
    f.project.agentConnections.config = () => { throw new Error('MUST_NOT_READ_CREDENTIALS'); };
    expect(f.project.inspect(f.task.id).model_selection).toEqual({ agent: 'pi', config_mode: 'lush', connection_id: null, model: '', thinking: '', explicit: false });
    f.project.configureTask(f.task.id, { ...rich(), connection_id: ID, model: 'deepseek/old' });
    expect(f.project.inspect(f.task.id).model_selection).toMatchObject({ connection_id: ID, model: 'deepseek/old', explicit: true });
    noSecrets(f.project.inspect(f.task.id).model_selection);
  } finally { await f.close(); }
});

test('RPC accepts only user-authorized mutually exclusive profile/model_selection inputs', async () => {
  const f = setup();
  try {
    expect(PARAMS['worker.configure']).toEqual(['id','profile','model_selection']);
    expect(USER_ONLY.has('worker.configure')).toBe(true);
    expect(() => assertAllowed('worker.configure', { id: f.task.id, model_selection: selection }, f.task.id)).toThrow('requires user approval');
    for (const profile of [null, {}, rich()]) {
      await expect(f.dispatcher.dispatch('worker.configure', { id: f.task.id, profile, model_selection: selection })).rejects.toThrow('mutually exclusive');
    }
    await expect(f.dispatcher.dispatch('worker.configure', { id: f.task.id, model_selection: selection, extra: 1 })).rejects.toThrow('unknown parameter');
    const result = await f.dispatcher.dispatch('worker.configure', { id: f.task.id, model_selection: selection });
    noSecrets(result); expect(result.model_selection).toMatchObject({ ...selection, explicit: true });
    // Legacy full-profile replacement and clearing keep their original semantics.
    const old = await f.dispatcher.dispatch('worker.configure', { id: f.task.id, profile: { agent: 'pi', model: 'legacy' } });
    expect(JSON.parse(old.retry_profile).model).toBe('legacy');
    await f.dispatcher.dispatch('worker.configure', { id: f.task.id, profile: null });
    expect(f.store.task(f.task.id).retry_profile).toBeNull();
    expect(f.project.inspect(f.task.id).model_selection.explicit).toBe(false);
  } finally { await f.close(); }
});

test('strict selection shape/type/UUID/model validation does not mutate the existing profile or events', async () => {
  const f = setup();
  try {
    f.project.configureTask(f.task.id, rich());
    const before = f.store.task(f.task.id), n = count(f);
    for (const invalid of [null, [], 'secret', {}, { connection_id: ID }, { ...selection, extra: 'PRIVATE' },
      { ...selection, connection_id: null }, { ...selection, connection_id: 'conn-one' }, { ...selection, connection_id: ` ${ID}` },
      { ...selection, model: null }, { ...selection, model: '' }, { ...selection, model: ' deepseek/chat' },
      { ...selection, model: 'deepseek/chat\n' }, { ...selection, model: 'deepseek/chat\u0000' },
      { ...selection, model: 'deepseek/' + 'x'.repeat(260) }]) {
      expect(() => f.project.configureTaskModelSelection(f.task.id, invalid)).toThrow();
      expect(f.store.task(f.task.id).retry_profile).toBe(before.retry_profile);
      expect(count(f)).toBe(n);
    }
  } finally { await f.close(); }
});

test('local connection and physical model validation fail closed without auto-switch or refresh', async () => {
  const f = setup();
  try {
    f.project.configureTask(f.task.id, rich()); const before = stored(f), n = count(f);
    for (const invalid of [{ ...selection, connection_id: OTHER }, { ...selection, model: 'openai-codex/chat' },
      { ...selection, model: 'deepseek/' }, { ...selection, model: 'deepseek/not-in-range' }]) {
      expect(() => f.project.configureTaskModelSelection(f.task.id, invalid)).toThrow();
      expect(stored(f)).toEqual(before); expect(count(f)).toBe(n);
    }
    f.manager.connections[0].enabled = false;
    expect(() => f.project.configureTaskModelSelection(f.task.id, selection)).toThrow('unavailable');
    f.manager.connections[0].enabled = true;
    for (const status of ['unconfigured','unknown','expired']) {
      f.manager.connections[0].credential.status = status;
      expect(() => f.project.configureTaskModelSelection(f.task.id, selection)).toThrow('no usable credential');
    }
    expect(stored(f)).toEqual(before); expect(count(f)).toBe(n);
  } finally { await f.close(); }
});

test('expired but configured OAuth may be selected for the next runtime-owned refresh', async () => {
  const f = setup([connection({ id: ID, provider: 'openai-codex', endpoint: 'https://chatgpt.com/backend-api/codex',
    auth_type: 'oauth', models: ['gpt-test'], credential: { status: 'expired', identity: null, expires_at: '2020-01-01T00:00:00Z' } })]);
  try {
    const value = { connection_id: ID, model: 'openai-codex/gpt-test' };
    expect(f.project.configureTaskModelSelection(f.task.id, value).model_selection).toMatchObject(value);
    expect(f.manager.calls).toBe(0);
  } finally { await f.close(); }
});

test('generic endpoint models are validated locally and endpoint/list failures keep existing settings', async () => {
  const f = setup([connection({ id: ID, provider: 'openai-compatible', endpoint: 'https://custom.invalid/v1', models: ['custom'] })]);
  try {
    const value = { connection_id: ID, model: 'openai-compatible/custom' };
    f.project.configureTaskModelSelection(f.task.id, value); const before = stored(f);
    f.manager.connections[0].endpoint = 'http://unsafe.invalid/v1';
    expect(() => f.project.configureTaskModelSelection(f.task.id, value)).toThrow('连接操作失败');
    expect(stored(f)).toEqual(before);
  } finally { await f.close(); }
});

test('backend is not changed and no Pi binding is silently added to Codex', async () => {
  const f = setup();
  try {
    f.project.configureTask(f.task.id, { agent: 'codex', model: 'codex-model', append_prompt: 'PRIVATE_APPEND' });
    const before = stored(f);
    expect(() => f.project.configureTaskModelSelection(f.task.id, selection)).toThrow('only Pi');
    expect(stored(f)).toEqual(before);
    expect(f.project.inspect(f.task.id).model_selection).toEqual({ agent: 'codex', config_mode: 'lush', connection_id: null, model: 'codex-model', thinking: '', explicit: true });
  } finally { await f.close(); }
});

test('paused/requested and order/child guards are retained, with no changes to the active run', async () => {
  const f = setup();
  try {
    for (const status of ['running','queued','waiting','failed','cancelled','awaiting_acceptance','completed']) {
      f.store.update(f.task.id, { status, interrupt_state: null });
      expect(() => f.project.configureTaskModelSelection(f.task.id, selection)).toThrow('only paused');
    }
    f.store.update(f.task.id, { status: 'running', interrupt_state: 'requested' });
    const run = { agent: { agent: 'pi', model: 'deepseek/current' }, recordId: 99, connectionBinding: { id: OTHER } };
    f.project.running.set(f.task.id, run);
    expect(f.project.configureTaskModelSelection(f.task.id, selection).model_selection.model).toBe('deepseek/chat');
    expect(run.agent.model).toBe('deepseek/current'); expect(run.connectionBinding.id).toBe(OTHER);
    f.project.running.delete(f.task.id);
    const child = f.store.create({ parent_id: f.task.id, role: 'agent', task_kind: 'child', goal: 'child selection' });
    f.store.update(child.id, { status: 'paused' });
    expect(f.project.configureTaskModelSelection(child.id, selection).model_selection).toMatchObject(selection);
    const analysis = f.store.create({ parent_id: null, role: 'agent', task_kind: 'analysis', goal: 'read-only' });
    f.store.update(analysis.id, { status: 'paused' });
    expect(() => f.project.configureTaskModelSelection(analysis.id, selection)).toThrow('only order/child');
  } finally { f.project.running.clear(); await f.close(); }
});

test('clear/delete/sync/branch freeze guard the narrow write before touching connection configuration', async () => {
  const f = setup();
  try {
    f.project.agentConnections.config = () => { throw new Error('TOUCHED_CONNECTION_CONFIG'); };
    f.project.clearing = true;
    expect(() => f.project.configureTaskModelSelection(f.task.id, selection)).toThrow('clear is in progress');
    f.project.clearing = false;
    f.project.workerDeleteIds = new Set([f.task.id]);
    expect(() => f.project.configureTaskModelSelection(f.task.id, selection)).toThrow('deletion is in progress');
    f.project.workerDeleteIds.clear();
    f.project.taskSyncBusy = new Set([f.task.id]);
    expect(() => f.project.configureTaskModelSelection(f.task.id, selection)).toThrow('sync is in flight');
    f.project.taskSyncBusy.clear();
    f.store.update(f.task.id, { branch: 'frozen-test' });
    f.project.assertBranchWritable = () => { throw new Error('branch is frozen'); };
    expect(() => f.project.configureTaskModelSelection(f.task.id, selection)).toThrow('branch is frozen');
  } finally { await f.close(); }
});

test('corrupt private profile reports fixed safe error, never its prompt/env contents', async () => {
  const f = setup();
  try {
    f.store.update(f.task.id, { retry_profile: '{"PRIVATE_ENV":' });
    expect(() => f.project.inspect(f.task.id)).toThrow('worker run configuration unavailable');
    expect(() => f.project.configureTaskModelSelection(f.task.id, selection)).toThrow('worker run configuration unavailable');
    expect(count(f)).toBe(0);
  } finally { await f.close(); }
});

test('clear override removes the task-local profile only, and only for idle order/child workers', async () => {
  const f = setup();
  try {
    f.project.configureTask(f.task.id, rich());
    const before = count(f);
    const cleared = f.project.clearTaskProfile(f.task.id);
    expect(f.store.task(f.task.id).retry_profile).toBeNull();
    expect(count(f)).toBe(before + 1);
    expect(cleared).toEqual({ id: f.task.id, model_selection: expect.objectContaining({ explicit: false, connection_id: null }) });
    noSecrets(cleared);
    // Idempotent: nothing to clear means no new audit event.
    const after = count(f);
    f.project.clearTaskProfile(f.task.id);
    expect(count(f)).toBe(after);
    f.project.running.set(f.task.id, {});
    expect(() => f.project.clearTaskProfile(f.task.id)).toThrow('invoking');
    f.project.running.clear();
    f.store.update(f.task.id, { status: 'completed' });
    expect(() => f.project.clearTaskProfile(f.task.id)).toThrow('ended');
    const analysis = f.store.create({ parent_id: null, role: 'agent', task_kind: 'analysis', goal: 'read-only' });
    f.store.update(analysis.id, { status: 'paused' });
    expect(() => f.project.clearTaskProfile(analysis.id)).toThrow('only order/child');
  } finally { f.project.running.clear(); await f.close(); }
});

test('a source-less Pi invocation is blocked before a Run or provider process starts', async () => {
  const calls = [];
  const provider = { requiresPiSource: true, resolve() { return { agent: 'pi', model: 'openai-codex/old' }; },
    async run() { calls.push('run'); throw new Error('MUST_NOT_RUN'); } };
  const f = fixture(provider);
  try {
    await repo(f.root);
    const { task } = await f.project.order('pi without a source');
    await until(() => f.store.task(task.id).status === 'paused' && !f.project.running.has(task.id));
    expect(calls).toEqual([]);
    const blocked = f.store.history(task.id).filter(event => event.type === 'invocation.blocked');
    expect(blocked).toHaveLength(1);
    expect(blocked[0].data.reason).toBe('missing_model_source');
    expect(f.store.all('SELECT id FROM agent_runs WHERE task_id=?', task.id)).toEqual([]);
    expect(f.store.all("SELECT title,kind FROM notices WHERE task_id=?", task.id)
      .some(row => row.kind === 'info' && row.title.includes('缺少 Lush 模型来源'))).toBe(true);
  } finally { await f.close(); }
});

test('current connection is based only on a live runtime binding, never model/default/profile guesses', () => {
  const task = { id: 8, role: 'agent', agent_wakes: 1 }, agent = { agent: 'pi', model: 'deepseek/chat', connection_id: ID };
  expect(agentView(task, { agent }).connection_id).toBeNull();
  expect(agentView(task, null, { provider: 'pi', model: 'deepseek/chat' }).connection_id).toBeNull();
  expect(agentView(task, { agent, connectionBinding: { id: OTHER } }).connection_id).toBe(OTHER);
  for (const extra of [{ parked: true }, { invocationEnded: true }, { controller: { signal: { aborted: true } } }]) {
    expect(agentView(task, { agent, connectionBinding: { id: OTHER }, ...extra }).connection_id).toBeNull();
  }
});
