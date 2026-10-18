import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, repo, git, env, until, gate } from '../helpers.js';
import { AgentProvider } from '../../src/agent/provider.js';
import { configurePiFixture } from './pi-runtime-fixture.js';
import { Dispatcher } from '../../src/rpc/dispatcher.js';
import { RPCServer } from '../../src/rpc/server.js';
import { createSignal } from '../../src/signal.js';

const bin = path.resolve(import.meta.dir, '../../bin/lush');
function checkpoint(f, task, commit, entry = 'current-entry') {
  const session = path.join(f.config.home, 'sessions', `${task.id}-${entry}.jsonl`);
  fs.mkdirSync(path.dirname(session), { recursive: true });
  fs.writeFileSync(session, [{ type: 'session', id: `session-${task.id}` }, { type: 'message', id: entry, parentId: null,
    message: { role: 'user', content: `checkpoint ${entry}` } }].map(JSON.stringify).join('\n') + '\n');
  f.store.run('INSERT OR REPLACE INTO commit_contexts(commit_hash,task_id,session_path,entry_id) VALUES (?,?,?,?)', commit, task.id, session, entry);
  return { session, entry };
}
async function setup(realPi = false) {
  const f = fixture(undefined, { LUSH_PROVIDER: realPi ? 'pi' : 'mock' }); f.project.kick = () => {}; f.project.scheduleInputEmissions = () => {};
  await repo(f.root); const { agent } = configurePiFixture(f);
  const current = (await f.project.order('current Worker', 'main', [], null, false)).task;
  f.project.configureTask(current.id, agent);
  fs.writeFileSync(path.join(current.workspace, 'current-code.txt'), 'current committed code\n');
  await git(current.workspace, 'add', '.'); await git(current.workspace, 'commit', '-m', 'current baseline');
  const commit = await git(current.workspace, 'rev-parse', 'HEAD'), pointer = checkpoint(f, current, commit);
  const dispatcher = new Dispatcher(f.project, createSignal(), {});
  return { ...f, current, commit, pointer, dispatcher };
}
async function resources(f) {
  return { tasks: f.store.tasks().length, inputs: f.store.all('SELECT id FROM inputs').length,
    branches: f.store.all('SELECT branch FROM branches').map(row => row.branch),
    worktrees: fs.readdirSync(path.join(f.config.home, 'worktrees')).sort(), refs: await git(f.root, 'for-each-ref', '--format=%(refname)') };
}
function manualChild(f, task, parent, source, commit) {
  expect(task).toMatchObject({ parent_id: parent.id, task_kind: 'order', status: 'paused', goal: '', input_id: null, calls: 0,
    target_branch: parent.branch, base_commit: commit, creation: { source_id: source.id, mode: 'fork', session_inherited: true, waiting_first_input: true } });
  expect(f.store.branch(task.branch)).toMatchObject({ parent: parent.branch, created_from_commit: commit });
  expect(f.project.autoMergeView(f.store.task(task.id))).toMatchObject({ enabled: false, locked: false });
  expect(f.store.task(task.id).reservation).toBeNull();
  expect(task.worker_number).toMatch(/^W\d+$/); // user order numbering, never Agent-delegated child identity
}

