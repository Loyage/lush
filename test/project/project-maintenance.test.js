import { test, expect, setDefaultTimeout } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, repo, gate, until, git } from '../helpers.js';
import { Project } from '../../src/core/project.js';
import { AgentPreempted } from '../../src/agent/provider.js';
setDefaultTimeout(30000);

function controlled(agent = 'pi') {
  const calls = [];
  return { calls,
    resolve: () => ({ agent, model: '', thinking: '', default_prompt: '', append_prompt: '', extensions: [], skills: [] }),
    run(options) {
      const done = gate(); calls.push({ ...options, done });
      return new Promise((resolve, reject) => {
        const abort = () => reject(options.signal.reason ?? new Error('aborted'));
        if (options.signal.aborted) return abort();
        options.signal.addEventListener('abort', abort, { once: true });
        done.promise.then(value => { options.signal.removeEventListener('abort', abort); value instanceof Error ? reject(value) : resolve(value ?? 'done'); });
      });
    },
  };
}
async function setup(agent = 'pi') {
  const provider = controlled(agent), f = fixture(provider);
  f.provider = provider; f.project.stopping = true; await repo(f.root);
  return f;
}
async function start(f, tasks) {
  f.project.stopping = false; f.project.kick();
  await until(() => tasks.every(task => f.provider.calls.some(call => call.task.id === task.id)));
}
function call(f, id) { return f.provider.calls.findLast(row => row.task.id === id); }
function claim(f, id) {
  const dir = path.join(f.config.home, 'preempt');
  fs.renameSync(path.join(dir, `task-${id}.request.json`), path.join(dir, `task-${id}.stop.json`));
}
async function pauseExit(f, id, claimStop = true) {
  if (claimStop) claim(f, id);
  call(f, id).done.resolve(new AgentPreempted({ reason: 'project maintenance', safe_point: 'turn_end' }));
  await until(() => !f.project.running.has(id));
}
const events = (f, type) => f.store.all('SELECT * FROM events WHERE type=?', type);
async function attach(f, task, hook) { return f.project.attachTaskHook(task.id, hook, f.project.taskHooks(task.id).revision); }
const notifyHook = (title, trigger = 'agent.returned') => ({ name: title, trigger, mode: 'once', enabled: true,
  actions: [{ type: 'notify', title, body: 'maintenance test' }] });

// A paused project leaves idle Worker states alone: the gate, not a mass status rewrite,
// prevents child-waiting parents, questions and pre-existing staged work from being invoked.
test('persistent gate pauses only current calls; queues, personal pauses, staged and delivered states retain their identities', async () => {
  const f = await setup();
  try {
    const active = (await f.project.order('active')).task;
    const staged = (await f.project.order('staged', 'main', [], null, false)).task;
    const personal = (await f.project.order('personal')).task; f.project.interrupt(personal.id);
    const waiting = (await f.project.order('idle waiting')).task; f.store.update(waiting.id, { status: 'waiting' });
    const delivered = (await f.project.order('delivered')).task; f.store.update(delivered.id, { status: 'awaiting_acceptance' });
    const failed = (await f.project.order('failed')).task; f.project.cancel(failed.id, 'fixture', 'failed');
    await start(f, [active]);
    const revision = f.project.overviewRevision();
    expect(f.project.interruptAll()).toMatchObject({ paused: true, phase: 'pausing', active_calls: 1, affected_count: 1, ready_to_restart: false });
    expect(f.project.overviewRevision()).not.toBe(revision);
    expect(f.project.actor(f.project.running.get(active.id).token)).toBe(active.id);
    const queued = (await f.project.order('new while paused')).task;
    f.project.pump();
    expect(f.provider.calls).toHaveLength(1);
    expect(f.store.task(queued.id).status).toBe('queued');
    const meta = f.store.get("SELECT value FROM meta WHERE key='project_maintenance'").value;
    f.project.interruptAll(); expect(events(f, 'maintenance.interrupted')).toHaveLength(1);
    expect(f.store.get("SELECT value FROM meta WHERE key='project_maintenance'").value).toBe(meta);
    await pauseExit(f, active.id);
    expect(f.project.maintenanceView()).toMatchObject({ phase: 'paused', ready_to_restart: true, active_calls: 0 });
    expect(f.project.summary().maintenance).toEqual(f.project.maintenanceView());
    expect(f.project.status(false).maintenance).toEqual(f.project.maintenanceView());
    f.project.resumeAll(); f.project.resumeAll();
    await until(() => f.provider.calls.length === 3);
    expect(events(f, 'maintenance.resumed')).toHaveLength(1);
    for (const row of [staged, personal]) expect(f.store.task(row.id).status).toBe('paused');
    expect(f.store.task(waiting.id).status).toBe('waiting');
    expect(f.store.task(delivered.id).status).toBe('awaiting_acceptance');
    expect(f.store.task(failed.id).status).toBe('failed');
    expect(f.provider.calls.map(row => row.task.id).sort((a, b) => a - b)).toEqual([active.id, active.id, queued.id].sort((a, b) => a - b));
  } finally { await f.close(); }
});

