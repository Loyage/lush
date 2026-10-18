import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, repo, git, until } from '../helpers.js';
import { Store } from '../../src/persistence/store.js';
import { Project } from '../../src/core/project.js';
import { Dispatcher } from '../../src/rpc/dispatcher.js';
import { createSignal } from '../../src/signal.js';

async function setup(provider = { async run() { return 'safe answer'; } }) {
  const f = fixture(provider); f.project.kick = () => {}; await repo(f.root);
  return f;
}
function checkpoint(f, commit, entry = 'entry') {
  const file = path.join(f.config.home, 'sessions', `source-${entry}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [{ type: 'session', id: 'source-session' },
    { type: 'message', id: entry, parentId: null, message: { role: 'user', content: 'original context' } }].map(JSON.stringify).join('\n') + '\n');
  f.store.run('INSERT OR REPLACE INTO commit_contexts(commit_hash,session_path,entry_id,task_id) VALUES (?,?,?,?)', commit, file, entry, f.store.tasks()[0]?.id ?? 1);
  return { session: file, entry };
}

test('manual spawn is paused without Input/Agent, includes safe provenance in inspect/activity, and never inherits a base checkpoint', async () => {
  const seen = [], f = await setup({ async run(args) { seen.push(args); return 'done'; } });
  try {
    await f.project.bootstrapMain();
    const main = await git(f.root, 'rev-parse', 'main'); checkpoint(f, main);
    fs.writeFileSync(path.join(f.root, 'uncommitted.txt'), 'must not copy');
    const made = await f.project.createWorker({ mode: 'spawn', title: ' Empty worker ' });
    expect(made.task).toMatchObject({ task_kind: 'order', status: 'paused', goal: '', input_id: null, calls: 0,
      display_title: 'Empty worker', target_branch: 'main', base_commit: main,
      creation: { mode: 'spawn', source_id: null, commit: main, waiting_first_input: true, session_inherited: false } });
    expect(made.task.worker_number).toBe('W1');
    expect(fs.existsSync(path.join(made.task.workspace, 'uncommitted.txt'))).toBe(false);
    expect(f.store.all('SELECT * FROM inputs')).toHaveLength(0);
    expect(f.project.inspect(made.task.id).creation).toEqual(made.task.creation);
    expect(f.project.activity().tasks.find(t => t.id === made.task.id).creation).toEqual(made.task.creation);
    expect(f.project.autoMergeView(f.store.task(made.task.id)).enabled).toBe(false);
    f.project.pump(); expect(seen).toHaveLength(0);
    const first = f.project.message(made.task.id, 'first actual user instruction');
    expect(first).toMatchObject({ status: 'queued', goal: 'first actual user instruction', input_id: 1, creation: { waiting_first_input: false } });
    expect(f.store.all('SELECT * FROM messages WHERE task_id=?', made.task.id)).toHaveLength(0);
    f.project.pump(); await until(() => !f.project.running.size && seen.length === 1);
    expect(seen[0].forkPointer).toBeNull();
    expect(seen[0].task.session_fork).toBeUndefined();
  } finally { await f.close(); }
});

test('empty Worker cannot start through resume, retry, Worker/runtime messages, delegation, Hook resume, wake, or restart', async () => {
  const seen = [], f = await setup({ async run(args) { seen.push(args); return 'unexpected'; } });
  let reopened;
  try {
    const task = (await f.project.createWorker({ mode: 'spawn' })).task;
    expect(() => f.project.resumeTask(task.id)).toThrow('first user input');
    expect(() => f.project.message(task.id, 'Hook content', null, false)).toThrow('real user');
    await expect(f.project.spawn(task.id, 'delegate empty')).rejects.toThrow('empty Worker');
    await expect(f.project.order('nested input', task.branch)).rejects.toThrow();
    const other = (await f.project.order('real source', 'main', [], null, false)).task;
    expect(() => f.project.message(task.id, 'Agent message', other.parent_id)).toThrow('real user');
    f.project.wake(task.id); f.project.pump(); expect(seen).toHaveLength(0);
    f.store.update(task.id, { status: 'cancelled' }); expect(() => f.project.retry(task.id)).toThrow('first user input');
    f.store.update(task.id, { status: 'paused' });
    reopened = new Store(path.join(f.config.home, 'project.db'), f.root);
    const project = new Project(f.config, reopened, { async run() { throw new Error('must not start'); } });
    project.kick = () => {}; project.recover(); project.pump();
    expect(reopened.task(task.id)).toMatchObject({ status: 'paused', input_id: null, calls: 0 });
    await project.shutdown(); reopened.close(); reopened = null;
    expect(seen).toHaveLength(0);
  } finally { reopened?.close(); await f.close(); }
});

test('concurrent/repeated first messages bind exactly one Input; later appends retain Message/A identity', async () => {
  const f = await setup();
  try {
    const task = (await f.project.createWorker({ mode: 'spawn' })).task;
    const results = await Promise.all(Array.from({ length: 10 }, () => Promise.resolve().then(() => f.project.message(task.id, 'same text'))));
    expect(new Set(results.map(t => t.input_id)).size).toBe(1);
    expect(f.store.all('SELECT * FROM inputs WHERE task_id=?', task.id)).toHaveLength(1);
    expect(f.store.all('SELECT * FROM messages WHERE task_id=?', task.id)).toHaveLength(9);
    expect(f.store.all('SELECT * FROM messages WHERE task_id=?', task.id).every(m => m.append_number)).toBe(true);
    expect(f.store.task(task.id).worker_number).toBe(task.worker_number);
    expect(() => f.project.bindWorkerFirstInput(task.id, 'must not overwrite')).toThrow('no longer waiting');
    expect(f.store.task(task.id).goal).toBe('same text');
    f.project.interrupt(task.id); f.project.message(task.id, 'paused append');
    expect(f.store.task(task.id).status).toBe('paused');
    f.project.resumeTask(task.id); expect(f.store.task(task.id).status).toBe('queued');
  } finally { await f.close(); }
});

test('fork copies committed source tip and effective profile, stays sibling order, and freezes the commit checkpoint mapping', async () => {
  const seen = [], f = await setup({ async run(args) { seen.push(args); return 'fork done'; } });
  try {
    const source = (await f.project.order('source', 'main', [], null, false)).task;
    fs.writeFileSync(path.join(source.workspace, 'source.txt'), 'committed source\n');
    await git(source.workspace, 'add', '.'); await git(source.workspace, 'commit', '-m', 'source feature');
    const commit = await git(source.workspace, 'rev-parse', 'HEAD'); const pointer = checkpoint(f, commit);
    fs.writeFileSync(path.join(source.workspace, 'dirty.txt'), 'not copied');
    f.project.configureTask(source.id, { agent: 'pi', model: 'deepseek/deepseek-chat' });
    // Exercise an inherited profile without requiring paid model execution in this controllable provider.
    const made = await f.project.createWorker({ mode: 'fork', source: source.id, title: 'fork' });
    expect(made.warning).toBeUndefined();
    expect(made.task).toMatchObject({ parent_id: source.parent_id, target_branch: source.target_branch, base_commit: commit,
      task_kind: 'order', input_id: null, status: 'paused', creation: { source_id: source.id, session_inherited: true, commit } });
    expect(f.store.branch(made.task.branch)).toMatchObject({ parent: 'main', created_from_commit: commit });
    expect(fs.readFileSync(path.join(made.task.workspace, 'source.txt'), 'utf8')).toBe('committed source\n');
    expect(fs.existsSync(path.join(made.task.workspace, 'dirty.txt'))).toBe(false);
    expect(f.store.task(made.task.id).retry_profile).toBe(f.store.task(source.id).retry_profile);
    expect(f.store.task(made.task.id).reservation).toBeNull();
    expect(f.store.task(made.task.id).hooks).toBeNull();
    expect(f.store.all('SELECT * FROM messages WHERE task_id=?', made.task.id)).toHaveLength(0);
    checkpoint(f, commit, 'new-entry');
    expect(JSON.parse(f.store.task(made.task.id).session_fork)).toEqual(pointer);
    // The frozen JSONL ends at the old entry even after global mappings or source files advance.
    expect(fs.readFileSync(path.join(f.config.home, 'session-checkpoints', `${commit}.jsonl`), 'utf8')).toContain('"id":"entry"');
    f.project.message(made.task.id, 'work on fork'); f.project.pump();
    await until(() => !f.project.running.size && seen.length === 1);
    expect(seen[0].forkPointer).toEqual(pointer);
    expect(f.store.task(source.id).calls).toBe(0);
    expect(f.project.inspect(made.task.id).session_fork).toBeUndefined();
  } finally { await f.close(); }
});

test('unsupported modes, missing/invalid checkpoints and invalid arguments reject before creating any Worker or Git resources', async () => {
  const f = await setup();
  try {
    const source = (await f.project.order('source', 'main', [], null, false)).task;
    const before = f.store.tasks().length, refs = await git(f.root, 'for-each-ref', '--format=%(refname)');
    const dirs = fs.readdirSync(path.join(f.config.home, 'worktrees')).sort();
    const supported = { agent: 'pi', model: 'deepseek/deepseek-chat' };
    for (const profile of [{ agent: 'pi', config_mode: 'pi' }, { agent: 'codex' }])
      await expect(f.project.createWorker({ mode: 'fork', source: source.id, profile })).rejects.toThrow('Pi 默认模式或 Codex');
    await expect(f.project.createWorker({ mode: 'fork', source: source.id, profile: supported })).rejects.toThrow('没有 Pi 检查点');
    f.store.run('INSERT INTO commit_contexts(commit_hash,session_path,entry_id,task_id) VALUES (?,?,?,?)', source.base_commit, '/outside.jsonl', 'bad', source.id);
    await expect(f.project.createWorker({ mode: 'fork', source: source.id, profile: supported })).rejects.toThrow('检查点无效或不可用');
    expect(f.store.all('SELECT * FROM inputs')).toHaveLength(1);
    expect(fs.readdirSync(path.join(f.config.home, 'worktrees')).sort()).toEqual(dirs);
    await expect(f.project.createWorker({ mode: 'fork', source: source.id, parent: source.id + 1000 })).rejects.toThrow('direct parent');
    await expect(f.project.createWorker({ mode: 'spawn', profile: { agent: 'invalid' } })).rejects.toThrow();
    await expect(f.project.createWorker({ mode: 'spawn', source: source.id })).rejects.toThrow('does not accept');
    await expect(f.project.createWorker({ mode: 'fork' })).rejects.toThrow();
    expect(f.store.tasks()).toHaveLength(before);
    expect(await git(f.root, 'for-each-ref', '--format=%(refname)')).toBe(refs);
  } finally { await f.close(); }
});

test('concurrent manual creation on an unbound main is serial and allocates unique independent numbers without ghost Inputs', async () => {
  const f = await setup();
  try {
    const made = await Promise.all(Array.from({ length: 8 }, () => f.project.createWorker({ mode: 'spawn' })));
    expect(new Set(made.map(r => r.task.worker_number)).size).toBe(8);
    expect(f.store.all("SELECT * FROM tasks WHERE task_kind='main'")).toHaveLength(1);
    expect(f.store.all('SELECT * FROM inputs')).toHaveLength(0);
  } finally { await f.close(); }
});

test('creation Git failure safely cleans its own exact snapshot and retains a diagnostic failed Worker without Input', async () => {
  const f = await setup();
  try {
    const original = f.project.workspaces.forkTaskUnsafe.bind(f.project.workspaces);
    f.project.workspaces.forkTaskUnsafe = async (...args) => { await original(...args); throw new Error('injected post-fork failure'); };
    await expect(f.project.createWorker({ mode: 'spawn' })).rejects.toThrow('creation failed');
    const failed = f.store.tasks().find(t => t.task_kind === 'order');
    expect(failed).toMatchObject({ status: 'failed', input_id: null });
    expect(f.store.all('SELECT * FROM inputs')).toHaveLength(0);
    expect(fs.existsSync(failed.workspace)).toBe(false);
    expect(await git(f.root, 'branch', '--list', failed.branch)).toBe('');
    expect(f.store.branch(failed.branch).status).toBe('deleted');
    expect(f.store.get("SELECT data FROM events WHERE task_id=? AND type='task.creation_failed'", failed.id).data).toContain('cleanup');
    expect(() => f.project.retry(failed.id)).toThrow('first user input');
  } finally { await f.close(); }
});

test('user-only RPC rejects Agent/Valet/unknown fields and redacts private fork pointer from every return envelope', async () => {
  const f = await setup();
  try {
    const rpc = new Dispatcher(f.project, createSignal(), {});
    const made = await rpc.dispatch('worker.create', { mode: 'spawn' });
    expect(made.task.session_fork).toBeUndefined();
    expect(made.task.retry_profile).toBeUndefined();
    await expect(rpc.dispatch('worker.create', { mode: 'spawn', goal: 'not accepted' })).rejects.toThrow('unknown parameter');
    const { assertAllowed } = await import('../../src/rpc/registry.js');
    expect(() => assertAllowed('worker.create', { mode: 'spawn' }, made.task.id)).toThrow('user approval');
    const { managementPolicy } = await import('../../src/rpc/management-policy.js');
    expect(managementPolicy('worker.create').access).toBe('unavailable');
  } finally { await f.close(); }
});

test('idempotent input.emit append binds first Input/O once and later emits Message/A with the same existing path', async () => {
  const f = await setup();
  try {
    const task = (await f.project.createWorker({ mode: 'spawn' })).task;
    const options = { content: 'first mounted instruction', mode: 'append', target_id: task.id, client_request_id: 'first-user-input' };
    const receipts = await Promise.all([f.project.emitBufferedInput(options), f.project.emitBufferedInput(options)]);
    expect(receipts[0].draft_id).toBe(receipts[1].draft_id);
    await f.project.drainInputEmissions();
    const first = f.project.inputEmissionResult(receipts[0].draft_id).dispatch;
    expect(first).toMatchObject({ state: 'succeeded', input_id: 1, worker_id: task.id });
    expect(first.message_id).toBeUndefined(); expect(first.append_number).toBeUndefined();
    expect(f.store.task(task.id).input_id).toBe(1);
    const retry = await f.project.emitBufferedInput(options); expect(retry.dispatch).toEqual(first);
    const next = await f.project.emitBufferedInput({ ...options, content: 'later', client_request_id: 'second-user-input' });
    await f.project.drainInputEmissions();
    expect(f.project.inputEmissionResult(next.draft_id).dispatch).toMatchObject({ state: 'succeeded', worker_id: task.id });
    expect(f.project.inputEmissionResult(next.draft_id).dispatch.append_number).toBeTruthy();
    expect(f.store.all('SELECT * FROM inputs')).toHaveLength(1);
  } finally { await f.close(); }
});
