import { test, expect, setDefaultTimeout } from 'bun:test';
import { fixture, repo, gate, until } from '../helpers.js';
import { Project } from '../../src/core/project.js';
setDefaultTimeout(20000);

async function scheduledFixture() {
  const f = fixture(); f.project.kick = () => {}; await repo(f.root);
  const job = await f.project.order('target', 'main', [], null, false);
  let clock = Date.parse('2030-01-01T00:00:00Z'), serial = 0;
  const timers = new Map();
  f.project.scheduledHookOptions = { now: () => clock,
    setTimeout: (fn, delay) => { const key = ++serial; timers.set(key, { fn: () => { timers.delete(key); fn(); }, delay }); return key; },
    clearTimeout: key => timers.delete(key) };
  return { ...f, job: job.task, main: f.store.task(job.task.parent_id), timers,
    advance: millis => { clock += millis; }, clock: () => clock,
    once: (action, extra = {}) => ({ name: '定时', trigger: 'time.scheduled', mode: 'once', enabled: true,
      schedule: { kind: 'once', at: new Date(clock + 60000).toISOString(), timezone: 'UTC' }, actions: [action], ...extra }),
    daily: action => ({ name: '每日', trigger: 'time.scheduled', mode: 'persistent', enabled: true,
      schedule: { kind: 'daily', time: '00:01', timezone: 'UTC' }, actions: [action] }),
    attach: (task, hook) => f.project.attachTaskHook(task.id, hook, f.project.taskHooks(task.id).revision).mounts.at(-1),
    view: (task, mount) => f.project.taskHooks(task.id).mounts.find(m => m.id === mount.id),
    async flush() { f.project.observeScheduledTaskHooks(); await f.project.hookQueue; },
  };
}
const notice = { type: 'notify', title: 'scheduled-test', body: 'submitted' };
const countNotices = f => f.store.get("SELECT count(*) AS n FROM notices WHERE title='scheduled-test'").n;

test('read-only future projection, bounded timer and nonblocking submission fire once even with runtime drift', async () => {
  const f = await scheduledFixture();
  try {
    const mount = f.attach(f.main, f.once(notice));
    await Promise.resolve();
    expect(f.view(f.main, mount)).toMatchObject({ state: 'waiting', next_run_at: '2030-01-01T00:01:00.000Z', pending_due_at: null });
    expect(f.timers.size).toBe(1); expect([...f.timers.values()][0].delay).toBeLessThanOrEqual(60000);
    const raw = f.store.task(f.main.id).hooks;
    f.project.taskHooks(f.main.id); f.project.inspect(f.main.id); f.project.hooksList();
    expect(f.store.task(f.main.id).hooks).toBe(raw); expect(countNotices(f)).toBe(0);
    const block = gate(); f.project.hookQueue = block.promise;
    f.advance(60000 * 5); f.project.observeScheduledTaskHooks();
    expect(f.view(f.main, mount)).toMatchObject({ state: 'waiting', pending_due_at: '2030-01-01T00:01:00.000Z' });
    expect(countNotices(f)).toBe(0); // Persisted authorization, no blocking work in observation.
    block.resolve(); await f.project.hookQueue;
    expect(f.view(f.main, mount)).toMatchObject({ state: 'succeeded', enabled: false, next_run_at: null, pending_due_at: null });
    expect(countNotices(f)).toBe(1);
    await f.flush(); await f.flush(); expect(countNotices(f)).toBe(1);
    await f.project.shutdown(); expect(f.timers.size).toBe(0);
  } finally { await f.close(); }
});