test('resume before Pi claims the request cancels it without another model call', async () => {
  const f = await setup();
  try {
    const task = (await f.project.order('cancel unclaimed')).task; await start(f, [task]);
    const run = f.project.running.get(task.id);
    f.project.interruptAll(); f.project.resumeAll(); f.project.pump();
    expect(f.store.task(task.id)).toMatchObject({ status: 'running', interrupt_state: null });
    expect(run.controller.signal.aborted).toBe(false);
    expect(f.provider.calls).toHaveLength(1);
    expect(fs.existsSync(path.join(f.config.home, 'preempt', `task-${task.id}.request.json`))).toBe(false);
    call(f, task.id).done.resolve('continued original'); await until(() => !f.project.running.has(task.id));
    expect(f.store.task(task.id).calls).toBe(1);
  } finally { await f.close(); }
});

test('a claimed pause accepts all-continue immediately but never overlaps the old call', async () => {
  const f = await setup();
  try {
    const task = (await f.project.order('claimed')).task; await start(f, [task]);
    const old = f.project.running.get(task.id);
    f.project.interruptAll(); claim(f, task.id); f.project.resumeAll(); f.project.resumeAll(); f.project.pump();
    expect(f.store.task(task.id)).toMatchObject({ status: 'queued', interrupt_state: 'resuming' });
    expect(f.provider.calls).toHaveLength(1);
    call(f, task.id).done.resolve(new AgentPreempted());
    await until(() => f.provider.calls.length === 2);
    expect(f.project.running.get(task.id)).not.toBe(old);
    expect(f.store.task(task.id).calls).toBe(2);
    expect(() => f.project.actor(old.token)).toThrow('expired');
  } finally { await f.close(); }
});

test('later individual pause wins; batch resume preserves the saved profile without starting that Worker', async () => {
  const f = await setup();
  try {
    const a = (await f.project.order('individual pause')).task, b = (await f.project.order('profile preserved')).task;
    await start(f, [a, b]); f.project.interruptAll();
    f.project.interrupt(a.id); // Already requested, but this is now a personal intent.
    const profile = { agent: 'pi', model: 'kept-model', thinking: 'high', append_prompt: 'private' };
    f.project.configureTask(b.id, profile);
    await pauseExit(f, a.id); await pauseExit(f, b.id);
    expect(f.project.maintenanceView().affected_count).toBe(1);
    f.project.resumeAll(); await until(() => f.provider.calls.length === 3);
    expect(f.store.task(a.id).status).toBe('paused');
    expect(call(f, b.id).agent).toMatchObject({ model: 'kept-model', append_prompt: 'private' });
    expect(f.store.task(b.id).workspace).toBe(b.workspace);
  } finally { await f.close(); }
});

test('maintenance after an asynchronous model selection prevents any late provider launch', async () => {
  const f = await setup(); const entered = gate(), selected = gate();
  try {
    f.project.agentSelection = { enabled: true,
      select: async (_task, profile) => { entered.resolve(); await selected.promise; return profile; } };
    const task = (await f.project.order('selection race')).task;
    f.project.stopping = false; f.project.kick(); await entered.promise;
    expect(f.project.running.has(task.id)).toBe(true);
    f.project.interruptAll(); selected.resolve();
    await until(() => !f.project.running.has(task.id));
    expect(f.provider.calls).toHaveLength(0);
    expect(f.store.task(task.id).status).toBe('paused');
    expect(f.project.maintenanceView().ready_to_restart).toBe(true);
    f.project.resumeAll(); await until(() => f.provider.calls.length === 1);
  } finally { selected.resolve(); await f.close(); }
});

