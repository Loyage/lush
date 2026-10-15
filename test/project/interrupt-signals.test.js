import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, repo, gate, until } from '../helpers.js';
import { Project } from '../../src/core/project.js';
import { AgentPreempted } from '../../src/agent/provider.js';
import { HOOK_ACTIONS, HOOK_LIMITS, normalizeHook } from '../../src/core/hooks.js';

function controlled(agent = 'pi') {
  const calls = [];
  return { calls, resolve: () => ({ agent, model: '', thinking: '', extensions: [], skills: [] }),
    run(options) {
      const done = gate(); calls.push({ ...options, done });
      return new Promise((resolve, reject) => {
        const abort = () => reject(new Error('aborted'));
        options.signal.addEventListener('abort', abort, { once: true });
        done.promise.then(value => { options.signal.removeEventListener('abort', abort); value instanceof Error ? reject(value) : resolve(value ?? 'done'); });
      });
    } };
}
async function setup(agent = 'pi') {
  const provider = controlled(agent), f = fixture(provider); f.provider = provider;
  f.project.stopping = true; await repo(f.root);
  return f;
}
async function start(f, ...tasks) {
  f.project.stopping = false; f.project.kick();
  await until(() => tasks.every(task => f.provider.calls.some(call => call.task.id === task.id)));
}
const hook = (title, trigger = 'worker.interrupted', mode = 'once') => ({ name: title, trigger, mode, enabled: true,
  actions: [{ type: 'notify', title, body: 'safe signal' }] });
const attach = (f, task, value) => f.project.attachTaskHook(task.id, value, f.project.taskHooks(task.id).revision);
const events = (f, type) => f.store.all('SELECT * FROM events WHERE type=?', type);
const notices = (f, title) => f.store.all('SELECT * FROM notices WHERE title=?', title);
const lastCall = (f, task) => f.provider.calls.findLast(call => call.task.id === task.id);
function claim(f, task) {
  const prefix = path.join(f.config.home, 'preempt', `task-${task.id}`);
  fs.renameSync(`${prefix}.request.json`, `${prefix}.stop.json`);
}
async function exit(f, task, result = new AgentPreempted()) {
  lastCall(f, task).done.resolve(result);
  await until(() => !f.project.running.has(task.id));
  await f.project.hookQueue;
}

test('new interruption nodes permit only notify; mixed command/message definitions are rejected', () => {
  for (const trigger of ['worker.interrupted','project.interrupted']) {
    expect(normalizeHook(hook('valid', trigger)).trigger).toBe(trigger);
    expect(HOOK_ACTIONS.filter(action => action.triggers.includes(trigger)).map(action => action.type)).toEqual(['notify']);
    for (const action of [{ type: 'message', target_id: 1, body: 'no' },
      { type: 'command', command_id: '11111111-1111-1111-1111-111111111111', command_version: 1 }, { type: 'request_merge' }])
      expect(() => normalizeHook({ ...hook('mixed', trigger), actions: [...hook('valid').actions, action] })).toThrow('not allowed');
  }
});

test('individual interruption publishes only after real exit and cleanup, once; staged pause is not an invocation signal', async () => {
  const f = await setup(); const cleanup = gate(), entered = gate();
  try {
    const task = (await f.project.order('personal')).task;
    const staged = (await f.project.order('staged', 'main', [], null, false)).task;
    attach(f, task, hook('personal complete')); attach(f, staged, hook('no invocation'));
    f.project.interrupt(staged.id);
    expect(notices(f, 'no invocation')).toHaveLength(0);
    await start(f, task);
    const close = f.project.workspaces.closeOwnedBranch.bind(f.project.workspaces);
    f.project.workspaces.closeOwnedBranch = async (...args) => { entered.resolve(); await cleanup.promise; return close(...args); };
    f.project.interrupt(task.id); f.project.interrupt(task.id); claim(f, task);
    lastCall(f, task).done.resolve(new AgentPreempted()); await entered.promise;
    expect(events(f, 'worker.interrupted')).toHaveLength(0);
    expect(notices(f, 'personal complete')).toHaveLength(0);
    cleanup.resolve(); await until(() => notices(f, 'personal complete').length === 1);
    expect(events(f, 'worker.interrupted')).toHaveLength(1);
    expect(f.store.task(task.id).status).toBe('paused');
    expect(f.project.taskHooks(task.id).mounts.filter(m => m.name === 'personal complete')).toHaveLength(0);
    expect(f.project.maintenanceView()).toMatchObject({ batch_id: null, completion_state: null, completion_notice_id: null });
  } finally { cleanup.resolve(); await f.close(); }
});

