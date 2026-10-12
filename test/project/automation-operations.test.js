import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, repo, git, until } from '../helpers.js';
import { Project } from '../../src/core/project.js';
import { normalizeHook } from '../../src/core/hooks.js';

const request = (f, task) => JSON.parse(f.store.task(task.id).reservation ?? 'null');
const mount = (f, task, name) => f.project.taskHooks(task.id).mounts.find(row => row.id === name);
async function setup(strategy = 'serial', changes = true, level = 'merge') {
  const f = fixture(); f.project.kick = () => { f.project.scheduleTaskCompletion(); }; f.project.stopping = true;
  try {
    await repo(f.root); const parent = await f.project.bootstrapMain();
    if (strategy === 'converge') await f.project.setBranchConvergence('main', true, null, (await f.project.branchConvergence('main')).revision);
    const { task } = await f.project.order('controlled operation', 'main', [], null, false);
    if (level !== 'off') await f.project.setTaskCompletion(task.id, level, f.project.taskHooks(task.id).revision);
    if (changes) {
      fs.writeFileSync(path.join(task.workspace, 'operation.txt'), 'fixed source\n');
      await git(task.workspace, 'add', '.'); await git(task.workspace, 'commit', '-m', 'source');
    }
    f.store.update(task.id, { status: 'waiting' });
    await f.project.workspaces.finish(task);
    return { ...f, parent, task };
  } catch (error) { await f.close(); throw error; }
}
async function land(f, strategy) {
  f.project.stopping = false;
  if (strategy === 'converge') {
    const run = await f.project.formConvergenceBatch(f.parent.id);
    await f.project.prepareConvergenceRun(run.id, run.generation, new AbortController().signal);
  } else await f.project.driveTaskMerge(f.parent.id);
  await f.project.completionQueue;
  f.project.scheduleTaskCompletion(f.task.id); await f.project.completionQueue;
}

for (const strategy of ['serial', 'converge']) for (const changes of [true, false]) {
  test(`${strategy} ${changes ? 'Git' : 'no-change'} delivery and automatic acceptance dispatch real catalogue tools with exact safe receipts`, async () => {
    const f = await setup(strategy, changes, 'accept');
    try {
      const calls = [], dispatch = f.project.dispatchAutomationOperation.bind(f.project);
      f.project.dispatchAutomationOperation = (tool, workerId, context) => { calls.push({ tool, workerId, phase: context?.phase }); return dispatch(tool, workerId, context); };
      expect(mount(f, f.task, 'auto-merge').operation).toBeNull();
      expect(mount(f, f.parent, 'delivery-handler').operation).toBeNull();
      await f.project.settleQueuedMerge(f.task.id);
      const sourceOp = mount(f, f.task, 'auto-merge').operation;
      const targetOp = mount(f, f.parent, 'delivery-handler').operation;
      expect(sourceOp).toMatchObject({ version: 1, tool: 'request_merge', worker_id: f.task.id, status: changes ? 'submitted' : 'succeeded' });
      expect(targetOp).toMatchObject({ version: 1, tool: 'integrate_deliveries', strategy, status: changes ? 'submitted' : 'succeeded' });
      expect(f.store.task(f.task.id).status).toBe(changes ? 'waiting' : 'awaiting_acceptance');
      expect(mount(f, f.task, 'auto-accept').operation).toBeNull();
      if (changes) await land(f, strategy);
      else { f.project.stopping = false; f.project.scheduleTaskCompletion(f.task.id); await f.project.completionQueue; }
      await until(() => f.store.task(f.task.id).status === 'completed');
      await f.project.completionQueue;
      expect(mount(f, f.task, 'auto-merge').operation).toMatchObject({ id: sourceOp.id, status: 'succeeded' });
      expect(mount(f, f.parent, 'delivery-handler').operation).toMatchObject({ id: targetOp.id, status: 'succeeded' });
      expect(mount(f, f.task, 'auto-accept').operation).toMatchObject({ tool: 'accept_worker', status: 'succeeded' });
      expect(fs.existsSync(f.task.workspace)).toBe(false);
      expect(await git(f.root, 'rev-list', '--count', 'main')).toBe(changes ? '2' : '1');
      expect(calls.some(call => call.tool === 'request_merge')).toBe(true);
      expect(calls.some(call => call.tool === 'integrate_deliveries' && call.phase === 'pin')).toBe(true);
      expect(calls.some(call => call.tool === 'accept_worker')).toBe(true);
      const history = f.store.history(f.task.id), submitted = history.find(row => row.type === 'completion.execution_submitted');
      const started = history.find(row => row.type === 'completion.execution_started');
      expect(started.data.execution_id).toBe(submitted.id);
      expect(history.find(row => row.type === 'task.accepted').data.completion_execution).toBe(submitted.id);
      const before = f.store.get('SELECT count(*) AS n FROM events').n;
      f.project.taskHooks(f.parent.id); f.project.taskHooks(f.task.id); f.project.inspect(f.task.id);
      expect(f.store.get('SELECT count(*) AS n FROM events').n).toBe(before);
    } finally { await f.close(); }
  });
}

