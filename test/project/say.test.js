import { test, expect, setDefaultTimeout } from 'bun:test';
setDefaultTimeout(15000);
import fs from 'node:fs';
import path from 'node:path';
import { fixture, repo, git, until, gate } from '../helpers.js';
import { Dispatcher } from '../../src/rpc/protocol.js';
import { assertAllowed } from '../../src/rpc/registry.js';

test('new say creates one Input and one Task in its own worktree, without planner or fast routing', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const response = await f.project.say('开发 做一个页面');
    const root = f.store.task(response.task.parent_id);
    expect(root).toMatchObject({ role: 'agent', task_kind: 'main', status: 'waiting', branch: 'main', input_id: null });
    expect(response.task).toMatchObject({ task_kind: 'say', role: 'agent', parent_id: root.id,
      input_id: response.id, workspace: response.anchor.workspace, branch: response.anchor.branch,
      target_branch: 'main' });
    expect(f.store.get('SELECT task_id FROM inputs WHERE id=?', response.id).task_id).toBe(response.task.id);
    expect(f.store.branch(response.anchor.branch).task_id).toBe(response.task.id);
    // 概览与输入区父 Task 选择共用 activity 读模型：分支所有者必须带上 branch。
    const activity = new Map(f.project.activity(50, 'work').tasks.map(task => [task.id, task]));
    expect(activity.get(response.task.id).branch).toBe(response.anchor.branch);
    expect(activity.get(root.id).branch).toBe('main');
    expect(await git(response.task.workspace, 'symbolic-ref', '--short', 'HEAD')).toBe(response.task.branch);
    expect(await f.project.workspaces.ensure(response.task)).toBe(response.task.workspace);
    expect(f.store.get("SELECT count(*) AS n FROM tasks WHERE role='planner'").n).toBe(0);
    expect(f.store.get("SELECT count(*) AS n FROM events WHERE type='input.route'").n).toBe(0);
    expect((await f.project.ensureMainTask()).id).toBe(root.id);
    expect(() => f.project.message(root.id, 'run in main')).toThrow('not an unrestricted Agent inbox');
    expect(() => f.project.spawn(root.id, 'write main')).toThrow('not unrestricted spawned work');
    expect(() => f.project.cancel(root.id)).toThrow('permanent root');
    await expect(f.project.say('another', 'feature/missing')).rejects.toThrow('explicitly bound Worker');
    expect(f.store.get('SELECT count(*) AS n FROM inputs').n).toBe(1);
  } finally { await f.close(); }
});

test('explicit branch.bind makes a new idle owner without replacing legacy history or guessing parent', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const baseline = await git(f.root, 'rev-parse', 'main');
    await git(f.root, 'branch', 'external', 'main');
    await git(f.root, 'checkout', 'external');
    fs.writeFileSync(path.join(f.root, 'external.txt'), 'outside\n');
    await git(f.root, 'add', 'external.txt'); await git(f.root, 'commit', '-m', 'outside');
    const commit = await git(f.root, 'rev-parse', 'HEAD');
    const old = f.store.create({ role: 'worker', goal: 'legacy', name: 'old' });
    f.store.update(old.id, { branch: 'external', status: 'completed' });
    f.store.recordBranch({ branch: 'external', parent: 'main', relation: 'recorded',
      created_from_commit: baseline, task_id: old.id });
    const pending = f.store.create({ role: 'worker', goal: 'unfinished legacy work' });
    f.store.update(pending.id, { target_branch: 'external' });
    await expect(f.project.bindBranch('external', commit)).rejects.toThrow('active old worker');
    f.store.update(pending.id, { status: 'cancelled' });
    await expect(f.project.say('not yet', 'external')).rejects.toThrow('explicitly bound Worker');
    await expect(f.project.bindBranch('external', baseline)).rejects.toThrow('moved');
    const owner = await new Dispatcher(f.project).dispatch('branch.bind', { branch: 'external', commit });
    expect(owner).toMatchObject({ task_kind: 'owner', status: 'waiting', branch: 'external',
      base_commit: commit, parent_id: null, calls: 0 });
    expect(f.store.branch('external').task_id).toBe(old.id);
    expect((await f.project.branchShow('external')).task_id).toBe(owner.id);
    await expect(f.project.bindBranch('external', commit)).rejects.toThrow('already has a new Worker owner');
    const sent = await f.project.say('new task', 'external');
    expect(sent.task.parent_id).toBe(owner.id);
    expect(f.store.get("SELECT count(*) AS n FROM tasks WHERE role='planner'").n).toBe(0);
    expect(() => f.project.message(owner.id, 'run')).toThrow('not an unrestricted Agent inbox');
    await expect(f.project.approveBranchMerge('external')).rejects.toThrow('legacy branch.merge');
    await expect(f.project.syncBranch('external')).rejects.toThrow('legacy branch.sync');
    expect(await git(f.root, 'rev-parse', 'main')).toBe(baseline);
  } finally { await f.close(); }
});