test('real daemon-side timer automatically submits a future action without UI polling or a manual tick', async () => {
  const f = await scheduledFixture(); let callbacks = 0;
  try {
    f.project.scheduledHookOptions = { now: Date.now,
      setTimeout: (fn, delay) => setTimeout(() => { callbacks += 1; fn(); }, delay), clearTimeout };
    const dueAt = new Date(Date.now() + 150).toISOString();
    const mount = f.attach(f.main, { name: 'real timer', trigger: 'time.scheduled', mode: 'once', enabled: true,
      schedule: { kind: 'once', at: dueAt, timezone: 'UTC' }, actions: [notice] });
    expect(countNotices(f)).toBe(0);
    // Only the normal attach microtask arms the timer. Neither observation nor emit/tick is called by the test.
    await until(() => f.view(f.main, mount).state === 'succeeded');
    expect(callbacks).toBeGreaterThanOrEqual(1); expect(countNotices(f)).toBe(1);
    expect(f.view(f.main, mount)).toMatchObject({ enabled: false, next_run_at: null, pending_due_at: null });
    expect(f.view(f.main, mount).last_execution.due_at).toBe(dueAt);
    expect(f.project.scheduledHookTimer).toBeNull();
  } finally { await f.close(); }
});

test('real timer retains a frozen pending action and submits exactly once when its safety gate clears', async () => {
  const f = await scheduledFixture(); let callbacks = 0;
  try {
    f.project.scheduledHookOptions = { now: Date.now,
      setTimeout: (fn, delay) => setTimeout(() => { callbacks += 1; fn(); }, delay), clearTimeout };
    f.store.update(f.job.id, { reservation: JSON.stringify({ version: 1, kind: 'merge', status: 'requested', commit: f.job.base_commit }) });
    const mount = f.attach(f.main, { name: 'real frozen timer', trigger: 'time.scheduled', mode: 'once', enabled: true,
      schedule: { kind: 'once', at: new Date(Date.now() + 150).toISOString(), timezone: 'UTC' },
      actions: [{ type: 'create_worker', content: 'real timer job', start: false }] });
    await until(() => Boolean(f.view(f.main, mount).pending_due_at));
    expect(f.view(f.main, mount).reason).toContain('冻结');
    expect(f.store.get('SELECT count(*) AS n FROM inputs').n).toBe(1);
    f.store.update(f.job.id, { reservation: null });
    // No manual observation after releasing the gate: the bounded pending timer rechecks and performs the action.
    await until(() => f.view(f.main, mount).state === 'succeeded');
    expect(callbacks).toBeGreaterThanOrEqual(2);
    expect(f.store.get('SELECT count(*) AS n FROM inputs').n).toBe(2);
    expect(f.view(f.main, mount)).toMatchObject({ enabled: false, pending_due_at: null });
  } finally { await f.close(); }
});

test('frozen creation submits on time, survives restart as pending, and forks only at first safe boundary once', async () => {
  const f = await scheduledFixture();
  try {
    f.store.update(f.job.id, { reservation: JSON.stringify({ version: 1, kind: 'merge', status: 'requested', commit: f.job.base_commit }) });
    const mount = f.attach(f.main, f.once({ type: 'create_worker', content: 'midnight job', start: false }));
    f.advance(60000); await f.flush();
    expect(f.view(f.main, mount)).toMatchObject({ state: 'waiting', pending_due_at: '2030-01-01T00:01:00.000Z' });
    expect(f.view(f.main, mount).reason).toContain('冻结');
    expect(f.store.get('SELECT count(*) AS n FROM inputs').n).toBe(1);
    f.advance(86400000); f.project.recoverTaskHooks(); await f.project.hookQueue;
    expect(f.view(f.main, mount).pending_due_at).toBe('2030-01-01T00:01:00.000Z');
    f.store.update(f.job.id, { reservation: null }); await f.project.runParentReadyHooks(f.main.id);
    expect(f.view(f.main, mount)).toMatchObject({ state: 'succeeded', enabled: false });
    const created = f.store.task(f.view(f.main, mount).last_execution.worker_id);
    expect(created).toMatchObject({ goal: 'midnight job', status: 'paused', parent_id: f.main.id });
    await f.flush(); expect(f.store.get('SELECT count(*) AS n FROM inputs').n).toBe(2);
  } finally { await f.close(); }
});

