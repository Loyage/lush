import { test, expect } from 'bun:test';
import { setup, fetch } from './harness.js';

const rawHooks = JSON.stringify({ mounts: [{ profile: { env: { TOKEN: 'private-hook-token' } } }] });
const rawProfile = JSON.stringify({ env: { KEY: 'private-worker-token' }, append_prompt: 'private-prompt' });
const publicHooks = { version: 1, worker_id: 7, revision: 'safe-revision', mounts: [] };
function rawTask(hooks = rawHooks) { return { id: 7, task_kind: 'order', status: 'paused', retry_profile: rawProfile, hooks }; }
const post = (url, method, params) => fetch(url + '/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ method, params }) });
function noPrivate(value) {
  for (const text of ['private-hook-token','private-worker-token','private-prompt','retry_profile']) expect(JSON.stringify(value)).not.toContain(text);
}

test('HTTP mutation envelopes, order.submit and inspect do not expose private Worker columns', async () => {
  const f = await setup();
  const source = { task: rawTask(), child: rawTask(publicHooks), nested: [rawTask(), { task: rawTask() }] };
  const original = JSON.stringify(source);
  f.project.retry = () => source;
  f.project.resumeTask = () => source;
  f.project.configureTask = () => source;
  f.project.order = () => ({ id: 1, content: 'goal', ...source });
  f.project.inspect = () => rawTask(publicHooks);
  try {
    for (const method of ['worker.retry','worker.resume','worker.configure']) {
      const response = await post(f.url, method, { id: 7 });
      expect(response.status).toBe(200);
      const result = await response.json(); noPrivate(result);
      expect(result.task).toEqual({ id: 7, task_kind: 'order', status: 'paused' });
      expect(result.child.hooks).toEqual(publicHooks);
    }
    const order = await post(f.url, 'order.submit', { content: 'goal' });
    expect(order.status).toBe(200); const result = await order.json(); noPrivate(result);
    expect(result.id).toBe(1); expect(result.content).toBe('goal'); expect(result.child.hooks).toEqual(publicHooks);
    const inspect = await fetch(f.url + '/api/worker/7');
    expect(inspect.status).toBe(200); const task = await inspect.json(); noPrivate(task); expect(task.hooks).toEqual(publicHooks);
    expect(JSON.stringify(source)).toBe(original);
    expect(source.task.retry_profile).toBe(rawProfile); expect(source.task.hooks).toBe(rawHooks);
  } finally { await f.close(); }
});

test('HTTP Worker string hooks are omitted while the safe object projection remains usable', async () => {
  const f = await setup();
  const raw = rawTask(); f.project.inspect = () => raw;
  f.project.taskHooks = () => publicHooks;
  try {
    const inspect = await (await fetch(f.url + '/api/worker/7')).json();
    expect(inspect.hooks).toBeUndefined(); expect(inspect.retry_profile).toBeUndefined(); noPrivate(inspect);
    expect(await (await fetch(f.url + '/api/worker/7/hooks')).json()).toEqual(publicHooks);
    expect(raw.hooks).toBe(rawHooks); expect(raw.retry_profile).toBe(rawProfile);
  } finally { await f.close(); }
});

test('HTTP Agent settings and environment APIs retain their authorized configuration, not arbitrary Worker fields', async () => {
  const f = await setup();
  const env = { SECRET: 'authorized-setting', hooks: 'legitimate-variable', retry_profile: 'legitimate-variable-2' };
  const profile = { agent: 'pi', config_mode: 'lush', append_prompt: 'authorized prompt', default_prompt: 'authorized default', env };
  const config = { version: 1, default: profile, roles: {}, resolved: { agent: profile } };
  const environment = { target: 'common', values: env };
  f.project.agentConfig = () => config; f.project.configureAgents = () => config;
  f.project.agentEnvironment = () => environment; f.project.configureAgentEnvironment = () => environment;
  try {
    expect(await (await fetch(f.url + '/api/agent/config')).json()).toEqual(config);
    expect(await (await post(f.url, 'agent.configure', { config })).json()).toEqual(config);
    expect(await (await fetch(f.url + '/api/agent/environment?target=common')).json()).toEqual(environment);
    expect(await (await post(f.url, 'agent.environment.configure', { target: 'common', values: env })).json()).toEqual(environment);
  } finally { await f.close(); }
});
