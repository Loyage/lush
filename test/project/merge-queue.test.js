import { test, expect, setDefaultTimeout } from 'bun:test';
// Real multi-worktree transactions and repair invocations must finish cleanup before timeout.
setDefaultTimeout(15000);
import fs from 'node:fs';
import path from 'node:path';
import { fixture, repo, git, until, gate } from '../helpers.js';
import { PARAMS, USER_ONLY, assertAllowed } from '../../src/rpc/registry.js';
import iteration from '../../src/core/project/iteration.js';

async function committedSay(f, name) {
  const say = await f.project.say(name);
  fs.writeFileSync(path.join(say.task.workspace, `${name}.txt`), `${name}\n`);
  await git(say.task.workspace, 'add', `${name}.txt`);
  await git(say.task.workspace, 'commit', '-m', `${name} one`);
  await git(say.task.workspace, 'commit', '--allow-empty', '-m', `${name} two`);
  f.store.update(say.task.id, { status: 'waiting', result: 'done' });
  return say.task;
}

test('detail and graph share read-only request readiness across child and message waits', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const say = await committedSay(f, 'readiness');
    await f.project.workspaces.finish(f.store.task(say.id));
    const projectView = async expected => {
      const before = f.store.history(say.id).length;
      expect(f.project.inspect(say.id).merge_readiness).toMatchObject(expected);
      const graph = await f.project.taskGraph();
      expect(graph.nodes.find(node => node.id === say.id).merge_readiness).toMatchObject(expected);
      expect(f.store.history(say.id)).toHaveLength(before);
    };
    await projectView({ ready: true, reason: null });
    const child = f.store.create({ parent_id: say.id, role: 'agent', task_kind: 'child', goal: 'pending child' });
    for (const status of ['queued','running','waiting','awaiting']) {
      f.store.update(child.id, { status });
      await projectView({ ready: false, reason: `等待子 Task #${child.id} 结算` });
    }
    const booked = await f.project.reserveTask(say.id, 'merge');
    expect(booked.reservation.status).toBe('pending');
    expect(booked.reservation.blocked_reason).toContain(`子 Task #${child.id}`);
    expect(f.store.history(say.id).some(event => event.type === 'task.merge_requested')).toBe(false);
    await f.project.unreserveTask(say.id);
    // A delivered child awaiting user acceptance no longer blocks this invocation's delivery.
    f.store.update(child.id, { status: 'awaiting_acceptance', integration: 'merged' });
    await projectView({ ready: true });
    f.store.message(say.id, 'continue work before merging');
    await projectView({ ready: false, reason: '还有未处理的消息或子任务信号，需先交给 Agent' });
    f.store.run('UPDATE messages SET consumed=1 WHERE task_id=?', say.id);
    f.project.running.set(say.id, {});
    try { await projectView({ ready: false, reason: 'Agent 正在调用或收尾，等待本轮安全结束' }); }
    finally { f.project.running.delete(say.id); }
    (f.project.taskSyncBusy ??= new Set()).add(say.id);
    try { await projectView({ ready: false, reason: 'Task 父分支同步正在执行，请等待安全点' }); }
    finally { f.project.taskSyncBusy.delete(say.id); }
    f.store.update(say.id, { integration: 'none', head_commit: f.store.task(say.id).base_commit });
    await projectView({ ready: false, reason: '没有登记的待交付提交，等待本轮工作完成' });
  } finally { await f.close(); }
});

