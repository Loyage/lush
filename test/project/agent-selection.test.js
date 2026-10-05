import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { Config } from '../../src/config.js';
import { Store } from '../../src/persistence/store.js';
import { Project } from '../../src/core/project.js';
import { AgentSelectionService } from '../../src/core/agent-selection.js';
import { createRuntimeConnection } from '../../src/agent/connection-runtime.js';
import { Dispatcher } from '../../src/rpc/protocol.js';
import { createSignal } from '../../src/signal.js';
import { env, temp, repo, until, gate, fixture } from '../helpers.js';
import { install, connection, ManagerStub, observation, NOW } from './agent-connection-fixture.js';

const id = 'd870678a-80de-4fd2-9e3b-20bba91a27b6';
const managed = extra => connection({ id, provider: 'openai-compatible', endpoint: 'https://custom.invalid/v1', models: ['chat'], ...extra });
const selected = { connection_id: id, model: 'openai-compatible/chat' };
const profile = { agent: 'pi', model: 'deepseek/deepseek-chat', thinking: 'off',
  default_prompt: 'private-system-instructions', append_prompt: 'private-append', extensions: ['/private/extension'],
  skills: ['/private/skill'], env: { API_KEY: 'private-environment-key' } };
const worker = { id: 9, role: 'agent', task_kind: 'order', goal: 'private-goal', retry_profile: 'private-profile', agent_token_hash: 'private-token' };