test('explicit branch.bind registers a previously untracked local branch without inferring genealogy', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    await git(f.root, 'branch', 'outside');
    const commit = await git(f.root, 'rev-parse', 'refs/heads/outside');
    const owner = await f.project.bindBranch('outside', commit);
    expect(f.store.branch('outside')).toMatchObject({ parent: null, parent_relation: 'unknown', task_id: owner.id });
    expect((await f.project.branchShow('outside')).task_id).toBe(owner.id);
    await expect(f.project.bindBranch('main', commit)).rejects.toThrow('non-main');
    await expect(f.project.bindBranch('missing', commit)).rejects.toThrow('does not exist');
  } finally { await f.close(); }
});

test('say merge reservations are durable, reject removed kinds and are not authorization', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const say = await f.project.say('build a view');
    const legacy = f.store.create({ role: 'worker', goal: 'legacy' });
    await expect(f.project.reserveTask(legacy.id, 'merge')).rejects.toThrow('only say/child');
    await expect(f.project.reserveTask(say.task.id, 'other')).rejects.toThrow('reservation kind must be merge');
    expect(() => assertAllowed('worker.reserve', { id: say.task.id, kind: 'merge' }, say.task.id))
      .toThrow('requires user approval');
    // 新模型 reservation 是 version 2：pending 是「还没满足条件」，不是合并批准。
    const first = await new Dispatcher(f.project).dispatch('worker.reserve', { id: say.task.id, kind: 'merge' });
    expect(first).toMatchObject({ task_id: say.task.id, changed: true,
      reservation: { version: 2, kind: 'merge', status: 'pending' } });
    expect(JSON.parse(f.store.task(say.task.id).reservation)).toEqual(first.reservation);
    // 读模型（详情与任务树）要能解码 v2，而不是把它当坏数据。
    expect(f.project.inspect(say.task.id).reservation).toEqual(first.reservation);
    expect(f.project.decorate(f.store.summaries('work')).find(task => task.id === say.task.id).reservation).toEqual(first.reservation);
    expect(await f.project.reserveTask(say.task.id, 'merge')).toEqual({ ...first, changed: false });
    await expect(f.project.reserveTask(say.task.id, 'showcase')).rejects.toThrow('reservation kind must be merge');
    expect(f.store.all("SELECT id FROM events WHERE task_id=? AND type='task.reserved'", say.task.id)).toHaveLength(1);
    expect(f.store.task(say.task.id).integration).toBe('none');
    expect(await git(f.root, 'rev-parse', 'main')).toBe(say.anchor.commit);
    expect(f.project.unreserveTask(say.task.id)).toMatchObject({ changed: true, reservation: null });
    expect(f.project.unreserveTask(say.task.id)).toMatchObject({ changed: false, reservation: null });
    await expect(f.project.reserveTask(say.task.id, 'showcase')).rejects.toThrow('reservation kind must be merge');
    expect(f.store.children(say.task.id)).toHaveLength(0);
    expect(f.store.task(say.task.id).reservation).toBeNull();
    expect(f.store.all("SELECT id FROM events WHERE task_id=? AND type='task.unreserved'", say.task.id)).toHaveLength(1);
  } finally { await f.close(); }
});

