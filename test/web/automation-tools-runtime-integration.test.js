import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { repo, git, until } from '../helpers.js';
import { setup, fetch } from './harness.js';
import { historicalConvergencePolicy, pinHistoricalConvergence } from '../convergence-fixtures.js';

async function get(f, route) {
  const response = await fetch(f.url + route);
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  return response.json();
}
async function post(f, method, params, status = 200) {
  const response = await fetch(f.url + '/api/action', { method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: f.url },
    body: JSON.stringify({ method, params }) });
  const value = await response.json();
  expect(response.status).toBe(status);
  return value;
}
const hooks = (f, id) => get(f, `/api/worker/${id}/hooks`);
const operation = (value, mountId) => value.mounts.find(mount => mount.id === mountId)?.operation;
async function completion(f, task, level) {
  return post(f, 'worker.completion', { id: task.id, level, expected_revision: (await hooks(f, task.id)).revision });
}
async function policy(f, enabled, mounted = true) {
  const previous = await get(f, '/api/branch-convergence?branch=main');
  const result = await post(f, 'branch.convergence_set', { branch: 'main', enabled, mounted, expected_revision: previous.revision }, 400);
  expect(result.error).toContain('retired'); return result;
}
function safe(value, authorization) {
  const json = JSON.stringify(value);
  for (const key of ['authorization', 'executions', 'policy_revision', 'retry_profile']) expect(json).not.toContain(`"${key}"`);
  if (authorization) expect(json).not.toContain(authorization);
}
async function prepared(strategy = 'serial', changes = true, level = 'accept') {
  const f = await setup();
  f.project.stopping = true;
  // Keep completion wakeups at queue-release boundaries, but never invoke a model.
  f.project.kick = () => { f.project.scheduleTaskCompletion(); };
  f.project.provider = { run() { throw new Error('automation tool integration must not call a model'); } };
  try {
    await repo(f.root);
    const parent = await f.project.bootstrapMain();
    if (strategy === 'converge') historicalConvergencePolicy(f, parent);
    const { task } = await post(f, 'order.submit', { content: 'controlled HTTP automation', start: false });
    await completion(f, task, level);
    if (changes) {
      fs.writeFileSync(path.join(task.workspace, 'automation-http.txt'), 'controlled source');
      await git(task.workspace, 'add', '.');
      await git(task.workspace, 'commit', '-m', 'controlled automation source');
    }
    f.store.update(task.id, { status: 'waiting' });
    await f.project.workspaces.finish(f.store.task(task.id));
    return { ...f, parent, task };
  } catch (error) { await f.close(); throw error; }
}
async function land(f, strategy) {
  f.project.stopping = false;
  if (strategy === 'converge') {
    const run = await f.project.formConvergenceBatch(f.parent.id);
    await f.project.prepareConvergenceRun(run.id, run.generation, new AbortController().signal);
  } else await f.project.driveTaskMerge(f.parent.id);
  await until(() => f.store.task(f.task.id).integration === 'merged', 10000);
  await f.project.completionQueue;
}

for (const strategy of ['serial', 'converge']) for (const changes of [true, false]) {
  test(`HTTP/RPC/Git ${strategy === 'converge' ? 'historical-enabled policy with serial routing' : strategy} ${changes ? 'code' : 'no-code'} tools separate submission, delivery and safe acceptance`, async () => {
    const f = await prepared(strategy, changes);
    try {
      const catalogue = await get(f, '/api/hooks');
      for (const tool of ['request_merge', 'accept_worker', 'integrate_deliveries'])
        expect(catalogue.actions.find(item => item.type === tool).execution).toBe('operation');
      expect(catalogue.actions.find(item => item.type === 'integrate_deliveries'))
        .toMatchObject({ builtin_only: true, scope: 'target', strategies: ['serial', 'converge'] });
      expect(operation(await hooks(f, f.task.id), 'auto-merge')).toBeNull();
      await f.project.settleQueuedMerge(f.task.id);
      const source = operation(await hooks(f, f.task.id), 'auto-merge');
      const target = operation(await hooks(f, f.parent.id), 'delivery-handler');
      expect(source).toMatchObject({ tool: 'request_merge', status: changes ? 'submitted' : 'succeeded' });
      expect(target).toMatchObject({ tool: 'integrate_deliveries', strategy: 'serial', status: changes ? 'submitted' : 'succeeded' });
      expect(operation(await hooks(f, f.task.id), 'auto-accept')).toBeNull();
      if (changes) {
        expect(f.store.task(f.task.id).integration).not.toBe('merged');
        await land(f, 'serial');
      } else f.project.stopping = false;
      f.project.scheduleTaskCompletion(f.task.id);
      await until(() => f.store.task(f.task.id).status === 'completed' && !f.project.completionQueued?.size, 10000);
      const finished = await hooks(f, f.task.id);
      expect(operation(finished, 'auto-merge')).toMatchObject({ id: source.id, status: 'succeeded' });
      expect(operation(finished, 'auto-accept')).toMatchObject({ tool: 'accept_worker', status: 'succeeded' });
      expect(operation(await hooks(f, f.parent.id), 'delivery-handler')).toMatchObject({ id: target.id, strategy: 'serial', status: 'succeeded' });
      expect(await git(f.root, 'rev-list', '--count', 'main')).toBe(changes ? '2' : '1');
      expect(fs.existsSync(f.task.workspace)).toBe(false);
      const authorization = JSON.parse(f.store.task(f.task.id).auto_merge).completion.authorization;
      safe(finished, authorization);
      safe(await get(f, `/api/worker/${f.task.id}`), authorization);
      const events = f.store.get('SELECT count(*) AS n FROM events').n;
      await hooks(f, f.task.id); await hooks(f, f.parent.id); await get(f, '/api/hooks');
      expect(f.store.get('SELECT count(*) AS n FROM events').n).toBe(events);
    } finally { await f.close(); }
  });
}

