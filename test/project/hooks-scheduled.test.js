import { test, expect, setDefaultTimeout } from 'bun:test';
import { fixture, repo, gate, until } from '../helpers.js';
import { retiredHook, interruptHookFinish } from '../hook-assertions.js';
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
    await until(() => !f.view(f.main, mount));
    expect(callbacks).toBeGreaterThanOrEqual(1); expect(countNotices(f)).toBe(1);
    expect(retiredHook(f.project, f.main.id, mount.id).due_at).toBe(dueAt);
    expect(f.project.scheduledHookTimer).toBeNull();
  } finally { await f.close(); }
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
    expect(f.store.unread(f.job.id).map(row => row.append_number)).toEqual([null, null]);
    expect(f.store.get('SELECT value FROM meta WHERE key=?', `input_append_high:${f.job.input_id}`)).toBeNull();
    f.project.message(f.job.id, 'explicit user append');
    expect(f.store.unread(f.job.id).at(-1).append_number).toBe(`A${f.job.input_id}-1`);
  } finally { await f.close(); }
});