test('directory, unique protected handler, compatibility revisions and builtin-only boundaries remain one source', async () => {
  const f = await setup();
  try {
    for (const type of ['request_merge','accept_worker','integrate_deliveries']) expect(f.project.hooksList().actions.find(row => row.type === type).execution).toBe('operation');
    expect(f.project.hooksList().actions.find(row => row.type === 'integrate_deliveries')).toMatchObject({ builtin_only: true, agent_call: true, scope: 'target', strategies: ['serial','converge'] });
    const hooks = f.project.taskHooks(f.parent.id), handler = mount(f, f.parent, 'delivery-handler');
    expect(hooks.mounts.filter(row => row.kind === 'delivery_handler')).toHaveLength(1);
    expect(handler).toMatchObject({ enabled: true, locked: true, editable: false, removable: false, actions: [{ type: 'integrate_deliveries', strategy: 'serial' }] });
    await expect(f.project.updateTaskHook(f.parent.id, handler.id, false, hooks.revision)).rejects.toThrow('protected');
    expect(() => f.project.removeTaskHook(f.parent.id, handler.id, hooks.revision)).toThrow('cannot be removed');
    for (const [trigger, type] of [['delivery.requested','integrate_deliveries'],['delivery.integrated','accept_worker'],['delivery.requested','notify']]) {
      expect(() => normalizeHook({ name: 'bypass', trigger, mode: 'persistent', enabled: true, actions: [{ type }] })).toThrow('not allowed');
    }
    await f.project.setBranchConvergence('main', true, null, hooks.convergence.revision);
    expect(f.project.taskHooks(f.parent.id).revision).not.toBe(hooks.revision);
    expect(mount(f, f.parent, handler.id).actions[0].strategy).toBe('converge');
    const view = await f.project.branchConvergence('main');
    await f.project.setBranchConvergence('main', false, null, view.revision, false);
    expect(mount(f, f.parent, handler.id)).toMatchObject({ enabled: true, actions: [{ type: 'integrate_deliveries', strategy: 'serial' }] });
    const child = await f.project.spawn(f.task.id, 'locked child');
    expect(mount(f, child, 'auto-merge')).toMatchObject({ enabled: true, locked: true });
    expect(mount(f, child, 'auto-accept').enabled).toBe(false);
    await expect(f.project.setTaskCompletion(child.id, 'accept', f.project.taskHooks(child.id).revision)).rejects.toThrow('锁定');
    expect(() => f.project.dispatchAutomationOperation('command', f.task.id)).toThrow('unsupported');
    expect(() => f.project.dispatchAutomationOperation('integrate_deliveries', child.id, { phase: 'pin', selection: f.project.deliveryHandlerSelection(child), sourceId: f.task.id, deliveryId: 999 })).toThrow();
  } finally { await f.close(); }
});