test('offline unsubmitted one-shot is skipped, daily advances without catch-up, running and pending retain different recovery meanings', async () => {
  const f = await scheduledFixture();
  try {
    const once = f.attach(f.main, f.once(notice));
    const daily = f.attach(f.job, f.daily({ type: 'message', target_id: f.job.id, body: 'nightly work' }));
    // No observation at the due date: emulate daemon offline.
    f.advance(3 * 86400000); f.project.recoverTaskHooks(); await f.project.hookQueue;
    expect(f.view(f.main, once)).toMatchObject({ state: 'skipped', enabled: false, pending_due_at: null });
    expect(f.view(f.main, once).last_execution.error).toContain('停机');
    expect(f.view(f.job, daily).next_run_at).toBe('2030-01-04T00:01:00.000Z');
    expect(f.store.get('SELECT count(*) AS n FROM messages WHERE task_id=?', f.job.id).n).toBe(0);
    expect(countNotices(f)).toBe(0);
    f.advance(60000); await f.flush();
    expect(f.store.get('SELECT count(*) AS n FROM messages WHERE task_id=?', f.job.id).n).toBe(1);
    expect(f.view(f.job, daily)).toMatchObject({ state: 'succeeded', enabled: true, next_run_at: '2030-01-05T00:01:00.000Z' });
  } finally { await f.close(); }
});

test('a fresh Project full recover skips offline dates but still executes persisted, never-started submission', async () => {
  const f = await scheduledFixture(); let restarted;
  try {
    f.project.taskSyncBusy = new Set([f.main.id]);
    const pending = f.attach(f.main, f.once({ type: 'create_worker', content: 'pre-restart pending', start: false }));
    f.advance(60000); await f.flush(); expect(f.view(f.main, pending).state).toBe('waiting');
    const missed = f.attach(f.main, f.once(notice));
    const daily = f.attach(f.main, f.daily(notice));
    f.store.update(f.job.id, { status: 'failed' });
    const retry = f.attach(f.job, f.once({ type: 'retry_worker', target_id: f.job.id }));
    await f.project.shutdown(); f.advance(2 * 86400000);
    restarted = new Project(f.config, f.store, f.project.provider, { scheduledHooks: f.project.scheduledHookOptions });
    restarted.kick = () => {}; restarted.recover();
    // Recovery installs a new queue/timer, rather than relying on the old instance's memory.
    await Promise.resolve(); await restarted.hookQueue;
    const mounts = restarted.taskHooks(f.main.id).mounts;
    expect(mounts.find(m => m.id === pending.id)).toMatchObject({ state: 'succeeded', enabled: false });
    expect(mounts.find(m => m.id === missed.id)).toMatchObject({ state: 'skipped', enabled: false });
    expect(mounts.find(m => m.id === daily.id).next_run_at).toBe('2030-01-04T00:01:00.000Z');
    expect(restarted.taskHooks(f.job.id).mounts.find(m => m.id === retry.id).state).toBe('skipped');
    expect(f.store.task(f.job.id).status).toBe('failed'); expect(countNotices(f)).toBe(0);
    expect(f.store.get('SELECT count(*) AS n FROM inputs').n).toBe(2);
  } finally { await restarted?.shutdown(); await f.close(); }
});

test('daily message is repeated only by clock, never by lifecycle edges or repeated observation', async () => {
  const f = await scheduledFixture();
  try {
    const mount = f.attach(f.job, f.daily({ type: 'message', target_id: f.job.id, body: 'nightly' }));
    f.advance(60000); await f.flush();
    f.project.emitTaskHook(f.job.id, 'agent.returned'); f.project.emitTaskHook(f.job.id, 'time.scheduled'); await f.project.hookQueue;
    await f.flush();
    expect(f.store.get('SELECT count(*) AS n FROM messages WHERE task_id=?', f.job.id).n).toBe(1);
    f.advance(86400000); await f.flush();
    expect(f.store.get('SELECT count(*) AS n FROM messages WHERE task_id=?', f.job.id).n).toBe(2);
    expect(f.view(f.job, mount).last_execution.due_at).toBe('2030-01-02T00:01:00.000Z');
  } finally { await f.close(); }
});

