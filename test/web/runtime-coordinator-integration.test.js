import { test, expect } from 'bun:test';
import { repo, git, until } from '../helpers.js';
import { setup, fetch } from './harness.js';
import { RPCClient } from '../../src/rpc/client.js';

async function action(f, method, params) {
  const response = await fetch(f.url + '/api/action', { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, params }) });
  expect(response.status).toBe(200);
  return response.json();
}
async function prepare() {
  const f = await setup(); f.project.stopping = true;
  await repo(f.root); await f.project.ensureMainTask();
  return f;
}

test('HTTP -> RPC -> durable emission -> coordinator -> real Provider invocation and bound RPC result', async () => {
  const f = await prepare(), rpc = new RPCClient(f.config.socket), calls = [];
  let read, denied;
  try {
    f.project.provider = { async run({ task, token }) {
      calls.push(task.id);
      read = await rpc.request('worker.inspect', { id: task.id, _token: token });
      try { await rpc.request('input.emit', { content: 'must require user approval', _token: token }); }
      catch (error) { denied = error.message; }
      return 'coordinated actual invocation result';
    } };
    const definition = { content: 'coordinated HTTP input', client_request_id: 'coordinator-once' };
    const mounted = await action(f, 'input.emit', definition);
    expect(mounted.dispatch.state).toBe('queued'); expect(mounted.task).toBeUndefined();
    expect(f.store.all('SELECT * FROM inputs')).toHaveLength(0); expect(calls).toEqual([]);
    f.project.stopping = false;
    // No manual pump/drain/observer invocation: both scheduling entrypoints use the new registry.
    f.project.kick(); f.project.scheduleInputEmissions();
    await until(() => f.project.inputEmissionResult(mounted.draft_id).dispatch.state === 'succeeded');
    const receipt = f.project.inputEmissionResult(mounted.draft_id), workerId = receipt.dispatch.worker_id;
    await until(() => !f.project.running.has(workerId) && f.store.task(workerId).result === 'coordinated actual invocation result');
    expect(read.id).toBe(workerId); expect(denied).toContain('requires user approval');
    expect(calls).toEqual([workerId]);
    expect(f.store.task(f.store.task(workerId).parent_id).calls).toBe(0);
    expect((await action(f, 'input.emit', definition)).dispatch.worker_id).toBe(workerId);
    for (let i = 0; i < 50; i++) { f.project.kick(); f.project.scheduleTaskHooks(); f.project.scheduleInputEmissions(); }
    await until(() => f.project.runtimeCoordinator.pendingCount === 0 && f.project.runtimeCoordinator.runningCount === 0);
    expect(calls).toEqual([workerId]); expect(f.store.all('SELECT * FROM inputs')).toHaveLength(1);
    expect(f.store.get('SELECT status FROM agent_runs WHERE task_id=?', workerId).status).toBe('completed');
  } finally { await f.close(); }
});

test('coordinated checks preserve frozen admission, cancellation, current baseline and a single ready edge', async () => {
  const f = await prepare(), calls = [];
  try {
    const source = await action(f, 'order.submit', { content: 'freeze source', start: false });
    const mainId = source.task.parent_id;
    f.store.update(source.task.id, { reservation: JSON.stringify({ version: 1, kind: 'merge', status: 'requested', commit: source.task.base_commit }) });
    await action(f, 'worker.hook_attach', { id: mainId, expected_revision: f.project.taskHooks(mainId).revision,
      hook: { name: 'parent writable', trigger: 'worker.parent_ready', mode: 'persistent', enabled: true,
        actions: [{ type: 'notify', title: 'coordinator-ready-edge', body: 'ready' }] } });
    const cancelled = await action(f, 'input.emit', { content: 'cancel before admission', client_request_id: 'coordinator-cancel' });
    const waiting = await action(f, 'input.emit', { content: 'wait for parent', client_request_id: 'coordinator-wait' });
    await action(f, 'input.emission_cancel', { draft_id: cancelled.draft_id, expected_revision: cancelled.revision });
    f.project.provider = { async run({ task }) { calls.push(task.id); return 'after safe release'; } };
    f.project.stopping = false; f.project.kick(); f.project.scheduleTaskHooks();
    await until(() => f.project.runtimeCoordinator.pendingCount === 0 && f.project.runtimeCoordinator.runningCount === 0);
    expect(f.project.inputEmissionResult(waiting.draft_id).dispatch.state).toBe('queued');
    expect(f.store.all('SELECT * FROM inputs')).toHaveLength(1); expect(calls).toEqual([]);
    expect(f.store.get("SELECT count(*) AS n FROM notices WHERE title='coordinator-ready-edge'").n).toBe(0);
    await git(f.root, 'commit', '--allow-empty', '-m', 'parent advances before release');
    const baseline = await git(f.root, 'rev-parse', 'HEAD');
    // Controlled release of the existing freeze fixture; the actual business gate is not mocked.
    f.store.update(source.task.id, { reservation: null });
    f.project.kick(); f.project.scheduleTaskHooks();
    await until(() => f.project.inputEmissionResult(waiting.draft_id).dispatch.state === 'succeeded');
    const workerId = f.project.inputEmissionResult(waiting.draft_id).dispatch.worker_id;
    await until(() => calls.length === 1 && !f.project.running.has(workerId));
    await until(() => f.store.get("SELECT count(*) AS n FROM notices WHERE title='coordinator-ready-edge'").n === 1);
    expect(f.store.task(workerId).base_commit).toBe(baseline);
    expect(f.project.inputEmissionResult(cancelled.draft_id).dispatch.state).toBe('cancelled');
    for (let i = 0; i < 20; i++) { f.project.kick(); f.project.scheduleTaskHooks(); }
    await until(() => f.project.runtimeCoordinator.pendingCount === 0 && f.project.runtimeCoordinator.runningCount === 0);
    expect(f.store.get("SELECT count(*) AS n FROM notices WHERE title='coordinator-ready-edge'").n).toBe(1);
    expect(f.store.all('SELECT * FROM inputs')).toHaveLength(2); expect(calls).toEqual([workerId]);
  } finally { await f.close(); }
});
