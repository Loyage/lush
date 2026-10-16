import fs from 'node:fs';
import path from 'node:path';
import { test, expect, setDefaultTimeout } from 'bun:test';
import { fixture, repo, gate, until, git } from '../helpers.js';
import { tokenHash } from '../../src/core/project/internal.js';
setDefaultTimeout(20000);

async function setup(manage = () => 'management finished') {
  let f, calls = 0;
  const provider = { run: async options => {
    if (options.task.role !== 'manager') return 'ordinary development test';
    calls += 1; return manage(options, f);
  } };
  f = fixture(provider); f.project.kick = () => {}; await repo(f.root);
  const target = (await f.project.order('target', 'main', [], null, false)).task;
  let clock = Date.parse('2030-01-01T00:00:00Z'), serial = 0;
  const timers = new Map();
  f.project.scheduledHookOptions = { now: () => clock,
    setTimeout: (fn, delay) => { const key = ++serial; timers.set(key, { fn: () => { timers.delete(key); fn(); }, delay }); return key; },
    clearTimeout: key => timers.delete(key) };
  return Object.assign(f, { target, timers, calls: () => calls, advance: ms => { clock += ms; }, clock: () => clock,
    once: () => ({ kind: 'once', at: new Date(clock + 60000).toISOString(), timezone: 'UTC' }),
    daily: () => ({ kind: 'daily', time: '00:01', timezone: 'UTC' }),
    signal(schedule, extra = {}) {
      const model = f.project.saveHookSignal({ name: 'quota time, not quota proof', schedule, ...extra }, f.project.hookSignals().revision);
      return model.signals.items.at(-1);
    },
    manager(signal, extra = {}) { return f.project.createManagementWorker({ name: 'manage target', instruction: 'start target', signal_id: signal.id, ...extra }); },
    view(task) { return f.project.managementView(task.id); },
    flush() { f.project.observeScheduledTaskHooks(); },
    async run() {
      f.project.pump();
      await Promise.all([...f.project.running.values()].map(run => run.promise));
    },
  });
}
function stored(f, task) { return JSON.parse(f.store.task(task.id).management); }
function rewrite(f, task, update) {
  const state = stored(f, task); update(state);
  f.store.update(task.id, { management: JSON.stringify(state) });
}
function count(f, type) { return f.store.get('SELECT count(*) AS n FROM events WHERE type=?', type).n; }

for (const failure of [false, true]) test(`management async remote retry holds a tracked receipt until ${failure ? 'unknown failure' : 'success'}`, async () => {
  const pending = gate(); let started = false, submitted, calls = 0;
  const f = await setup(({ task, api }, f) => {
    submitted = api.requestManagementAction(task.id, 'retry', f.target.id);
    return 'retry submitted, not completed';
  });
  const runnerBinding = f.store.runnerBinding.bind(f.store);
  // Caller-contract test, not a replacement for the independent Runner lifecycle chain.
  f.store.runnerBinding = id => id === f.target.id ? { worker_id: id } : runnerBinding(id);
  f.project.retry = async () => {
    calls++; started = true; expect(f.store.db.inTransaction).toBe(false);
    await pending.promise;
    if (failure) throw new Error('remote reconciliation unknown');
  };
  try {
    f.store.update(f.target.id, { status: 'failed' });
    const signal = f.signal(f.once()), manager = f.manager(signal);
    f.advance(60000); f.flush(); await f.run();
    expect(started).toBe(true); expect(submitted.status).toBe('running');
    expect(stored(f, manager).receipts[0].status).toBe('running');
    expect(f.project.managementControlJobs.size).toBe(1);
    expect(f.store.db.inTransaction).toBe(false);
    // A concurrent state update must survive the eventual asynchronous receipt write.
    rewrite(f, manager, state => { state.concurrent_marker = 'preserved'; });
    pending.resolve(); await Promise.all([...f.project.managementControlJobs]);
    const state = stored(f, manager);
    expect(state.concurrent_marker).toBe('preserved');
    const receipt = state.receipts[0] ?? state.last_execution?.actions[0];
    expect(receipt.status).toBe(failure ? 'unknown' : 'succeeded');
    expect(f.project.managementControlJobs.size).toBe(0);
    expect(f.project.managementControlOwners.size).toBe(0);
    f.project.drainManagementActions(); expect(calls).toBe(1);
  } finally { pending.resolve(); f.store.runnerBinding = runnerBinding; await f.close(); }
});

