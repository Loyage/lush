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
    // Recovery checks now share a coordinator and count toward the restart barrier;
    // one microtask is not proof that every admitted check has settled.
    await until(() => reopened.runtimeCoordinator.pendingCount === 0 && reopened.runtimeCoordinator.runningCount === 0);
    expect(reopened.maintenanceView()).toMatchObject({ paused: true, ready_to_restart: true, affected_count: 1 });
    expect(f.provider.calls).toHaveLength(1);
    reopened.resumeAll(); await until(() => f.provider.calls.length === 2);
    expect(call(f, task.id).agent.model).toBe('saved');
    expect(f.store.task(staged.id).status).toBe('paused');
  } finally { if (reopened) await reopened.shutdown(); await f.close(); }
});
