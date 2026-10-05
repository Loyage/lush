import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { Database } from 'bun:sqlite';
import { fixture, repo, until, gate, temp } from '../helpers.js';
import { AgentPreempted } from '../../src/agent/provider.js';
import { Store } from '../../src/persistence/store.js';
import { PARAMS, USER_ONLY, assertAllowed } from '../../src/rpc/registry.js';
import { Dispatcher } from '../../src/rpc/protocol.js';

function controlled(agent = 'pi') {
  const calls = [];
  return {
    calls,
    resolve: () => ({ agent, model: '', thinking: '', default_prompt: '', append_prompt: '', extensions: [], skills: [] }),
    run: options => {
      const done = gate();
      calls.push({ ...options, done });
      return new Promise((resolve, reject) => {
        const stop = () => reject(options.signal.reason);
        if (options.signal.aborted) return stop();
        options.signal.addEventListener('abort', stop, { once: true });
        done.promise.then(result => {
          options.signal.removeEventListener('abort', stop);
          if (result instanceof Error) reject(result); else resolve(result ?? 'finished');
        });
      });
    },
  };
}
async function start(f) {
  f.project.stopping = true;
  await repo(f.root);
  const { task } = await f.project.order('interruptible work');
  f.project.stopping = false; f.project.kick();
  await until(() => f.project.provider.calls.length === 1);
  return task;
}
function files(f, task) {
  const dir = path.join(f.config.home, 'preempt');
  return { request: path.join(dir, `task-${task.id}.request.json`), stop: path.join(dir, `task-${task.id}.stop.json`) };
}
function events(f, task, type) { return f.store.all('SELECT * FROM events WHERE task_id=? AND type=?', task.id, type); }

test('pending interrupt preserves active credentials, context and children; resume cancels without a second call', async () => {
  const provider = controlled(), f = fixture(provider);
  try {
    const task = await start(f), run = f.project.running.get(task.id), marks = files(f, task);
    const child = f.store.create({ parent_id: task.id, input_id: task.input_id, role: 'agent', goal: 'independent child', task_kind: 'child' });
    f.store.update(child.id, { status: 'waiting' });
    const before = f.store.task(task.id);
    expect(f.project.interrupt(task.id)).toMatchObject({ status: 'running', interrupt_state: 'requested', error: null });
    expect(f.project.actor(run.token)).toBe(task.id);
    f.project.reportProgressPlan(task.id, [{ key: 'safe-work', label: 'safe work' }]);
    expect(f.store.task(child.id).status).toBe('waiting');
    expect(fs.existsSync(marks.request)).toBe(true);
    // Both writes and read projections remain truthful while tools finish.
    expect(f.project.inspect(task.id).interrupt_state).toBe('requested');
    expect(f.project.activity().tasks.find(row => row.id === task.id).interrupt_state).toBe('requested');
    expect((await f.project.taskGraph()).nodes.find(row => row.id === task.id).interrupt_state).toBe('requested');
    expect(f.project.interrupt(task.id).interrupt_state).toBe('requested');
    expect(events(f, task, 'task.interrupted')).toHaveLength(1);
    expect(f.project.resumeTask(task.id)).toMatchObject({ status: 'running', interrupt_state: null });
    expect(fs.existsSync(marks.request)).toBe(false);
    expect(run.controller.signal.aborted).toBe(false);
    expect(f.project.actor(run.token)).toBe(task.id);
    expect(f.project.resumeTask(task.id).status).toBe('running');
    f.project.pump();
    expect(provider.calls).toHaveLength(1);
    provider.calls[0].done.resolve('original invocation completed');
    await until(() => !f.project.running.has(task.id));
    expect(f.store.task(task.id)).toMatchObject({ status: 'waiting', calls: 1, branch: before.branch, workspace: before.workspace });
    expect(events(f, task, 'invocation.preempted')).toHaveLength(0);
  } finally { await f.close(); }
});

test('claimed interrupt accepts resume immediately but starts exactly one new call only after old exit', async () => {
  const provider = controlled(), f = fixture(provider);
  try {
    const task = await start(f), run = f.project.running.get(task.id), marks = files(f, task);
    f.project.interrupt(task.id);
    fs.renameSync(marks.request, marks.stop); // Pi wins the atomic claim race.
    expect(f.project.resumeTask(task.id)).toMatchObject({ status: 'queued', interrupt_state: 'resuming' });
    expect(fs.existsSync(marks.stop)).toBe(true);
    f.project.resumeTask(task.id); f.project.pump();
    expect(provider.calls).toHaveLength(1);
    provider.calls[0].done.resolve(new AgentPreempted({ safe_point: 'turn_end', reason: 'pause' }));
    await until(() => provider.calls.length === 2);
    expect(f.store.task(task.id)).toMatchObject({ status: 'running', calls: 2, interrupt_state: null });
    expect(f.project.running.get(task.id)).not.toBe(run);
    expect(() => f.project.actor(run.token)).toThrow('invalid or expired');
    expect(f.store.all('SELECT status FROM agent_runs WHERE task_id=?', task.id).map(row => row.status)).toContain('preempted');
    provider.calls[1].done.resolve('resumed');
    await until(() => !f.project.running.has(task.id));
    expect(f.store.task(task.id).status).toBe('waiting');
  } finally { await f.close(); }
});

