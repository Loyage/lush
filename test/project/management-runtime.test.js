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

test('saving signals and management instructions is noncalling, revision-stable on ticks, and creates no Input/branch', async () => {
  const f = await setup();
  try {
    const beforeInputs = f.store.get('SELECT count(*) AS n FROM inputs').n;
    const beforeBranches = await git(f.root, 'branch', '--format=%(refname:short)');
    const signal = f.signal(f.once()); const manager = f.manager(signal);
    const revision = f.project.hookSignals().revision, bindingRevision = f.view(manager).revision;
    expect(manager).toMatchObject({ role: 'manager', task_kind: 'management', status: 'waiting', input_id: null,
      parent_id: null, branch: null, target_branch: null, worker_number: null, workspace: null });
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

test('one shared signal invokes independent managers and each once binding settles without Git or development inheritance', async () => {
  const seen = [];
  const f = await setup((options, f) => {
    expect(options.cwd).toBe(path.join(f.config.home, 'management', String(options.task.id)));
    expect(options.task.management).toBeUndefined(); expect(options.task.retry_profile).toBeUndefined();
    expect(options.forkPointer).toBeNull();
    expect(options.context.management.authorization.operations).toEqual(['query','start','retry']);
    seen.push(options.context.management.signal.id); return 'queried signal';
  });
  try {
    const signal = f.signal(f.once()); const first = f.manager(signal), second = f.manager(signal, { name: 'second' });
    f.advance(60000); f.flush(); await f.run();
    expect(f.calls()).toBe(2); expect(seen[0]).toBe(seen[1]);
    for (const manager of [first, second]) {
      expect(f.store.task(manager.id)).toMatchObject({ status: 'completed', branch: null, base_commit: null, head_commit: null, integration: 'none' });
      expect(f.view(manager)).toMatchObject({ enabled: false, state: 'succeeded', pending_signal: null,
        last_execution: { status: 'succeeded', id: seen[0] } });
      expect(fs.existsSync(path.join(f.config.home, 'management', String(manager.id)))).toBe(true);
      expect(() => f.project.retry(manager.id)).toThrow('only failed/cancelled');
      expect(() => f.project.updateManagementBinding(manager.id, true, f.view(manager).revision)).toThrow('cannot be replayed');
    }
    expect(f.timers.size).toBe(0); f.flush(); await f.run(); expect(f.calls()).toBe(2);
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

test('retry retains target selection and all failed-only, ancestor, archive, cancellation and action whitelist gates', async () => {
  let results;
  const f = await setup(({ task, api }, f) => {
    results = [api.requestManagementAction(task.id, 'retry', f.target.id)];
    for (const target of f.unsuitable) results.push(api.requestManagementAction(task.id, 'retry', target.id));
    expect(() => api.requestManagementAction(task.id, 'cancel', f.target.id)).toThrow('not authorized');
    return 'retry attempted';
  });
  try {
    const privateProfile = f.project.agentSettings.retryProfile('agent', { agent: 'pi', config_mode: 'pi' });
    f.store.update(f.target.id, { status: 'failed', retry_profile: JSON.stringify(privateProfile) });
    const cancelled = (await f.project.order('cancelled', 'main', [], null, false)).task;
    f.project.cancel(cancelled.id);
    const accepted = (await f.project.order('accepted', 'main', [], null, false)).task;
    f.store.update(accepted.id, { status: 'completed' });
    const archived = (await f.project.order('archived', 'main', [], null, false)).task;
    f.store.update(archived.id, { status: 'failed' }); f.store.run("UPDATE branches SET status='archived' WHERE branch=?", archived.branch);
    const closedParent = f.store.create({ role: 'agent', task_kind: 'order', goal: 'closed' });
    f.store.update(closedParent.id, { status: 'completed' });
    const descendant = f.store.create({ parent_id: closedParent.id, role: 'agent', task_kind: 'child', goal: 'ancestor closed' });
    f.store.update(descendant.id, { status: 'failed' });
    const paused = (await f.project.order('paused', 'main', [], null, false)).task;
    f.unsuitable = [cancelled, accepted, archived, descendant, paused, f.store.task(f.target.parent_id)];
    const manager = f.manager(f.signal(f.once()));
    f.advance(60000); f.flush(); await f.run();
    expect(results[0].status).toBe('succeeded'); expect(results.slice(1).every(result => result.status === 'skipped')).toBe(true);
    expect(JSON.parse(f.store.task(f.target.id).retry_profile)).toEqual(privateProfile);
    expect(f.store.task(f.target.id).status).toBe('queued');
    expect(f.view(manager).last_execution.status).toBe('skipped');
    expect(f.calls()).toBe(1);
  } finally { await f.close(); }
});

test('a frozen durable request survives manager return and executes at its safe point without another model call', async () => {
  const f = await setup(({ task, api }, f) => {
    expect(api.requestManagementAction(task.id, 'start', f.target.id).status).toBe('waiting');
    return 'submitted; do not poll';
  });
  try {
    let frozen = true; const original = f.project.branchFreeze.bind(f.project);
    f.project.branchFreeze = branch => branch === f.target.branch && frozen ? { branch, reason: 'test freeze' } : original(branch);
    const manager = f.manager(f.signal(f.once())); f.advance(60000); f.flush(); await f.run();
    expect(f.calls()).toBe(1); expect(f.store.task(f.target.id).status).toBe('paused');
    expect(f.view(manager)).toMatchObject({ state: 'waiting_actions', pending_signal: { actions: [{ status: 'waiting' }] } });
    const revision = f.view(manager).revision;
    frozen = false; f.flush();
    expect(f.store.task(f.target.id).status).toBe('queued');
    expect(f.store.task(manager.id).status).toBe('completed');
    expect(f.view(manager)).toMatchObject({ revision, pending_signal: null, last_execution: { status: 'succeeded', actions: [{ status: 'succeeded' }] } });
    expect(f.calls()).toBe(1); f.flush(); expect(count(f, 'task.resumed')).toBe(1);
  } finally { await f.close(); }
});

test('sync, worktree cleanup and physical target invocation exit are temporary gates, not failed commands', async () => {
  const f = await setup(({ task, api }, f) => { api.requestManagementAction(task.id, 'start', f.target.id); return 'submitted'; });
  try {
    f.project.taskSyncBusy = new Set([f.target.id]);
    const manager = f.manager(f.signal(f.once())); f.advance(60000); f.flush(); await f.run();
    expect(f.view(manager).pending_signal.actions[0].reason).toContain('同步');
    f.project.taskSyncBusy.clear(); f.project.workspaces.busy.add(f.target.id); f.flush();
    expect(f.view(manager).pending_signal.actions[0].reason).toContain('清理');
    f.project.workspaces.busy.delete(f.target.id);
    f.project.running.set(f.target.id, { role: 'agent', controller: new AbortController(), promise: Promise.resolve(), invocationEnded: true }); f.flush();
    expect(f.view(manager).pending_signal.actions[0].reason).toContain('实际退出');
    f.project.running.delete(f.target.id); f.flush();
    expect(f.view(manager).last_execution.actions[0].status).toBe('succeeded');
    expect(f.calls()).toBe(1);
  } finally { f.project.running.delete(f.target.id); await f.close(); }
});

test('disabling queued or waiting-action bindings revokes unstarted work and prevents old signals replaying on re-enable', async () => {
  const f = await setup(({ task, api }, f) => { api.requestManagementAction(task.id, 'start', f.target.id); return 'submitted'; });
  try {
    const signal = f.signal(f.daily()); const first = f.manager(signal, { mode: 'persistent' });
    f.advance(60000); f.flush();
    f.project.updateManagementBinding(first.id, false, f.view(first).revision);
    expect(f.view(first)).toMatchObject({ enabled: false, state: 'stopped', pending_signal: null });
    await f.run(); expect(f.calls()).toBe(0);
    f.project.updateManagementBinding(first.id, true, f.view(first).revision); f.flush(); await f.run();
    expect(f.calls()).toBe(0);
    let frozen = true; const original = f.project.branchFreeze.bind(f.project);
    f.project.branchFreeze = branch => branch === f.target.branch && frozen ? { branch } : original(branch);
    f.advance(86400000); f.flush(); await f.run(); expect(f.calls()).toBe(1);
    f.project.updateManagementBinding(first.id, false, f.view(first).revision);
    frozen = false; f.flush();
    expect(f.store.task(f.target.id).status).toBe('paused');
    expect(f.view(first)).toMatchObject({ pending_signal: null, last_execution: { actions: [{ status: 'skipped' }] } });
    f.project.updateManagementBinding(first.id, true, f.view(first).revision); f.flush(); await f.run(); expect(f.calls()).toBe(1);
  } finally { await f.close(); }
});

test('running disable rejects new privileged tools without killing the model or its already completed operation', async () => {
  const entered = gate(), release = gate(); let token;
  const f = await setup(async ({ task, api, token: current }, f) => {
    token = current; api.requestManagementAction(task.id, 'start', f.target.id); entered.resolve(); await release.promise;
    expect(() => api.requestManagementAction(task.id, 'retry', f.target.id)).toThrow('authorization is not active');
    return 'honored revocation';
  });
  try {
    const manager = f.manager(f.signal(f.once())); f.advance(60000); f.flush();
    f.project.pump(); await entered.promise;
    f.project.updateManagementBinding(manager.id, false, f.view(manager).revision);
    expect(f.project.actor(token)).toBe(manager.id); // Credential remains per invocation; capabilities have been revoked.
    expect(f.project.running.get(manager.id).controller.signal.aborted).toBe(false);
    release.resolve(); await Promise.all([...f.project.running.values()].map(run => run.promise));
    expect(f.store.task(f.target.id).status).toBe('queued');
    expect(f.view(manager)).toMatchObject({ enabled: false, pending_signal: null, last_execution: { status: 'skipped' } });
  } finally { release.resolve(); await f.close(); }
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
    expect(f.store.task(manager.id).agent_wakes).toBe(2);
  } finally { release.resolve(); await f.close(); }
});

test('failed or unknown management cannot be automatically revived by the next day or the ordinary retry endpoint', async () => {
  const f = await setup(() => { throw new Error('raw-auth-response-must-not-enter-management-view'); });
  try {
    const manager = f.manager(f.signal(f.daily()), { mode: 'persistent' }); f.advance(60000); f.flush(); await f.run();
    expect(f.view(manager)).toMatchObject({ enabled: false, state: 'failed', last_execution: { status: 'failed' } });
    expect(JSON.stringify(f.project.inspect(manager.id))).not.toContain('raw-auth-response');
    expect(f.store.task(manager.id).status).toBe('failed');
    f.advance(86400000); f.flush(); await f.run(); expect(f.calls()).toBe(1);
    expect(() => f.project.retry(manager.id)).toThrow('do not replay');
    expect(() => f.project.updateManagementBinding(manager.id, true, f.view(manager).revision)).toThrow('cannot be replayed');
  } finally { await f.close(); }
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

for (const throwsAfterTool of [false, true]) test(`unknown tool effect closes the physical Run after Provider ${throwsAfterTool ? 'throws' : 'returns'} without a success Artifact or replay`, async () => {
  const entered = gate(), release = gate(); let token, runId, diagnostic;
  const f = await setup(async ({ task, api, token: current }, f) => {
    token = current; runId = api.running.get(task.id).recordId;
    expect(api.requestManagementAction(task.id, 'start', f.target.id).status).toBe('succeeded');
    api.resumeTask = () => { throw new Error('private unknown-side-effect diagnostic'); };
    expect(api.requestManagementAction(task.id, 'start', f.other.id).status).toBe('unknown');
    diagnostic = stored(f, task).last_execution;
    entered.resolve(); await release.promise;
    if (throwsAfterTool) throw new Error('private Provider failure after unknown tool');
    return 'must not become a successful Artifact';
  });
  try {
    f.other = (await f.project.order('unknown target', 'main', [], null, false)).task;
    const manager = f.manager(f.signal(f.daily()), { mode: 'persistent' });
    f.advance(60000); f.flush(); f.project.pump(); await entered.promise;
    const invocation = f.project.running.get(manager.id);
    expect(f.store.task(manager.id).status).toBe('failed');
    expect(f.store.get('SELECT status FROM agent_runs WHERE id=?', runId).status).toBe('running');
    expect(() => f.project.actor(token)).toThrow();
    release.resolve(); await invocation.promise;
    expect(f.project.running.has(manager.id)).toBe(false);
    expect(f.store.task(manager.id).agent_token_hash).toBeNull();
    const run = f.store.get('SELECT * FROM agent_runs WHERE id=?', runId);
    expect(run).toMatchObject({ status: 'failed', result: null }); expect(run.ended_at).not.toBeNull();
    expect(JSON.stringify(run)).not.toContain('private');
    expect(f.store.get("SELECT count(*) AS n FROM artifacts WHERE task_id=? AND kind='run.result'", manager.id).n).toBe(0);
    expect(f.store.get("SELECT count(*) AS n FROM events WHERE task_id=? AND type='invocation.completed'", manager.id).n).toBe(0);
    expect(f.view(manager)).toMatchObject({ enabled: false, state: 'unknown', last_execution: { status: 'unknown',
      actions: [{ status: 'succeeded', target_id: f.target.id }, { status: 'unknown', target_id: f.other.id }] } });
    expect(stored(f, manager).last_execution).toEqual(diagnostic);
    expect(count(f, 'management.unknown')).toBe(1); expect(count(f, 'management.failed')).toBe(0);
    expect(f.store.task(f.target.id).status).toBe('queued'); expect(f.store.task(f.other.id).status).toBe('paused');
    f.project.recover(); f.advance(86400000); f.flush(); await f.run();
    expect(f.calls()).toBe(1); expect(f.store.task(f.other.id).status).toBe('paused');
    expect(stored(f, manager).last_execution).toEqual(diagnostic);
  } finally { release.resolve(); await f.close(); }
});

test('Hooks compact summaries keep all 64 enabled authorizations visible under the byte budget with maximal goals and duplicated 32-receipt history', async () => {
  const f = await setup();
  try {
    const signal = f.signal(f.daily(), { name: '信'.repeat(200) }), goal = '😀'.repeat(16000);
    for (let i = 0; i < 40; i++) {
      const old = f.manager(signal, { instruction: goal });
      f.project.updateManagementBinding(old.id, false, f.view(old).revision);
    }
    const managers = Array.from({ length: 64 }, () => f.manager(signal, { name: '管'.repeat(200), instruction: goal, mode: 'persistent' }));
    f.advance(60000); f.flush();
    for (const manager of managers) rewrite(f, manager, state => {
      state.receipts = Array.from({ length: 32 }, (_, index) => ({ receipt_id: `receipt-${manager.id}-${index}`, action: 'start',
        target_id: f.target.id + index, target_worker_number: 'W1' + '-1'.repeat(600), status: 'succeeded', reason: '原'.repeat(100) }));
      state.last_execution = { ...state.pending_signal, status: 'succeeded', actions: state.receipts };
      expect(Buffer.byteLength(JSON.stringify(state))).toBeLessThanOrEqual(128 * 1024);
    });
    const list = f.project.hooksList().management_workers;
    const enabled = list.filter(row => row.management.enabled);
    expect(enabled.map(row => row.id).sort((a, b) => a - b)).toEqual(managers.map(row => row.id));
    expect(Buffer.byteLength(JSON.stringify(list))).toBeLessThanOrEqual(512 * 1024);
    for (const row of enabled) {
      expect(row).toMatchObject({ goal_truncated: true, goal_length: 32000 }); expect(row.goal.length).toBe(160);
      for (const execution of [row.management.pending_signal, row.management.last_execution]) {
        expect(execution).toMatchObject({ actions_count: 32, actions_truncated: true });
        expect(execution.actions).toHaveLength(2);
        expect(execution.actions[0]).toMatchObject({ target_worker_number: null, target_worker_number_truncated: true });
      }
      const inspect = f.project.inspect(row.id);
      expect(inspect.goal).toBe(goal);
      expect(inspect.management.pending_signal.actions).toHaveLength(32);
      expect(inspect.management.last_execution.actions).toHaveLength(32);
      f.project.updateManagementBinding(row.id, false, row.management.revision);
    }
    expect(f.project.hooksList().management_workers.some(row => row.management.enabled)).toBe(false);
    expect(f.calls()).toBe(0);
  } finally { await f.close(); }
});

test('stopped-daemon missed dates skip while already submitted unstarted management resumes safely', async () => {
  const f = await setup();
  try {
    const missed = f.manager(f.signal(f.once()));
    const daily = f.manager(f.signal(f.daily()), { mode: 'persistent' });
    f.advance(60000);
    f.project.recover();
    expect(f.project.hookSignals().items[0]).toMatchObject({ enabled: false, next_run_at: null, last_execution: { status: 'skipped' } });
    expect(f.project.hookSignals().items[1].next_run_at).toBe('2030-01-02T00:01:00.000Z');
    await f.run(); expect(f.calls()).toBe(0); expect(f.view(missed).pending_signal).toBeNull();
    f.advance(86400000); f.flush(); expect(f.view(daily).state).toBe('queued');
    const pending = f.view(daily).pending_signal.id;
    f.advance(86400000 * 2); f.project.recover(); await f.run();
    expect(f.calls()).toBe(1); expect(f.view(daily).last_execution.id).toBe(pending);
  } finally { await f.close(); }
});

test('interrupted started models do not replay; exact successful model receipts recover pending actions without another call', async () => {
  const f = await setup();
  try {
    const signal = f.signal(f.daily()), unknown = f.manager(signal), confirmed = f.manager(signal);
    f.advance(60000); f.flush();
    for (const manager of [unknown, confirmed]) {
      const run = f.store.startRun(f.store.task(manager.id), { agent: 'mock', model: '' });
      f.project.beginManagementInvocation(manager.id, run.id);
      f.store.update(manager.id, { status: 'running' });
      if (manager.id === confirmed.id) {
        f.store.finishRun(run.id, 'completed', { result: 'done' });
        f.store.event(manager.id, 'invocation.completed', { run_id: run.id, result: 'done' });
      }
    }
    f.project.recover();
    expect(f.view(unknown)).toMatchObject({ enabled: false, state: 'unknown', pending_signal: { status: 'unknown' } });
    expect(f.store.task(unknown.id).status).toBe('failed');
    expect(f.view(confirmed)).toMatchObject({ enabled: false, pending_signal: null, last_execution: { status: 'succeeded' } });
    expect(f.store.task(confirmed.id).status).toBe('completed');
    await f.run(); expect(f.calls()).toBe(0);
  } finally { await f.close(); }
});

test('returned blocked operations survive daemon recovery; exact atomic operation receipts reconcile started records', async () => {
  const f = await setup(({ task, api }, f) => { api.requestManagementAction(task.id, 'start', f.target.id); return 'submitted'; });
  try {
    let frozen = true; const original = f.project.branchFreeze.bind(f.project);
    f.project.branchFreeze = branch => branch === f.target.branch && frozen ? { branch } : original(branch);
    const manager = f.manager(f.signal(f.once())); f.advance(60000); f.flush(); await f.run();
    f.project.recover(); expect(f.view(manager).state).toBe('waiting_actions');
    frozen = false; f.flush(); expect(f.view(manager).last_execution.actions[0].status).toBe('succeeded');
    expect(f.calls()).toBe(1);
    // Simulate a receipt write lost after its exact atomic evidence: no second lifecycle action occurs.
    const state = stored(f, manager); state.pending_signal = { ...state.last_execution, phase: 'returned' };
    state.enabled = true; state.consumed = false; state.state = 'waiting_actions'; state.receipts[0].status = 'running';
    f.store.update(manager.id, { management: JSON.stringify(state), status: 'waiting' });
    f.project.recover(); f.flush();
    expect(f.view(manager).last_execution.actions[0].status).toBe('succeeded'); expect(count(f, 'task.resumed')).toBe(1);
  } finally { await f.close(); }
});

test('one-shot clock rollback does not re-enable emitted/missed signals; editing to a genuinely new future time is explicit', async () => {
  const f = await setup();
  try {
    const signal = f.signal(f.once()), manager = f.manager(signal); f.advance(60000); f.flush();
    f.advance(-120000);
    expect(() => f.project.saveHookSignal({ ...signal, enabled: true, next_run_at: null }, f.project.hookSignals().revision)).toThrow('invalid signal fields');
    expect(() => f.project.saveHookSignal({ id: signal.id, name: 'rename', schedule: signal.schedule, enabled: true }, f.project.hookSignals().revision)).toThrow('already emitted or skipped');
    expect(f.view(manager).pending_signal).not.toBeNull();
    f.project.saveHookSignal({ id: signal.id, name: 'new future deadline', schedule: f.once(), enabled: true }, f.project.hookSignals().revision);
    expect(f.project.hookSignals().items[0].next_run_at).not.toBe(signal.schedule.at);
  } finally { await f.close(); }
});

test('profile and configuration validation occurs before creating a management record; safe projections omit private config', async () => {
  const f = await setup();
  try {
    const signal = f.signal(f.daily()); const before = f.store.tasks().length;
    expect(() => f.manager(signal, { mode: 'loop' })).toThrow('mode');
    expect(() => f.manager(signal, { profile: { agent: 'codex' } })).toThrow('legacy Codex CLI');
    expect(() => f.manager(signal, { profile: { agent: 'pi' } })).toThrow('model source');
    expect(() => f.manager(signal, { profile: { connection_id: 'not-a-uuid' } })).toThrow();
    expect(f.store.tasks().length).toBe(before);
    const manager = f.manager(signal, { profile: { agent: 'pi', connection_id: 'a1111111-1111-4111-8111-111111111111',
      model: 'codex/gpt-test', default_prompt: 'PRIVATE_PROMPT', env: { PRIVATE_ENV: 'PRIVATE_VALUE' } } });
    const storedProfile = JSON.parse(f.store.task(manager.id).retry_profile);
    expect(storedProfile.default_prompt).toBe(''); // The parent's manager role strips development Prompt overrides.
    expect(storedProfile.env.PRIVATE_ENV).toBe('PRIVATE_VALUE');
    expect(f.project.inspect(manager.id).model_selection).toMatchObject({ explicit: true, connection_id: storedProfile.connection_id });
    expect(JSON.stringify(f.project.hooksList())).not.toContain('PRIVATE');
    expect(JSON.stringify(f.project.inspect(manager.id))).not.toContain('PRIVATE');
    expect(() => f.project.saveHookSignal({ name: 'wrong', schedule: { ...f.daily(), timezone: 'invalid/timezone' } }, f.project.hookSignals().revision)).toThrow('timezone');
    expect(() => f.project.removeHookSignal(signal.id, f.project.hookSignals().revision)).toThrow('bindings');
    f.project.updateManagementBinding(manager.id, false, f.view(manager).revision);
    f.project.removeHookSignal(signal.id, f.project.hookSignals().revision);
    expect(f.project.hookSignals().items).toHaveLength(0);
  } finally { await f.close(); }
});

test('manager workspace rejects links and cleanup preserves unexpected files rather than running Git or deleting them', async () => {
  const f = await setup();
  try {
    const manager = f.manager(f.signal(f.daily()));
    const dir = await f.project.workspaces.ensure(f.store.task(manager.id));
    fs.writeFileSync(path.join(dir, 'unexpected.txt'), 'preserve');
    await f.project.workspaces.finish(f.store.task(manager.id));
    f.project.cancel(manager.id);
    await expect(f.project.workspaces.cleanup(manager.id)).rejects.toThrow('contains files');
    expect(fs.readFileSync(path.join(dir, 'unexpected.txt'), 'utf8')).toBe('preserve');
    fs.unlinkSync(path.join(dir, 'unexpected.txt'));
    expect((await f.project.workspaces.cleanup(manager.id)).cleanup).toMatchObject({ worktree: 'removed', branch: 'absent' });
    const another = f.manager(f.project.hookSignals().items[0]);
    const alias = path.join(f.config.home, 'management', String(another.id)); fs.symlinkSync(f.root, alias);
    await expect(f.project.workspaces.ensure(f.store.task(another.id))).rejects.toThrow('symlink');
  } finally { await f.close(); }
});

test('bounded operations, revision conflicts, actor mismatch and autonomous real timer admission use the same secure seams', async () => {
  const f = await setup(({ task, api }, f) => {
    const run = api.running.get(task.id), hash = f.store.task(task.id).agent_token_hash;
    f.store.armAgent(task.id, tokenHash('different invocation'));
    expect(() => api.managementQuery(task.id)).toThrow('not active');
    f.store.armAgent(task.id, hash);
    expect(run.recordId).toBeGreaterThan(0);
    for (let i = 0; i < 32; i++) {
      const invalid = f.store.create({ role: 'agent', task_kind: 'order', goal: 'queued is ineligible' });
      api.requestManagementAction(task.id, 'retry', invalid.id);
    }
    expect(() => api.requestManagementAction(task.id, 'start', f.target.id)).toThrow('action limit');
    return 'bounded';
  });
  try {
    const signal = f.signal(f.daily()), manager = f.manager(signal), revision = f.view(manager).revision;
    f.project.updateManagementBinding(manager.id, false, revision);
    expect(() => f.project.updateManagementBinding(manager.id, true, revision)).toThrow('revision changed');
    f.project.updateManagementBinding(manager.id, true, f.view(manager).revision);
    f.advance(60000); f.flush(); await f.run(); expect(f.view(manager).last_execution.actions).toHaveLength(32);
    f.project.scheduledHookOptions = { now: Date.now, setTimeout, clearTimeout };
    const dueAt = new Date(Date.now() + 250).toISOString();
    const realSignal = f.signal({ kind: 'once', at: dueAt, timezone: 'UTC' }); const realManager = f.manager(realSignal);
    await until(() => f.view(realManager).state === 'queued');
    expect(f.view(realManager).pending_signal.due_at).toBe(dueAt);
    expect(f.calls()).toBe(1); // The timer submits; the disabled kick seam does not call a provider.
    await f.project.shutdown(); expect(f.project.scheduledHookTimer).toBeNull();
  } finally { await f.close(); }
});