test('spawn reserves child delivery by default, waits for its safe point, and leaves say delivery to the user', async () => {
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
    const say = await f.project.say('parent');
    f.store.update(say.task.id, { status: 'waiting' });
    const child = await f.project.spawn(say.task.id, 'automatic child');
    expect(JSON.parse(child.reservation)).toMatchObject({ version: 2, kind: 'merge', status: 'pending' });
    expect(f.store.task(say.task.id).reservation).toBeNull();
    const baseline = await git(f.root, 'rev-parse', 'main');
    const reserved = f.store.history(child.id).filter(event => event.type === 'task.reserved');
    expect(reserved).toHaveLength(1);
    expect(reserved[0].data.via).toBe('spawn');
    f.project.stopping = false; f.project.kick();
    await until(() => f.store.task(child.id).status === 'running');
    expect(JSON.parse(f.store.task(child.id).reservation).status).toBe('pending');
    expect(await git(say.task.workspace, 'rev-parse', 'HEAD')).toBe(baseline);
    pause.resolve();
    await until(() => f.store.task(child.id).integration === 'merged', 8000);
    await until(() => f.store.task(say.task.id).calls === 1 && f.store.task(say.task.id).status === 'waiting');
    expect(await git(say.task.workspace, 'show', 'HEAD:auto.txt')).toBe('automatic');
    expect(await git(f.root, 'rev-parse', 'main')).toBe(baseline);
    expect(f.store.task(say.task.id).reservation).toBeNull();
    expect(f.store.task(child.id).parent_id).toBe(say.task.id);
  } finally { pause.resolve(); await f.close(); }
});

test('automatic sibling deliveries batch the parent wake and repair divergence on the source', async () => {
  const slow = gate(), slowStarted = gate();
  let parentCalls = 0;
  const f = fixture({ resolve() { return { agent: 'mock' }; }, async run({ task, cwd, messages, api }) {
    if (task.task_kind === 'say') {
      parentCalls++;
      expect(api.store.children(task.id).filter(child => child.task_kind === 'child').every(child => child.integration === 'merged')).toBe(true);
      return 'collected both children';
    }
    const instruction = messages.find(row => row.body.includes('合并分歧'));
    if (instruction) {
      await git(cwd, 'merge', '--no-edit', instruction.body.match(/[0-9a-f]{40}/)[0]);
      return 'repaired';
    }
    fs.writeFileSync(path.join(cwd, `${task.name}.txt`), `${task.name}\n`);
    await git(cwd, 'add', '.'); await git(cwd, 'commit', '-m', task.name);
    if (task.name === 'slow') { slowStarted.resolve(); await slow.promise; }
    return task.name;
  } });
  f.project.stopping = true; await repo(f.root);
  try {
    const say = await f.project.say('parent'); f.store.update(say.task.id, { status: 'waiting' });
    const fast = await f.project.spawn(say.task.id, 'fast', undefined, [], 'fast');
    const second = await f.project.spawn(say.task.id, 'slow', undefined, [], 'slow');
    f.project.stopping = false; f.project.kick();
    await slowStarted.promise;
    await until(() => f.store.task(fast.id).integration === 'merged', 8000);
    expect(parentCalls).toBe(0);
    expect(f.project.hasActionableMessages(say.task.id)).toBe(false);
    expect(f.store.task(say.task.id).status).toBe('waiting');
    slow.resolve();
    await until(() => f.store.task(second.id).integration === 'merged', 8000);
    await until(() => parentCalls === 1 && f.store.task(say.task.id).status === 'waiting');
    expect(f.store.task(second.id).calls).toBe(2);
    expect(await git(say.task.workspace, 'show', 'HEAD:fast.txt')).toBe('fast');
    expect(await git(say.task.workspace, 'show', 'HEAD:slow.txt')).toBe('slow');
    expect(f.store.task(say.task.id).reservation).toBeNull();
  } finally { slow.resolve(); await f.close(); }
});