test('daily restart/re-enable cannot repeat an already submitted local date after a backwards clock correction', async () => {
  const f = await scheduledFixture();
  try {
    const mount = f.attach(f.main, f.daily(notice)); f.advance(60000); await f.flush(); expect(countNotices(f)).toBe(1);
    await f.project.updateTaskHook(f.main.id, mount.id, false, f.project.taskHooks(f.main.id).revision);
    f.advance(-60000);
    await f.project.updateTaskHook(f.main.id, mount.id, true, f.project.taskHooks(f.main.id).revision);
    f.project.recoverTaskHooks(); await f.project.hookQueue;
    expect(f.view(f.main, mount).next_run_at).toBe('2030-01-02T00:01:00.000Z');
    f.advance(60000); await f.flush(); expect(countNotices(f)).toBe(1);
  } finally { await f.close(); }
});

test('daily frozen message coalesces multiple days and never queues a backlog', async () => {
  const f = await scheduledFixture();
  try {
    const frozen = f.project.branchFreeze.bind(f.project); let blocked = true;
    f.project.branchFreeze = branch => branch === f.job.branch && blocked ? { branch, kind: 'test' } : frozen(branch);
    const mount = f.attach(f.job, f.daily({ type: 'message', target_id: f.job.id, body: 'one pending' }));
    f.advance(60000); await f.flush();
    const due = f.view(f.job, mount).pending_due_at;
    f.advance(5 * 86400000); await f.flush();
    expect(f.view(f.job, mount).pending_due_at).toBe(due);
    expect(f.view(f.job, mount).next_run_at).toBe('2030-01-07T00:01:00.000Z');
    blocked = false; await f.flush(); await f.flush();
    expect(f.store.get('SELECT count(*) AS n FROM messages WHERE task_id=?', f.job.id).n).toBe(1);
  } finally { await f.close(); }
});

test('failed Worker can mount only scheduled self-retry, profile is preserved and execution/receipt commit once', async () => {
  const f = await scheduledFixture();
  try {
    const profile = f.project.agentSettings.retryProfile('agent', { agent: 'pi', config_mode: 'lush', model: 'codex/model', append_prompt: 'PRIVATE_PROMPT', env: { PRIVATE_KEY: 'PRIVATE_VALUE' } });
    f.store.update(f.job.id, { status: 'failed', calls: 4, error: 'quota exhausted', retry_profile: JSON.stringify(profile) });
    expect(f.project.taskHooks(f.job.id).can_attach).toBe(true);
    expect(() => f.attach(f.job, f.once(notice))).toThrow('scheduled self-retry');
    expect(() => f.attach(f.job, { name: 'failure loop', trigger: 'agent.failed', mode: 'once', enabled: true, actions: [notice] })).toThrow('scheduled self-retry');
    const mount = f.attach(f.job, f.once({ type: 'retry_worker', target_id: f.job.id }));
    expect(JSON.stringify(f.project.taskHooks(f.job.id))).not.toContain('PRIVATE_');
    f.project.running.set(f.job.id, { role: 'agent', controller: new AbortController(), promise: Promise.resolve() });
    f.advance(60000); await f.flush();
    expect(f.view(f.job, mount).reason).toContain('收尾'); expect(f.store.task(f.job.id).status).toBe('failed');
    f.project.running.delete(f.job.id); await f.flush();
    expect(f.store.task(f.job.id)).toMatchObject({ status: 'queued', error: null, calls: 0 });
    expect(JSON.parse(f.store.task(f.job.id).retry_profile)).toEqual(profile);
    expect(f.view(f.job, mount)).toMatchObject({ state: 'succeeded', enabled: false });
    await f.flush(); expect(f.store.get("SELECT count(*) AS n FROM events WHERE task_id=? AND type='retry'", f.job.id).n).toBe(1);
  } finally { await f.close(); }
});