test('HTTP retired policy mutation rejects explicitly and does not reroute an already fixed historical operation', async () => {
  const f = await prepared('converge', true, 'merge');
  try {
    await f.project.settleQueuedMerge(f.task.id);
    await pinHistoricalConvergence(f, f.task.id);
    const pinned = f.store.task(f.task.id).reservation;
    const before = operation(await hooks(f, f.parent.id), 'delivery-handler');
    await policy(f, false, false);
    historicalConvergencePolicy(f, f.parent, { mounted: false, enabled: false, generation: 2 });
    const current = await hooks(f, f.parent.id);
    expect(current.mounts.filter(mount => mount.id === 'delivery-handler')).toHaveLength(1);
    expect(current.mounts.find(mount => mount.id === 'delivery-handler')).toMatchObject({ enabled: true, actions: [{ type: 'integrate_deliveries', strategy: 'serial' }] });
    expect(operation(current, 'delivery-handler')).toMatchObject({ id: before.id, strategy: 'converge', status: 'submitted' });
    expect(f.store.task(f.task.id).reservation).toBe(pinned);
    await land(f, 'converge');
    expect(operation(await hooks(f, f.parent.id), 'delivery-handler')).toMatchObject({ id: before.id, strategy: 'converge', status: 'succeeded' });
    expect((await hooks(f, f.task.id)).completion.level).toBe('merge');
  } finally { await f.close(); }
});

test('HTTP acceptance operation waits on dirty preflight without claiming deletion; explicit acceptance exposes its own exact receipt', async () => {
  const f = await prepared('serial', true, 'merge');
  try {
    await f.project.settleQueuedMerge(f.task.id); await land(f, 'serial');
    f.project.stopping = true; await completion(f, f.task, 'accept');
    const dirty = path.join(f.task.workspace, 'keep-private.txt'); fs.writeFileSync(dirty, 'PRIVATE_WAIT_SECRET');
    f.project.stopping = false; await f.project.runTaskCompletion(f.task.id);
    const waiting = operation(await hooks(f, f.task.id), 'auto-accept');
    expect(waiting).toMatchObject({ tool: 'accept_worker', status: 'waiting' });
    expect(fs.existsSync(f.task.workspace)).toBe(true);
    expect(f.store.history(f.task.id).filter(event => event.type === 'completion.execution_started')).toHaveLength(0);
    expect(JSON.stringify(await hooks(f, f.task.id))).not.toContain('PRIVATE_WAIT_SECRET');
    await post(f, 'worker.accept', { id: f.task.id }, 400);
    expect(fs.existsSync(dirty)).toBe(true);
    fs.unlinkSync(dirty);
    await post(f, 'worker.accept', { id: f.task.id });
    const accepted = operation(await hooks(f, f.task.id), 'auto-accept');
    expect(accepted).toMatchObject({ tool: 'accept_worker', status: 'succeeded' });
    expect(accepted.id).not.toBe(waiting.id);
    expect(f.store.history(f.task.id).filter(event => event.type === 'task.accepted')).toHaveLength(1);
    expect(fs.existsSync(f.task.workspace)).toBe(false);
  } finally { await f.close(); }
});

test('HTTP system tool catalogue grants no custom installation, handler editing or arbitrary RPC authority', async () => {
  const f = await prepared('serial', false, 'merge');
  try {
    const model = await hooks(f, f.parent.id);
    for (const [type, trigger] of [['integrate_deliveries', 'delivery.requested'], ['accept_worker', 'delivery.integrated']]) {
      const error = await post(f, 'worker.hook_attach', { id: f.parent.id, expected_revision: model.revision,
        hook: { name: 'unauthorized tool', mode: 'persistent', enabled: true, trigger, actions: [{ type }] } }, 400);
      expect(error.error).toContain('built-in');
    }
    await post(f, 'worker.hook_update', { id: f.parent.id, hook_id: 'delivery-handler', enabled: false, expected_revision: model.revision }, 400);
    await post(f, 'worker.hook_remove', { id: f.parent.id, hook_id: 'delivery-handler', expected_revision: model.revision }, 400);
    await post(f, 'automation.execute', { tool: 'integrate_deliveries', worker_id: f.parent.id }, 400);
    expect((await hooks(f, f.parent.id)).revision).toBe(model.revision);
    expect(f.store.task(f.task.id).integration).not.toBe('merged');
  } finally { await f.close(); }
});