test('nested delegated Tasks deliver bottom-up without reserving the user say', async () => {
  let childId, grandchildId;
  const f = fixture({ resolve() { return { agent: 'mock' }; }, async run({ task, cwd, api }) {
    if (task.task_kind === 'say' && task.calls === 1) {
      childId = (await api.spawn(task.id, 'child', undefined, [], 'child')).id;
      return 'delegated';
    }
    if (task.name === 'child' && task.calls === 1) {
      grandchildId = (await api.spawn(task.id, 'grandchild', undefined, [], 'grandchild')).id;
      return 'delegated again';
    }
    if (task.name === 'grandchild') {
      fs.writeFileSync(path.join(cwd, 'nested.txt'), 'nested\n');
      await git(cwd, 'add', '.'); await git(cwd, 'commit', '-m', 'nested');
    }
    for (const child of api.store.children(task.id).filter(row => row.task_kind === 'child' && row.status === 'awaiting_acceptance')) {
      await api.acceptTask(child.id, task.id);
    }
    return 'done';
  } });
  await repo(f.root);
  try {
    const say = await f.project.say('nested parent');
    await until(() => childId && f.store.task(childId).integration === 'merged', 10000);
    await until(() => f.store.task(say.task.id).calls === 2 && f.store.task(say.task.id).status === 'waiting');
    expect(f.store.task(grandchildId)).toMatchObject({ integration: 'merged', status: 'completed' });
    expect(f.store.task(childId).status).toBe('completed');
    expect(f.store.history(grandchildId).find(event => event.type === 'task.accepted').data)
      .toMatchObject({ accepted_by: 'parent', parent_id: childId });
    expect(await git(say.task.workspace, 'show', 'HEAD:nested.txt')).toBe('nested');
    expect(f.store.task(say.task.id).reservation).toBeNull();
    expect(await git(f.root, 'rev-list', '--count', 'main')).toBe('1');
    await f.project.reserveTask(say.task.id, 'merge');
    await until(() => f.store.task(say.task.id).status === 'awaiting_acceptance' && !f.project.running.has(say.task.id));
    await f.project.acceptTask(say.task.id);
    expect(f.store.task(say.task.id).status).toBe('completed');
  } finally { await f.close(); }
});

test('a clean no-change child delivers its result without a merge commit', async () => {
  const f = fixture({ resolve() { return { agent: 'mock' }; }, async run() { return 'research answer'; } });
  f.project.stopping = true; await repo(f.root);
  try {
    const say = await f.project.say('parent'); f.store.update(say.task.id, { status: 'waiting' });
    const child = await f.project.spawn(say.task.id, 'research');
    const baseline = await git(f.root, 'rev-parse', 'main');
    f.project.stopping = false; f.project.kick();
    await until(() => f.store.task(child.id).status === 'awaiting_acceptance');
    await until(() => f.store.task(say.task.id).calls === 1 && f.store.task(say.task.id).status === 'waiting');
    expect(f.store.task(child.id)).toMatchObject({ integration: 'none', result: 'research answer', reservation: null });
    expect(await git(say.task.workspace, 'rev-parse', 'HEAD')).toBe(baseline);
    expect(f.store.get("SELECT count(*) AS n FROM messages WHERE task_id=? AND signal_type='child.completed'", say.task.id).n).toBe(1);
  } finally { await f.close(); }
});

test('a historical child with an explicitly withdrawn reservation is not re-enabled at its safe point', async () => {
  const f = fixture({ resolve() { return { agent: 'mock' }; }, async run({ cwd }) {
    fs.writeFileSync(path.join(cwd, 'held.txt'), 'held\n');
    await git(cwd, 'add', '.'); await git(cwd, 'commit', '-m', 'held');
    return 'held';
  } });
  f.project.stopping = true; await repo(f.root);
  try {
    const say = await f.project.say('parent'); f.store.update(say.task.id, { status: 'waiting' });
    const child = await f.project.spawn(say.task.id, 'held');
    // NULL is an old row, not a new locked hook. Upgrade never rewrites this choice.
    f.store.update(child.id, { auto_merge: null });
    f.project.unreserveTask(child.id);
    const baseline = await git(f.root, 'rev-parse', 'main');
    f.project.stopping = false; f.project.kick();
    await until(() => f.store.task(child.id).status === 'waiting' && !f.project.running.has(child.id));
    expect(f.store.task(child.id)).toMatchObject({ reservation: null, integration: 'pending' });
    expect(await git(say.task.workspace, 'rev-parse', 'HEAD')).toBe(baseline);
    expect(f.store.task(say.task.id).calls).toBe(0);
  } finally { await f.close(); }
});