test('a gate closing after Run creation but before provider start preserves unread messages and prevents the call', async () => {
  const f = await setup(); const entered = gate(), release = gate();
  try {
    const task = (await f.project.order('preparation race')).task;
    f.project.message(task.id, 'not delivered yet');
    const context = f.project.invocationContext.bind(f.project);
    let once = true;
    f.project.invocationContext = async (...args) => { if (once) { once = false; entered.resolve(); await release.promise; } return context(...args); };
    f.project.stopping = false; f.project.kick(); await entered.promise;
    f.project.interruptAll(); release.resolve();
    await until(() => !f.project.running.has(task.id));
    expect(f.provider.calls).toHaveLength(0);
    expect(f.store.unread(task.id).map(row => row.body)).toEqual(['not delivered yet']);
    expect(f.store.get('SELECT status FROM agent_runs WHERE task_id=?', task.id).status).toBe('preempted');
    f.project.resumeAll(); await until(() => f.provider.calls.length === 1);
    expect(call(f, task.id).messages.map(row => row.body)).toEqual(['not delivered yet']);
  } finally { release.resolve(); await f.close(); }
});

test('cancellation during the final asynchronous branch preparation never launches a late provider', async () => {
  const f = await setup(); const entered = gate(), release = gate();
  try {
    const task = (await f.project.order('cancel preparation race')).task;
    const observe = f.project.workspaces.observeOwnedBranch.bind(f.project.workspaces);
    f.project.workspaces.observeOwnedBranch = async (...args) => {
      const observation = await observe(...args); entered.resolve(); await release.promise; return observation;
    };
    f.project.stopping = false; f.project.kick(); await entered.promise;
    f.project.cancel(task.id); release.resolve();
    await until(() => !f.project.running.has(task.id));
    expect(f.provider.calls).toHaveLength(0);
    expect(f.store.task(task.id).status).toBe('cancelled');
    expect(f.store.get('SELECT status,error FROM agent_runs WHERE task_id=?', task.id))
      .toMatchObject({ status: 'cancelled', error: 'cancelled by user' });
  } finally { release.resolve(); await f.close(); }
});

test('non-safe-boundary backend returns naturally without abort; late Git cleanup is still a restart barrier', async () => {
  const f = await setup('mock'); const cleanup = gate(), entered = gate();
  try {
    const task = (await f.project.order('natural exit')).task; await start(f, [task]);
    const original = f.project.workspaces.closeOwnedBranch.bind(f.project.workspaces);
    f.project.workspaces.closeOwnedBranch = async (...args) => { entered.resolve(); await cleanup.promise; return original(...args); };
    const old = f.project.running.get(task.id); f.project.interruptAll();
    expect(old.controller.signal.aborted).toBe(false);
    call(f, task.id).done.resolve('natural result'); await entered.promise;
    expect(f.project.maintenanceView()).toMatchObject({ ready_to_restart: false, active_calls: 1 });
    cleanup.resolve(); await until(() => !f.project.running.has(task.id));
    expect(f.store.task(task.id)).toMatchObject({ status: 'paused', result: 'natural result', error: null });
    expect(f.project.maintenanceView()).toMatchObject({ ready_to_restart: true });
  } finally { cleanup.resolve(); await f.close(); }
});

test('ready-to-restart and overview revision reflect real model, Git, write, Hook, sync and acceptance barriers', async () => {
  const f = await setup();
  try {
    f.project.stopping = false; f.project.interruptAll();
    const idle = f.project.overviewRevision();
    f.project.introRunning.set('test', {});
    expect(f.project.maintenanceView()).toMatchObject({ active_calls: 1, ready_to_restart: false });
    f.project.introRunning.clear();
    const properties = ['taskSyncBusy','acceptanceBusy','workerDeleteIds','commandHookRunning','completionBusy','lifecycleHookRunning'];
    for (const prop of properties) {
      f.project[prop] = new Set([5]);
      expect(f.project.maintenanceView()).toMatchObject({ ready_to_restart: false, phase: 'pausing' });
      expect(f.project.maintenanceView().pending_operations).toBeGreaterThan(0);
      expect(f.project.overviewRevision()).not.toBe(idle);
      f.project[prop].clear();
    }
    f.project.writing = 1; expect(f.project.maintenanceView().ready_to_restart).toBe(false); f.project.writing = 0;
    const entered = gate(), release = gate();
    const job = f.project.workspaces.exclusive(async () => { entered.resolve(); await release.promise; });
    await entered.promise;
    expect(f.project.maintenanceView().blockers.join(' ')).toContain('Git');
    release.resolve(); await job;
    expect(f.project.maintenanceView().ready_to_restart).toBe(true);
    expect(f.project.overviewRevision()).toBe(idle);
  } finally { await f.close(); }
});