test('provider cleanup cannot erase the claimed-stop fact before resume races with scheduler catch', async () => {
  const provider = controlled(), f = fixture(provider);
  try {
    const task = await start(f), marks = files(f, task);
    f.project.interrupt(task.id);
    // Real PiProvider latches onPreempt before cleaning its consumed stop marker.
    fs.renameSync(marks.request, marks.stop);
    provider.calls[0].onPreempt();
    fs.rmSync(marks.stop);
    expect(f.project.resumeTask(task.id).interrupt_state).toBe('resuming');
    provider.calls[0].done.resolve(new AgentPreempted());
    await until(() => provider.calls.length === 2);
    provider.calls[1].done.resolve('continued once');
    await until(() => !f.project.running.has(task.id));
    expect(f.store.task(task.id).calls).toBe(2);
  } finally { await f.close(); }
});

test('pause settles at a safe boundary, keeps messages unread and resumes with the same workspace', async () => {
  const provider = controlled(), f = fixture(provider);
  try {
    const task = await start(f), run = f.project.running.get(task.id);
    f.project.interrupt(task.id);
    f.project.message(task.id, 'correction for next invocation');
    expect(f.store.task(task.id).status).toBe('running');
    provider.calls[0].done.resolve(new AgentPreempted({ safe_point: 'turn_end' }));
    await until(() => !f.project.running.has(task.id));
    expect(f.store.task(task.id)).toMatchObject({ status: 'paused', interrupt_state: null, error: null, calls: 1 });
    expect(f.store.unread(task.id)).toHaveLength(1);
    expect(() => f.project.actor(run.token)).toThrow('invalid or expired');
    expect(f.project.resumeTask(task.id).status).toBe('queued');
    await until(() => provider.calls.length === 2);
    expect(provider.calls[1].messages[0].body).toBe('correction for next invocation');
    expect(provider.calls[1].cwd).toBe(task.workspace);
    provider.calls[1].done.resolve('continued');
    await until(() => !f.project.running.has(task.id));
    expect(f.store.unread(task.id)).toHaveLength(0);
  } finally { await f.close(); }
});

test('resume does not cancel independent user-message preemption', async () => {
  const provider = controlled(), f = fixture(provider);
  try {
    const task = await start(f), marks = files(f, task);
    f.project.message(task.id, 'urgent input');
    f.project.interrupt(task.id);
    f.project.resumeTask(task.id);
    expect(fs.existsSync(marks.request)).toBe(true);
    expect(JSON.parse(fs.readFileSync(marks.request, 'utf8')).reason).toBe('user message');
    provider.calls[0].done.resolve(new AgentPreempted({ safe_point: 'turn_end' }));
    await until(() => provider.calls.length === 2);
    expect(provider.calls[1].messages[0].body).toBe('urgent input');
    provider.calls[1].done.resolve('handled input');
    await until(() => !f.project.running.has(task.id));
  } finally { await f.close(); }
});

test('backends without safe boundaries wait naturally and never abort solely for interrupt', async () => {
  const provider = controlled('mock'), f = fixture(provider);
  try {
    const task = await start(f), run = f.project.running.get(task.id);
    f.config.interruptGraceMs = 1; // An old setting cannot turn a signal into a hard kill.
    f.project.interrupt(task.id);
    await Bun.sleep(20);
    expect(run.controller.signal.aborted).toBe(false);
    f.project.resumeTask(task.id);
    expect(provider.calls).toHaveLength(1);
    f.project.interrupt(task.id);
    provider.calls[0].done.resolve('natural completion');
    await until(() => !f.project.running.has(task.id));
    expect(f.store.task(task.id)).toMatchObject({ status: 'paused', result: 'natural completion', interrupt_state: null });
    expect(events(f, task, 'task.interrupt_timeout')).toHaveLength(0);
    expect(f.store.all("SELECT * FROM notices WHERE task_id=? AND source_event_id IS NOT NULL", task.id)).toHaveLength(0);
  } finally { await f.close(); }
});

test('Pi interrupt no longer has a grace-period hard kill; ordinary invocation timeout remains a failure', async () => {
  const provider = controlled(), f = fixture(provider);
  try {
    f.config.timeout = 0.12;
    f.config.interruptGraceMs = 1;
    const task = await start(f), run = f.project.running.get(task.id);
    f.project.interrupt(task.id);
    await Bun.sleep(20);
    expect(run.controller.signal.aborted).toBe(false);
    await until(() => !f.project.running.has(task.id));
    expect(f.store.task(task.id)).toMatchObject({ status: 'failed', interrupt_state: null });
    expect(f.store.task(task.id).error).toContain('timed out after 0.12 seconds');
    expect(events(f, task, 'task.interrupt_timeout')).toHaveLength(0);
  } finally { await f.close(); }
});