test('paused resume queues without restarting cancelled/accepted workers, incompatible retry records skipped', async () => {
  const f = await scheduledFixture();
  try {
    const retry = f.attach(f.job, f.once({ type: 'retry_worker', target_id: f.job.id }));
    const resume = f.attach(f.job, f.once({ type: 'resume_worker', target_id: f.job.id }));
    f.advance(60000); await f.flush();
    expect(f.view(f.job, retry)).toMatchObject({ state: 'skipped', enabled: false });
    expect(f.view(f.job, resume)).toMatchObject({ state: 'succeeded', enabled: false });
    expect(f.view(f.job, resume).actions[0].target_worker_number).toBe(f.job.worker_number);
    expect(f.store.task(f.job.id).status).toBe('queued');
    f.store.update(f.job.id, { status: 'paused' });
    const cancelled = f.attach(f.job, f.once({ type: 'resume_worker', target_id: f.job.id }));
    f.store.update(f.job.id, { status: 'cancelled' }); f.advance(60000); await f.flush();
    expect(f.view(f.job, cancelled)).toMatchObject({ state: 'skipped', enabled: false });
    expect(f.store.task(f.job.id).status).toBe('cancelled');
    expect(f.project.taskHooks(f.job.id).can_attach).toBe(false);
  } finally { await f.close(); }
});

test('sync gate is temporary, ancestor closure/archive is permanent, sibling target is refused at mount', async () => {
  const f = await scheduledFixture();
  try {
    const sibling = await f.project.order('sibling', 'main', [], null, false);
    expect(() => f.attach(f.job, f.once({ type: 'resume_worker', target_id: sibling.task.id }))).toThrow('direct parent/child');
    const mount = f.attach(f.job, f.once({ type: 'resume_worker', target_id: f.job.id }));
    f.project.taskSyncBusy = new Set([f.job.id]); f.advance(60000); await f.flush();
    expect(f.view(f.job, mount)).toMatchObject({ state: 'waiting' });
    expect(f.view(f.job, mount).reason).toContain('同步');
    f.project.taskSyncBusy.clear(); f.store.update(f.main.id, { status: 'completed' }); await f.flush();
    expect(f.view(f.job, mount)).toMatchObject({ state: 'skipped', enabled: false });
    expect(f.store.task(f.job.id).status).toBe('paused');
  } finally { await f.close(); }
});

test('disable/remove cancel only future authorization and re-enable daily does not catch up disabled dates', async () => {
  const f = await scheduledFixture();
  try {
    const mount = f.attach(f.main, f.daily(notice));
    await f.project.updateTaskHook(f.main.id, mount.id, false, f.project.taskHooks(f.main.id).revision);
    f.advance(5 * 86400000); await f.flush(); expect(countNotices(f)).toBe(0);
    await f.project.updateTaskHook(f.main.id, mount.id, true, f.project.taskHooks(f.main.id).revision);
    await f.flush(); expect(countNotices(f)).toBe(0);
    expect(f.view(f.main, mount).next_run_at).toBe('2030-01-06T00:01:00.000Z');
    f.project.removeTaskHook(f.main.id, mount.id, f.project.taskHooks(f.main.id).revision);
    f.advance(60000); await f.flush(); expect(countNotices(f)).toBe(0);
    await expect(f.project.updateTaskHook(f.main.id, mount.id, true, f.project.taskHooks(f.main.id).revision)).rejects.toThrow('not found');
  } finally { await f.close(); }
});

test('explicit restart profile/template is private and retained when same action is edited; expired template mount refuses', async () => {
  const f = await scheduledFixture();
  try {
    const privateProfile = { agent: 'pi', config_mode: 'lush', model: 'codex/model', append_prompt: 'PRIVATE_PROMPT', env: { PRIVATE_SECRET: 'PRIVATE_VALUE' } };
    const rule = f.once({ type: 'resume_worker', target_id: f.job.id, profile: privateProfile });
    const catalogue = f.project.saveHookTemplate(rule, f.project.hooksList().revision), template = catalogue.templates[0];
    expect(template.actions[0].model_selection.model).toBe('codex/model'); expect(JSON.stringify(catalogue)).not.toContain('PRIVATE_');
    const { model_selection, target_worker_number, ...publicAction } = template.actions[0];
    f.project.saveHookTemplate({ ...rule, id: template.id, name: 'renamed', actions: [publicAction] }, catalogue.revision);
    const mount = f.attach(f.job, { template_id: template.id });
    f.advance(60000); await f.flush();
    expect(f.view(f.job, mount).state).toBe('succeeded');
    expect(JSON.parse(f.store.task(f.job.id).retry_profile)).toEqual(f.project.agentSettings.retryProfile('agent', privateProfile));
    expect(() => f.attach(f.job, { template_id: template.id })).toThrow('future');
  } finally { await f.close(); }
});