test('a waiting parent and grandparent stay idle until the entire child delivery wave is settled', async () => {
  const f = await setup();
  try {
    const parent = (await f.project.order('parent waiting')).task;
    const child = await f.project.spawn(parent.id, 'child waiting');
    const grandchild = await f.project.spawn(child.id, 'grandchild active');
    f.store.update(parent.id, { status: 'waiting' }); f.store.update(child.id, { status: 'waiting' });
    await start(f, [grandchild]);
    f.project.interruptAll(); await pauseExit(f, grandchild.id);
    f.project.resumeAll(); await until(() => f.provider.calls.length === 2);
    expect(f.provider.calls.every(row => row.task.id === grandchild.id)).toBe(true);
    expect(f.store.task(parent.id).status).toBe('waiting');
    expect(f.store.task(child.id).status).toBe('waiting');
    call(f, grandchild.id).done.resolve('grandchild delivered');
    await until(() => f.provider.calls.some(row => row.task.id === child.id));
    expect(f.store.task(grandchild.id).status).toBe('awaiting_acceptance');
    expect(f.store.task(parent.id).status).toBe('waiting');
  } finally { await f.close(); }
});

test('explicit parent input saved during maintenance wakes it after resume without waiting for the child', async () => {
  const f = await setup();
  try {
    const parent = (await f.project.order('waiting parent')).task;
    const child = await f.project.spawn(parent.id, 'active child');
    f.store.update(parent.id, { status: 'waiting' }); await start(f, [child]);
    f.project.interruptAll();
    const reply = f.project.message(parent.id, 'urgent parent work');
    expect(reply.input_queue.buffered).toBe(1);
    expect(f.provider.calls).toHaveLength(1);
    await pauseExit(f, child.id); f.project.resumeAll();
    await until(() => f.provider.calls.some(row => row.task.id === parent.id));
    expect(call(f, parent.id).messages.map(row => row.body)).toContain('urgent parent work');
  } finally { await f.close(); }
});

test('safe paused restart retains the durable gate, profiles, staged work and affected-call continuation', async () => {
  const f = await setup(); let reopened;
  try {
    const task = (await f.project.order('restart paused call')).task;
    const staged = (await f.project.order('never started', 'main', [], null, false)).task;
    await start(f, [task]); f.project.interruptAll(); await pauseExit(f, task.id);
    f.project.configureTask(task.id, { agent: 'pi', model: 'saved', thinking: 'high' });
    await f.project.shutdown();
    reopened = new Project(f.config, f.store, f.provider); reopened.recover();
    await Promise.resolve(); reopened.pump();
    expect(reopened.maintenanceView()).toMatchObject({ paused: true, ready_to_restart: true, affected_count: 1 });
    expect(f.provider.calls).toHaveLength(1);
    reopened.resumeAll(); await until(() => f.provider.calls.length === 2);
    expect(call(f, task.id).agent.model).toBe('saved');
    expect(f.store.task(staged.id).status).toBe('paused');
  } finally { if (reopened) await reopened.shutdown(); await f.close(); }
});

test('crash recovery under the gate still fails unknown active work and never bulk-retries its descendants', async () => {
  const f = await setup(); let reopened;
  try {
    const parent = (await f.project.order('unknown active')).task;
    const child = await f.project.spawn(parent.id, 'unknown child');
    f.project.stopping = false; f.project.interruptAll();
    f.store.update(parent.id, { status: 'running', interrupt_state: 'requested' });
    f.store.startRun(parent);
    reopened = new Project(f.config, f.store, f.provider); reopened.recover();
    expect(f.store.task(parent.id).status).toBe('failed');
    expect(f.store.task(child.id).status).toBe('cancelled');
    expect(reopened.maintenancePaused()).toBe(true);
    reopened.resumeAll(); reopened.pump(); await Promise.resolve();
    expect(f.provider.calls).toHaveLength(0);
  } finally { if (reopened) await reopened.shutdown(); await f.close(); }
});