test('a child waiting for a user decision keeps its automatic merge pending until the answer is processed', async () => {
  const f = fixture({ resolve() { return { agent: 'mock' }; }, async run({ task, cwd, api }) {
    if (task.task_kind === 'child' && task.calls === 1) {
      fs.writeFileSync(path.join(cwd, 'decision.txt'), 'decision\n');
      await git(cwd, 'add', '.'); await git(cwd, 'commit', '-m', 'decision');
      api.notice(task.id, 'confirm', 'need an answer');
    }
    return 'done';
  } });
  f.project.stopping = true; await repo(f.root);
  try {
    const say = await f.project.say('parent'); f.store.update(say.task.id, { status: 'waiting' });
    const child = await f.project.spawn(say.task.id, 'decision');
    const baseline = await git(f.root, 'rev-parse', 'main');
    f.project.stopping = false; f.project.kick();
    await until(() => f.store.task(child.id).status === 'awaiting' && !f.project.running.has(child.id));
    expect(JSON.parse(f.store.task(child.id).reservation).status).toBe('pending');
    expect(await git(say.task.workspace, 'rev-parse', 'HEAD')).toBe(baseline);
    f.project.answer(f.store.get("SELECT id FROM notices WHERE task_id=? AND status='open'", child.id).id, 'yes');
    await until(() => f.store.task(child.id).integration === 'merged', 8000);
    expect(f.store.task(child.id).calls).toBe(2);
  } finally { await f.close(); }
});

test('a failed sibling wakes the parent urgently without deadlocking an automatic merge request', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const say = await f.project.say('parent'); f.store.update(say.task.id, { status: 'waiting' });
    const child = await f.project.spawn(say.task.id, 'ready');
    const failed = await f.project.spawn(say.task.id, 'failed');
    fs.writeFileSync(path.join(child.workspace, 'ready.txt'), 'ready\n');
    await git(child.workspace, 'add', '.'); await git(child.workspace, 'commit', '-m', 'ready');
    f.store.update(child.id, { status: 'waiting', result: 'done' });
    await f.project.settleQueuedMerge(child.id);
    f.project.finish(failed.id, 'failed', null, 'failed to implement');
    expect(f.store.task(say.task.id).status).toBe('queued');
    expect(f.project.hasActionableMessages(say.task.id)).toBe(true);
    expect(f.project.branchFreeze(say.task.branch)).toBeNull();
    expect(f.project.branchFreeze(child.branch)?.task_id).toBe(child.id);
    f.project.kick = () => {}; f.project.stopping = false;
    await f.project.driveTaskMerge(say.task.id);
    expect(f.store.task(child.id).integration).not.toBe('merged');
    // The queued parent gets the urgent failure before the next landing attempt.
    f.store.run('UPDATE messages SET consumed=1 WHERE task_id=?', say.task.id);
    f.store.update(say.task.id, { status: 'waiting' });
    await f.project.driveTaskMerge(say.task.id);
    expect(f.store.task(child.id).integration).toBe('merged');
    expect(f.store.task(failed.id).integration).toBe('none');
    expect(f.project.branchFreeze(say.task.branch)).toBeNull();
    expect(f.store.all("SELECT id FROM messages WHERE task_id=? AND signal_type='child.failed'", say.task.id)).toHaveLength(1);
  } finally { await f.close(); }
});

