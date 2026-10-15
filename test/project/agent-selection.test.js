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
  const root = temp(), deviceRoot = temp();
  // Each runtime is a separate temporary device. helpers.env() shares its HOME,
  // so omitting this root would retain real Manager connections across reruns.
  const config = new Config({ project: root, env: env({ LUSH_GLOBAL_CONFIG: deviceRoot, ...extra }) }); config.prepare();
  const store = new Store(path.join(config.home, 'project.db'), root), calls = [];
  const provider = { resolve() { return profile; }, async run(ctx) { calls.push(ctx); return 'done'; } };
  const project = new Project(config, store, provider, { modelSelectionStrategy: strategy });
  const invocations = new Map(), invoke = project.invoke.bind(project);
  project.invoke = (taskId, run) => { invocations.set(taskId, run); return invoke(taskId, run); };
  return { root, deviceRoot, config, store, project, calls, invocations,
    async close() {
      try { await project.shutdown(); }
      finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(deviceRoot, { recursive: true, force: true }); }
    } };
}

async function invocationSettled(f, task) {
  // Admission is observed separately from completion: run.promise includes async
  // Git finish and branch-observation cleanup. Do not mistake a provider return
  // or an arbitrary 4-second polling cutoff for the invocation safe point.
  const run = await until(() => f.invocations.get(task.id));
  await run.promise; // Still bounded by the project's 20-second single-test budget.
  await f.project.workspaces.queue;
  expect(f.project.running.has(task.id)).toBe(false);
  expect(f.store.task(task.id).status).toBe('waiting');
  expect(f.store.runsForTask(task.id).at(-1)?.status).toBe('completed');
}

function serviceFixture(strategy, connections = [managed()]) {
  const f = fixture(), manager = new ManagerStub(connections); install(f, { manager });
  const service = new AgentSelectionService(f.project, { strategy });
  return { ...f, manager, service };
}

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

test('constructor-injected selection is frozen into Run, started event and runtime binding before provider execution', async () => {
  const f = runtime(() => selected); install(f, { manager: new ManagerStub([managed()]) });
  try {
    await repo(f.root);
    const task = (await f.project.order('selected invocation')).task;
    await invocationSettled(f, task);
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