test('real CLI/RPC self-copy -> manual child -> first Input/source receipt -> controlled Pi checkpoint; direct-child copy makes a same-parent sibling', async () => {
  const f = await setup(true), log = path.join(f.config.home, 'controlled-child-pi.jsonl');
  const program = path.join(f.config.home, 'controlled-child-pi');
  fs.writeFileSync(program, `#!/usr/bin/env bun
import fs from 'node:fs';
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ task: process.env.LUSH_TASK_ID, args: process.argv.slice(2) }) + '\\n');
console.log('controlled child result');
`, { mode: 0o755 });
  f.config.env.LUSH_PI_COMMAND = program; f.project.provider = new AgentProvider(f.config, f.project.agentSettings);
  const rpc = new RPCServer(f.config.socket, f.dispatcher); await rpc.start();
  async function cli(...args) {
    const proc = Bun.spawn([process.execPath, bin, '--project', f.root, '--json', ...args], { cwd: f.root,
      env: env(f.config.env), stdout: 'pipe', stderr: 'pipe' });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { code, err, value: out.trim() ? JSON.parse(out) : null };
  }
  try {
    const made = await cli('worker', 'create', 'fork', '--parent', f.current.worker_number, '--source', f.current.worker_number);
    expect(made).toMatchObject({ code: 0, err: '' }); const child = made.value.task;
    manualChild(f, child, f.current, f.current, f.commit);
    expect(child.parent_id).not.toBe(f.current.parent_id);
    expect(fs.readFileSync(path.join(child.workspace, 'current-code.txt'), 'utf8')).toBe('current committed code\n');
    expect(f.store.all('SELECT id FROM inputs')).toHaveLength(1); expect(fs.existsSync(log)).toBe(false);
    const first = await cli('order', 'child first real instruction', '--append', child.worker_number);
    expect(first.code).toBe(0); await f.project.drainInputEmissions();
    const receipt = f.project.inputEmissionResult(first.value.draft_id).dispatch;
    expect(receipt).toMatchObject({ state: 'succeeded', worker_id: child.id, input_id: 2 });
    expect(f.project.inputGet('input', receipt.input_id).source_draft_id).toBe(first.value.draft_id);
    f.project.pump(); await until(() => !f.project.running.size && f.store.task(child.id).calls === 1, 10000);
    expect(f.store.task(child.id).result).toBe('controlled child result');
    const invocation = JSON.parse(fs.readFileSync(log, 'utf8').trim());
    expect(Number(invocation.task)).toBe(child.id); expect(invocation.args).toContain('--fork');
    expect(fs.readFileSync(invocation.args[invocation.args.indexOf('--fork') + 1], 'utf8')).toContain('current-entry');
    expect(f.store.task(f.current.id).calls).toBe(0); expect(await git(f.current.workspace, 'rev-parse', 'HEAD')).toBe(f.commit);
    fs.writeFileSync(path.join(child.workspace, 'child-code.txt'), 'direct child code\n');
    await git(child.workspace, 'add', '.'); await git(child.workspace, 'commit', '-m', 'direct child baseline');
    const childCommit = await git(child.workspace, 'rev-parse', 'HEAD'); checkpoint(f, child, childCommit, 'direct-child-entry');
    const copied = await cli('worker', 'create', 'fork', '--parent', f.current.worker_number, '--source', child.worker_number);
    expect(copied.code).toBe(0); manualChild(f, copied.value.task, f.current, child, childCommit);
    expect(fs.readFileSync(path.join(copied.value.task.workspace, 'child-code.txt'), 'utf8')).toBe('direct child code\n');
    const omitted = await cli('worker', 'create', 'fork', '--source', child.worker_number);
    expect(omitted.code).toBe(0); manualChild(f, omitted.value.task, f.current, child, childCommit);
    const global = await cli('worker', 'create', 'fork', '--source', f.current.worker_number);
    expect(global.code).toBe(0); expect(global.value.task.parent_id).toBe(f.current.parent_id); expect(global.value.task.target_branch).toBe('main');
    const blank = await cli('worker', 'create', 'spawn', '--parent', f.current.worker_number);
    expect(blank).toMatchObject({ code: 0, value: { task: { task_kind: 'order', parent_id: f.current.id, status: 'paused', input_id: null,
      creation: { mode: 'spawn', source_id: null, session_inherited: false } } } });
    const before = await resources(f);
    const invalid = await cli('worker', 'create', 'fork', '--parent', String(f.current.parent_id), '--source', child.worker_number);
    expect(invalid.code).not.toBe(0); expect(invalid.err).toContain('source itself or its direct parent'); expect(await resources(f)).toEqual(before);
    f.store.run('UPDATE commit_contexts SET session_path=? WHERE commit_hash=?', '/invalid-checkpoint.jsonl', childCommit);
    const badCheckpoint = await cli('worker', 'create', 'fork', '--parent', f.current.worker_number, '--source', child.worker_number);
    expect(badCheckpoint.code).not.toBe(0); expect(badCheckpoint.err).toContain('检查点无效或不可用'); expect(await resources(f)).toEqual(before);
    f.store.run('UPDATE commit_contexts SET session_path=? WHERE commit_hash=?', '/invalid-self-checkpoint.jsonl', f.commit);
    const badSelf = await cli('worker', 'create', 'fork', '--parent', f.current.worker_number, '--source', f.current.worker_number);
    expect(badSelf.code).not.toBe(0); expect(badSelf.err).toContain('检查点无效或不可用'); expect(await resources(f)).toEqual(before);
  } finally { await rpc.close(); await f.close(); }
});