test('unknown begun effect never replays; complete atomic receipts reconcile and unstarted pending remains authorized', async () => {
  const f = await scheduledFixture();
  try {
    const hold = gate(); f.project.hookQueue = hold.promise;
    const mount = f.attach(f.job, f.once({ type: 'message', target_id: f.job.id, body: 'unknown' }));
    f.advance(60000); f.project.observeScheduledTaskHooks();
    const data = JSON.parse(f.store.task(f.job.id).hooks), raw = data.mounts.find(m => m.id === mount.id);
    raw.state = 'running'; raw.last_execution.status = 'running'; raw.action_started_index = 0;
    f.store.update(f.job.id, { hooks: JSON.stringify(data) });
    f.project.recoverTaskHooks(); hold.resolve(); await f.project.hookQueue;
    expect(f.view(f.job, mount)).toMatchObject({ state: 'unknown', enabled: false, pending_due_at: null });
    await f.flush(); expect(f.store.get('SELECT count(*) AS n FROM messages WHERE task_id=?', f.job.id).n).toBe(0);
    await expect(f.project.updateTaskHook(f.job.id, mount.id, true, f.project.taskHooks(f.job.id).revision)).rejects.toThrow('require inspection');
    const atomic = f.attach(f.main, f.once(notice));
    f.advance(60000); await f.flush(); expect(countNotices(f)).toBe(1);
    const stored = JSON.parse(f.store.task(f.main.id).hooks), complete = stored.mounts.find(m => m.id === atomic.id);
    complete.state = 'running'; complete.enabled = true; complete.pending_execution_id = complete.last_execution.id;
    complete.pending_due_at = complete.last_execution.due_at; complete.last_execution.status = 'running';
    f.store.update(f.main.id, { hooks: JSON.stringify(stored) }); f.project.recoverTaskHooks(); await f.project.hookQueue;
    expect(f.view(f.main, atomic)).toMatchObject({ state: 'succeeded', enabled: false }); expect(countNotices(f)).toBe(1);
  } finally { await f.close(); }
});

test('submitted pending can be disabled/re-enabled without losing due identity; stopped future timers stay bounded', async () => {
  const f = await scheduledFixture();
  try {
    const freeze = f.project.branchFreeze.bind(f.project); let blocked = true;
    f.project.branchFreeze = branch => branch === f.job.branch && blocked ? { branch, kind: 'test' } : freeze(branch);
    const mount = f.attach(f.job, f.once({ type: 'message', target_id: f.job.id, body: 'persistent pending' }));
    f.advance(60000); await f.flush(); const due = f.view(f.job, mount).pending_due_at;
    await f.project.updateTaskHook(f.job.id, mount.id, false, f.project.taskHooks(f.job.id).revision);
    blocked = false; f.advance(86400000); await f.flush();
    expect(f.store.get('SELECT count(*) AS n FROM messages WHERE task_id=?', f.job.id).n).toBe(0);
    await f.project.updateTaskHook(f.job.id, mount.id, true, f.project.taskHooks(f.job.id).revision); await f.flush();
    expect(f.view(f.job, mount).last_execution.due_at).toBe(due);
    expect(f.store.get('SELECT count(*) AS n FROM messages WHERE task_id=?', f.job.id).n).toBe(1);
    const far = f.attach(f.main, f.once(notice, { schedule: { kind: 'once', at: '2035-01-01T00:00:00Z', timezone: 'UTC' } }));
    await f.flush(); expect([...f.timers.values()][0].delay).toBe(60000);
    const timer = [...f.timers.values()][0]; f.advance(60000); timer.fn(); await f.project.hookQueue;
    expect(f.view(f.main, far).state).toBe('waiting'); expect(countNotices(f)).toBe(0);
  } finally { await f.close(); }
});

