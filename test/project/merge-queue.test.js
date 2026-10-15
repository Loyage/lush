import { test, expect, setDefaultTimeout } from 'bun:test';
// Real multi-worktree transactions and repair invocations must finish cleanup before timeout.
setDefaultTimeout(15000);
import fs from 'node:fs';
import path from 'node:path';
import { fixture, repo, git, until, gate } from '../helpers.js';
import { PARAMS, USER_ONLY, assertAllowed } from '../../src/rpc/registry.js';
import iteration from '../../src/core/project/iteration.js';

async function committedOrder(f, name) {
  const order = await f.project.order(name);
  fs.writeFileSync(path.join(order.task.workspace, `${name}.txt`), `${name}\n`);
  await git(order.task.workspace, 'add', `${name}.txt`);
  await git(order.task.workspace, 'commit', '-m', `${name} one`);
  await git(order.task.workspace, 'commit', '--allow-empty', '-m', `${name} two`);
  f.store.update(order.task.id, { status: 'waiting', result: 'done' });
  return order.task;
}

test('spawn reserves child delivery by default, waits for its safe point, and leaves order delivery to the user', async () => {
  const pause = gate();
  const f = fixture({ resolve() { return { agent: 'mock' }; }, async run({ task, cwd }) {
    if (task.task_kind === 'child') {
      fs.writeFileSync(path.join(cwd, 'auto.txt'), 'automatic\n');
      await git(cwd, 'add', 'auto.txt'); await git(cwd, 'commit', '-m', 'automatic child');
      await pause.promise;
    }
    return 'done';
  } });
  f.project.stopping = true; await repo(f.root);
  try {
    const order = await f.project.order('parent');
    f.store.update(order.task.id, { status: 'waiting' });
    const child = await f.project.spawn(order.task.id, 'automatic child');
    expect(JSON.parse(child.reservation)).toMatchObject({ version: 2, kind: 'merge', status: 'pending' });
    expect(f.store.task(order.task.id).reservation).toBeNull();
    const baseline = await git(f.root, 'rev-parse', 'main');
    const reserved = f.store.history(child.id).filter(event => event.type === 'task.reserved');
    expect(reserved).toHaveLength(1);
    expect(reserved[0].data.via).toBe('spawn');
    f.project.stopping = false; f.project.kick();
    await until(() => f.store.task(child.id).status === 'running');
    expect(JSON.parse(f.store.task(child.id).reservation).status).toBe('pending');
    expect(await git(order.task.workspace, 'rev-parse', 'HEAD')).toBe(baseline);
    pause.resolve();
    await until(() => f.store.task(child.id).integration === 'merged', 8000);
    await until(() => f.store.task(order.task.id).calls === 1 && f.store.task(order.task.id).status === 'waiting');
    expect(await git(order.task.workspace, 'show', 'HEAD:auto.txt')).toBe('automatic');
    expect(await git(f.root, 'rev-parse', 'main')).toBe(baseline);
    expect(f.store.task(order.task.id).reservation).toBeNull();
    expect(f.store.task(child.id).parent_id).toBe(order.task.id);
  } finally { pause.resolve(); await f.close(); }
});

test('a clean no-change child delivers its result without a merge commit', async () => {
  const f = fixture({ resolve() { return { agent: 'mock' }; }, async run() { return 'research answer'; } });
  f.project.stopping = true; await repo(f.root);
  try {
    const order = await f.project.order('parent'); f.store.update(order.task.id, { status: 'waiting' });
    const child = await f.project.spawn(order.task.id, 'research');
    const baseline = await git(f.root, 'rev-parse', 'main');
    f.project.stopping = false; f.project.kick();
    await until(() => f.store.task(child.id).status === 'awaiting_acceptance');
    await until(() => f.store.task(order.task.id).calls === 1 && f.store.task(order.task.id).status === 'waiting');
    expect(f.store.task(child.id)).toMatchObject({ integration: 'none', result: 'research answer', reservation: null });
    expect(await git(order.task.workspace, 'rev-parse', 'HEAD')).toBe(baseline);
    expect(f.store.get("SELECT count(*) AS n FROM messages WHERE task_id=? AND signal_type='child.completed'", order.task.id).n).toBe(1);
  } finally { await f.close(); }
});