test('historical completed child is repaired from both tips and runtime lands it after the parent reaches a safe point', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const parent = await f.project.say('parent with two children');
    const first = await f.project.spawn(parent.task.id, 'first child', 'agent', [], 'first');
    const second = await f.project.spawn(parent.task.id, 'second child', 'agent', [], 'second');
    for (const child of [first, second]) {
      // Historical pre-hook children retain their manual ff-only integration path.
      f.store.update(child.id, { reservation: null, auto_merge: null });
      const cwd = await f.project.workspaces.ensure(child);
      fs.writeFileSync(path.join(cwd, `${child.id}.txt`), 'work\n');
      await git(cwd, 'add', '.'); await git(cwd, 'commit', '-m', `child ${child.id}`);
      await f.project.workspaces.finish(f.store.task(child.id));
      f.project.finish(child.id, 'completed', 'done');
      f.store.run('UPDATE messages SET consumed=1 WHERE task_id=?', parent.task.id);
    }
    f.store.update(parent.task.id, { status: 'running' });
    const firstCommit = f.store.task(first.id).head_commit;
    await f.project.integrateChild(parent.task.id, first.id, firstCommit);
    expect(await git(f.root, 'rev-parse', parent.task.branch)).toBe(firstCommit);
    // 兄弟先落地：第二个子任务的固定提交不再能快进，直接确认必须拒绝并保留现场。
    const secondCommit = f.store.task(second.id).head_commit;
    await expect(f.project.integrateChild(parent.task.id, second.id, secondCommit)).rejects.toThrow('fast-forward');
    expect(f.store.task(second.id).integration).toBe('pending');
    expect(await git(f.root, 'rev-parse', parent.task.branch)).toBe(firstCommit);
    // 只有正在跑的直接父 Agent 能派，且不能修别人的子任务。
    expect(() => assertAllowed('worker.resolve_child_divergence', { id: second.id }, null)).toThrow('agent only');
    await expect(f.project.resolveChildDivergence(parent.task.parent_id, second.id)).rejects.toThrow('only a new Worker agent');
    await expect(f.project.resolveChildDivergence(parent.task.id, first.id)).rejects.toThrow('whose work is not integrated yet');
    const started = await f.project.resolveChildDivergence(parent.task.id, second.id);
    expect(started).toMatchObject({ status: 'queued', source_commit: secondCommit, parent_commit: firstCommit });
    const repair = f.store.task(started.task.id);
    expect(repair).toMatchObject({ parent_id: parent.task.id, task_kind: 'child', role: 'agent',
      base_commit: secondCommit, target_branch: parent.task.branch });
    const repeated = await f.project.resolveChildDivergence(parent.task.id, second.id);
    expect(repeated).toMatchObject({ status: 'existing', task: { id: repair.id } });
    expect(f.store.children(parent.task.id)).toHaveLength(3);
    // 解分歧工作区从固定子提交拉起（谱系直接指向父分支），只合入父分支的固定顶端。
    const cwd = await f.project.workspaces.ensure(repair);
    expect(f.store.branch(f.store.task(repair.id).branch).parent).toBe(parent.task.branch);
    expect(await git(cwd, 'rev-parse', 'HEAD')).toBe(secondCommit);
    await git(cwd, 'merge', '--no-ff', '--no-edit', firstCommit);
    await f.project.workspaces.finish(f.store.task(repair.id));
    const resolved = f.store.task(repair.id).head_commit;
    f.store.update(parent.task.id, { status: 'waiting' }); // 父 Agent 到安全点，runtime 才能原样落地固定产物
    f.project.stopping = false; f.project.kick = () => {};
    f.project.finish(repair.id, 'completed', 'both commits tested');
    await until(() => f.store.task(second.id).integration === 'merged');
    expect(f.store.task(repair.id).integration).toBe('merged');
    expect(await git(f.root, 'rev-parse', parent.task.branch)).toBe(resolved);
    // 被修复的子任务一并结算，且两个固定提交都在父分支里。
    expect(f.store.task(second.id)).toMatchObject({ status: 'completed', integration: 'merged', head_commit: resolved });
    expect(f.store.all("SELECT id FROM events WHERE task_id=? AND type='task.divergence_integrated'", second.id)).toHaveLength(1);
    expect(await f.project.workspaces.isAncestor(f.root, secondCommit, resolved)).toBe(true);
    expect(await f.project.workspaces.isAncestor(f.root, firstCommit, resolved)).toBe(true);
    f.store.run('UPDATE messages SET consumed=1 WHERE task_id=?', parent.task.id);
    f.store.update(parent.task.id, { status: 'waiting' });
    await f.project.reserveTask(parent.task.id, 'merge');
    // New parent-owned runtime may already have taken the writer slot before reserve returns.
    await until(() => f.store.task(parent.task.id).integration === 'merged');
    expect(JSON.parse(f.store.task(parent.task.id).reservation).status).toBe('integrated');
  } finally { await f.close(); }
});