test('exact scheduled creation Event reconciles an interrupted receipt without another Worker', async () => {
  const f = await scheduledFixture();
  try {
    const mount = f.attach(f.main, f.once({ type: 'create_worker', content: 'exact scheduled', start: false }));
    f.advance(60000); await f.flush();
    const completed = f.view(f.main, mount), data = JSON.parse(f.store.task(f.main.id).hooks), raw = data.mounts.find(m => m.id === mount.id);
    raw.state = 'running'; raw.enabled = true; raw.receipts = []; raw.pending_execution_id = raw.last_execution.id;
    raw.pending_due_at = raw.last_execution.due_at; raw.last_execution.status = 'running'; raw.action_started_index = 0;
    f.store.update(f.main.id, { hooks: JSON.stringify(data) }); f.project.recoverTaskHooks(); await f.project.hookQueue;
    expect(f.view(f.main, mount)).toMatchObject({ state: 'succeeded', enabled: false });
    expect(f.view(f.main, mount).last_execution.worker_id).toBe(completed.last_execution.worker_id);
    expect(f.view(f.main, mount).last_execution.worker_number).toBe(f.store.task(completed.last_execution.worker_id).worker_number);
    expect(f.store.get('SELECT count(*) AS n FROM inputs').n).toBe(2);
  } finally { await f.close(); }
});

test('a partially completed rule waits at a later gate without duplicating prior successful actions', async () => {
  const f = await scheduledFixture();
  try {
    f.project.taskSyncBusy = new Set([f.job.id]);
    const mount = f.attach(f.main, f.once(notice, { actions: [notice, { type: 'resume_worker', target_id: f.job.id }] }));
    f.advance(60000); await f.flush(); expect(countNotices(f)).toBe(1);
    expect(f.view(f.main, mount)).toMatchObject({ state: 'waiting', enabled: true });
    f.project.recoverTaskHooks(); await f.project.hookQueue; expect(countNotices(f)).toBe(1);
    f.project.taskSyncBusy.clear(); await f.flush();
    expect(f.view(f.main, mount).state).toBe('succeeded'); expect(countNotices(f)).toBe(1);
    expect(f.store.task(f.job.id).status).toBe('queued');
  } finally { await f.close(); }
});

test('failed Worker can revoke an existing scheduled message but cannot enable it as a revival loophole', async () => {
  const f = await scheduledFixture();
  try {
    const mount = f.attach(f.job, f.daily({ type: 'message', target_id: f.job.id, body: 'future' }));
    f.store.update(f.job.id, { status: 'failed' });
    expect(f.view(f.job, mount).editable).toBe(true);
    await f.project.updateTaskHook(f.job.id, mount.id, false, f.project.taskHooks(f.job.id).revision);
    await expect(f.project.updateTaskHook(f.job.id, mount.id, true, f.project.taskHooks(f.job.id).revision)).rejects.toThrow('scheduled self-retry');
    expect(f.store.task(f.job.id).status).toBe('failed');
  } finally { await f.close(); }
});

test('multi-action partial effects do not replay after later failure and schedule conditions skip at deadline', async () => {
  const f = await scheduledFixture();
  try {
    const mount = f.attach(f.main, f.once(notice, { actions: [notice, { type: 'resume_worker', target_id: f.job.id }] }));
    const originalResume = f.project.resumeTask; f.project.resumeTask = () => { throw new Error('PRIVATE_ERROR_TEXT'); };
    f.advance(60000); await f.flush();
    expect(countNotices(f)).toBe(1); expect(f.view(f.main, mount)).toMatchObject({ state: 'failed', enabled: false });
    expect(JSON.stringify(f.view(f.main, mount))).not.toContain('PRIVATE_ERROR_TEXT');
    f.project.resumeTask = originalResume; await f.flush(); expect(countNotices(f)).toBe(1);
    const conditional = f.attach(f.main, f.once(notice, { conditions: { statuses: ['paused'] } }));
    f.advance(60000); await f.flush(); expect(f.view(f.main, conditional).state).toBe('skipped'); expect(countNotices(f)).toBe(1);
  } finally { await f.close(); }
});