for (const diverged of [false, true]) test(`self-copy manual child ${diverged ? 'pins source repair to the current Worker' : 'Squashes only into the current Worker'}, never its ancestor`, async () => {
  const f = await setup();
  f.project.provider = { async run({ task, cwd }) {
    fs.writeFileSync(path.join(cwd, 'manual-child-change.txt'), `child ${task.id}\n`);
    await git(cwd, 'add', '.'); await git(cwd, 'commit', '-m', 'manual child change'); return 'child result';
  } };
  try {
    const main = await git(f.root, 'rev-parse', 'main');
    const child = (await f.project.createWorker({ mode: 'fork', parent: f.current.id, source: f.current.id })).task;
    if (diverged) {
      fs.writeFileSync(path.join(f.current.workspace, 'new-parent-code.txt'), 'parent advances\n');
      await git(f.current.workspace, 'add', '.'); await git(f.current.workspace, 'commit', '-m', 'parent advance');
    }
    const parentHead = await git(f.current.workspace, 'rev-parse', 'HEAD');
    f.project.message(child.id, 'implement manual child'); f.project.pump();
    await until(() => !f.project.running.size && f.store.task(child.id).result, 10000);
    expect(f.store.task(child.id).integration).toBe('pending');
    expect(await git(f.current.workspace, 'rev-parse', 'HEAD')).toBe(parentHead); // manual order never auto-merges
    const childHead = await git(child.workspace, 'rev-parse', 'HEAD');
    await f.project.requestTaskMerge(child.id); await f.project.settleQueuedMerge(child.id);
    if (diverged) {
      await until(() => JSON.parse(f.store.task(child.id).reservation).status === 'resolving', 10000);
      expect(JSON.parse(f.store.task(child.id).reservation)).toMatchObject({ parent_id: f.current.id, baseline: parentHead, commit: childHead });
      expect(await git(f.current.workspace, 'rev-parse', 'HEAD')).toBe(parentHead);
      expect(f.project.activeTaskMerge(f.current.id).id).toBe(child.id);
    } else {
      await until(() => f.store.task(child.id).integration === 'merged', 10000);
      expect(await git(f.current.workspace, 'show', 'HEAD:manual-child-change.txt')).toBe(`child ${child.id}`);
      expect(await git(f.current.workspace, 'rev-list', '--count', `${parentHead}..HEAD`)).toBe('1');
    }
    expect(await git(f.root, 'rev-parse', 'main')).toBe(main);
    expect(f.store.task(child.id)).toMatchObject({ parent_id: f.current.id, target_branch: f.current.branch, base_commit: f.commit });
  } finally { await f.close(); }
});