test('lifecycle Hooks submitted under maintenance survive restart and execute once only after resume', async () => {
  const f = await setup(); let reopened;
  try {
    const task = (await f.project.order('hook owner', 'main', [], null, false)).task;
    await attach(f, task, notifyHook('held lifecycle notification'));
    f.project.stopping = false; f.project.interruptAll();
    const source = f.store.event(task.id, 'test.returned', {});
    f.project.emitTaskHook(task.id, 'agent.returned', source);
    await f.project.hookQueue;
    expect(f.store.get("SELECT id FROM notices WHERE title='held lifecycle notification'")).toBeNull();
    expect(f.project.maintenanceView().ready_to_restart).toBe(true);
    await f.project.shutdown();
    reopened = new Project(f.config, f.store, f.provider); reopened.recover();
    await reopened.hookQueue;
    expect(f.store.get("SELECT id FROM notices WHERE title='held lifecycle notification'")).toBeNull();
    reopened.resumeAll(); await reopened.hookQueue;
    expect(f.store.get("SELECT count(*) AS n FROM notices WHERE title='held lifecycle notification'").n).toBe(1);
    reopened.emitTaskHook(task.id, 'agent.returned', source); await reopened.hookQueue;
    expect(f.store.get("SELECT count(*) AS n FROM notices WHERE title='held lifecycle notification'").n).toBe(1);
    expect(events(f, 'hook.execution_unknown')).toHaveLength(0);
  } finally { if (reopened) await reopened.shutdown(); await f.close(); }
});

test('lifecycle action already begun finishes; later actions wait durably without duplicating successful work', async () => {
  const f = await setup(); const entered = gate(), release = gate(); let reopened;
  try {
    const task = (await f.project.order('hook parent', 'main', [], null, false)).task;
    const parent = f.store.task(task.parent_id);
    await attach(f, parent, { name: 'partial actions', trigger: 'worker.parent_ready', mode: 'once', enabled: true,
      actions: [{ type: 'create_worker', content: 'created once', start: false }, { type: 'notify', title: 'second effect', body: 'after continue' }] });
    const send = f.project.sendOrder.bind(f.project);
    f.project.sendOrder = async (...args) => { entered.resolve(); await release.promise; return send(...args); };
    f.project.stopping = false; f.project.observeTaskHooks(); await entered.promise;
    f.project.interruptAll(); expect(f.project.maintenanceView().ready_to_restart).toBe(false);
    release.resolve(); await f.project.hookQueue;
    expect(f.store.get("SELECT count(*) AS n FROM tasks WHERE goal='created once'").n).toBe(1);
    expect(f.store.get("SELECT id FROM notices WHERE title='second effect'")).toBeNull();
    expect(f.project.maintenanceView().ready_to_restart).toBe(true);
    await f.project.shutdown(); reopened = new Project(f.config, f.store, f.provider); reopened.recover();
    reopened.resumeAll(); await reopened.hookQueue;
    expect(f.store.get("SELECT count(*) AS n FROM tasks WHERE goal='created once'").n).toBe(1);
    expect(f.store.get("SELECT count(*) AS n FROM notices WHERE title='second effect'").n).toBe(1);
  } finally { release.resolve(); if (reopened) await reopened.shutdown(); await f.close(); }
});

test('scheduled resume remains a submitted waiting action and cannot defeat the maintenance gate', async () => {
  const f = await setup();
  try {
    const task = (await f.project.order('scheduled staged', 'main', [], null, false)).task;
    let now = Date.parse('2030-01-01T00:00:00Z'); f.project.scheduledHookOptions.now = () => now;
    await attach(f, task, { name: 'scheduled continue', trigger: 'time.scheduled', mode: 'once', enabled: true,
      schedule: { kind: 'once', at: new Date(now + 60000).toISOString(), timezone: 'UTC' }, actions: [{ type: 'resume_worker', target_id: task.id }] });
    f.project.stopping = false; f.project.interruptAll(); now += 60000;
    f.project.observeScheduledTaskHooks(); await f.project.hookQueue;
    expect(f.store.task(task.id).status).toBe('paused');
    const mount = f.project.taskHooks(task.id).mounts.find(row => row.name === 'scheduled continue');
    expect(mount).toMatchObject({ state: 'waiting', pending_due_at: new Date(now).toISOString() });
    expect(f.provider.calls).toHaveLength(0);
    f.project.resumeAll(); await until(() => f.provider.calls.length === 1);
    expect(events(f, 'hook.execution_succeeded')).toHaveLength(1);
  } finally { await f.close(); }
});