test('pause and resume during asynchronous settlement preserve the last user intent', async () => {
  const provider = controlled('mock'), f = fixture(provider), settlement = gate(), entered = gate();
  try {
    const task = await start(f);
    const finish = f.project.workspaces.finish.bind(f.project.workspaces);
    let once = true;
    f.project.workspaces.finish = async row => {
      if (once) { once = false; entered.resolve(); await settlement.promise; }
      return finish(row);
    };
    provider.calls[0].done.resolve('completed provider');
    await entered.promise;
    expect(f.project.interrupt(task.id).status).toBe('paused');
    expect(f.project.resumeTask(task.id).interrupt_state).toBe('resuming');
    // Latest intent wins even if a restart was previously requested.
    expect(f.project.interrupt(task.id).status).toBe('paused');
    settlement.resolve();
    await until(() => !f.project.running.has(task.id));
    expect(provider.calls).toHaveLength(1);
    expect(f.store.task(task.id).status).toBe('paused');
    expect(events(f, task, 'task.idle')).toHaveLength(0);
    f.project.resumeTask(task.id);
    await until(() => provider.calls.length === 2);
    provider.calls[1].done.resolve('continued');
    await until(() => !f.project.running.has(task.id));
  } finally { settlement.resolve(); await f.close(); }
});

test('queued pause and run configuration are preserved; running pending pause may save next-run settings', async () => {
  const provider = controlled(), f = fixture(provider);
  try {
    const task = await start(f);
    f.project.interrupt(task.id);
    const profile = { agent: 'pi', model: 'gpt-5.4', thinking: 'high', append_prompt: 'next call' };
    expect(JSON.parse(f.project.configureTask(task.id, profile).retry_profile).model).toBe('gpt-5.4');
    f.project.resumeTask(task.id);
    expect(provider.calls[0].agent.model).toBe('');
    f.project.interrupt(task.id);
    provider.calls[0].done.resolve(new AgentPreempted());
    await until(() => !f.project.running.has(task.id));
    f.project.resumeTask(task.id);
    await until(() => provider.calls.length === 2);
    expect(provider.calls[1].agent.model).toBe('gpt-5.4');
    provider.calls[1].done.resolve('configured');
    await until(() => !f.project.running.has(task.id));
    f.project.stopping = true;
    const queued = (await f.project.order('queue then pause')).task;
    expect(f.project.interrupt(queued.id)).toMatchObject({ status: 'paused', interrupt_state: null });
    expect(f.project.interrupt(queued.id).status).toBe('paused');
    expect(f.project.resumeTask(queued.id).status).toBe('queued');
  } finally { await f.close(); }
});

test('interrupt/resume/configure retain target guards and user-only RPC authorization', async () => {
  const f = fixture();
  f.project.stopping = true; await repo(f.root);
  try {
    const root = await f.project.ensureMainTask();
    expect(() => f.project.interrupt(root.id)).toThrow('permanent root');
    const { task } = await f.project.order('guards');
    f.store.update(task.id, { status: 'waiting' });
    expect(() => f.project.resumeTask(task.id)).toThrow('only paused workers');
    expect(() => f.project.configureTask(task.id, { agent: 'pi' })).toThrow('only paused');
    await new Dispatcher(f.project).dispatch('worker.interrupt', { id: task.id });
    expect((await new Dispatcher(f.project).dispatch('worker.inspect', { id: task.id })).status).toBe('paused');
    f.store.update(task.id, { status: 'cancelled' });
    expect(() => f.project.interrupt(task.id)).toThrow('has ended');
    expect(() => f.project.resumeTask(task.id)).toThrow('only paused workers');
    expect(PARAMS['worker.interrupt']).toEqual(['id']);
    expect(PARAMS['worker.resume']).toEqual(['id', 'profile']);
    expect(PARAMS['worker.configure']).toEqual(['id', 'profile', 'model_selection']);
    for (const method of ['worker.interrupt', 'worker.resume', 'worker.configure']) {
      expect(USER_ONLY.has(method)).toBe(true);
      expect(() => assertAllowed(method, { id: 5 }, 5)).toThrow('requires user approval');
    }
  } finally { await f.close(); }
});

test('restart never replays a resuming old invocation, and clears its stale control state', async () => {
  const f = fixture();
  f.project.stopping = true; await repo(f.root);
  try {
    const { task } = await f.project.order('unknown old execution');
    f.store.update(task.id, { status: 'queued', interrupt_state: 'resuming' });
    f.project.recover();
    expect(f.store.task(task.id)).toMatchObject({ status: 'failed', interrupt_state: null, calls: 0 });
    expect(f.store.task(task.id).error).toContain('daemon interrupted');
  } finally { await f.close(); }
});

test('old databases gain only a nullable interrupt column without backfilling historical workers', () => {
  const root = temp(), file = path.join(root, 'store.db');
  let store = new Store(file, root);
  const task = store.create({ input_id: null, role: 'agent', goal: 'historical', task_kind: 'order' });
  const original = store.task(task.id);
  store.close();
  const db = new Database(file);
  db.exec('ALTER TABLE tasks DROP COLUMN interrupt_state'); db.close();
  store = new Store(file, root);
  try { expect(store.task(task.id)).toEqual({ ...original, interrupt_state: null }); }
  finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