test('repair refuses a diverged child of a locked parent and a child whose branch did not diverge', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const parent = await f.project.say('parent');
    const child = await f.project.spawn(parent.task.id, 'child', 'agent', [], 'child');
    f.store.update(child.id, { reservation: null, auto_merge: null });
    const cwd = await f.project.workspaces.ensure(child);
    fs.writeFileSync(path.join(cwd, 'x.txt'), 'work\n');
    await git(cwd, 'add', '.'); await git(cwd, 'commit', '-m', 'child');
    await f.project.workspaces.finish(f.store.task(child.id));
    f.project.finish(child.id, 'completed', 'done');
    f.store.run('UPDATE messages SET consumed=1 WHERE task_id=?', parent.task.id);
    // 还没分歧（父分支没动）：不需要也不能派解分歧子任务。
    await expect(f.project.resolveChildDivergence(parent.task.id, child.id)).rejects.toThrow('repair only applies to a diverged child');
    // 父分支被另一个未集成请求锁住时，先处理那个请求。
    const requester = await f.project.say('requester', parent.task.branch);
    const requestCwd = await f.project.workspaces.ensure(requester.task);
    fs.writeFileSync(path.join(requestCwd, 'req.txt'), 'work\n');
    await git(requestCwd, 'add', '.'); await git(requestCwd, 'commit', '-m', 'request');
    await f.project.workspaces.finish(f.store.task(requester.task.id));
    f.store.update(requester.task.id, { status: 'waiting' });
    expect((await f.project.reserveTask(requester.task.id, 'merge')).reservation.status).toBe('requested');
    // Historical v1 requests pin the parent at enqueue; v2 only owns it while executing.
    const legacy = JSON.parse(f.store.task(requester.task.id).reservation);
    f.store.update(requester.task.id, { reservation: JSON.stringify({ ...legacy, version: 1,
      baseline: await git(parent.task.workspace, 'rev-parse', 'HEAD') }) });
    await git(parent.task.workspace, 'commit', '--allow-empty', '-m', 'parent moved');
    f.store.update(parent.task.id, { status: 'running' });
    await expect(f.project.resolveChildDivergence(parent.task.id, child.id)).rejects.toThrow('frozen');
    expect(f.store.children(parent.task.id)).toHaveLength(2);
  } finally { await f.close(); }
});
test('pending merge can be explicitly rechecked without duplicate bookings or skipping unread messages', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const say = await f.project.say('ship after review');
    const first = await f.project.reserveTask(say.task.id, 'merge');
    expect(first.reservation).toMatchObject({ status: 'pending' });
    expect(first.reservation.blocked_reason).toContain('下一轮 Agent');
    const repeat = await f.project.reserveTask(say.task.id, 'merge');
    expect(repeat.changed).toBe(false);
    expect(f.store.all("SELECT id FROM events WHERE task_id=? AND type='task.reserved'", say.task.id)).toHaveLength(1);
    fs.writeFileSync(path.join(say.task.workspace, 'review.txt'), 'ready\n');
    await git(say.task.workspace, 'add', 'review.txt'); await git(say.task.workspace, 'commit', '-m', 'ready');
    f.store.update(say.task.id, { status: 'waiting' });
    const messageId = f.store.message(say.task.id, 'review this before delivery', say.task.parent_id);
    const blocked = await f.project.reserveTask(say.task.id, 'merge');
    expect(blocked.reservation.blocked_reason).toContain('未处理的消息');
    expect(f.store.unread(say.task.parent_id)).toHaveLength(0);
    f.store.run('UPDATE messages SET consumed=1 WHERE id=?', messageId); // mock the next invocation in this temporary project
    const ready = await f.project.reserveTask(say.task.id, 'merge');
    expect(ready.changed).toBe(false);
    expect(ready.reservation.status).toBe('requested');
    expect(ready.reservation.blocked_reason).toBeUndefined();
    expect(f.store.unread(say.task.parent_id)).toHaveLength(1);
    expect(f.store.all("SELECT id FROM events WHERE task_id=? AND type='task.reserved'", say.task.id)).toHaveLength(1);
  } finally { await f.close(); }
});
test('say --draft retains exact draft text and references, sends only one, and refuses stale edits', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  const reference = { kind: 'text', label: 'context', quote: 'selected', target: {}, location: {} };
  try {
    const first = f.project.draft('  original\n text  ', [reference]);
    const other = f.project.draft('untouched');
    const sent = await f.project.say(undefined, 'main', [], first.id);
    expect(sent.content).toBe('  original\n text  '); expect(sent.draft).toBe(first.id);
    expect(f.store.inputReferences(sent.id)[0].quote).toBe('selected');
    expect(f.store.draft(first.id).input_id).toBe(sent.id);
    expect(f.store.draft(other.id).input_id).toBeNull();
    await expect(f.project.say(undefined, 'main', [], first.id)).rejects.toThrow('already submitted');
    expect(f.store.get('SELECT count(*) AS n FROM inputs').n).toBe(1);
  } finally { await f.close(); }
});