test('active management Agent pauses at a safe point, preserving occurrence and exact completed action receipts', async () => {
  const f = await setup();
  try {
    const target = (await f.project.order('target staged', 'main', [], null, false)).task;
    const signal = f.project.saveHookSignal({ name: 'signal', schedule: { kind: 'once', at: '2030-01-01T00:01:00Z', timezone: 'UTC' } }, f.project.hookSignals().revision).signals.items.at(-1);
    const manager = f.project.createManagementWorker({ name: 'manage', instruction: 'query/start', signal_id: signal.id });
    const occurrence = { id: f.store.event(manager.id, 'test.signal', {}), signal_id: signal.id, name: 'signal', due_at: '2030-01-01T00:01:00Z' };
    f.project.submitManagementSignal(manager.id, occurrence); await start(f, [manager]);
    f.project.interruptAll();
    const submitted = f.project.requestManagementAction(manager.id, 'start', target.id);
    expect(submitted.status).toBe('waiting'); expect(f.store.task(target.id).status).toBe('paused');
    await pauseExit(f, manager.id);
    expect(f.project.managementView(manager.id)).toMatchObject({ enabled: true, state: 'queued', pending_signal: { id: occurrence.id } });
    expect(f.store.get('SELECT status FROM agent_runs WHERE task_id=?', manager.id).status).toBe('preempted');
    expect(f.project.maintenanceView().ready_to_restart).toBe(true);
    f.project.resumeAll(); await until(() => f.provider.calls.filter(row => row.task.id === manager.id).length === 2);
    expect(call(f, manager.id).context.management.signal.id).toBe(occurrence.id);
    const result = f.project.requestManagementAction(manager.id, 'start', target.id);
    expect(result.receipt_id).toBe(submitted.receipt_id);
    call(f, manager.id).done.resolve('management safely returned');
    await until(() => !f.project.running.has(manager.id));
    expect(events(f, 'management.action_completed')).toHaveLength(1);
  } finally { await f.close(); }
});

test('batch pause of a source repair preserves its fixed delivery attempt and parent slot across safe restart', async () => {
  const f = await setup(); let reopened;
  try {
    const parent = (await f.project.order('repair parent')).task;
    const source = await f.project.spawn(parent.id, 'repair source');
    f.store.update(parent.id, { status: 'waiting' });
    const attempt = f.store.event(source.id, 'merge.attempt_started', {});
    const booking = { version: 2, kind: 'merge', status: 'resolving', queue_protocol: 1, parent_id: parent.id,
      attempt_id: attempt, delivery_id: attempt, enqueue_seq: attempt, commit: source.base_commit, original_commit: source.base_commit,
      baseline: parent.base_commit, parent_commit: parent.base_commit, repair_ready: false };
    f.store.update(source.id, { reservation: JSON.stringify(booking) });
    await start(f, [source]); f.project.interruptAll();
    expect(JSON.parse(f.store.task(source.id).reservation)).toEqual(booking);
    await pauseExit(f, source.id);
    expect(f.project.activeTaskMerge(parent.id).id).toBe(source.id);
    expect(JSON.parse(f.store.task(source.id).reservation)).toEqual(booking);
    await f.project.shutdown(); reopened = new Project(f.config, f.store, f.provider); reopened.recover();
    expect(JSON.parse(f.store.task(source.id).reservation)).toEqual(booking);
    reopened.resumeAll(); await until(() => f.provider.calls.length === 2);
    expect(reopened.running.get(source.id).deliveryAttempt).toBe(attempt);
    expect(events(f, 'merge.attempt_suspended')).toHaveLength(0);
    expect(f.store.task(parent.id).status).toBe('waiting');
  } finally { if (reopened) await reopened.shutdown(); await f.close(); }
});