test('bulk interruption during already-returned invocation cleanup still waits for ownership release', async () => {
  const f = await setup('mock'); const entered = gate(), release = gate();
  try {
    const task = (await f.project.order('late cleanup')).task; await start(f, task);
    const close = f.project.workspaces.closeOwnedBranch.bind(f.project.workspaces);
    f.project.workspaces.closeOwnedBranch = async (...args) => { entered.resolve(); await release.promise; return close(...args); };
    lastCall(f, task).done.resolve('returned'); await entered.promise;
    expect(f.project.running.get(task.id).invocationEnded).toBe(true);
    expect(f.project.interruptAll()).toMatchObject({ completion_state: 'pending', ready_to_restart: false });
    expect(events(f, 'worker.interrupted')).toHaveLength(0);
    release.resolve(); await until(() => f.project.maintenanceView().completion_state === 'completed');
    expect(f.store.task(task.id).status).toBe('paused');
    expect(events(f, 'worker.interrupted')).toHaveLength(1);
  } finally { release.resolve(); await f.close(); }
});

test('batch installs exact one-shot bindings before requests; pure new notify runs under maintenance, old Hooks wait', async () => {
  const f = await setup();
  try {
    const a = (await f.project.order('a')).task, b = (await f.project.order('b')).task;
    const main = f.store.get("SELECT * FROM tasks WHERE task_kind='main'");
    attach(f, a, hook('new pure')); attach(f, a, hook('old paused', 'agent.paused'));
    attach(f, main, hook('project custom', 'project.interrupted'));
    expect(() => attach(f, a, hook('bad owner', 'project.interrupted'))).toThrow('main/owner');
    await start(f, a, b);
    const original = f.project.requestPreempt.bind(f.project);
    f.project.requestPreempt = (...args) => {
      const data = JSON.parse(f.store.get("SELECT value FROM meta WHERE key='project_maintenance'").value);
      expect(data.completion_state).toBe('pending');
      expect(data.participants).toHaveLength(2);
      for (const row of data.participants) {
        const mounts = JSON.parse(f.store.task(row.id).hooks).mounts;
        expect(mounts.find(m => m.signal_binding?.batch_id === data.batch_id)?.signal_binding)
          .toMatchObject({ invocation_id: f.project.running.get(row.id).signalId, run_id: row.run_id });
      }
      return original(...args);
    };
    const ack = f.project.interruptAll();
    expect(ack.batch_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(ack).toMatchObject({ completion_state: 'pending', completion_notice_id: null, ready_to_restart: false });
    f.project.interruptAll(); expect(events(f, 'maintenance.interrupted')).toHaveLength(1);
    claim(f, a); await exit(f, a);
    expect(notices(f, 'new pure')).toHaveLength(1);
    expect(notices(f, 'old paused')).toHaveLength(0);
    expect(f.project.maintenanceView().completion_state).toBe('pending');
    claim(f, b); await exit(f, b); await f.project.hookQueue;
    await until(() => f.project.maintenanceView().completion_state === 'completed');
    const complete = f.project.maintenanceView();
    expect(complete.completion_notice_id).toBeGreaterThan(0);
    expect(notices(f, 'project custom')).toHaveLength(1);
    expect(f.store.get('SELECT kind,task_id,source_event_id FROM notices WHERE id=?', complete.completion_notice_id))
      .toEqual({ kind: 'info', task_id: main.id, source_event_id: events(f, 'project.interrupted')[0].id });
    expect(events(f, 'worker.interrupted')).toHaveLength(2);
    expect(events(f, 'project.interrupted')).toHaveLength(1);
    f.project.observeMaintenanceCompletion(); f.project.interruptAll();
    expect(events(f, 'project.interrupted')).toHaveLength(1);
    expect(f.project.summary().maintenance).toEqual(f.project.status(false).maintenance);
    f.project.resumeAll(); await until(() => notices(f, 'old paused').length === 1);
    expect(f.project.maintenanceView()).toMatchObject({ completion_state: 'cancelled', completion_notice_id: null });
  } finally { await f.close(); }
});

test('pre-existing personal pause participates in all-interrupt but is never resumed by all-continue', async () => {
  const f = await setup();
  try {
    const task = (await f.project.order('personal already pending')).task; await start(f, task);
    f.project.interrupt(task.id);
    expect(f.project.interruptAll().affected_count).toBe(0);
    claim(f, task); await exit(f, task);
    await until(() => f.project.maintenanceView().completion_state === 'completed');
    f.project.resumeAll(); f.project.pump();
    expect(f.store.task(task.id).status).toBe('paused'); expect(f.provider.calls).toHaveLength(1);
  } finally { await f.close(); }
});

for (const claimed of [false, true]) test(`all-continue cancels batch and exact signal (${claimed ? 'claimed' : 'unclaimed'} stop)`, async () => {
  const f = await setup();
  try {
    const task = (await f.project.order('withdraw')).task; attach(f, task, hook('must not notify'));
    await start(f, task); const batch = f.project.interruptAll().batch_id;
    if (claimed) claim(f, task);
    expect(f.project.resumeAll()).toMatchObject({ batch_id: batch, completion_state: 'cancelled', completion_notice_id: null });
    lastCall(f, task).done.resolve(claimed ? new AgentPreempted() : 'continued');
    await until(() => claimed ? f.provider.calls.length === 2 : !f.project.running.has(task.id));
    expect(events(f, 'worker.interrupted')).toHaveLength(0);
    expect(events(f, 'project.interrupted')).toHaveLength(0);
    expect(notices(f, 'must not notify')).toHaveLength(0);
  } finally { await f.close(); }
});

test('individual resume during maintenance cancels the pending batch, without overlapping invocation', async () => {
  const f = await setup();
  try {
    const task = (await f.project.order('resume one')).task; await start(f, task);
    f.project.interruptAll(); f.project.resumeTask(task.id);
    await exit(f, task, 'kept running');
    expect(f.project.maintenanceView()).toMatchObject({ paused: true, completion_state: 'cancelled', completion_notice_id: null });
    expect(events(f, 'worker.interrupted')).toHaveLength(0);
    expect(events(f, 'project.interrupted')).toHaveLength(0);
  } finally { await f.close(); }
});

for (const cancelled of [false, true]) test(`affected invocation ${cancelled ? 'cancellation' : 'failure'} cannot publish batch success`, async () => {
  const f = await setup();
  try {
    const task = (await f.project.order('not successful')).task; await start(f, task);
    f.project.interruptAll();
    if (cancelled) f.project.cancel(task.id);
    else lastCall(f, task).done.resolve(new Error('provider crash'));
    await until(() => !f.project.running.has(task.id));
    expect(f.project.maintenanceView()).toMatchObject({ ready_to_restart: true, completion_state: cancelled ? 'cancelled' : 'unknown', completion_notice_id: null });
    expect(events(f, 'worker.interrupted')).toHaveLength(0);
    expect(events(f, 'project.interrupted')).toHaveLength(0);
  } finally { await f.close(); }
});

test('input preemption is never an interruption completion signal', async () => {
  const f = await setup();
  try {
    const task = (await f.project.order('input only')).task; attach(f, task, hook('not personal'));
    await start(f, task); f.project.requestPreempt(task.id); claim(f, task);
    await exit(f, task);
    expect(events(f, 'worker.interrupted')).toHaveLength(0);
    expect(notices(f, 'not personal')).toHaveLength(0);
  } finally { await f.close(); }
});

test('no in-flight calls completes exactly once; old legacy maintenance remains unbatched and reads have no side effects', async () => {
  const f = await setup();
  try {
    await f.project.order('staged', 'main', [], null, false); f.project.stopping = false;
    f.store.run("INSERT INTO meta(key,value) VALUES ('project_maintenance',?)", JSON.stringify({ version: 1, paused: true, affected: [] }));
    const before = f.store.get('SELECT count(*) AS n FROM events').n;
    for (let n = 0; n < 3; n++) expect(f.project.maintenanceView()).toMatchObject({ ready_to_restart: true, batch_id: null, completion_state: null, completion_notice_id: null });
    expect(f.store.get('SELECT count(*) AS n FROM events').n).toBe(before);
    f.project.resumeAll();
    const ack = f.project.interruptAll();
    expect(ack).toMatchObject({ completion_state: 'completed', ready_to_restart: true });
    expect(ack.completion_notice_id).toBeGreaterThan(0);
    f.project.interruptAll(); f.project.observeMaintenanceCompletion();
    expect(events(f, 'project.interrupted')).toHaveLength(1);
    const readEvents = f.store.get('SELECT count(*) AS n FROM events').n;
    f.project.summary(); f.project.status(false); f.project.maintenanceView();
    expect(f.store.get('SELECT count(*) AS n FROM events').n).toBe(readEvents);
  } finally { await f.close(); }
});

test('original Git/write/Hook/sync/acceptance barriers delay project signal; dynamic busy never rewrites historical completed evidence', async () => {
  const f = await setup(); const entered = gate(), release = gate();
  try {
    await f.project.order('staged', 'main', [], null, false); f.project.stopping = false;
    const job = f.project.workspaces.exclusive(async () => { entered.resolve(); await release.promise; }); await entered.promise;
    f.project.lifecycleHookRunning = new Set(['test']); f.project.taskSyncBusy = new Set([99]); f.project.writing = 1;
    expect(f.project.interruptAll()).toMatchObject({ completion_state: 'pending', ready_to_restart: false });
    f.project.observeMaintenanceCompletion(); expect(events(f, 'project.interrupted')).toHaveLength(0);
    release.resolve(); await job; f.project.lifecycleHookRunning.clear(); f.project.writing = 0;
    f.project.observeMaintenanceCompletion(); expect(events(f, 'project.interrupted')).toHaveLength(0);
    f.project.taskSyncBusy.clear();
    await until(() => f.project.maintenanceView().completion_state === 'completed'); // lifecycle monitor, not a read mutation
    const noticeId = f.project.maintenanceView().completion_notice_id;
    f.project.acceptanceBusy = new Set([99]);
    expect(f.project.maintenanceView()).toMatchObject({ completion_state: 'completed', completion_notice_id: noticeId, ready_to_restart: false });
    f.project.acceptanceBusy.clear(); expect(events(f, 'project.interrupted')).toHaveLength(1);
  } finally { release.resolve(); f.project.writing = 0; await f.close(); }
});

test('mount capacity exhaustion aborts atomically before gate, request and any batch Hook; internal bindings are immutable', async () => {
  const f = await setup();
  try {
    const a = (await f.project.order('capacity a')).task, b = (await f.project.order('capacity b')).task;
    for (let n = 0; n < HOOK_LIMITS.mounts; n++) attach(f, b, hook(`capacity ${n}`));
    await start(f, a, b);
    expect(() => f.project.interruptAll()).toThrow('too many mounted Hooks');
    expect(f.project.maintenancePaused()).toBe(false);
    expect(events(f, 'maintenance.interrupted')).toHaveLength(0);
    expect(events(f, 'preempt.requested')).toHaveLength(0);
    expect(f.project.taskHooks(a.id).mounts.some(m => m.name === '批量中断完成告知')).toBe(false);
    const mounts = f.project.taskHooks(b.id); f.project.removeTaskHook(b.id, mounts.mounts.find(m => !m.builtin).id, mounts.revision);
    f.project.interruptAll();
    const installed = f.project.taskHooks(a.id), internal = installed.mounts.find(m => m.name === '批量中断完成告知');
    expect(internal).toMatchObject({ builtin: true, locked: true, editable: false, removable: false });
    expect(() => f.project.removeTaskHook(a.id, internal.id, installed.revision)).toThrow('runtime');
    await expect(f.project.updateTaskHook(a.id, internal.id, false, installed.revision)).rejects.toThrow('runtime');
  } finally { await f.close(); }
});

test('byte and project-wide Worker Hook capacity also reject the entire batch before admission closes', async () => {
  for (const limit of ['bytes','workers']) {
    const f = await setup();
    try {
      const task = (await f.project.order('bounded batch')).task;
      if (limit === 'bytes') for (let n = 0; n < 4; n++)
        attach(f, task, { ...hook(`large ${n}`), actions: [{ type: 'notify', title: 'large', body: 'x'.repeat(32000) }] });
      await start(f, task);
      if (limit === 'bytes') {
        const data = JSON.parse(f.store.task(task.id).hooks);
        // A valid extra action fills the remaining bounded JSON budget without exceeding it.
        data.mounts[0].actions.push({ type: 'notify', title: 'padding', body: '' });
        data.mounts[0].actions.at(-1).body = 'x'.repeat(HOOK_LIMITS.bytes - Buffer.byteLength(JSON.stringify(data)) - 16);
        expect(Buffer.byteLength(JSON.stringify(data))).toBeLessThanOrEqual(HOOK_LIMITS.bytes);
        f.store.update(task.id, { hooks: JSON.stringify(data) });
      } else {
        const count = f.store.get('SELECT count(*) AS n FROM tasks WHERE hooks IS NOT NULL').n;
        f.store.transaction(() => {
          for (let n = count; n < 500; n++) {
            const owner = f.store.create({ role: 'agent', name: `capacity-${n}`, goal: 'capacity fixture', task_kind: 'owner' });
            f.store.update(owner.id, { status: 'waiting', hooks: JSON.stringify({ version: 1, observed: {}, mounts: [{ ...hook('held'), enabled: false, id: `fixture-${n}`, state: 'idle', last_execution: null }] }) });
          }
        });
      }
      expect(() => f.project.interruptAll()).toThrow(limit === 'bytes' ? 'size limit' : 'limit 500');
      expect(f.project.maintenancePaused()).toBe(false);
      expect(events(f, 'maintenance.interrupted')).toHaveLength(0);
      expect(events(f, 'preempt.requested')).toHaveLength(0);
    } finally { await f.close(); }
  }
});

test('new batches use new invocation/batch identities and persistent signals deduplicate exact source events', async () => {
  const f = await setup();
  try {
    const task = (await f.project.order('two batches')).task; attach(f, task, hook('persistent personal', 'worker.interrupted', 'persistent'));
    await start(f, task); const firstRun = f.project.running.get(task.id).signalId;
    const first = f.project.interruptAll(); claim(f, task); await exit(f, task);
    await until(() => f.project.maintenanceView().completion_state === 'completed');
    const firstNoticeId = f.project.maintenanceView().completion_notice_id;
    const source = events(f, 'worker.interrupted')[0];
    f.project.emitTaskHook(task.id, 'worker.interrupted', source.id); await f.project.hookQueue;
    expect(notices(f, 'persistent personal')).toHaveLength(1);
    f.project.resumeAll(); await until(() => f.provider.calls.length === 2);
    expect(f.project.running.get(task.id).signalId).not.toBe(firstRun);
    const second = f.project.interruptAll(); expect(second.batch_id).not.toBe(first.batch_id);
    // An old invocation's source cannot claim a new batch's internal one-shot.
    f.project.emitTaskHook(task.id, 'worker.interrupted', source.id); await f.project.hookQueue;
    expect(notices(f, `${task.worker_number} 中断完成`)).toHaveLength(1);
    claim(f, task); await exit(f, task);
    await until(() => f.project.maintenanceView().completion_state === 'completed');
    expect(f.project.maintenanceView().completion_notice_id).not.toBe(firstNoticeId);
    expect(notices(f, 'persistent personal')).toHaveLength(2);
    expect(events(f, 'project.interrupted')).toHaveLength(2);
  } finally { await f.close(); }
});

test('a re-issued pause after claimed all-continue binds the still-exiting call to the new batch only', async () => {
  const f = await setup();
  try {
    const task = (await f.project.order('claimed then re-pause')).task; await start(f, task);
    const first = f.project.interruptAll(); claim(f, task); f.project.resumeAll();
    const second = f.project.interruptAll(); expect(second.batch_id).not.toBe(first.batch_id);
    await exit(f, task);
    await until(() => f.project.maintenanceView().completion_state === 'completed');
    expect(events(f, 'project.interrupted')).toHaveLength(1);
    expect(JSON.parse(events(f, 'project.interrupted')[0].data).batch_id).toBe(second.batch_id);
    expect(f.provider.calls).toHaveLength(1);
  } finally { await f.close(); }
});

test('already-claimed input preemption plus batch pause is unknown, never a fabricated interrupt completion', async () => {
  const f = await setup();
  try {
    const task = (await f.project.order('input claim')).task; await start(f, task);
    f.project.requestPreempt(task.id); claim(f, task); f.project.interruptAll();
    await exit(f, task);
    expect(f.project.maintenanceView()).toMatchObject({ completion_state: 'unknown', completion_notice_id: null });
    expect(events(f, 'worker.interrupted')).toHaveLength(0);
  } finally { await f.close(); }
});

test('project signal reaches explicit owners as well as main, without duplicate source Notices', async () => {
  const f = await setup();
  try {
    await f.project.order('staged', 'main', [], null, false);
    const owner = f.store.create({ role: 'agent', name: 'owner', goal: 'fixture owner', task_kind: 'owner', status: 'waiting' });
    attach(f, owner, hook('owner project', 'project.interrupted'));
    f.project.stopping = false; f.project.interruptAll(); await f.project.hookQueue;
    expect(notices(f, 'owner project')).toHaveLength(1);
    expect(notices(f, '项目中断完成')).toHaveLength(1);
    expect(events(f, 'project.interrupted')).toHaveLength(1);
  } finally { await f.close(); }
});

for (const agent of ['pi','mock']) test(`management ${agent} invocation safely pauses and completes its batch without losing its occurrence`, async () => {
  const f = await setup(agent);
  try {
    await f.project.order('staged', 'main', [], null, false);
    const signal = f.project.saveHookSignal({ name: 'signal', schedule: { kind: 'once', at: '2030-01-01T00:00:00Z', timezone: 'UTC' } }, f.project.hookSignals().revision).signals.items.at(-1);
    const manager = f.project.createManagementWorker({ name: 'manager', instruction: 'query', signal_id: signal.id });
    const occurrence = { id: f.store.event(manager.id, 'test.signal', {}), signal_id: signal.id, name: 'signal', due_at: '2030-01-01T00:00:00Z' };
    f.project.submitManagementSignal(manager.id, occurrence); await start(f, manager);
    f.project.interruptAll(); if (agent === 'pi') claim(f, manager);
    await exit(f, manager, agent === 'pi' ? new AgentPreempted() : 'natural safe return');
    await until(() => f.project.maintenanceView().completion_state === 'completed');
    expect(f.project.managementView(manager.id)).toMatchObject({ state: 'queued', pending_signal: { id: occurrence.id, status: 'queued' } });
    expect(JSON.parse(f.store.task(manager.id).management).pending_signal.phase).toBe('pending');
    expect(events(f, 'worker.interrupted')).toHaveLength(1);
    expect(f.provider.calls).toHaveLength(1);
  } finally { await f.close(); }
});

test('restart with pending batch marks unknown without success or replay; completed batch evidence survives repeated recovery', async () => {
  const f = await setup(); let restored;
  try {
    const task = (await f.project.order('orphan')).task; await start(f, task); const old = f.project.interruptAll();
    // Capture a crash image, then gracefully close only the test provider ownership.
    const image = f.store.get("SELECT value FROM meta WHERE key='project_maintenance'").value;
    const hooks = f.store.task(task.id).hooks, runId = f.project.running.get(task.id).recordId;
    await f.project.shutdown();
    f.store.run("UPDATE meta SET value=? WHERE key='project_maintenance'", image);
    f.store.update(task.id, { status: 'running', interrupt_state: 'requested', hooks });
    f.store.run("UPDATE agent_runs SET status='running',ended_at=NULL WHERE id=?", runId);
    restored = new Project(f.config, f.store, f.provider); restored.recover();
    expect(restored.maintenanceView()).toMatchObject({ batch_id: old.batch_id, completion_state: 'unknown', completion_notice_id: null, ready_to_restart: true });
    restored.observeMaintenanceCompletion(); expect(events(f, 'project.interrupted')).toHaveLength(0);
    expect(f.store.task(task.id).status).toBe('failed');
    expect(restored.taskHooks(task.id).mounts.find(m => m.name === '批量中断完成告知')).toMatchObject({ state: 'unknown', enabled: false, removable: true });
    await restored.hookQueue; expect(f.provider.calls).toHaveLength(1);
    restored.resumeAll();
    // Keep the now-queued Worker staged for a no-call completed batch.
    f.store.update(task.id, { status: 'paused' });
    restored.interruptAll();
    // No Agent is running, but admitted recovery checks must also leave the restart
    // barrier before this batch can claim completion.
    await until(() => restored.maintenanceView().completion_state === 'completed');
    const completed = restored.maintenanceView();
    expect(f.provider.calls).toHaveLength(1);
    await restored.shutdown(); restored = new Project(f.config, f.store, f.provider); restored.recover();
    expect(restored.maintenanceView()).toMatchObject({ batch_id: completed.batch_id, completion_state: 'completed', completion_notice_id: completed.completion_notice_id });
    restored.observeMaintenanceCompletion(); expect(events(f, 'project.interrupted')).toHaveLength(1);
  } finally { if (restored) await restored.shutdown(); await f.close(); }
});