test('RPC rejects unrelated parents, skipped ancestors, reversed descendants and a grandchild source without leaving resources', async () => {
  const f = await setup();
  try {
    const call = params => f.dispatcher.dispatch('worker.create', params);
    const child = (await call({ mode: 'fork', parent: f.current.id, source: f.current.id })).task;
    f.project.message(child.id, 'authorize child target');
    const grandchild = (await call({ mode: 'fork', parent: child.id, source: child.id })).task;
    const unrelated = (await f.project.order('unrelated', 'main', [], null, false)).task;
    const before = await resources(f);
    for (const [parent, source] of [[unrelated.id, child.id], [f.current.parent_id, child.id], [child.id, f.current.id], [f.current.id, grandchild.id]]) {
      await expect(call({ mode: 'fork', parent, source })).rejects.toThrow('source itself or its direct parent');
      expect(await resources(f)).toEqual(before);
    }
    manualChild(f, (await call({ mode: 'fork', parent: child.id, source: grandchild.id })).task, child, grandchild, f.commit);
  } finally { await f.close(); }
});

test('copying an existing Agent-delegated direct child stays a user order without delegated auto-merge locks or inherited Input', async () => {
  const f = await setup();
  try {
    const delegated = await f.project.spawn(f.current.id, 'existing Agent-delegated child');
    expect(delegated.task_kind).toBe('child'); expect(delegated.input_id).toBe(f.current.input_id);
    expect(f.project.autoMergeView(f.store.task(delegated.id))).toMatchObject({ enabled: true, locked: true });
    const copied = await f.dispatcher.dispatch('worker.create', { mode: 'fork', parent: f.current.id, source: delegated.id });
    manualChild(f, copied.task, f.current, delegated, f.commit);
    expect(copied.task.worker_number).not.toContain('-');
    expect(f.store.task(copied.task.id).hooks).toBeNull();
  } finally { await f.close(); }
});

test('a source reparented while the Git queue is held is revalidated before manual child creation', async () => {
  const f = await setup(), held = gate(), acquired = gate(); let blocking, creating;
  try {
    const child = (await f.project.createWorker({ mode: 'fork', parent: f.current.id, source: f.current.id })).task;
    const other = (await f.project.order('new source parent', 'main', [], null, false)).task;
    const before = await resources(f);
    blocking = f.project.workspaces.exclusive(async () => { acquired.resolve(); await held.promise; }); await acquired.promise;
    creating = f.project.createWorker({ mode: 'fork', parent: f.current.id, source: child.id });
    f.store.run('UPDATE tasks SET parent_id=? WHERE id=?', other.id, child.id);
    held.resolve(); await blocking;
    await expect(creating).rejects.toThrow('source itself or its direct parent'); expect(await resources(f)).toEqual(before);
  } finally { held.resolve(); await blocking; await creating?.catch(() => {}); await f.close(); }
});

for (const scenario of ['direct-child-reparent', 'self-parent-branch-change']) test(`Git read wait rechecks ${scenario} before allocating any manual child resources`, async () => {
  const f = await setup();
  try {
    const child = (await f.project.createWorker({ mode: 'fork', parent: f.current.id, source: f.current.id })).task;
    const other = (await f.project.order('unrelated', 'main', [], null, false)).task;
    const source = scenario === 'direct-child-reparent' ? child : f.current;
    const before = await resources(f), original = f.project.workspaces.git.bind(f.project.workspaces); let changed = false;
    f.project.workspaces.git = async (cwd, ...args) => {
      const result = await original(cwd, ...args);
      if (!changed && args[0] === 'rev-parse' && args.includes(`refs/heads/${source.branch}^{commit}`)) {
        changed = true;
        if (scenario === 'direct-child-reparent') f.store.run('UPDATE tasks SET parent_id=? WHERE id=?', other.id, child.id);
        else f.store.run('UPDATE tasks SET branch=? WHERE id=?', 'changed-parent-branch', f.current.id);
      }
      return result;
    };
    await expect(f.project.createWorker({ mode: 'fork', parent: f.current.id, source: source.id })).rejects.toThrow(
      scenario === 'direct-child-reparent' ? 'fork source changed' : 'parent Worker is not available');
    expect(changed).toBe(true); expect(await resources(f)).toEqual(before);
    if (scenario === 'self-parent-branch-change') f.store.run('UPDATE tasks SET branch=? WHERE id=?', f.current.branch, f.current.id);
  } finally { await f.close(); }
});