test('automatic questionnaire answers and user replies cannot launch calls through the maintenance gate', async () => {
  const f = await setup();
  try {
    const auto = (await f.project.order('auto question', 'main', [], null, false)).task;
    const manual = (await f.project.order('manual question', 'main', [], null, false)).task;
    f.store.update(auto.id, { status: 'waiting' }); f.store.update(manual.id, { status: 'waiting' });
    f.project.stopping = false; f.project.interruptAll();
    f.project.setDaemonAutoSelect(true, f.project.daemonHooks().revision);
    const question = f.project.notice(auto.id, 'held auto decision', '', 'question', [{ header: 'decision', question: 'Continue?',
      options: [{ label: 'yes', description: 'continue' }, { label: 'no', description: 'wait' }] }]);
    expect(f.store.get('SELECT status FROM notices WHERE id=?', question.id).status).toBe('open');
    // Device authorization is unchanged; it simply waits on the project gate.
    expect(f.project.daemonHooks().mounts.find(row => row.id === 'auto-select').enabled).toBe(true);
    f.project.setDaemonAutoSelect(false, f.project.daemonHooks().revision);
    const user = f.project.notice(manual.id, 'manual decision');
    f.project.answer(user.id, 'continue after maintenance'); f.project.pump();
    expect(f.provider.calls).toHaveLength(0);
    f.project.setDaemonAutoSelect(true, f.project.daemonHooks().revision);
    f.project.resumeAll(); await until(() => f.provider.calls.length === 2);
    expect(f.store.get('SELECT status FROM notices WHERE id=?', question.id).status).toBe('answered');
    expect(f.provider.calls.map(row => row.task.id).sort((a,b) => a-b)).toEqual([auto.id, manual.id]);
  } finally { await f.close(); }
});

test('failed child notifications remain urgent after resume while successful receipts wait for unfinished siblings', async () => {
  const f = await setup();
  try {
    const parent = (await f.project.order('waiting for siblings')).task;
    const first = await f.project.spawn(parent.id, 'failing child'), second = await f.project.spawn(parent.id, 'remaining child');
    f.store.update(parent.id, { status: 'waiting' }); await start(f, [first, second]);
    f.project.interruptAll(); call(f, first.id).done.resolve(new Error('controlled child failure'));
    await until(() => !f.project.running.has(first.id));
    expect(f.store.task(first.id).status).toBe('failed');
    expect(f.provider.calls).toHaveLength(2);
    await pauseExit(f, second.id); f.project.resumeAll();
    await until(() => f.provider.calls.some(row => row.task.id === parent.id));
    expect(f.provider.calls.filter(row => row.task.id === first.id)).toHaveLength(1);
    expect(call(f, parent.id).messages.some(row => row.signal_type === 'child.failed')).toBe(true);
  } finally { await f.close(); }
});

test('requested Git delivery cannot start under maintenance and drains its real parent queue after resume', async () => {
  const f = await setup();
  try {
    const source = (await f.project.order('commit ready for delivery')).task;
    fs.writeFileSync(path.join(source.workspace, 'added.txt'), 'maintenance delivery\n');
    await git(source.workspace, 'add', '.'); await git(source.workspace, 'commit', '-m', 'source change');
    await f.project.workspaces.finish(f.store.task(source.id)); f.store.update(source.id, { status: 'waiting', result: 'ready' });
    await f.project.requestTaskMerge(source.id);
    expect(JSON.parse(f.store.task(source.id).reservation).status).toBe('requested');
    const before = await git(f.root, 'rev-parse', 'HEAD');
    f.project.stopping = false; f.project.interruptAll();
    await f.project.driveTaskMerge(source.parent_id);
    expect(await git(f.root, 'rev-parse', 'HEAD')).toBe(before);
    expect(events(f, 'merge.attempt_started')).toHaveLength(0);
    expect(f.project.maintenanceView().ready_to_restart).toBe(true);
    f.project.resumeAll(); await until(() => f.store.task(source.id).integration === 'merged');
    await f.project.workspaces.queue;
    expect(await git(f.root, 'rev-parse', 'HEAD')).not.toBe(before);
    expect(f.store.task(source.id).status).toBe('awaiting_acceptance');
    expect(f.provider.calls).toHaveLength(0);
  } finally { await f.close(); }
});

test('all-continue does not retry a cancelled or failed affected Worker', async () => {
  const f = await setup();
  try {
    const source = (await f.project.order('cancel before continue')).task; await start(f, [source]);
    f.project.interruptAll(); f.project.cancel(source.id, 'explicit user cancel');
    await until(() => !f.project.running.has(source.id));
    f.project.resumeAll(); f.project.pump(); await Promise.resolve();
    expect(f.store.task(source.id).status).toBe('cancelled');
    expect(f.provider.calls).toHaveLength(1);
  } finally { await f.close(); }
});