function runtime(strategy, extra = {}) {
  const root = temp(), config = new Config({ project: root, env: env(extra) }); config.prepare();
  const store = new Store(path.join(config.home, 'project.db'), root), calls = [];
  const provider = { resolve() { return profile; }, async run(ctx) { calls.push(ctx); return 'done'; } };
  const project = new Project(config, store, provider, { modelSelectionStrategy: strategy });
  return { root, config, store, project, calls,
    async close() { await project.shutdown(); store.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

function serviceFixture(strategy, connections = [managed()]) {
  const f = fixture(), manager = new ManagerStub(connections); install(f, { manager });
  const service = new AgentSelectionService(f.project, { strategy });
  return { ...f, manager, service };
}

test('disabled and explicit selection return the original profile without reading any managed credentials', async () => {
  const f = fixture();
  try {
    const disabled = new AgentSelectionService(f.project);
    expect(disabled.enabled).toBe(false);
    expect(await disabled.select(worker, profile)).toBe(profile);
    const explicit = new AgentSelectionService(f.project, { strategy: () => { throw new Error('must not run'); } });
    expect(await explicit.select(worker, profile, { explicit: true })).toBe(profile);
    expect(f.project.agentConnections.manager).toBeNull();
  } finally { await f.close(); }
});

test('resources are local safe structured data with capability, unknown, failed and stale states preserved', async () => {
  const f = serviceFixture(null);
  try {
    const empty = f.service.resources();
    expect(empty).toMatchObject({ version: 1, checked_at: new Date(NOW).toISOString() });
    expect(empty.connections[0]).toMatchObject({ provider: 'openai-compatible', models: ['chat'], supported_agents: ['pi'],
      credential: { status: 'configured' }, observation: { status: 'unknown', resources: [] }, last_success: null });
    expect(f.manager.calls).toBe(0);
    await f.project.agentConnections.query(id);
    f.manager.result = observation({ status: 'error', error_code: 'network', resources: [] });
    await f.project.agentConnections.query(id);
    const row = f.service.resources().connections[0];
    expect(row.observation).toMatchObject({ status: 'error', resources: [], error_code: 'network' });
    expect(row.last_success.observation.resources[0].remaining).toBe(70);
    const calls = f.manager.calls;
    f.manager.result = observation({ status: 'unsupported', resources: [] });
    await f.project.agentConnections.query(id);
    expect(f.service.resources().connections[0].observation).toMatchObject({ status: 'unsupported', resources: [] });
    expect(f.manager.calls).toBe(calls + 1);
    expect(JSON.stringify(f.service.resources())).not.toMatch(/test-secret|MUST_NOT_RETURN/);
  } finally { await f.close(); }
});

test('strategy receives only minimal frozen facts and can change only the managed connection and model', async () => {
  let input;
  const f = serviceFixture(value => { input = value; return selected; });
  try {
    const result = await f.service.select(worker, profile);
    expect(input.worker).toEqual({ id: 9, role: 'agent', task_kind: 'order' });
    expect(input.profile).toEqual({ agent: 'pi', model: 'deepseek/deepseek-chat', thinking: 'off' });
    expect(JSON.stringify(input)).not.toMatch(/private-|test-secret|MUST_NOT_RETURN/);
    expect(Object.isFrozen(input.resources.connections[0].models)).toBe(true);
    expect(Object.isFrozen(input.profile)).toBe(true);
    expect(result).toEqual({ ...profile, ...selected });
    expect(f.manager.calls).toBe(0);
    f.service.strategy = () => null;
    expect(await f.service.select(worker, profile)).toBe(profile);
    f.service.strategy = () => undefined;
    expect(await f.service.select(worker, profile)).toBe(profile);
  } finally { await f.close(); }
});

test('invalid strategy output and unsupported/unconfigured choices fail without exposing raw values', async () => {
  const f = serviceFixture(() => selected);
  try {
    for (const output of [false, 'SECRET', {}, { ...selected, agent: 'codex' }, { ...selected, model: 'SECRET-provider/chat' },
      { ...selected, model: 'openai-compatible/SECRET' }, { ...selected, connection_id: 'SECRET' },
      { ...selected, model: 'openai-compatible/chat\n' }, { ...selected, model: 'openai-compatible/' }]) {
      f.service.strategy = () => output;
      await expect(f.service.select(worker, profile)).rejects.toThrow('managed model selection failed');
    }
    f.service.strategy = () => { throw new Error('SECRET upstream auth response'); };
    await expect(f.service.select(worker, profile)).rejects.toThrow(/^managed model selection failed$/);
    f.service.strategy = () => selected;
    await expect(f.service.select(worker, { ...profile, agent: 'codex' })).rejects.toThrow('managed model selection failed');
    f.manager.connections[0].enabled = false;
    await expect(f.service.select(worker, profile)).rejects.toThrow('managed model selection failed');
    f.manager.connections[0].enabled = true;
    for (const status of ['unknown', 'unconfigured', 'expired']) {
      f.manager.connections[0].credential.status = status;
      await expect(f.service.select(worker, profile)).rejects.toThrow('managed model selection failed');
    }
    f.project.agentConnections.list = () => { throw new Error('SECRET credential path'); };
    expect(() => f.service.resources()).toThrow(/^managed model selection failed$/);
  } finally { await f.close(); }
});

test('expired managed OAuth remains selectable for coordinated prepareRuntime refresh, not for another backend', async () => {
  const f = serviceFixture(() => ({ connection_id: id, model: 'openai-codex/chat' }), [managed({ provider: 'openai-codex',
    endpoint: 'https://chatgpt.com/backend-api', auth_type: 'oauth', credential: { status: 'expired', identity: null, expires_at: '2020-01-01T00:00:00Z' } })]);
  try {
    expect((await f.service.select(worker, profile)).model).toBe('openai-codex/chat');
    await expect(f.service.select(worker, { ...profile, agent: 'codex' })).rejects.toThrow('managed model selection failed');
  } finally { await f.close(); }
});

test('late strategy results reject changed scope, endpoint or account and cannot resurrect removed connections', async () => {
  const f = serviceFixture(() => selected);
  try {
    for (const change of [() => { f.manager.connections[0].models = ['different']; },
      () => { f.manager.connections[0].endpoint = 'https://other.invalid/v1'; },
      () => { f.manager.keys.set(id, 'replacement-secret'); }, () => { f.manager.connections = []; }]) {
      f.manager.connections = [managed()]; f.manager.keys.set(id, 'test-secret');
      const entered = gate(), release = gate();
      f.service.strategy = async () => { entered.resolve(); await release.promise; return selected; };
      const pending = f.service.select(worker, profile);
      await entered.promise; change(); release.resolve();
      await expect(pending).rejects.toThrow('managed model selection failed');
    }
  } finally { await f.close(); }
});

test('real compatible Manager, resource RPC and selection prepare the same isolated Pi endpoint/model without network probes', async () => {
  let row, requests = 0;
  const f = runtime(({ resources }) => {
    const candidate = resources.connections.find(item => item.id === row.id);
    expect(candidate).toMatchObject({ provider: 'openai-compatible', supported_agents: ['pi'],
      observation: { status: 'unsupported', resources: [] } });
    return { connection_id: candidate.id, model: `${candidate.provider}/${candidate.models[0]}` };
  });
  f.project.agentConnections.managerOptions = { fetch: async () => { requests++; throw new Error('unexpected network'); } };
  const originalRun = f.project.provider.run;
  f.project.provider.run = async ctx => {
    const privatePi = createRuntimeConnection(f.config, ctx.agent, ctx.connectionRuntime);
    try {
      const models = JSON.parse(fs.readFileSync(path.join(privatePi.dir, 'models.json'), 'utf8'));
      const selected = models.providers['openai-compatible'];
      expect(selected).toMatchObject({ baseUrl: row.endpoint, api: 'openai-completions',
        models: [{ id: 'vendor/chat', input: ['text'], reasoning: false, contextWindow: 32768, maxTokens: 4096 }] });
      expect(JSON.stringify(models)).not.toContain('REAL-MANAGER-PRIVATE-KEY');
      const auth = JSON.parse(fs.readFileSync(path.join(privatePi.dir, 'auth.json'), 'utf8'));
      expect(auth['openai-compatible'].key).toBe('REAL-MANAGER-PRIVATE-KEY');
      return originalRun(ctx);
    } finally { fs.rmSync(privatePi.dir, { recursive: true, force: true }); }
  };
  await repo(f.root);
  try {
    row = await f.project.saveAgentConnection({ label: 'Real compatible account', provider: 'openai-compatible',
      auth_type: 'api_key', enabled: true, endpoint: 'https://custom.invalid/v1', models: ['vendor/chat'] },
    { api_key: 'REAL-MANAGER-PRIVATE-KEY' });
    await f.project.queryAgentConnections(row.id);
    const rpc = new Dispatcher(f.project, createSignal(), {});
    const resources = await rpc.dispatch('agent.selection.resources', {});
    expect(resources.connections[0]).toMatchObject({ id: row.id, credential: { status: 'configured' },
      observation: { status: 'unsupported', resources: [] } });
    expect(JSON.stringify(resources)).not.toContain('REAL-MANAGER-PRIVATE-KEY');
    const task = (await f.project.order('real managed selection')).task;
    await until(() => f.store.task(task.id).status === 'waiting' && f.project.running.size === 0);
    expect(f.calls).toHaveLength(1);
    expect(f.store.runsForTask(task.id)[0]).toMatchObject({ model: 'openai-compatible/vendor/chat', status: 'completed' });
    expect(requests).toBe(0);
    expect(JSON.stringify(f.store.history(task.id))).not.toContain('REAL-MANAGER-PRIVATE-KEY');
  } finally { await f.close(); }
});

test('constructor-injected selection is frozen into Run, started event and runtime binding before provider execution', async () => {
  const f = runtime(() => selected); install(f, { manager: new ManagerStub([managed()]) }); await repo(f.root);
  try {
    const task = (await f.project.order('selected invocation')).task;
    await until(() => f.store.task(task.id).status === 'waiting' && f.project.running.size === 0);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].agent).toMatchObject(selected);
    expect(f.calls[0].connectionRuntime.connection.id).toBe(id);
    expect(f.store.runsForTask(task.id)[0]).toMatchObject({ provider: 'pi', model: 'openai-compatible/chat', status: 'completed' });
    const events = f.store.history(task.id);
    expect(events.find(row => row.type === 'invocation.started').data.model).toBe('openai-compatible/chat');
    expect(events.find(row => row.type === 'invocation.connection').data.connection_id).toBe(id);
    expect(JSON.stringify(events)).not.toMatch(/private-environment-key|test-secret/);
  } finally { await f.close(); }
});

test('ordinary invocations and null strategy results keep the old profile and never prepare managed credentials', async () => {
  for (const strategy of [undefined, () => null]) {
    const f = runtime(strategy); await repo(f.root);
    try {
      const task = (await f.project.order('old profile')).task;
      await until(() => f.store.task(task.id).status === 'waiting' && f.project.running.size === 0);
      expect(f.calls[0].agent).toEqual(profile);
      expect(f.calls[0].connectionRuntime).toBeNull();
      if (!strategy) expect(f.project.agentConnections.manager).toBeNull();
    } finally { await f.close(); }
  }
});

test('explicit Worker retry profile wins over strategy, and retry RPC accepts its existing profile parameter', async () => {
  let selectedCalls = 0;
  const f = runtime(() => { selectedCalls++; throw new Error('must not select'); }); await repo(f.root);
  try {
    f.project.stopping = true;
    const task = (await f.project.order('explicit retry')).task;
    f.project.cancel(task.id, 'fixture failed', 'failed');
    const rpc = new Dispatcher(f.project, createSignal(), {});
    await rpc.dispatch('worker.retry', { id: task.id, profile: { ...profile, model: 'deepseek/explicit' } });
    f.project.stopping = false; f.project.kick();
    await until(() => f.store.task(task.id).status === 'waiting' && f.project.running.size === 0);
    expect(selectedCalls).toBe(0);
    expect(f.calls[0].agent.model).toBe('deepseek/explicit');
    expect(f.project.agentConnections.manager).toBeNull();
  } finally { await f.close(); }
});

test('strategy exceptions fail before starting a Run and never persist exception details', async () => {
  const f = runtime(() => { throw new Error('SECRET strategy stack'); }); await repo(f.root);
  try {
    const task = (await f.project.order('failing strategy')).task;
    await until(() => f.store.task(task.id).status === 'failed' && f.project.running.size === 0);
    expect(f.calls).toHaveLength(0); expect(f.store.runsForTask(task.id)).toEqual([]);
    expect(f.store.task(task.id).error).toBe('managed model selection failed');
    expect(JSON.stringify(f.store.history(task.id))).not.toContain('SECRET');
  } finally { await f.close(); }
});

test('cancellation releases an uncooperative selection and a late result cannot launch a provider', async () => {
  const entered = gate(), release = gate();
  const f = runtime(async ({ signal }) => { expect(signal).toBeInstanceOf(AbortSignal); entered.resolve(); await release.promise; return selected; });
  install(f, { manager: new ManagerStub([managed()]) }); await repo(f.root);
  try {
    const task = (await f.project.order('cancel selection')).task;
    await entered.promise; f.project.cancel(task.id, 'cancelled by user');
    await until(() => f.project.running.size === 0);
    release.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(f.calls).toHaveLength(0); expect(f.store.runsForTask(task.id)).toEqual([]);
    expect(f.store.task(task.id).status).toBe('cancelled');
  } finally { release.resolve(); await f.close(); }
});

test('invocation timeout bounds a strategy that never resolves, without starting a provider', async () => {
  const f = runtime(() => new Promise(() => {}), { LUSH_CALL_TIMEOUT: '1' }); await repo(f.root);
  try {
    const task = (await f.project.order('timeout selection')).task;
    await until(() => f.store.task(task.id).status === 'failed' && f.project.running.size === 0);
    expect(f.calls).toHaveLength(0); expect(f.store.task(task.id).error).toBe('agent invocation timed out after 1 second');
    expect(f.store.runsForTask(task.id)).toEqual([]);
  } finally { await f.close(); }
});

test('pause during selection prevents late launch; explicit resume is selected only on the next invocation', async () => {
  const entered = gate(), release = gate();
  const f = runtime(async () => { entered.resolve(); await release.promise; return selected; });
  install(f, { manager: new ManagerStub([managed()]) }); await repo(f.root);
  try {
    const task = (await f.project.order('pause selection')).task;
    await entered.promise; f.project.interrupt(task.id); release.resolve();
    await until(() => f.project.running.size === 0 && f.store.task(task.id).status === 'paused');
    expect(f.calls).toHaveLength(0); expect(f.store.runsForTask(task.id)).toEqual([]);
    f.project.resumeTask(task.id, { ...profile, model: 'deepseek/explicit-resume' });
    await until(() => f.calls.length === 1 && f.project.running.size === 0);
    expect(f.calls[0].agent.model).toBe('deepseek/explicit-resume');
  } finally { release.resolve(); await f.close(); }
});
