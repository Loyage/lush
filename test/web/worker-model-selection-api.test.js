import { test, expect } from 'bun:test';
import { RPCClient } from '../../src/rpc/client.js';
import { tokenHash } from '../../src/core/project/internal.js';
import { setup, fetch } from './harness.js';
import { install, connection, ManagerStub } from '../project/agent-connection-fixture.js';

const ID = '11111111-1111-4111-8111-111111111111';
const choice = { connection_id: ID, model: 'deepseek/chat' };
const rich = { agent: 'pi', model: 'deepseek/old', thinking: 'high', append_prompt: 'PRIVATE_PROMPT',
  env: { CUSTOM_KEY: 'PRIVATE_ENV' }, skills: ['/private/SKILL.md'], extensions: ['/private/review.ts'], soft_budget: { responses: 7 } };
const post = (f, params, headers = {}) => fetch(f.url + '/api/action', { method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ method: 'worker.configure', params }) });
function prepare(f) {
  const manager = new ManagerStub([connection({ id: ID, models: ['chat'] })]);
  install(f, { manager });
  manager.prepareRuntime = manager.query = () => { throw new Error('MUST_NOT_PREPARE_OR_QUERY'); };
  const task = f.store.create({ parent_id: null, role: 'agent', task_kind: 'order', goal: 'HTTP model selection' });
  f.store.update(task.id, { status: 'paused' });
  f.project.configureTask(task.id, rich);
  return { task, manager };
}
const noSecrets = (value) => expect(JSON.stringify(value)).not.toMatch(/PRIVATE_|private\/|test-secret|MUST_NOT_RETURN|retry_profile|CUSTOM_KEY|append_prompt|extensions|skills|soft_budget/);

test('real RPC and HTTP narrow configuration preserve private overrides with safe no-store readbacks', async () => {
  const f = await setup(), { task, manager } = prepare(f);
  try {
    const before = JSON.parse(f.store.task(task.id).retry_profile);
    const rpc = await new RPCClient(f.config.socket).request('worker.configure', { id: task.id, model_selection: choice });
    expect(rpc).toEqual({ id: task.id, model_selection: { agent: 'pi', ...choice, thinking: 'high', explicit: true } });
    noSecrets(rpc);
    const response = await post(f, { id: task.id, model_selection: choice });
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
    const value = await response.json(); noSecrets(value);
    expect(JSON.stringify(value)).toContain('deepseek/chat');
    expect(JSON.parse(f.store.task(task.id).retry_profile)).toEqual({ ...before, ...choice });
    const read = await fetch(f.url + `/api/worker/${task.id}`);
    expect(read.status).toBe(200); expect(read.headers.get('cache-control')).toBe('no-store');
    const worker = await read.json();
    expect(worker.model_selection).toEqual(rpc.model_selection); expect(worker.retry_profile).toBeUndefined();
    expect(worker.agent.connection_id).toBeNull(); noSecrets(worker.model_selection);
    expect(manager.calls).toBe(0); expect(f.store.task(task.id)).toMatchObject({ status: 'paused', calls: 0 });
    expect(f.project.running.size).toBe(0);
  } finally { await f.close(); }
});

test('HTTP rejects mutually exclusive/unknown/invalid choices and cross-origin writes without mutations', async () => {
  const f = await setup(), { task } = prepare(f);
  try {
    const before = f.store.task(task.id).retry_profile;
    for (const params of [{ id: task.id, profile: null, model_selection: choice },
      { id: task.id, model_selection: { ...choice, env: { SECRET: 'PRIVATE_ENV' } } },
      { id: task.id, model_selection: null }, { id: task.id, model_selection: choice, extra: 1 },
      { id: task.id, model_selection: { ...choice, model: 'deepseek/outside' } }]) {
      const response = await post(f, params); expect(response.status).toBe(400);
      noSecrets(await response.json()); expect(f.store.task(task.id).retry_profile).toBe(before);
    }
    expect((await post(f, { id: task.id, model_selection: choice }, { Origin: 'https://attacker.invalid' })).status).toBe(403);
    expect(f.store.task(task.id).retry_profile).toBe(before);
    f.store.update(task.id, { status: 'running' });
    expect((await post(f, { id: task.id, model_selection: choice })).status).toBe(400);
    expect(f.store.task(task.id).retry_profile).toBe(before);
  } finally { await f.close(); }
});

test('valid active Agent RPC credential may read safe choice but cannot configure it', async () => {
  const f = await setup(), { task } = prepare(f), token = 'test-active-agent-token';
  try {
    f.store.update(task.id, { status: 'running' });
    f.store.armAgent(task.id, tokenHash(token));
    f.project.running.set(task.id, { token, controller: new AbortController(), agent: { agent: 'pi', model: 'deepseek/current' } });
    const client = new RPCClient(f.config.socket), before = f.store.task(task.id).retry_profile;
    await expect(client.request('worker.configure', { id: task.id, model_selection: choice, _token: token })).rejects.toThrow('requires user approval');
    const read = await client.request('worker.inspect', { id: task.id, _token: token });
    noSecrets(read.model_selection); expect(read.retry_profile).toBeUndefined(); expect(read.model_selection.model).toBe('deepseek/old');
    expect(read.agent.model).toBe('deepseek/current'); expect(read.agent.connection_id).toBeNull();
    expect(f.store.task(task.id).retry_profile).toBe(before);
  } finally { f.project.running.clear(); await f.close(); }
});

test('existing Web login gates the narrow update and the safe next-choice read', async () => {
  const f = await setup({ auth: { username: 'owner', password: 'test-password' } }), { task } = prepare(f);
  try {
    const params = { id: task.id, model_selection: choice };
    expect((await post(f, params)).status).toBe(401);
    expect((await fetch(f.url + `/api/worker/${task.id}`)).status).toBe(401);
    const login = await fetch(f.url + '/login', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'username=owner&password=test-password&next=%2F' });
    const Cookie = login.headers.get('set-cookie').split(';')[0];
    expect((await post(f, params, { Cookie })).status).toBe(200);
    expect((await post(f, params, { Cookie, Origin: 'https://attacker.invalid' })).status).toBe(403);
    const worker = await (await fetch(f.url + `/api/worker/${task.id}`, { headers: { Cookie } })).json();
    expect(worker.model_selection).toMatchObject({ ...choice, explicit: true }); noSecrets(worker.model_selection);
  } finally { await f.close(); }
});