test('an already-started Shell Hook completes and its next queued occurrence waits without duplicate execution', async () => {
  const f = await setup();
  try {
    const order = (await f.project.order('seed', 'main', [], null, false)).task, parent = f.store.task(order.parent_id);
    const command = f.project.saveShortcutCommand({ name: 'temporary output', command: 'printf x >> command-runs.txt' }, f.project.shortcutCommands().revision).commands.items.at(-1);
    f.project.authorizeShortcutCommand(command.id, command.version, true, f.project.shortcutCommands().revision);
    await attach(f, parent, { name: 'queued commands', trigger: 'worker.merge_received', mode: 'persistent', enabled: true,
      actions: [{ type: 'command', command_id: command.id, command_version: command.version }] });
    const run = f.project.workspaces.runHookCommand.bind(f.project.workspaces);
    let first = true;
    f.project.workspaces.runHookCommand = (task, text, guard, options) => run(task, text, guard, { ...options, started() {
      options.started();
      if (first) { first = false; f.project.interruptAll(); expect(f.project.maintenanceView().ready_to_restart).toBe(false); }
    } });
    f.project.stopping = false;
    f.project.emitTaskHook(parent.id, 'worker.merge_received', f.store.event(parent.id, 'test.first', {}));
    f.project.emitTaskHook(parent.id, 'worker.merge_received', f.store.event(parent.id, 'test.second', {}));
    await f.project.hookQueue;
    expect(fs.readFileSync(path.join(f.root, 'command-runs.txt'), 'utf8')).toBe('x');
    expect(f.project.taskHooks(parent.id).mounts.find(row => row.name === 'queued commands').state).toBe('waiting');
    expect(f.project.maintenanceView().ready_to_restart).toBe(true);
    f.project.resumeAll(); await f.project.hookQueue;
    expect(fs.readFileSync(path.join(f.root, 'command-runs.txt'), 'utf8')).toBe('xx');
    expect(events(f, 'hook.action_completed')).toHaveLength(2);
  } finally { await f.close(); }
});

test('automatic acceptance does not begin resource deletion under maintenance and resumes through its authorized safety path', async () => {
  const f = await setup();
  try {
    const source = (await f.project.order('answer without changes', 'main', [], null, false)).task;
    await f.project.setTaskCompletion(source.id, 'accept', f.project.taskHooks(source.id).revision);
    f.store.update(source.id, { status: 'waiting', result: 'answer' });
    await f.project.settleQueuedMerge(source.id);
    expect(f.store.task(source.id).status).toBe('awaiting_acceptance');
    f.project.stopping = false; f.project.interruptAll(); f.project.scheduleTaskCompletion(source.id);
    await f.project.completionQueue;
    expect(fs.existsSync(source.workspace)).toBe(true);
    expect(events(f, 'task.acceptance_started')).toHaveLength(0);
    expect(f.project.maintenanceView().ready_to_restart).toBe(true);
    f.project.resumeAll(); await until(() => f.store.task(source.id).status === 'completed');
    await f.project.completionQueue;
    expect(f.store.branch(source.branch).status).toBe('archived');
    expect(fs.existsSync(source.workspace)).toBe(false);
    expect(events(f, 'task.acceptance_started')).toHaveLength(1);
    expect(f.provider.calls).toHaveLength(0);
  } finally { await f.close(); }
});

test('a queued unstarted source repair keeps its fixed attempt across a maintenance restart without starting an Agent', async () => {
  const f = await setup(); let reopened;
  try {
    const parent = (await f.project.order('fixed parent')).task, source = await f.project.spawn(parent.id, 'unstarted repair');
    f.store.update(parent.id, { status: 'waiting' });
    const attempt = f.store.event(source.id, 'merge.attempt_started', {});
    const booking = { version: 2, kind: 'merge', status: 'resolving', queue_protocol: 1, parent_id: parent.id,
      attempt_id: attempt, delivery_id: attempt, enqueue_seq: attempt, commit: source.base_commit, original_commit: source.base_commit,
      baseline: parent.base_commit, parent_commit: parent.base_commit, repair_ready: false };
    f.store.update(source.id, { reservation: JSON.stringify(booking) });
    f.project.stopping = false; f.project.interruptAll(); await f.project.shutdown();
    reopened = new Project(f.config, f.store, f.provider); reopened.recover();
    expect(f.provider.calls).toHaveLength(0);
    expect(JSON.parse(f.store.task(source.id).reservation)).toEqual(booking);
    reopened.resumeAll(); await until(() => f.provider.calls.length === 1);
    expect(reopened.running.get(source.id).deliveryAttempt).toBe(attempt);
    expect(events(f, 'merge.attempt_suspended')).toHaveLength(0);
  } finally { if (reopened) await reopened.shutdown(); await f.close(); }
});
