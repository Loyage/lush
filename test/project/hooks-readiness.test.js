import { test, expect, setDefaultTimeout } from 'bun:test';
import { fixture, repo, until } from '../helpers.js';
import { AgentPreempted } from '../../src/agent/provider.js';
setDefaultTimeout(20000);
const notify = (trigger, mode = 'once') => ({ name: trigger, trigger, mode, enabled: true, actions: [{ type: 'notify', title: trigger, body: '' }] });
const attach = (f, task, hook) => f.project.attachTaskHook(task.id, hook, f.project.taskHooks(task.id).revision);

test('persistent parent_ready is an edge, not a notification on every pump or fair boundary', async () => {
  const f = fixture(); f.project.kick = () => {}; await repo(f.root);
  try {
    const parent = await f.project.ensureMainTask();
    attach(f, parent, notify('worker.parent_ready', 'persistent'));
    f.project.observeTaskHooks(); await f.project.hookQueue;
    f.project.observeTaskHooks(); await f.project.runParentReadyHooks(parent.id); await f.project.runParentReadyHooks(parent.id);
    expect(f.store.get("SELECT count(*) AS n FROM notices WHERE title='worker.parent_ready'").n).toBe(1);
  } finally { await f.close(); }
});

test('no-code normal work can notify completion, but a standard open question still blocks delivery-ready', async () => {
  const f = fixture({ async run() { return 'no code needed'; } }); await repo(f.root);
  try {
    const order = await f.project.order('explain','main',[],null,false);
    attach(f, order.task, notify('worker.delivery_ready'));
    f.project.resumeTask(order.task.id);
    await until(() => f.store.get("SELECT id FROM notices WHERE title='worker.delivery_ready'"));
    expect(f.project.mergeReadiness(f.store.task(order.task.id)).ready).toBe(false);
    const another = await f.project.order('decision','main',[],null,false);
    attach(f, another.task, notify('worker.delivery_ready'));
    f.store.update(another.task.id, { status: 'waiting', head_commit: another.task.base_commit });
    f.project.notice(another.task.id, 'standard question');
    f.project.observeTaskHooks(); await f.project.hookQueue;
    expect(f.store.get("SELECT count(*) AS n FROM notices WHERE title='worker.delivery_ready'").n).toBe(1);
  } finally { await f.close(); }
});

test('a deferred start creates its worktree and immediately schedules the saved Agent parameters', async () => {
  let invocation = null;
  const f = fixture({ async run({ task, agent, cwd }) { invocation = { task, agent, cwd }; return 'started'; } });
  f.project.stopping = true; await repo(f.root);
  try {
    const source = await f.project.order('freeze','main',[],null,false);
    f.store.update(source.task.id, { reservation: JSON.stringify({ version: 1, kind: 'merge', status: 'requested', commit: source.task.base_commit }) });
    const queued = await f.project.order('start after release','main',[],null,true,undefined,
      { agent: 'pi', model: 'selected/model', thinking: 'high', env: { SAVED: 'value' } }, true);
    expect(invocation).toBeNull();
    f.store.update(source.task.id, { reservation: null }); f.project.stopping = false; f.project.kick();
    await until(() => invocation);
    const mount = f.project.taskHooks(source.task.parent_id).mounts.find(m => m.id === queued.hook_id);
    expect(invocation.task.id).toBe(mount.last_execution.worker_id);
    expect(invocation.agent).toMatchObject({ agent: 'pi', model: 'selected/model', thinking: 'high', env: { SAVED: 'value' } });
    expect(invocation.cwd).toBe(f.store.task(invocation.task.id).workspace);
    expect(invocation.task.hooks).toBeUndefined(); expect(invocation.task.retry_profile).toBeUndefined();
  } finally { await f.close(); }
});

test('a preempted invocation emits the input-preemption node, not the failure node', async () => {
  const f = fixture({ async run() { throw new AgentPreempted({ reason: 'new input', safe_point: 'turn_end' }); } }); await repo(f.root);
  try {
    const order = await f.project.order('preempt','main',[],null,false);
    attach(f, order.task, notify('agent.preempted')); attach(f, order.task, notify('agent.failed'));
    f.project.resumeTask(order.task.id);
    await until(() => f.store.get("SELECT id FROM notices WHERE title='agent.preempted'"));
    expect(f.store.get("SELECT id FROM notices WHERE title='agent.failed'")).toBeNull();
    expect(f.store.task(order.task.id).status).toBe('waiting');
  } finally { await f.close(); }
});

test('locked child automatic merge is a built-in mount and cannot be removed or disabled through generic Hook APIs', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const order = await f.project.order('parent','main',[],null,false), child = await f.project.spawn(order.task.id, 'child');
    const view = f.project.taskHooks(child.id), automatic = view.mounts[0];
    expect(automatic).toMatchObject({ id: 'auto-merge', trigger: 'worker.delivery_ready', mode: 'persistent', enabled: true, locked: true });
    await expect(f.project.updateTaskHook(child.id, 'auto-merge', false, view.revision)).rejects.toThrow('不能关闭');
    expect(() => f.project.removeTaskHook(child.id, 'auto-merge', view.revision)).toThrow('cannot be removed');
  } finally { await f.close(); }
});
