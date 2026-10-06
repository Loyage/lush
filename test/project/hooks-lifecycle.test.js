import { test, expect, setDefaultTimeout } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, repo, git, until } from '../helpers.js';
setDefaultTimeout(20000);
function rule(trigger, title = trigger) { return { name: title, trigger, mode: 'once', enabled: true,
  actions: [{ type: 'notify', title, body: '' }] }; }
function attach(f, task, hook) { return f.project.attachTaskHook(task.id, hook, f.project.taskHooks(task.id).revision); }

test('started, failed, safe pause, awaiting/resumed, cancelled and accepted are real runtime nodes', async () => {
  const f = fixture({ async run() { throw new Error('PRIVATE_PROVIDER_ERROR'); } }); await repo(f.root);
  try {
    const order = await f.project.order('failure','main',[],null,false);
    attach(f, order.task, rule('agent.started')); attach(f, order.task, rule('agent.failed'));
    f.project.resumeTask(order.task.id);
    await until(() => f.store.get("SELECT id FROM notices WHERE title='agent.failed'"));
    expect(f.store.get("SELECT id FROM notices WHERE title='agent.started'")).not.toBeNull();
    expect(f.project.running.has(order.task.id)).toBe(false);
    const next = await f.project.order('pause','main',[],null,false);
    attach(f, next.task, rule('agent.paused')); f.store.update(next.task.id, { status: 'waiting' });
    f.project.interrupt(next.task.id); await until(() => f.store.get("SELECT id FROM notices WHERE title='agent.paused'"));
    attach(f, next.task, rule('worker.awaiting')); attach(f, next.task, rule('worker.resumed'));
    const question = f.project.notice(next.task.id, 'decision', 'choose');
    await until(() => f.store.get("SELECT id FROM notices WHERE title='worker.awaiting'"));
    f.project.answer(question.id, 'answer');
    await until(() => f.store.get("SELECT id FROM notices WHERE title='worker.resumed'"));
    attach(f, next.task, rule('worker.cancelled')); f.project.cancel(next.task.id);
    await until(() => f.store.get("SELECT id FROM notices WHERE title='worker.cancelled'"));
    const accept = await f.project.order('accept','main',[],null,false);
    attach(f, accept.task, rule('worker.accepted')); f.store.update(accept.task.id, { status: 'waiting', integration: 'none', head_commit: accept.task.base_commit });
    await f.project.acceptTask(accept.task.id);
    await until(() => f.store.get("SELECT id FROM notices WHERE title='worker.accepted'"));
  } finally { await f.close(); }
});

test('a queued merge boundary creates a mounted Worker before the next merge acquires its baseline', async () => {
  const f = fixture(); f.project.stopping = true; f.project.kick = () => {}; await repo(f.root);
  try {
    const first = await f.project.order('first','main',[],null,false), second = await f.project.order('second','main',[],null,false);
    for (const [order, file] of [[first,'first.txt'],[second,'second.txt']]) {
      fs.writeFileSync(path.join(order.task.workspace, file), file); await git(order.task.workspace, 'add','.'); await git(order.task.workspace,'commit','-m',file);
      f.store.update(order.task.id, { status: 'waiting', head_commit: await git(order.task.workspace,'rev-parse','HEAD') });
      await f.project.reserveTask(order.task.id, 'merge');
    }
    const initial = JSON.parse(f.store.task(first.task.id).reservation), parent = f.store.task(first.task.parent_id);
    const attempt = f.store.event(first.task.id,'merge.attempt_started',{ delivery_id: initial.delivery_id, parent_id: parent.id });
    f.store.update(first.task.id, { reservation: JSON.stringify({ ...initial, status: 'executing', attempt_id: attempt, original_commit: initial.commit }) });
    const mounted = attach(f, parent, { name: 'at boundary', trigger: 'worker.parent_ready', mode: 'once', enabled: true,
      actions: [{ type: 'create_worker', content: 'after first', start: false }] }).mounts.at(-1);
    attach(f, first.task, rule('delivery.integrated'));
    f.project.stopping = false; await f.project.driveTaskMerge(parent.id);
    await until(() => JSON.parse(f.store.task(second.task.id).reservation).attempt_id);
    const complete = f.project.taskHooks(parent.id).mounts.find(m => m.id === mounted.id);
    expect(complete.state).toBe('succeeded');
    const sourceReceipt = JSON.parse(f.store.task(first.task.id).reservation);
    expect(f.store.task(complete.last_execution.worker_id).base_commit).toBe(sourceReceipt.landed_commit);
    const created = f.store.get("SELECT id FROM events WHERE task_id=? AND type='hook.worker_created'", parent.id);
    expect(created.id).toBeLessThan(JSON.parse(f.store.task(second.task.id).reservation).attempt_id);
    await f.project.hookQueue;
    expect(f.store.get("SELECT id FROM notices WHERE title='delivery.integrated'")).not.toBeNull();
  } finally { await f.close(); }
});

test('creation rechecks frozen/sync admission inside the Git queue and retains failure diagnostics without raw output', async () => {
  const f = fixture(); f.project.kick = () => {}; await repo(f.root);
  try {
    const source = await f.project.order('source','main',[],null,false), parent = f.store.task(source.task.parent_id);
    const hook = attach(f, parent, { name: 'race', trigger: 'worker.parent_ready', mode: 'once', enabled: true,
      actions: [{ type: 'create_worker', content: 'race job', start: false }] }).mounts.at(-1);
    f.project.taskSyncBusy = new Set([parent.id]);
    f.project.observeTaskHooks(); await f.project.hookQueue;
    expect(f.project.taskHooks(parent.id).mounts.find(m => m.id === hook.id).state).toBe('waiting');
    f.project.taskSyncBusy.clear();
    const original = f.project.workspaces.anchor.bind(f.project.workspaces);
    f.project.workspaces.anchor = async (...args) => {
      f.store.update(source.task.id, { reservation: JSON.stringify({ version: 1, kind: 'merge', status: 'requested', commit: source.task.base_commit }) });
      return original(...args);
    };
    await f.project.runParentReadyHooks(parent.id);
    const failed = f.project.taskHooks(parent.id).mounts.find(m => m.id === hook.id);
    expect(failed.state).toBe('failed'); expect(failed.last_execution.error).toContain('未自动重试');
    expect(f.store.get('SELECT count(*) AS n FROM inputs').n).toBe(1);
    expect(fs.readdirSync(path.join(f.config.home,'worktrees'))).toHaveLength(1);
    f.store.update(source.task.id, { reservation: null });
  } finally { await f.close(); }
});