test('new say Task can spawn independent agent child and its settlement sends a typed parent signal', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const say = await f.project.say('develop');
    const child = await f.project.spawn(say.task.id, 'review changes', 'agent', [], 'review');
    expect(child).toMatchObject({ role: 'agent', task_kind: 'child', parent_id: say.task.id });
    const workspace = await f.project.workspaces.ensure(child);
    const stored = f.store.task(child.id);
    expect(stored.target_branch).toBe(say.task.branch);
    expect(f.store.branch(stored.branch).parent).toBe(say.task.branch);
    expect(workspace).not.toBe(say.task.workspace);
    f.project.finish(child.id, 'completed', 'child done');
    expect(f.store.task(say.task.id).status).toBe('queued');
    const unread = f.store.unread(say.task.id);
    expect(unread).toHaveLength(1);
    expect(unread[0].signal_type).toBe('child.completed');
    expect(JSON.parse(unread[0].body).payload.result).toBe('child done');
    f.project.finish(child.id, 'completed', 'duplicate');
    expect(f.store.unread(say.task.id)).toHaveLength(1);
    await expect(f.project.approveMerge(child.id)).rejects.toThrow('parent confirmation');
    await expect(f.project.approveBranchMerge(stored.branch)).rejects.toThrow('legacy branch.merge');
    expect(await git(f.root, 'rev-parse', 'main')).toBe(say.anchor.commit);
  } finally { await f.close(); }
});

test('graph plots a spawned agent child as its own task node, but not the main root', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const say = await f.project.say('develop');
    const child = await f.project.spawn(say.task.id, 'review changes', 'agent', [], 'review');
    await f.project.workspaces.ensure(child);
    const stored = f.store.task(child.id);
    const graph = await f.project.graph();
    // child 有自己的分支与 worktree，必须像 say 一样画成任务行，否则分支节点报有任务却点不进去。
    expect(graph.nodes.find(node => node.kind === 'task' && node.id === child.id)).toMatchObject({
      role: 'agent', task_kind: 'child', parent_id: say.task.id, branch: stored.branch,
    });
    expect(graph.nodes.find(node => node.kind === 'branch' && node.name === stored.branch).tasks.total).toBe(1);
    // main/owner 根 Task 是分支所有者而不是工作分支：信息在 branch 节点上，不重复画成任务行。
    expect(graph.nodes.find(node => node.kind === 'task' && node.id === say.task.parent_id)).toBeUndefined();
  } finally { await f.close(); }
});

