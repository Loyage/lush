import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, repo, git, until, gate } from '../helpers.js';
import { PARAMS, USER_ONLY, assertAllowed } from '../../src/rpc/registry.js';

async function committedSay(f, name) {
  const say = await f.project.say(name);
  fs.writeFileSync(path.join(say.task.workspace, `${name}.txt`), `${name}\n`);
  await git(say.task.workspace, 'add', `${name}.txt`);
  await git(say.task.workspace, 'commit', '-m', `${name} one`);
  await git(say.task.workspace, 'commit', '--allow-empty', '-m', `${name} two`);
  f.store.update(say.task.id, { status: 'waiting', result: 'done' });
  return say.task;
}

test('idle say requests route through a reusable merge child, squash one commit and archive', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const source = await committedSay(f, 'alpha');
    const original = await git(f.root, 'rev-parse', 'main');
    const tip = await git(source.workspace, 'rev-parse', 'HEAD');
    const booked = await f.project.reserveTask(source.id, 'merge');
    expect(booked.reservation).toMatchObject({ version: 2, status: 'requested', commit: tip });
    expect(await git(f.root, 'rev-parse', 'main')).toBe(original);
    f.project.stopping = false;
    await f.project.driveTaskMerge(source.parent_id);
    const done = f.store.task(source.id);
    expect(done).toMatchObject({ status: 'completed', integration: 'merged', branch: null, workspace: null });
    const merger = f.store.task(done.parent_id);
    expect(merger).toMatchObject({ parent_id: source.parent_id, task_kind: 'merge', status: 'completed' });
    expect(await git(f.root, 'rev-list', '--count', `${original}..main`)).toBe('1');
    expect(await git(f.root, 'show', 'main:alpha.txt')).toBe('alpha');
    expect(f.store.branch(source.branch).status).toBe('archived');
    expect(f.store.get("SELECT count(*) AS n FROM events WHERE task_id=? AND type='task.reparented_for_merge'", source.id).n).toBe(1);
  } finally { await f.close(); }
});

test('a completed showcase say reopens for automatic delivery without v1 approval', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const source = await committedSay(f, 'showcased');
    await f.project.workspaces.finish(source);
    f.store.update(source.id, { status: 'completed', reservation: JSON.stringify({ version: 1,
      kind: 'showcase', status: 'completed', child_id: 999 }) });
    const booking = await f.project.reserveTask(source.id, 'merge');
    expect(booking.reservation).toMatchObject({ version: 2, kind: 'merge', status: 'requested' });
    f.project.stopping = false;
    await f.project.driveTaskMerge(source.parent_id);
    expect(f.store.task(source.id)).toMatchObject({ status: 'completed', integration: 'merged', branch: null });
  } finally { await f.close(); }
});

test('a dirty parent rejects auto merge without deleting the source worktree', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const source = await committedSay(f, 'safe');
    const before = await git(f.root, 'rev-parse', 'main');
    await f.project.reserveTask(source.id, 'merge');
    fs.writeFileSync(path.join(f.root, 'untracked.txt'), 'user work\n');
    f.project.stopping = false;
    await expect(f.project.driveTaskMerge(source.parent_id)).rejects.toThrow();
    expect(await git(f.root, 'rev-parse', 'main')).toBe(before);
    expect(f.store.task(source.id).status).toBe('waiting');
    expect(fs.existsSync(source.workspace)).toBe(true);
  } finally { await f.close(); }
});

test('a child Task can request a squash into its say parent without waking its Agent', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const say = await f.project.say('parent');
    f.store.update(say.task.id, { status: 'waiting' });
    const child = await f.project.spawn(say.task.id, 'child change');
    fs.writeFileSync(path.join(child.workspace, 'child.txt'), 'child\n');
    await git(child.workspace, 'add', 'child.txt'); await git(child.workspace, 'commit', '-m', 'child one');
    f.store.update(child.id, { status: 'waiting', result: 'done' });
    const start = await git(say.task.workspace, 'rev-parse', 'HEAD');
    await f.project.reserveTask(child.id, 'merge');
    f.project.stopping = false;
    await f.project.driveTaskMerge(say.task.id);
    expect(f.store.task(child.id).integration).toBe('merged');
    expect(f.store.task(child.id).parent_id).toBe(f.store.get("SELECT id FROM tasks WHERE parent_id=? AND task_kind='merge'", say.task.id).id);
    expect(await git(say.task.workspace, 'rev-list', '--count', `${start}..HEAD`)).toBe('1');
    expect(await git(say.task.workspace, 'show', 'HEAD:child.txt')).toBe('child');
    expect(f.store.get("SELECT count(*) AS n FROM messages WHERE task_id=? AND signal_type='merge.completed'", say.task.id).n).toBe(1);
  } finally { await f.close(); }
});

test('reservation during an invocation freezes only at the safe point and merges automatically', async () => {
  const pause = gate();
  const f = fixture({ resolve() { return { agent: 'mock' }; }, async run({ cwd }) {
    fs.writeFileSync(path.join(cwd, 'hook.txt'), 'done\n');
    await git(cwd, 'add', 'hook.txt'); await git(cwd, 'commit', '-m', 'hook');
    await pause.promise;
    return 'done';
  } });
  await repo(f.root);
  try {
    const say = await f.project.say('hook');
    await until(() => f.store.task(say.task.id).status === 'running');
    const booked = await f.project.reserveTask(say.task.id, 'merge');
    expect(booked.reservation.status).toBe('pending');
    pause.resolve();
    await until(() => f.store.task(say.task.id).integration === 'merged', 6000);
    expect(f.store.task(say.task.id).status).toBe('completed');
    expect(await git(f.root, 'show', 'main:hook.txt')).toBe('done');
  } finally { pause.resolve(); await f.close(); }
});