test('idle say requests use their parent queue without merge identities or reparenting, and squash one commit', async () => {
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

test('a completed historical showcase say cannot reopen through merge reservation', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const source = await committedSay(f, 'showcased');
    await f.project.workspaces.finish(source);
    f.store.update(source.id, { status: 'completed', reservation: JSON.stringify({ version: 1,
      kind: 'showcase', status: 'completed', child_id: 999 }) });
    const before = f.store.task(source.id);
    await expect(f.project.reserveTask(source.id, 'merge')).rejects.toThrow('ended say Task');
    expect(f.store.task(source.id)).toEqual(before);
    expect(f.store.unread(source.parent_id)).toHaveLength(0);
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
    await f.project.driveTaskMerge(source.parent_id);
    expect(JSON.parse(f.store.task(source.id).reservation).status).toBe('suspended');
    expect(f.project.activeTaskMerge(source.parent_id)).toBeNull();
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
    expect(f.store.task(child.id).parent_id).toBe(say.task.id);
    expect(f.store.task(child.id).branch).toBe(child.branch);
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
    expect(f.store.task(say.task.id).status).toBe('awaiting_acceptance');
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
    await until(() => f.store.task(second.id).integration === 'merged' || f.store.task(second.id).integration_error, 8000);
    expect(f.store.task(second.id)).toMatchObject({ status: 'awaiting_acceptance', integration: 'merged', parent_id: parentId });
    expect(f.store.task(second.id).branch).toBe(second.branch);
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
    expect(f.project.branchFreeze('main')).toBeNull();
    expect(f.project.branchFreeze(source.branch)?.task_id).toBe(source.id);
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
    await until(() => JSON.parse(f.store.task(second.id).reservation).status === 'resolving');
    const returned = f.store.task(second.id);
    expect(JSON.parse(returned.reservation).status).toBe('resolving');
    expect(returned.status).toBe('queued');
    expect(returned.workspace).toBe(second.workspace);
    expect(returned.parent_id).toBe(parentId);
    expect(f.project.activeTaskMerge(parentId)?.id).toBe(second.id);
    expect(f.store.get("SELECT count(*) AS n FROM tasks WHERE task_kind='merge'").n).toBe(0);
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

test('a Task archived right after landing by an older daemon is still returned to its parent on recovery', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const source = await committedSay(f, 'legacy');
    const parent = source.parent_id;
    await f.project.reserveTask(source.id, 'merge');
    f.project.stopping = false;
    await f.project.driveTaskMerge(parent);
    const merger = f.store.create({ parent_id: parent, role: 'agent', task_kind: 'merge', name: 'merge', goal: 'historical queue' });
    f.store.update(merger.id, { status: 'completed' });
    // The pre-change path archived the branch and worktree right after landing, leaving the Task
    // under the reusable merge identity. Recovery must still hand it back to its original parent.
    // Simulate the historical terminal fact, without migrating real historical rows.
    f.store.update(source.id, { status: 'completed' });
    await f.project.workspaces.cleanup(source.id);
    f.store.run('UPDATE tasks SET parent_id=? WHERE id=?', merger.id, source.id);
    f.store.event(source.id, 'task.reparented_for_merge', { from: parent, to: merger.id });
    expect(f.store.task(source.id)).toMatchObject({ parent_id: merger.id, branch: null, workspace: null });
    f.project.stopping = true;
    f.project.recover();
    expect(f.store.task(source.id).parent_id).toBe(parent);
    expect(f.store.get("SELECT count(*) AS n FROM events WHERE task_id=? AND type='task.merge_parent_restored'", source.id).n).toBe(1);
  } finally { await f.close(); }
});

test('a merged Task keeps its branch until the user archives it, without blocking its parent', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const say = await f.project.say('parent');
    f.store.update(say.task.id, { status: 'waiting' });
    const child = await f.project.spawn(say.task.id, 'child work');
    fs.writeFileSync(path.join(child.workspace, 'child.txt'), 'child\n');
    await git(child.workspace, 'add', 'child.txt'); await git(child.workspace, 'commit', '-m', 'child one');
    f.store.update(child.id, { status: 'waiting', result: 'done' });

    await f.project.reserveTask(child.id, 'merge');
    f.project.stopping = false;
    await f.project.driveTaskMerge(say.task.id);

    const merged = f.store.task(child.id);
    expect(merged).toMatchObject({ status: 'awaiting_acceptance', integration: 'merged', parent_id: say.task.id });
    expect(merged.branch).toBe(child.branch);
    expect(merged.workspace).toBe(child.workspace);
    // Squash ancestry looks divergent in Git, but the read model reports it integrated and does not
    // let a retained merged child block its parent branch.
    expect((await f.project.workspaces.branchState(child.branch)).status).toBe('integrated');
    expect((await f.project.workspaces.branchState(say.task.branch)).blockers).toEqual([`task:#${say.task.id}`]);

    // Archiving is the user's explicit later decision.
    await iteration.acceptTask.call(f.project, child.id);
    await f.project.workspaces.cleanup(child.id);
    expect(f.store.task(child.id)).toMatchObject({ branch: null, workspace: null });
    expect(f.store.branch(child.branch).status).toBe('archived');
  } finally { await f.close(); }
});
