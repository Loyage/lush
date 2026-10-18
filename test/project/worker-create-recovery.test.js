import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, repo, until, gate, temp } from '../helpers.js';
import { Store } from '../../src/persistence/store.js';
import { Project } from '../../src/core/project.js';

test('first input cannot race partially-created resources; completion opens the existing authorization path', async () => {
  const f = fixture(), ready = gate(); f.project.kick = () => {}; await repo(f.root);
  const original = f.project.workspaces.forkTaskUnsafe.bind(f.project.workspaces);
  f.project.workspaces.forkTaskUnsafe = async (...args) => { const result = await original(...args); await ready.promise; return result; };
  const creating = f.project.createWorker({ mode: 'spawn' });
  try {
    const task = await until(() => f.store.tasks().find(t => t.task_kind === 'order' && t.workspace && fs.existsSync(t.workspace)));
    expect(() => f.project.message(task.id, 'racing input')).toThrow('creation is incomplete');
    expect(f.store.all('SELECT * FROM inputs')).toHaveLength(0);
    ready.resolve(); await creating;
    expect(f.project.message(task.id, 'authorized after completion').input_id).toBeGreaterThan(0);
  } finally { ready.resolve(); await creating.catch(() => {}); await f.close(); }
});

test('restart marks an interrupted creation failed with owned resource diagnostics, never replaying or starting it', async () => {
  const f = fixture(); f.project.kick = () => {}; await repo(f.root); let reopened;
  try {
    const task = (await f.project.createWorker({ mode: 'spawn' })).task;
    f.store.run("DELETE FROM events WHERE task_id=? AND type='task.manual_created'", task.id); // model crash before completion receipt
    reopened = new Store(path.join(f.config.home, 'project.db'), f.root);
    const project = new Project(f.config, reopened, { async run() { throw new Error('must not start'); } }); project.kick = () => {};
    project.recover(); project.pump();
    expect(reopened.task(task.id)).toMatchObject({ status: 'failed', input_id: null, calls: 0 });
    expect(reopened.task(task.id).error).toContain('interrupted during Worker creation');
    expect(fs.existsSync(task.workspace)).toBe(true);
    expect(reopened.get("SELECT id FROM events WHERE task_id=? AND type='task.creation_interrupted'", task.id)).toBeTruthy();
    expect(() => project.retry(task.id)).toThrow('first user input');
    expect(reopened.all('SELECT * FROM inputs')).toHaveLength(0);
    await project.shutdown(); reopened.close(); reopened = null;
  } finally { reopened?.close(); await f.close(); }
});

test('legacy database opens with nullable creation metadata only; historical goal/input/session semantics are not rewritten', () => {
  const root = temp(), file = path.join(root, 'legacy.db'); let store = new Store(file, root);
  try {
    const legacy = store.create({ role: 'agent', goal: 'old goal', input_id: null, task_kind: 'order' });
    store.run('ALTER TABLE tasks DROP COLUMN creation'); store.run('ALTER TABLE tasks DROP COLUMN session_fork');
    store.close(); store = new Store(file, root);
    expect(store.task(legacy.id)).toMatchObject({ creation: null, session_fork: null, goal: 'old goal', input_id: null,
      worker_number: legacy.worker_number, status: 'queued' });
  } finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('first-input transaction rollback leaves neither ghost Input nor changed goal when a storage write fails', async () => {
  const f = fixture(); f.project.kick = () => {}; await repo(f.root);
  try {
    const task = (await f.project.createWorker({ mode: 'spawn' })).task;
    f.store.run(`CREATE TRIGGER reject_first_input BEFORE UPDATE OF input_id ON tasks BEGIN SELECT RAISE(ABORT,'injected first input failure'); END`);
    expect(() => f.project.message(task.id, 'failed instruction')).toThrow('injected first input failure');
    expect(f.store.all('SELECT * FROM inputs')).toHaveLength(0);
    expect(f.store.task(task.id)).toMatchObject({ input_id: null, goal: '', status: 'paused' });
    f.store.run('DROP TRIGGER reject_first_input');
    expect(f.project.message(task.id, 'successful instruction').input_id).toBeGreaterThan(0);
  } finally { await f.close(); }
});

test('invalid profile has no initial binding side effect, and a failed Git add with no ref leaves a deleted diagnostic branch record', async () => {
  const f = fixture(); f.project.kick = () => {}; await repo(f.root);
  try {
    await expect(f.project.createWorker({ mode: 'spawn', profile: { agent: 'invalid' } })).rejects.toThrow();
    expect(f.store.tasks()).toHaveLength(0);
    const git = f.project.workspaces.git.bind(f.project.workspaces);
    f.project.workspaces.git = (cwd, ...args) => args[0] === 'worktree' && args[1] === 'add'
      ? Promise.reject(new Error('injected worktree add failure')) : git(cwd, ...args);
    await expect(f.project.createWorker({ mode: 'spawn' })).rejects.toThrow('creation failed');
    const failed = f.store.tasks().find(t => t.task_kind === 'order');
    expect(failed).toMatchObject({ status: 'failed', input_id: null });
    expect(f.store.branch(failed.branch).status).toBe('deleted');
    expect(fs.existsSync(failed.workspace)).toBe(false);
    expect(f.store.all('SELECT * FROM inputs')).toHaveLength(0);
  } finally { await f.close(); }
});

test('first user input can bind reliably during a parent freeze, without bypassing scheduler execution gates', async () => {
  let runs = 0;
  const f = fixture({ async run() { runs++; return 'done'; } }); f.project.kick = () => {}; await repo(f.root);
  try {
    const task = (await f.project.createWorker({ mode: 'spawn' })).task;
    const original = f.project.branchFreeze.bind(f.project);
    const freeze = { branch: task.branch, task_id: task.parent_id, kind: 'merge' };
    f.project.branchFreeze = branch => branch ? branch === task.branch ? freeze : null : [freeze];
    const submitted = f.project.message(task.id, 'first instruction during freeze');
    expect(submitted).toMatchObject({ input_id: 1, status: 'queued' });
    f.project.pump(); expect(runs).toBe(0);
    f.project.branchFreeze = original; f.project.pump(); await until(() => runs === 1 && !f.project.running.size);
    expect(f.store.task(task.id).result).toBe('done');
  } finally { await f.close(); }
});