test('the original source Agent repairs divergence and the queue resumes without approval', async () => {
  const f = fixture({ resolve() { return { agent: 'mock' }; }, async run({ cwd, messages }) {
    const instruction = messages.map(row => row.body).find(body => body.includes('合并分歧'));
    if (instruction) {
      const commit = instruction.match(/[0-9a-f]{40}/)?.[0];
      await git(cwd, 'merge', '--no-edit', commit);
      return 'resolved and tested';
    }
    return 'idle';
  } });
  f.project.stopping = true;
  await repo(f.root);
  try {
    const first = await committedSay(f, 'one');
    const second = await committedSay(f, 'two');
    const parentId = first.parent_id;
    const baseline = await git(f.root, 'rev-parse', 'main');
    await f.project.reserveTask(first.id, 'merge');
    await f.project.reserveTask(second.id, 'merge');
    f.project.stopping = false;
    await f.project.driveTaskMerge(parentId);
    await until(() => f.store.task(second.id).branch === null || f.store.task(second.id).integration_error, 8000);
    expect(f.store.task(second.id)).toMatchObject({ status: 'completed', branch: null, workspace: null });
    expect(await git(f.root, 'rev-list', '--count', `${baseline}..main`)).toBe('2');
    expect(await git(f.root, 'show', 'main:one.txt')).toBe('one');
    expect(await git(f.root, 'show', 'main:two.txt')).toBe('two');
  } finally { await f.close(); }
});

test('cancelling a frozen request releases the parent lock but preserves the source branch', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const source = await committedSay(f, 'cancelled');
    await f.project.reserveTask(source.id, 'merge');
    expect(f.project.branchFreeze('main')?.task_id).toBe(source.id);
    f.project.cancel(source.id);
    expect(f.project.branchFreeze('main')).toBeNull();
    expect(f.store.task(source.id).branch).toBe(source.branch);
    expect(await git(source.workspace, 'rev-parse', 'HEAD')).toBe(await git(f.root, 'rev-parse', source.branch));
  } finally { await f.close(); }
});

test('a second source diverging after squash is returned to its own Agent without losing work', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const first = await committedSay(f, 'first');
    const second = await committedSay(f, 'second');
    const parentId = first.parent_id;
    await f.project.reserveTask(first.id, 'merge');
    await f.project.reserveTask(second.id, 'merge');
    f.project.stopping = false;
    f.project.kick = () => {};
    await f.project.driveTaskMerge(parentId);
    expect(f.store.task(first.id).integration).toBe('merged');
    const returned = f.store.task(second.id);
    expect(JSON.parse(returned.reservation).status).toBe('resolving');
    expect(returned.status).toBe('queued');
    expect(returned.workspace).toBe(second.workspace);
    expect(f.store.task(returned.parent_id).task_kind).toBe('merge');
    expect(f.store.unread(second.id).some(message => message.body.includes('分歧'))).toBe(true);
  } finally { await f.close(); }
});

test('reserve_all is a user-only branch batch entry', () => {
  expect(PARAMS['task.reserve_all']).toEqual(['branch']);
  expect(USER_ONLY.has('task.reserve_all')).toBe(true);
  expect(assertAllowed('task.reserve_all', { branch: 'main' }, null)).toBeNull();
  expect(() => assertAllowed('task.reserve_all', { branch: 'main' }, 7)).toThrow(/requires user approval/);
  expect(() => assertAllowed('task.reserve_all', { branch: 'main', extra: 1 }, null)).toThrow(/unknown parameter/);
});

test('reserveMergeAll queues every idle pending Task on a branch and the queue lands them in order', async () => {
  const f = fixture({ resolve() { return { agent: 'mock' }; }, async run({ cwd, messages }) {
    const instruction = messages.map(row => row.body).find(body => body.includes('合并分歧'));
    if (instruction) { const commit = instruction.match(/[0-9a-f]{40}/)?.[0]; await git(cwd, 'merge', '--no-edit', commit); return 'resolved and tested'; }
    return 'idle';
  } });
  f.project.stopping = true;
  await repo(f.root);
  try {
    const first = await committedSay(f, 'alpha');
    const second = await committedSay(f, 'beta');
    f.store.update(first.id, { integration: 'pending' });
    f.store.update(second.id, { integration: 'pending' });
    // 目标分支不同、或还没静息的 Task 不能被这一次批量带入。
    const other = await committedSay(f, 'other');
    f.store.update(other.id, { integration: 'pending', target_branch: 'release' });
    const busy = await committedSay(f, 'busy');
    f.store.update(busy.id, { integration: 'pending', status: 'running' });

    const result = await f.project.reserveMergeAll('main');
    expect(result).toMatchObject({ target_branch: 'main', total: 2, requested: 2, blocked: 0, failed: 0 });
    expect(result.tasks.map(task => task.id)).toEqual([first.id, second.id]);
    expect(JSON.parse(f.store.task(other.id).reservation)).toBeNull();
    expect(JSON.parse(f.store.task(busy.id).reservation)).toBeNull();

    f.project.stopping = false;
    await f.project.driveTaskMerge(first.parent_id);
    await until(() => f.store.task(second.id).integration === 'merged', 8000);
    expect(f.store.task(first.id).integration).toBe('merged');
    expect(f.store.task(second.id).integration).toBe('merged');
    expect(await git(f.root, 'show', 'main:alpha.txt')).toBe('alpha');
    expect(await git(f.root, 'show', 'main:beta.txt')).toBe('beta');
  } finally { await f.close(); }
});
