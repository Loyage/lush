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