test('generic merge Hook and automatic/manual submissions use the same idempotent operation, without projecting ACK as integration', async () => {
  const f = await setup('serial', true, 'off');
  try {
    const rule = f.project.attachTaskHook(f.task.id, { name: 'request', trigger: 'worker.delivery_ready', mode: 'persistent', enabled: true, actions: [{ type: 'request_merge' }] }, f.project.taskHooks(f.task.id).revision).mounts.at(-1);
    f.project.stopping = false;
    // Keep the actual publisher unavailable, not a fake success response.
    const parent = f.store.task(f.parent.id); f.store.update(parent.id, { status: 'running' });
    f.project.emitTaskHook(f.task.id, 'worker.delivery_ready', 987);
    await f.project.hookQueue;
    const hook = mount(f, f.task, rule.id);
    expect(hook.state).toBe('succeeded'); // the authorized submission completed
    expect(hook.operation).toMatchObject({ tool: 'request_merge', status: 'submitted' }); // actual merge did not
    expect(f.store.task(f.task.id).integration).not.toBe('merged');
    await f.project.requestTaskMerge(f.task.id);
    expect(mount(f, f.task, rule.id).operation.id).toBe(hook.operation.id);
    expect(f.store.history(f.task.id).filter(row => row.type === 'automation.operation_submitted')).toHaveLength(1);
    expect(f.store.history(parent.id).filter(row => row.type === 'delivery.requested')).toHaveLength(1);
    f.store.update(parent.id, { status: 'waiting' }); await f.project.driveTaskMerge(parent.id);
    await until(() => f.store.task(f.task.id).integration === 'merged');
    expect(mount(f, f.task, rule.id).operation).toMatchObject({ id: hook.operation.id, status: 'succeeded' });
  } finally { await f.close(); }
});

test('fixed routing survives future disabling; policy generation and revision are rechecked atomically', async () => {
  const f = await setup('converge');
  try {
    await f.project.settleQueuedMerge(f.task.id);
    const pinned = request(f, f.task), policy = await f.project.branchConvergence('main');
    await f.project.setBranchConvergence('main', false, null, policy.revision, false);
    expect(request(f, f.task)).toEqual(pinned);
    expect(mount(f, f.parent, 'delivery-handler').actions[0].strategy).toBe('serial');
    expect(mount(f, f.parent, 'delivery-handler').operation.strategy).toBe('converge');
    await land(f, 'converge');
    expect(f.store.task(f.task.id).integration).toBe('merged');
  } finally { await f.close(); }
  const race = await setup('converge');
  try {
    const selection = race.project.deliveryHandlerSelection.bind(race.project), syncBase = race.project.workspaces.taskSyncBase.bind(race.project.workspaces);
    let changed = false;
    race.project.deliveryHandlerSelection = task => {
      const value = selection(task);
      return changed ? { ...value, revision: 'changed revision' } : value;
    };
    race.project.workspaces.taskSyncBase = async (...args) => { const base = await syncBase(...args); changed = true; return base; };
    await expect(race.project.settleQueuedMerge(race.task.id)).rejects.toThrow('policy changed');
    expect(request(race, race.task).status).toBe('pending');
    expect(race.store.history(race.parent.id).filter(row => row.type === 'delivery.requested')).toHaveLength(0);
    expect(race.store.history(race.task.id).filter(row => row.type === 'merge.enqueued')).toHaveLength(0);
  } finally { await race.close(); }
});