test('idle order requests use their parent queue without merge identities or reparenting, and squash one commit', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const source = await committedOrder(f, 'alpha');
    const original = await git(f.root, 'rev-parse', 'main');
    const tip = await git(source.workspace, 'rev-parse', 'HEAD');
    const booked = await f.project.reserveTask(source.id, 'merge');
    expect(booked.reservation).toMatchObject({ version: 2, status: 'requested', commit: tip });
    expect(await git(f.root, 'rev-parse', 'main')).toBe(original);
    f.project.stopping = false;
    await f.project.driveTaskMerge(source.parent_id);
    const done = f.store.task(source.id);
    // Integration no longer auto-archives: branch, worktree and original parent are preserved.
    expect(done).toMatchObject({ status: 'awaiting_acceptance', integration: 'merged', parent_id: source.parent_id });
    expect(done.branch).toBe(source.branch);
    expect(done.workspace).toBe(source.workspace);
    const merger = f.store.get("SELECT * FROM tasks WHERE parent_id=? AND task_kind='merge' AND name='merge'", source.parent_id);
    expect(merger).toBeNull();
    expect(JSON.parse(done.reservation)).toMatchObject({ queue_protocol: 1,
      delivery_id: booked.reservation.delivery_id, enqueue_seq: booked.reservation.enqueue_seq,
      baseline: original, status: 'integrated' });
    expect(await git(f.root, 'rev-list', '--count', `${original}..main`)).toBe('1');
    expect(await git(f.root, 'show', 'main:alpha.txt')).toBe('alpha');
    expect(f.store.branch(source.branch).status).toBe('active');
    expect(f.store.get("SELECT count(*) AS n FROM events WHERE task_id=? AND type='task.reparented_for_merge'", source.id).n).toBe(0);
    expect(f.store.get("SELECT count(*) AS n FROM events WHERE task_id=? AND type='task.merge_parent_restored'", source.id).n).toBe(0);
  } finally { await f.close(); }
});

test('a dirty parent rejects auto merge without deleting the source worktree', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const source = await committedOrder(f, 'safe');
    const before = await git(f.root, 'rev-parse', 'main');
    await f.project.reserveTask(source.id, 'merge');
    fs.writeFileSync(path.join(f.root, 'untracked.txt'), 'user work\n');
    f.project.stopping = false;
    await f.project.driveTaskMerge(source.parent_id);
    expect(JSON.parse(f.store.task(source.id).reservation).status).toBe('suspended');
    expect(f.project.activeTaskMerge(source.parent_id)).toBeNull();
    expect(await git(f.root, 'rev-parse', 'main')).toBe(before);
    expect(f.store.task(source.id).status).toBe('waiting');
    expect(fs.existsSync(source.workspace)).toBe(true);
  } finally { await f.close(); }
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
    const first = await committedOrder(f, 'one');
    const second = await committedOrder(f, 'two');
    const parentId = first.parent_id;
    const baseline = await git(f.root, 'rev-parse', 'main');
    await f.project.reserveTask(first.id, 'merge');
    await f.project.reserveTask(second.id, 'merge');
    f.project.stopping = false;
    await f.project.driveTaskMerge(parentId);
    await until(() => f.store.task(second.id).integration === 'merged' || f.store.task(second.id).integration_error, 8000);
    expect(f.store.task(second.id)).toMatchObject({ status: 'awaiting_acceptance', integration: 'merged', parent_id: parentId });
    expect(f.store.task(second.id).branch).toBe(second.branch);
    expect(await git(f.root, 'rev-list', '--count', `${baseline}..main`)).toBe('2');
    expect(await git(f.root, 'show', 'main:one.txt')).toBe('one');
    expect(await git(f.root, 'show', 'main:two.txt')).toBe('two');
  } finally { await f.close(); }
});