test('historical child without a v2 delivery intent needs a running direct parent to integrate ff-only', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const say = await f.project.say('develop');
    const child = await f.project.spawn(say.task.id, 'write child code', 'agent', [], 'write-child');
    f.store.update(child.id, { reservation: null, auto_merge: null });
    const workspace = await f.project.workspaces.ensure(child);
    fs.writeFileSync(path.join(workspace, 'child.txt'), 'work\n');
    await git(workspace, 'add', 'child.txt'); await git(workspace, 'commit', '-m', 'child work');
    await f.project.workspaces.finish(f.store.task(child.id));
    f.project.finish(child.id, 'completed', 'written');
    const commit = f.store.task(child.id).head_commit;
    expect(commit).toBe(await git(workspace, 'rev-parse', 'HEAD'));
    await expect(f.project.integrateChild(say.task.id, child.id, commit)).rejects.toThrow('must be running');
    f.store.update(say.task.id, { status: 'running' });
    await expect(f.project.integrateChild(say.task.id, child.id, 'a'.repeat(40))).rejects.toThrow('fixed head_commit');
    const mainBefore = await git(f.root, 'rev-parse', 'main');
    const outcome = await f.project.integrateChild(say.task.id, child.id, commit);
    expect(outcome.child.integration).toBe('merged');
    expect(await git(say.task.workspace, 'rev-parse', 'HEAD')).toBe(commit);
    expect(await git(f.root, 'rev-parse', 'main')).toBe(mainBefore);
    expect((await f.project.integrateChild(say.task.id, child.id, commit)).merge.already_integrated).toBe(true);
    await expect(new Dispatcher(f.project).dispatch('worker.integrate', { id: child.id, commit }))
      .rejects.toThrow('agent only');
  } finally { await f.close(); }
});

test('child branch drift rejects the fixed commit without moving the parent', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const say = await f.project.say('develop');
    const child = await f.project.spawn(say.task.id, 'write child code', 'agent', [], 'write-child');
    f.store.update(child.id, { reservation: null, auto_merge: null });
    const workspace = await f.project.workspaces.ensure(child);
    fs.writeFileSync(path.join(workspace, 'child.txt'), 'first\n');
    await git(workspace, 'add', 'child.txt'); await git(workspace, 'commit', '-m', 'first');
    await f.project.workspaces.finish(f.store.task(child.id));
    f.project.finish(child.id, 'completed', 'written');
    const commit = f.store.task(child.id).head_commit;
    fs.writeFileSync(path.join(workspace, 'child.txt'), 'second\n');
    await git(workspace, 'add', 'child.txt'); await git(workspace, 'commit', '-m', 'second');
    f.store.update(say.task.id, { status: 'running' });
    await expect(f.project.integrateChild(say.task.id, child.id, commit)).rejects.toThrow('moved');
    expect(await git(say.task.workspace, 'rev-parse', 'HEAD')).toBe(say.anchor.commit);
    expect(f.store.task(child.id).integration).not.toBe('merged');
  } finally { await f.close(); }
});

test('say.submit is user-only and the legacy input.submit path remains closed', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const dispatcher = new Dispatcher(f.project);
    // Buffered draft submission cannot override the saved body or ownership.
    await expect(dispatcher.dispatch('say.submit', { content: 'x', draft_id: 1 })).rejects.toThrow('cannot be combined');
    await expect(dispatcher.dispatch('input.submit', { content: 'legacy request' })).rejects.toThrow('unknown method');
    const sent = await dispatcher.dispatch('say.submit', { content: 'new request' });
    expect(sent.task.task_kind).toBe('say');
    expect(sent.content).toBe('new request');
    await expect(dispatcher.dispatch('say.submit', { content: 'bad', _token: 'fake' })).rejects.toThrow();
  } finally { await f.close(); }
});