test('saving signals and management instructions is noncalling, revision-stable on ticks, and creates no Input/branch', async () => {
  const f = await setup();
  try {
    const beforeInputs = f.store.get('SELECT count(*) AS n FROM inputs').n;
    const beforeBranches = await git(f.root, 'branch', '--format=%(refname:short)');
    const signal = f.signal(f.once()); const manager = f.manager(signal);
    const revision = f.project.hookSignals().revision, bindingRevision = f.view(manager).revision;
    expect(manager).toMatchObject({ role: 'manager', task_kind: 'management', status: 'waiting', input_id: null,
      parent_id: null, branch: null, target_branch: null, worker_number: 'V1', workspace: null });
    expect(f.calls()).toBe(0); expect(f.timers.size).toBe(1);
    expect([...f.timers.values()][0].delay).toBeLessThanOrEqual(60000);
    expect(f.project.inspect(manager.id).management).toEqual(f.view(manager));
    expect(f.project.hooksList().management_workers).toHaveLength(1);
    expect(f.store.get('SELECT count(*) AS n FROM inputs').n).toBe(beforeInputs);
    expect(await git(f.root, 'branch', '--format=%(refname:short)')).toBe(beforeBranches);
    f.advance(60000); f.flush(); f.flush();
    expect(f.project.hookSignals().revision).toBe(revision);
    expect(f.view(manager).revision).toBe(bindingRevision);
    expect(f.view(manager)).toMatchObject({ state: 'queued', enabled: true, pending_signal: { due_at: signal.schedule.at } });
    expect(count(f, 'hook.signal_emitted')).toBe(1);
    expect(f.calls()).toBe(0); // Submission and actual admission are different facts.
  } finally { await f.close(); }
});

test('manager starts any eligible project target through the original lifecycle with deduplicated actions and expired tokens', async () => {
  let token, results;
  const f = await setup(({ task, api, token: current }, f) => {
    token = current;
    expect(api.actor(token)).toBe(task.id);
    const targets = api.managementQuery(task.id); expect(targets.workers.find(row => row.id === f.target.id).available_actions).toEqual(['start']);
    results = [api.requestManagementAction(task.id, 'start', f.target.id), api.requestManagementAction(task.id, 'start', f.target.id)];
    expect(results[0]).toEqual(results[1]);
    expect(api.managementQuery(task.id, f.target.id)).toMatchObject({ status: 'queued', available_actions: [] });
    return 'started, not proof of quota';
  });
  try {
    const signal = f.signal(f.once()); const manager = f.manager(signal);
    f.advance(60000); f.flush(); await f.run();
    expect(results[0]).toMatchObject({ status: 'succeeded', target_id: f.target.id, target_worker_number: f.target.worker_number });
    expect(f.store.task(f.target.id).status).toBe('queued');
    expect(count(f, 'management.action_submitted')).toBe(1); expect(count(f, 'management.action_completed')).toBe(1);
    expect(count(f, 'task.resumed')).toBe(1);
    expect(() => f.project.actor(token)).toThrow('invalid or expired');
    expect(() => f.project.requestManagementAction(manager.id, 'start', f.target.id)).toThrow('not active');
    expect(() => f.project.managementQuery(f.target.id)).toThrow('only a management');
  } finally { await f.close(); }
});

test('persistent management reuses one Worker, busy daily signals do not accumulate or create overlapping calls', async () => {
  const entered = gate(), release = gate();
  const f = await setup(async () => { entered.resolve(); await release.promise; return 'done'; });
  try {
    const signal = f.signal(f.daily()), manager = f.manager(signal, { mode: 'persistent' });
    f.advance(60000); f.flush(); f.project.pump(); await entered.promise;
    const due = f.view(manager).pending_signal.due_at;
    f.advance(86400000 * 3); f.flush(); f.project.pump();
    expect(f.calls()).toBe(1); expect(f.view(manager).pending_signal.due_at).toBe(due);
    expect(count(f, 'management.signal_skipped')).toBe(1);
    release.resolve(); await Promise.all([...f.project.running.values()].map(run => run.promise));
    expect(f.view(manager)).toMatchObject({ enabled: true, state: 'waiting', pending_signal: null });
    f.advance(86400000); f.flush(); await f.run();
    expect(f.calls()).toBe(2); expect(f.project.hooksList().management_workers).toHaveLength(1);
    expect(f.project.hooksList().management_workers[0]).toMatchObject({ id: manager.id, worker_number: 'V1' });
    expect(f.store.task(manager.id)).toMatchObject({ agent_wakes: 2, worker_number: 'V1' });
    expect(f.store.get("SELECT value FROM meta WHERE key='valet_number_high'").value).toBe('1');
  } finally { release.resolve(); await f.close(); }
});

test('unexpected errors after management operation begins stop authorization instead of treating exception text as a retryable gate', async () => {
  const f = await setup(({ task, api }, f) => {
    api.resumeTask = () => { throw new Error('a mystery gate with secret'); };
    expect(api.requestManagementAction(task.id, 'start', f.target.id)).toMatchObject({ status: 'unknown' });
    return 'cannot claim success';
  });
  try {
    const manager = f.manager(f.signal(f.daily()), { mode: 'persistent' }); f.advance(60000); f.flush(); await f.run();
    expect(f.view(manager)).toMatchObject({ enabled: false, state: 'unknown', last_execution: { status: 'unknown', actions: [{ status: 'unknown' }] } });
    expect(JSON.stringify(f.project.inspect(manager.id))).not.toContain('mystery gate');
    f.advance(86400000); f.flush(); await f.run(); expect(f.calls()).toBe(1);
    expect(f.store.task(f.target.id).status).toBe('paused');
    f.project.removeHookSignal(f.view(manager).signal_id, f.project.hookSignals().revision);
    expect(f.view(manager).last_execution.status).toBe('unknown'); // Historical diagnostic survives signal removal.
  } finally { await f.close(); }
});