test('dirty preflight is a durable wait with no deletion claim and resumes safely; buffered input and live calls still block acceptance', async () => {
  const waiting = await setup('serial', true, 'merge');
  try {
    await waiting.project.settleQueuedMerge(waiting.task.id); await land(waiting, 'serial');
    waiting.project.stopping = true;
    await waiting.project.setTaskCompletion(waiting.task.id, 'accept', waiting.project.taskHooks(waiting.task.id).revision);
    const dirty = path.join(waiting.task.workspace, 'private.txt'); fs.writeFileSync(dirty, 'PRIVATE_TOKEN');
    waiting.project.stopping = false; await waiting.project.runTaskCompletion(waiting.task.id);
    const operation = mount(waiting, waiting.task, 'auto-accept').operation;
    expect(operation).toMatchObject({ tool: 'accept_worker', status: 'waiting' });
    expect(waiting.store.history(waiting.task.id).filter(row => row.type === 'completion.execution_started')).toHaveLength(0);
    expect(JSON.stringify(waiting.project.taskHooks(waiting.task.id))).not.toContain('PRIVATE_TOKEN');
    fs.unlinkSync(dirty);
    const messageId = waiting.store.message(waiting.task.id, 'next input');
    waiting.store.run("UPDATE messages SET delivery_hold='delivery' WHERE id=?", messageId);
    await waiting.project.runTaskCompletion(waiting.task.id);
    expect(fs.existsSync(waiting.task.workspace)).toBe(true);
    waiting.store.run('UPDATE messages SET consumed=1 WHERE id=?', messageId);
    waiting.project.running.set(waiting.task.id, {});
    await waiting.project.runTaskCompletion(waiting.task.id);
    expect(fs.existsSync(waiting.task.workspace)).toBe(true);
    waiting.project.running.delete(waiting.task.id);
    await waiting.project.runTaskCompletion(waiting.task.id);
    expect(mount(waiting, waiting.task, 'auto-accept').operation).toMatchObject({ id: operation.id, status: 'succeeded' });
    expect(fs.existsSync(waiting.task.workspace)).toBe(false);
  } finally { waiting.project.running.delete(waiting.task.id); await waiting.close(); }
});

test('interrupted acceptance effect becomes unknown without replay, while legacy in-flight receipts are not assigned invented operations', async () => {
  const f = await setup('serial', true, 'merge');
  try {
    await f.project.settleQueuedMerge(f.task.id); await land(f, 'serial');
    f.project.stopping = true; await f.project.setTaskCompletion(f.task.id, 'accept', f.project.taskHooks(f.task.id).revision);
    const config = JSON.parse(f.store.task(f.task.id).auto_merge), data = config.completion;
    const executionId = f.store.event(f.task.id, 'completion.execution_started', { phase: 'accept', round: data.round, authorization: data.authorization, head_commit: f.store.task(f.task.id).head_commit });
    data.executions.accept = { id: executionId, phase: 'accept', round: data.round, authorization: data.authorization, head_commit: f.store.task(f.task.id).head_commit, status: 'running', created_at: new Date().toISOString() };
    f.store.update(f.task.id, { auto_merge: JSON.stringify(config) });
    const restarted = new Project(f.config, f.store); restarted.stopping = true;
    restarted.recoverTaskCompletion();
    expect(restarted.taskHooks(f.task.id).mounts.find(row => row.id === 'auto-accept').operation.status).toBe('unknown');
    restarted.acceptWorkerOperation = () => { throw new Error('must not replay'); };
    restarted.stopping = false; restarted.scheduleTaskCompletion(f.task.id); await restarted.completionQueue;
    expect(fs.existsSync(f.task.workspace)).toBe(true);
    await restarted.shutdown();
    const pinned = request(f, f.task); delete pinned.request_operation_id; delete pinned.handler_operation_id;
    f.store.update(f.task.id, { reservation: JSON.stringify(pinned) });
    f.store.run("DELETE FROM events WHERE task_id IN (?,?) AND type IN ('automation.operation_submitted','delivery.requested')", f.task.id, f.parent.id);
    expect(mount(f, f.task, 'auto-merge').operation).toBeNull();
    expect(mount(f, f.parent, 'delivery-handler').operation).toBeNull();
  } finally { await f.close(); }
});