test('say Agent becomes idle after a call, can wake again, and can own another say child without waking main', async () => {
  const f = fixture(); await repo(f.root);
  try {
    const sent = await f.project.say('simple answer');
    await until(() => f.store.task(sent.task.id).status === 'waiting' && f.store.task(sent.task.id).calls === 1);
    expect(f.store.task(sent.task.id).head_commit).toBe(sent.anchor.commit);
    expect(f.store.task(sent.task.id).integration).toBe('none');
    expect(f.store.task(sent.task.parent_id)).toMatchObject({ status: 'waiting', calls: 0 });
    expect(f.store.unread(sent.task.parent_id)).toEqual([]);
    f.project.message(sent.task.id, 'please continue');
    await until(() => f.store.task(sent.task.id).status === 'waiting' && f.store.task(sent.task.id).calls === 2);
    const next = await f.project.say('follow-up on this branch', sent.task.branch);
    expect(next.task.parent_id).toBe(sent.task.id);
    expect(next.task.workspace).not.toBe(sent.task.workspace);
    expect(f.store.get("SELECT count(*) AS n FROM tasks WHERE role='planner'").n).toBe(0);
  } finally { await f.close(); }
});

test('user marks a no-change say resolved: completed + integration none, answer kept, no redundant settlement notice', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const sent = await f.project.say('只是想了解：预约是怎么工作的？');
    f.store.update(sent.task.id, { status: 'waiting', result: '预约是 say 上的一种互斥意图。' });
    const before = f.store.task(sent.task.id);
    const resolved = await new Dispatcher(f.project).dispatch('worker.resolve', { id: sent.task.id });
    expect(resolved).toMatchObject({ status: 'completed', integration: 'none', reservation: null,
      result: '预约是 say 上的一种互斥意图。', branch: before.branch, base_commit: before.base_commit });
    expect(resolved.head_commit).toBe(before.base_commit);
    expect(f.store.all("SELECT id FROM events WHERE task_id=? AND type='task.resolved'", sent.task.id)).toHaveLength(1);
    const notices = f.store.all("SELECT * FROM notices WHERE task_id=? AND kind='info'", sent.task.id);
    // User-created Tasks notify on runtime idle/failure, not on the user's own explicit resolution.
    expect(notices).toHaveLength(0);
    // 终态不能重复结算，也不能再被 message 唤醒。
    await expect(f.project.resolveTask(sent.task.id)).rejects.toThrow('already ended');
  } finally { await f.close(); }
});

test('resolving a say refuses committed work, in-flight delivery, and active invocations; user-only', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const committed = await f.project.say('写点东西');
    f.store.update(committed.task.id, { status: 'waiting' });
    fs.writeFileSync(path.join(committed.task.workspace, 'work.txt'), 'work\n');
    await git(committed.task.workspace, 'add', 'work.txt');
    await git(committed.task.workspace, 'commit', '-m', 'work');
    await expect(f.project.resolveTask(committed.task.id)).rejects.toThrow('已经有提交');
    expect(f.store.task(committed.task.id).status).toBe('waiting');

    // 先建好全部 say，再伪造各态：requested 预约会冻结 main，之后就不能再往 main 发 say。
    const requested = await f.project.say('已经请求合并');
    const shown = await f.project.say('历史交付记录');
    const busy = await f.project.say('正在调用');

    f.store.update(requested.task.id, { status: 'waiting', reservation: JSON.stringify({ version: 1, kind: 'merge',
      status: 'requested', commit: 'a'.repeat(40), baseline: 'b'.repeat(40), parent_id: 1 }) });
    await expect(f.project.resolveTask(requested.task.id)).rejects.toThrow('合并请求');

    f.store.update(shown.task.id, { status: 'waiting', reservation: JSON.stringify({ version: 1, kind: 'showcase',
      status: 'preparing', child_id: 1 }) });
    await expect(f.project.resolveTask(shown.task.id)).rejects.toThrow('reservation state is invalid');

    f.store.update(busy.task.id, { status: 'running' });
    f.project.running.set(busy.task.id, { controller: new AbortController() });
    try { await expect(f.project.resolveTask(busy.task.id)).rejects.toThrow('正在调用'); }
    finally { f.project.running.delete(busy.task.id); }

    expect(() => assertAllowed('worker.resolve', { id: busy.task.id }, busy.task.id)).toThrow('requires user approval');
  } finally { await f.close(); }
});
