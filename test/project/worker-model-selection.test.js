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
