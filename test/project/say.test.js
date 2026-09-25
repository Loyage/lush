import { test, expect } from 'bun:test';
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
    expect(await git(response.task.workspace, 'symbolic-ref', '--short', 'HEAD')).toBe(response.task.branch);
    expect(await f.project.workspaces.ensure(response.task)).toBe(response.task.workspace);
    expect(f.store.get("SELECT count(*) AS n FROM tasks WHERE role='planner'").n).toBe(0);
    expect(f.store.get("SELECT count(*) AS n FROM events WHERE type='input.route'").n).toBe(0);
    expect((await f.project.ensureMainTask()).id).toBe(root.id);
    expect(() => f.project.message(root.id, 'run in main')).toThrow('not an unrestricted Agent inbox');
    expect(() => f.project.spawn(root.id, 'write main')).toThrow('not unrestricted spawned work');
    expect(() => f.project.cancel(root.id)).toThrow('permanent root');
    await expect(f.project.say('another', 'feature/missing')).rejects.toThrow('explicitly bound Task');
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
    await expect(f.project.bindBranch('external', commit)).rejects.toThrow('active old task');
    f.store.update(pending.id, { status: 'cancelled' });
    await expect(f.project.say('not yet', 'external')).rejects.toThrow('explicitly bound Task');
    await expect(f.project.bindBranch('external', baseline)).rejects.toThrow('moved');
    const owner = await new Dispatcher(f.project).dispatch('branch.bind', { branch: 'external', commit });
    expect(owner).toMatchObject({ task_kind: 'owner', status: 'waiting', branch: 'external',
      base_commit: commit, parent_id: null, calls: 0 });
    expect(f.store.branch('external').task_id).toBe(old.id);
    expect((await f.project.branchShow('external')).task_id).toBe(owner.id);
    await expect(f.project.bindBranch('external', commit)).rejects.toThrow('already has a new Task owner');
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

test('say delivery reservations are mutually exclusive, durable and cannot be mistaken for authorization', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const say = await f.project.say('build a view');
    const legacy = f.store.create({ role: 'worker', goal: 'legacy' });
    await expect(f.project.reserveTask(legacy.id, 'merge')).rejects.toThrow('only new say');
    await expect(f.project.reserveTask(say.task.id, 'other')).rejects.toThrow('merge or showcase');
    expect(() => assertAllowed('task.reserve', { id: say.task.id, kind: 'merge' }, say.task.id))
      .toThrow('requires user approval');
    const first = await new Dispatcher(f.project).dispatch('task.reserve', { id: say.task.id, kind: 'merge' });
    expect(first).toMatchObject({ task_id: say.task.id, changed: true,
      reservation: { version: 1, kind: 'merge', status: 'pending' } });
    expect(JSON.parse(f.store.task(say.task.id).reservation)).toEqual(first.reservation);
    expect(f.project.inspect(say.task.id).reservation).toEqual(first.reservation);
    expect(f.project.decorate(f.store.summaries('work')).find(task => task.id === say.task.id).reservation).toEqual(first.reservation);
    expect(await f.project.reserveTask(say.task.id, 'merge')).toEqual({ ...first, changed: false });
    await expect(f.project.reserveTask(say.task.id, 'showcase')).rejects.toThrow('unreserve it before choosing');
    expect(f.store.all("SELECT id FROM events WHERE task_id=? AND type='task.reserved'", say.task.id)).toHaveLength(1);
    expect(f.store.task(say.task.id).integration).toBe('none');
    expect(await git(f.root, 'rev-parse', 'main')).toBe(say.anchor.commit);
    expect(f.project.unreserveTask(say.task.id)).toMatchObject({ changed: true, reservation: null });
    expect(f.project.unreserveTask(say.task.id)).toMatchObject({ changed: false, reservation: null });
    expect((await f.project.reserveTask(say.task.id, 'showcase')).reservation.kind).toBe('showcase');
    expect(f.store.all("SELECT id FROM events WHERE task_id=? AND type='task.unreserved'", say.task.id)).toHaveLength(1);
  } finally { await f.close(); }
});

test('merge reservation pins source and parent tips, signals once, then requires matching user approval', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const say = await f.project.say('prepare release');
    const root = f.store.task(say.task.parent_id);
    fs.writeFileSync(path.join(say.task.workspace, 'release.txt'), 'ready\n');
    await git(say.task.workspace, 'add', 'release.txt');
    await git(say.task.workspace, 'commit', '-m', 'release');
    const commit = await git(say.task.workspace, 'rev-parse', 'HEAD');
    const baseline = await git(f.root, 'rev-parse', 'main');
    f.store.update(say.task.id, { status: 'waiting' }); // provider has yielded; no running invocation
    const booked = await new Dispatcher(f.project).dispatch('task.reserve', { id: say.task.id, kind: 'merge' });
    expect(booked.reservation).toMatchObject({ status: 'requested', commit, baseline, parent_id: root.id });
    expect((await f.project.graph()).nodes.find(node => node.kind === 'task' && node.id === say.task.id))
      .toMatchObject({ task_kind: 'say', parent_task_kind: 'main', reservation: { kind: 'merge', status: 'requested', commit, baseline } });
    expect(f.store.task(say.task.id)).toMatchObject({ status: 'completed', head_commit: commit, integration: 'pending' });
    expect(await git(f.root, 'rev-parse', 'main')).toBe(baseline);
    const signals = f.store.all('SELECT * FROM messages WHERE task_id=? AND sender_id=?', root.id, say.task.id);
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ signal_type: 'merge.requested', consumed: 0 });
    expect(JSON.parse(signals[0].body).payload).toEqual({ branch: say.task.branch, commit, baseline });
    // 请求已发出：不能静默撤销（撤销是用户显式动作，另有确认弹窗），必须用同一个固定 commit + baseline 批准。
    expect(f.store.all("SELECT id FROM events WHERE task_id=? AND type='task.request_withdrawn'", say.task.id)).toHaveLength(0);
    expect(f.project.branchFreeze('main')).toMatchObject({ kind: 'delivery', task_id: say.task.id, commit });
    await expect(f.project.approveReservedMerge(say.task.id, baseline, baseline)).rejects.toThrow('does not match');
    await expect(f.project.approveReservedMerge(say.task.id, commit, commit)).rejects.toThrow('does not match');
    expect(await git(f.root, 'rev-parse', 'main')).toBe(baseline);
    expect(() => assertAllowed('task.approve_merge', { id: say.task.id, commit, baseline }, say.task.id))
      .toThrow('requires user approval');
    const approved = await new Dispatcher(f.project).dispatch('task.approve_merge', { id: say.task.id, commit, baseline });
    expect(approved.task.integration).toBe('merged');
    expect(JSON.parse(approved.task.reservation).status).toBe('integrated');
    expect(await git(f.root, 'rev-parse', 'main')).toBe(commit);
    expect((await f.project.approveReservedMerge(say.task.id, commit, baseline)).already_integrated).toBe(true);
    expect(f.project.branchFreeze('main')).toBeNull();
    expect(f.store.all("SELECT id FROM events WHERE task_id=? AND type='task.merge_requested'", say.task.id)).toHaveLength(1);
    expect(f.store.all('SELECT id FROM messages WHERE task_id=? AND sender_id=?', root.id, say.task.id)).toHaveLength(1);
  } finally { await f.close(); }
});

test('an outstanding request freezes its parent branch: one request at a time, only the holder can land', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const parent = await f.project.say('parent');
    const plan = f.project.spawn(parent.task.id, 'plain child work', 'agent', [], 'plain');
    const first = await f.project.say('first delivery', parent.task.branch);
    const second = await f.project.say('second delivery', parent.task.branch);
    for (const task of [plan, first.task, second.task]) {
      const cwd = await f.project.workspaces.ensure(task);
      fs.writeFileSync(path.join(cwd, `${task.id}.txt`), 'work\n');
      await git(cwd, 'add', '.'); await git(cwd, 'commit', '-m', `task ${task.id}`);
      await f.project.workspaces.finish(f.store.task(task.id));
    }
    f.project.finish(plan.id, 'completed', 'plain done'); // child Task: no reservation, delivered by parent confirmation
    f.store.run('UPDATE messages SET consumed=1 WHERE task_id=?', parent.task.id);
    for (const task of [first.task, second.task]) f.store.update(task.id, { status: 'waiting' });
    const firstCommit = f.store.task(first.task.id).head_commit;
    expect((await f.project.reserveTask(first.task.id, 'merge')).reservation.status).toBe('requested');
    expect(f.project.branchFreeze(parent.task.branch)).toMatchObject({ kind: 'delivery', task_id: first.task.id, commit: firstCommit });
    // 同一个父分支不能再接受第二个未集成的请求；它保持 pending 并说清原因。
    const blocked = await f.project.reserveTask(second.task.id, 'merge');
    expect(blocked.reservation).toMatchObject({ status: 'pending', blocked_code: 'parent_locked' });
    expect(blocked.reservation.blocked_reason).toContain('已被');
    expect(f.store.unread(parent.task.id).filter(row => row.signal_type === 'merge.requested')).toHaveLength(1);
    // 交付锁期间父分支不接受其它写：新 say 与其它子任务集成都被拒，只有持有锁的请求能落地。
    await expect(f.project.say('another', parent.task.branch)).rejects.toThrow('frozen');
    // 源分支也不能被归档：它是那次未集成交付本身，删了父分支的锁就永远没有落地对象。
    await expect(f.project.archiveBranch(first.task.branch)).rejects.toThrow('outstanding merge request');
    f.store.update(parent.task.id, { status: 'running' });
    await expect(f.project.integrateChild(parent.task.id, plan.id, f.store.task(plan.id).head_commit))
      .rejects.toThrow('frozen');
    const landed = await f.project.integrateChild(parent.task.id, first.task.id, firstCommit);
    expect(landed.child.integration).toBe('merged');
    expect(await git(f.root, 'rev-parse', parent.task.branch)).toBe(firstCommit);
    // 请求集成后锁就解除；兄弟的基点早于这次落地，所以按已有源侧解分歧路径报“分歧”。
    expect(f.project.branchFreeze(parent.task.branch)).toBeNull();
    f.store.update(second.task.id, { status: 'waiting' });
    f.store.run('UPDATE messages SET consumed=1 WHERE task_id=?', second.task.id);
    const diverged = await f.project.reserveTask(second.task.id, 'merge');
    expect(diverged.reservation).toMatchObject({ status: 'pending', blocked_code: 'diverged' });
  } finally { await f.close(); }
});

test('a request invalidated by the parent’s own commits is diagnosed, and withdrawal releases the lock', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const parent = await f.project.say('parent keeps working');
    const child = await f.project.say('child delivery', parent.task.branch);
    const cwd = await f.project.workspaces.ensure(child.task);
    fs.writeFileSync(path.join(cwd, 'child.txt'), 'work\n');
    await git(cwd, 'add', '.'); await git(cwd, 'commit', '-m', 'child');
    await f.project.workspaces.finish(f.store.task(child.task.id));
    f.store.update(child.task.id, { status: 'waiting' });
    const commit = f.store.task(child.task.id).head_commit;
    expect((await f.project.reserveTask(child.task.id, 'merge')).reservation.status).toBe('requested');
    const baseline = JSON.parse(f.store.task(child.task.id).reservation).baseline;
    // 父分支自己的 say Agent 提交了（daemon 阻止不了），请求因此已经不能快进。
    fs.writeFileSync(path.join(parent.task.workspace, 'later.txt'), 'later\n');
    await git(parent.task.workspace, 'add', '.'); await git(parent.task.workspace, 'commit', '-m', 'parent moved');
    await f.project.workspaces.finish(f.store.task(parent.task.id));
    expect(await f.project.noteBranchAdvance(parent.task.id)).toBe(child.task.id);
    const diagnosis = JSON.parse(f.store.task(child.task.id).reservation);
    expect(diagnosis).toMatchObject({ status: 'requested', blocked_code: 'parent_moved' });
    expect(diagnosis.blocked_reason).toContain('撤销这个请求');
    f.store.update(parent.task.id, { status: 'running' });
    await expect(f.project.integrateChild(parent.task.id, child.task.id, commit)).rejects.toThrow('fast-forward');
    expect(await f.project.noteBranchAdvance(parent.task.id)).toBe(child.task.id); // 仍处于失效状态，但不再重写事件
    expect(f.store.all("SELECT id FROM events WHERE task_id=? AND type='task.reservation_blocked'", child.task.id)).toHaveLength(1);
    // 用户显式撤销：锁解除，任务、分支与提交都保留。
    const withdrawn = f.project.unreserveTask(child.task.id);
    expect(withdrawn.withdrawn).toMatchObject({ commit, baseline });
    expect(f.project.branchFreeze(parent.task.branch)).toBeNull();
    expect(f.store.all("SELECT id FROM events WHERE task_id=? AND type='task.request_withdrawn'", child.task.id)).toHaveLength(1);
    expect(f.store.task(child.task.id)).toMatchObject({ status: 'completed', head_commit: commit, integration: 'pending', reservation: null });
    expect(await git(f.root, 'rev-parse', child.task.branch)).toBe(commit);
    expect(await f.project.noteBranchAdvance(parent.task.id)).toBeNull();
  } finally { await f.close(); }
});

test('a request whose commit is already contained in the parent closes idempotently without the old baseline', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const say = await f.project.say('close by containment');
    fs.writeFileSync(path.join(say.task.workspace, 'work.txt'), 'work\n');
    await git(say.task.workspace, 'add', '.'); await git(say.task.workspace, 'commit', '-m', 'work');
    f.store.update(say.task.id, { status: 'waiting' });
    const { reservation } = await f.project.reserveTask(say.task.id, 'merge');
    expect(reservation.status).toBe('requested');
    // 用户 / 外部进程把这次固定提交直接合进了 main：main 前进了，但已包含固定提交。
    await git(f.root, 'merge', '--no-ff', '--no-edit', reservation.commit);
    const movedTo = await git(f.root, 'rev-parse', 'main');
    const closed = await f.project.approveReservedMerge(say.task.id, reservation.commit, reservation.baseline);
    expect(closed.merge.already_integrated).toBe(true);
    expect(await git(f.root, 'rev-parse', 'main')).toBe(movedTo);
    expect(JSON.parse(f.store.task(say.task.id).reservation)).toMatchObject({ status: 'integrated' });
    expect(f.store.task(say.task.id).integration).toBe('merged');
    expect(f.project.branchFreeze('main')).toBeNull();
  } finally { await f.close(); }
});

test('a diverged completed child is absorbed by a repair child the parent Agent starts, and lands only with both tips', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const parent = await f.project.say('parent with two children');
    const first = f.project.spawn(parent.task.id, 'first child', 'agent', [], 'first');
    const second = f.project.spawn(parent.task.id, 'second child', 'agent', [], 'second');
    for (const child of [first, second]) {
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
    expect(() => assertAllowed('task.resolve_child_divergence', { id: second.id }, null)).toThrow('agent only');
    await expect(f.project.resolveChildDivergence(parent.task.parent_id, second.id)).rejects.toThrow('only a new Task agent');
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
    f.project.finish(repair.id, 'completed', 'both commits tested');
    f.store.run('UPDATE messages SET consumed=1 WHERE task_id=?', parent.task.id);
    f.store.update(parent.task.id, { status: 'running' });
    const landed = await f.project.integrateChild(parent.task.id, repair.id, resolved);
    expect(landed.child.integration).toBe('merged');
    expect(await git(f.root, 'rev-parse', parent.task.branch)).toBe(resolved);
    // 被修复的子任务一并结算，且两个固定提交都在父分支里。
    expect(f.store.task(second.id)).toMatchObject({ status: 'completed', integration: 'merged', head_commit: secondCommit });
    expect(f.store.all("SELECT id FROM events WHERE task_id=? AND type='child.integrated_via_resolution'", second.id)).toHaveLength(1);
    expect(await f.project.workspaces.isAncestor(f.root, secondCommit, resolved)).toBe(true);
    expect(await f.project.workspaces.isAncestor(f.root, firstCommit, resolved)).toBe(true);
    f.store.run('UPDATE messages SET consumed=1 WHERE task_id=?', parent.task.id);
    f.store.update(parent.task.id, { status: 'waiting' });
    await f.project.reserveTask(parent.task.id, 'merge');
    expect(JSON.parse(f.store.task(parent.task.id).reservation).status).toBe('requested');
  } finally { await f.close(); }
});

test('repair refuses a diverged child of a locked parent and a child whose branch did not diverge', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const parent = await f.project.say('parent');
    const child = f.project.spawn(parent.task.id, 'child', 'agent', [], 'child');
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
    await git(parent.task.workspace, 'commit', '--allow-empty', '-m', 'parent moved');
    f.store.update(parent.task.id, { status: 'running' });
    await expect(f.project.resolveChildDivergence(parent.task.id, child.id)).rejects.toThrow('frozen');
    expect(f.store.children(parent.task.id)).toHaveLength(2);
  } finally { await f.close(); }
});

test('a restart re-diagnoses already-requested merges against the current Git facts', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const say = await f.project.say('request then drift');
    fs.writeFileSync(path.join(say.task.workspace, 'work.txt'), 'work\n');
    await git(say.task.workspace, 'add', '.'); await git(say.task.workspace, 'commit', '-m', 'work');
    f.store.update(say.task.id, { status: 'waiting' });
    const { reservation } = await f.project.reserveTask(say.task.id, 'merge');
    expect(reservation.status).toBe('requested');
    f.store.update(say.task.id, { status: 'completed' });
    // 请求发出后 main 被外部推进（daemon 不在场）：重启后的复查要如实写成 parent_moved。
    await git(f.root, 'commit', '--allow-empty', '-m', 'moved while down');
    expect(await f.project.recheckRequestedMerge(say.task.id)).toBe('parent_moved');
    expect(JSON.parse(f.store.task(say.task.id).reservation)).toMatchObject({ status: 'requested', blocked_code: 'parent_moved' });
    // 固定提交已经进了父分支：诊断为可幂等关闭，而不是“不能落地”。
    await git(f.root, 'merge', '--no-ff', '--no-edit', reservation.commit);
    expect(await f.project.recheckRequestedMerge(say.task.id)).toBe('contained');
    expect(JSON.parse(f.store.task(say.task.id).reservation).blocked_code).toBe('contained');
    await f.project.approveReservedMerge(say.task.id, reservation.commit, reservation.baseline);
    expect(JSON.parse(f.store.task(say.task.id).reservation)).toMatchObject({ status: 'integrated' });
    expect(JSON.parse(f.store.task(say.task.id).reservation).blocked_code).toBeUndefined();
    const diagnoses = f.store.all("SELECT data FROM events WHERE task_id=? AND type='task.reservation_blocked' ORDER BY id", say.task.id)
      .map(row => JSON.parse(row.data).code);
    expect(diagnoses).toEqual(['parent_moved', 'contained']);
    // 源分支自己被动过：请求同样失效，不再假装还在等集成。
    const other = await f.project.say('source moved');
    await git(other.task.workspace, 'commit', '--allow-empty', '-m', 'source');
    f.store.update(other.task.id, { status: 'waiting' });
    const second = await f.project.reserveTask(other.task.id, 'merge');
    expect(second.reservation.status).toBe('requested');
    f.store.update(other.task.id, { status: 'completed' });
    await git(other.task.workspace, 'commit', '--allow-empty', '-m', 'someone else moved it');
    expect(await f.project.recheckRequestedMerge(other.task.id)).toBe('source_moved');
    expect(JSON.parse(f.store.task(other.task.id).reservation).blocked_code).toBe('source_moved');
    // 失效的请求仍然锁着 main：先显式撤销（这也是唯一退路）才能在 main 上派新的 say。
    await expect(f.project.say('still landable')).rejects.toThrow('frozen');
    expect(f.project.unreserveTask(other.task.id).withdrawn.commit).toBe(second.reservation.commit);
    expect(f.project.branchFreeze('main')).toBeNull();
    // 仍然可以快进的请求：复查会把过期诊断清掉，而不是留着旧原因。
    const healthy = await f.project.say('still landable');
    await git(healthy.task.workspace, 'commit', '--allow-empty', '-m', 'healthy');
    f.store.update(healthy.task.id, { status: 'waiting' });
    const third = await f.project.reserveTask(healthy.task.id, 'merge');
    expect(third.reservation.status).toBe('requested');
    f.store.update(healthy.task.id, { status: 'completed' });
    f.store.run('UPDATE tasks SET reservation=? WHERE id=?', JSON.stringify({ version: 1, kind: 'merge', status: 'requested',
      commit: third.reservation.commit, baseline: third.reservation.baseline, parent_id: healthy.task.parent_id,
      blocked_reason: 'stale reason', blocked_code: 'parent_moved' }), healthy.task.id);
    expect(await f.project.recheckRequestedMerge(healthy.task.id)).toBe('landable');
    const cleaned = JSON.parse(f.store.task(healthy.task.id).reservation);
    expect(cleaned.blocked_reason).toBeUndefined();
    expect(cleaned.blocked_code).toBeUndefined();
    expect(f.store.all("SELECT id FROM events WHERE task_id=? AND type='task.reservation_rechecked'", healthy.task.id)).toHaveLength(1);
  } finally { await f.close(); }
});

test('approval refuses a dirty parent and reconciles a Git-success/DB-interruption without a second write', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const say = await f.project.say('safe merge');
    fs.writeFileSync(path.join(say.task.workspace, 'safe.txt'), 'ready\n');
    await git(say.task.workspace, 'add', 'safe.txt'); await git(say.task.workspace, 'commit', '-m', 'safe');
    f.store.update(say.task.id, { status: 'waiting' });
    const { reservation } = await f.project.reserveTask(say.task.id, 'merge');
    const scratch = path.join(f.root, 'untracked.tmp');
    fs.writeFileSync(scratch, 'do not overwrite');
    await expect(f.project.approveReservedMerge(say.task.id, reservation.commit, reservation.baseline))
      .rejects.toThrow();
    expect(fs.readFileSync(scratch, 'utf8')).toBe('do not overwrite');
    expect(await git(f.root, 'rev-parse', 'main')).toBe(reservation.baseline);
    fs.unlinkSync(scratch); // only our temporary test project file
    const original = f.store.update.bind(f.store);
    let interrupted = true;
    f.store.update = (taskId, patch) => {
      if (taskId === say.task.id && patch.integration === 'merged' && interrupted) {
        interrupted = false; throw new Error('simulated database interruption');
      }
      return original(taskId, patch);
    };
    await expect(f.project.approveReservedMerge(say.task.id, reservation.commit, reservation.baseline))
      .rejects.toThrow('simulated database interruption');
    f.store.update = original;
    expect(await git(f.root, 'rev-parse', 'main')).toBe(reservation.commit);
    expect(JSON.parse(f.store.task(say.task.id).reservation).status).toBe('requested');
    expect((await f.project.approveReservedMerge(say.task.id, reservation.commit, reservation.baseline)).merge.already_integrated).toBe(true);
    expect(JSON.parse(f.store.task(say.task.id).reservation).status).toBe('integrated');
  } finally { await f.close(); }
});

test('pending merge is diagnosable and replayed after recovery only from a clean committed idle branch', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const say = await f.project.say('commit later');
    f.store.update(say.task.id, { status: 'waiting' });
    const initial = await f.project.reserveTask(say.task.id, 'merge');
    expect(initial.reservation).toMatchObject({ status: 'pending', blocked_reason: 'no committed source changes yet' });
    fs.writeFileSync(path.join(say.task.workspace, 'later.txt'), 'uncommitted\n');
    f.project.recover();
    await until(() => JSON.parse(f.store.task(say.task.id).reservation).blocked_reason !== initial.reservation.blocked_reason);
    expect(f.store.task(say.task.id).status).toBe('waiting');
    expect(f.store.unread(say.task.parent_id)).toHaveLength(0);
    await git(say.task.workspace, 'add', 'later.txt'); await git(say.task.workspace, 'commit', '-m', 'ready');
    f.project.recover();
    await until(() => JSON.parse(f.store.task(say.task.id).reservation).status === 'requested');
    expect(f.store.task(say.task.id).status).toBe('completed');
    expect(f.store.unread(say.task.parent_id)).toHaveLength(1);
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

test('a diverged pending say starts one source-side child; only its running parent can integrate both frozen tips', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const say = await f.project.say('deliver despite a moving parent');
    fs.writeFileSync(path.join(say.task.workspace, 'mine.txt'), 'from say\n');
    await git(say.task.workspace, 'add', 'mine.txt'); await git(say.task.workspace, 'commit', '-m', 'mine');
    const sourceCommit = await git(say.task.workspace, 'rev-parse', 'HEAD');
    await git(f.root, 'commit', '--allow-empty', '-m', 'parent changed');
    const parentCommit = await git(f.root, 'rev-parse', 'main');
    f.store.update(say.task.id, { status: 'waiting' });
    const blocked = await f.project.reserveTask(say.task.id, 'merge');
    expect(blocked.reservation).toMatchObject({ status: 'pending', blocked_code: 'diverged' });
    expect(await git(f.root, 'rev-parse', 'main')).toBe(parentCommit);
    f.project.stopping = false; f.project.kick = () => {}; // deterministic mock: manual child invocation only
    const dispatcher = new Dispatcher(f.project);
    const started = await dispatcher.dispatch('task.resolve_divergence', { id: say.task.id });
    expect(started.status).toBe('queued');
    const child = f.store.task(started.task.id);
    expect(child).toMatchObject({ parent_id: say.task.id, task_kind: 'child', role: 'agent',
      base_commit: sourceCommit, target_branch: say.task.branch });
    const repeated = await f.project.resolveSayDivergence(say.task.id);
    expect(repeated).toMatchObject({ status: 'existing', task: { id: child.id } });
    expect(f.store.children(say.task.id)).toHaveLength(1);
    expect(() => assertAllowed('task.resolve_divergence', { id: say.task.id }, say.task.id)).toThrow('requires user approval');
    expect(() => assertAllowed('task.integrate', { id: child.id, commit: sourceCommit }, null)).toThrow('agent only');
    expect(JSON.parse(f.store.task(say.task.id).reservation).resolution_child_id).toBe(child.id);
    const cwd = await f.project.workspaces.ensure(child);
    expect(await git(cwd, 'rev-parse', 'HEAD')).toBe(sourceCommit);
    await git(cwd, 'merge', '--no-ff', '--no-edit', parentCommit);
    await f.project.workspaces.finish(f.store.task(child.id));
    const resolvedCommit = f.store.task(child.id).head_commit;
    f.project.finish(child.id, 'completed', 'both commits tested');
    f.store.update(say.task.id, { status: 'running' });
    const integrated = await f.project.integrateChild(say.task.id, child.id, resolvedCommit);
    expect(integrated.child.integration).toBe('merged');
    expect(await git(say.task.workspace, 'rev-parse', 'HEAD')).toBe(resolvedCommit);
    expect(await git(f.root, 'rev-parse', 'main')).toBe(parentCommit);
    f.store.run('UPDATE messages SET consumed=1 WHERE task_id=?', say.task.id); // mock the parent invocation consuming the child signal
    f.store.update(say.task.id, { status: 'waiting' });
    const ready = await f.project.reserveTask(say.task.id, 'merge');
    expect(ready.reservation).toMatchObject({ status: 'requested', commit: resolvedCommit, baseline: parentCommit });
    expect(await git(f.root, 'rev-parse', 'main')).toBe(parentCommit);
    await f.project.approveReservedMerge(say.task.id, ready.reservation.commit, ready.reservation.baseline);
    expect(await git(f.root, 'rev-parse', 'main')).toBe(resolvedCommit);
  } finally { await f.close(); }
});

test('source-side resolution refuses unbooked, non-diverged and dirty say branches without creating children', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const say = await f.project.say('resolve only real divergence');
    f.store.update(say.task.id, { status: 'waiting' });
    await expect(f.project.resolveSayDivergence(say.task.id)).rejects.toThrow('pending say merge reservation');
    await f.project.reserveTask(say.task.id, 'merge');
    await expect(f.project.resolveSayDivergence(say.task.id)).rejects.toThrow('only applies to a diverged branch');
    await git(say.task.workspace, 'commit', '--allow-empty', '-m', 'source');
    await git(f.root, 'commit', '--allow-empty', '-m', 'parent');
    const scratch = path.join(say.task.workspace, 'uncommitted.txt');
    fs.writeFileSync(scratch, 'preserve user changes');
    await expect(f.project.resolveSayDivergence(say.task.id)).rejects.toThrow();
    expect(fs.readFileSync(scratch, 'utf8')).toBe('preserve user changes');
    expect(f.store.children(say.task.id)).toHaveLength(0);
  } finally { await f.close(); }
});

test('an invalid completed resolution keeps its branch until explicit archive, then creates a fresh child', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const say = await f.project.say('diverged source');
    await git(say.task.workspace, 'commit', '--allow-empty', '-m', 'source');
    const source = await git(say.task.workspace, 'rev-parse', 'HEAD');
    await git(f.root, 'commit', '--allow-empty', '-m', 'parent');
    const parent = await git(f.root, 'rev-parse', 'main');
    f.store.update(say.task.id, { status: 'waiting' });
    await f.project.reserveTask(say.task.id, 'merge');
    f.project.stopping = false; f.project.kick = () => {};
    const { task: child } = await f.project.resolveSayDivergence(say.task.id);
    const cwd = await f.project.workspaces.ensure(child);
    await git(cwd, 'commit', '--allow-empty', '-m', 'did not merge parent');
    await f.project.workspaces.finish(f.store.task(child.id));
    f.project.finish(child.id, 'completed', 'incomplete');
    f.store.update(say.task.id, { status: 'running' });
    await expect(f.project.integrateChild(say.task.id, child.id, f.store.task(child.id).head_commit))
      .rejects.toThrow('both frozen source and parent commits');
    const held = await f.project.resolveSayDivergence(say.task.id);
    expect(held.status).toBe('needs_review');
    expect(held.task.id).toBe(child.id);
    expect(held.reason).toContain('显式归档');
    expect(f.store.children(say.task.id)).toHaveLength(1);
    f.store.update(say.task.id, { status: 'waiting' });
    f.store.run('UPDATE messages SET consumed=1 WHERE task_id=?', say.task.id);
    await expect(f.project.resolveSayDivergence(say.task.id)).resolves.toMatchObject({ status: 'needs_review' });
    const oldBranch = f.store.task(child.id).branch;
    const archived = await f.project.archiveBranch(oldBranch);
    expect(archived.archived).toBe(true);
    expect(f.store.branch(oldBranch).status).toBe('archived');
    expect(f.store.task(child.id).status).toBe('completed');
    expect(f.store.task(child.id).workspace).toBeNull();
    expect(f.project.inspect(child.id).divergence_resolution).toMatchObject({
      source_commit: source, parent_commit: parent, branch_status: 'archived' });
    expect(f.store.all("SELECT * FROM events WHERE task_id=? AND type='task.divergence_resolution_requested'", child.id)).toHaveLength(1);
    const next = await f.project.resolveSayDivergence(say.task.id);
    expect(next.status).toBe('queued');
    expect(next.task.id).not.toBe(child.id);
    expect(f.store.task(next.task.id)).toMatchObject({ parent_id: say.task.id, base_commit: source,
      target_branch: say.task.branch });
    expect(f.store.children(say.task.id)).toHaveLength(2);
    expect(await git(say.task.workspace, 'rev-parse', 'HEAD')).toBe(source);
    expect(await git(f.root, 'rev-parse', 'main')).toBe(parent);
  } finally { await f.close(); }
});

test('a failed dirty resolution requires explicit discard during archive; failure is not replayed', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const say = await f.project.say('preserve failed conflict work');
    await git(say.task.workspace, 'commit', '--allow-empty', '-m', 'source');
    const source = await git(say.task.workspace, 'rev-parse', 'HEAD');
    await git(f.root, 'commit', '--allow-empty', '-m', 'parent');
    const parent = await git(f.root, 'rev-parse', 'main');
    f.store.update(say.task.id, { status: 'waiting' });
    await f.project.reserveTask(say.task.id, 'merge');
    f.project.stopping = false; f.project.kick = () => {};
    const { task: child } = await f.project.resolveSayDivergence(say.task.id);
    const cwd = await f.project.workspaces.ensure(child);
    const scratch = path.join(cwd, 'uncommitted.txt');
    fs.writeFileSync(scratch, 'valuable conflict work');
    f.project.finish(child.id, 'failed', null, 'agent stopped during conflict');
    expect(() => f.project.retry(child.id)).toThrow('不重放未知文件副作用');
    f.store.run('UPDATE messages SET consumed=1 WHERE task_id=?', say.task.id);
    f.store.update(say.task.id, { status: 'waiting' });
    const blocked = await f.project.resolveSayDivergence(say.task.id);
    expect(blocked).toMatchObject({ status: 'needs_review', task: { id: child.id } });
    expect(fs.readFileSync(scratch, 'utf8')).toBe('valuable conflict work');
    await expect(f.project.archiveBranch(f.store.task(child.id).branch)).rejects.toThrow('archive keeps');
    expect(fs.readFileSync(scratch, 'utf8')).toBe('valuable conflict work');
    expect(f.store.children(say.task.id)).toHaveLength(1);
    const archived = await f.project.archiveBranch(f.store.task(child.id).branch, { discard_worktree: true });
    expect(archived.discarded).toBe(true);
    expect(f.store.task(child.id).error).toBe('agent stopped during conflict');
    const next = await f.project.resolveSayDivergence(say.task.id);
    expect(next).toMatchObject({ status: 'queued', source_commit: source, parent_commit: parent });
    expect(next.task.id).not.toBe(child.id);
    expect(await git(f.root, 'rev-parse', say.task.branch)).toBe(source);
    expect(await git(f.root, 'rev-parse', 'main')).toBe(parent);
  } finally { await f.close(); }
});

test('a resolution child cancelled before its branch exists can be replaced without archiving any work', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const say = await f.project.say('cancel before checkout');
    await git(say.task.workspace, 'commit', '--allow-empty', '-m', 'source');
    await git(f.root, 'commit', '--allow-empty', '-m', 'parent');
    f.store.update(say.task.id, { status: 'waiting' });
    await f.project.reserveTask(say.task.id, 'merge');
    f.project.stopping = false; f.project.kick = () => {};
    const { task: first } = await f.project.resolveSayDivergence(say.task.id);
    expect(f.store.task(first.id).branch).toBeNull();
    f.project.cancel(first.id);
    expect(() => f.project.retry(first.id)).toThrow('不重放未知文件副作用');
    f.store.run('UPDATE messages SET consumed=1 WHERE task_id=?', say.task.id);
    f.store.update(say.task.id, { status: 'waiting' });
    const next = await f.project.resolveSayDivergence(say.task.id);
    expect(next.status).toBe('queued');
    expect(next.task.id).not.toBe(first.id);
    expect(f.store.children(say.task.id)).toHaveLength(2);
  } finally { await f.close(); }
});

test('an early merge reservation requests delivery only after the say invocation safely yields', async () => {
  const proceed = gate();
  const f = fixture({ run: async ({ cwd }) => {
    await proceed.promise;
    fs.writeFileSync(path.join(cwd, 'auto.txt'), 'committed\n');
    await git(cwd, 'add', 'auto.txt'); await git(cwd, 'commit', '-m', 'auto');
    return 'done';
  } });
  await repo(f.root);
  try {
    const say = await f.project.say('commit after booking');
    const booked = await f.project.reserveTask(say.task.id, 'merge');
    expect(booked.reservation.status).toBe('pending');
    expect(f.store.task(say.task.id).status).not.toBe('completed');
    proceed.resolve();
    await until(() => JSON.parse(f.store.task(say.task.id).reservation).status === 'requested');
    expect(f.store.task(say.task.id).status).toBe('completed');
    expect(f.store.unread(say.task.parent_id)).toHaveLength(1);
    expect(await git(f.root, 'rev-parse', 'main')).toBe(say.anchor.commit);
  } finally { proceed.resolve(); await f.close(); }
});

test('a requested say child can only be integrated by its direct running parent Agent', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const parent = await f.project.say('parent');
    const child = await f.project.say('child', parent.task.branch);
    fs.writeFileSync(path.join(child.task.workspace, 'child.txt'), 'ready\n');
    await git(child.task.workspace, 'add', 'child.txt'); await git(child.task.workspace, 'commit', '-m', 'child');
    f.store.update(child.task.id, { status: 'waiting' });
    const { reservation } = await f.project.reserveTask(child.task.id, 'merge');
    expect(reservation.status).toBe('requested');
    expect(f.store.unread(parent.task.id)).toHaveLength(1);
    const before = await git(f.root, 'rev-parse', parent.task.branch);
    await expect(f.project.integrateChild(parent.task.id, child.task.id, reservation.commit)).rejects.toThrow('must be running');
    expect(await git(f.root, 'rev-parse', parent.task.branch)).toBe(before);
    f.store.update(parent.task.id, { status: 'running' });
    await expect(f.project.integrateChild(parent.task.parent_id, child.task.id, reservation.commit)).rejects.toThrow('only a direct child');
    const result = await f.project.integrateChild(parent.task.id, child.task.id, reservation.commit);
    expect(result.child.integration).toBe('merged');
    expect(JSON.parse(result.child.reservation).status).toBe('integrated');
    expect(await git(f.root, 'rev-parse', parent.task.branch)).toBe(reservation.commit);
    expect(await git(f.root, 'rev-parse', 'main')).toBe(before);
  } finally { await f.close(); }
});

test('showcase booking creates a detached child and finishes the say only after the report is delivered', async () => {
  const show = gate();
  const f = fixture({ run: async ({ task, cwd, context }) => {
    if (task.role === 'showcase') {
      await show.promise;
      fs.writeFileSync(context.showcase.report_path, '<!doctype html><h1>Ready</h1>');
      return 'preview ready';
    }
    fs.writeFileSync(path.join(cwd, 'screen.txt'), 'ready\n');
    await git(cwd, 'add', 'screen.txt'); await git(cwd, 'commit', '-m', 'screen');
    return 'screen built';
  } });
  await repo(f.root);
  try {
    const say = await f.project.say('show new screen');
    const baseline = await git(f.root, 'rev-parse', 'main');
    const booked = await f.project.reserveTask(say.task.id, 'showcase');
    expect(['pending','started']).toContain(booked.reservation.status);
    await until(() => JSON.parse(f.store.task(say.task.id).reservation).status === 'started');
    const current = f.store.task(say.task.id), reservation = JSON.parse(current.reservation);
    const child = f.store.task(reservation.child_id);
    expect(child).toMatchObject({ parent_id: say.task.id, role: 'showcase', task_kind: 'showcase' });
    expect(current.status).toBe('waiting');
    expect(f.store.activeTasks().some(row => row.id === child.id)).toBe(true);
    expect(JSON.parse(child.showcase)).toMatchObject({ commit: reservation.commit, baseline_commit: reservation.baseline });
    expect(() => f.project.message(say.task.id, 'interrupt the presentation')).toThrow('presenting');
    await expect(f.project.say('too late', say.task.branch)).rejects.toThrow('presenting');
    expect(await git(f.root, 'rev-parse', 'main')).toBe(baseline);
    show.resolve();
    await until(() => f.store.task(say.task.id).status === 'completed');
    expect(f.store.task(child.id).status).toBe('completed');
    expect(f.project.inspect(child.id).report).toContain(`showcase/${child.id}/report.html`);
    expect(JSON.parse(f.store.task(say.task.id).reservation).status).toBe('completed');
    expect(f.store.task(say.task.id).integration).toBe('pending');
    expect(f.store.unread(say.task.id)).toMatchObject([{ signal_type: 'showcase.completed', sender_id: child.id }]);
    expect(f.store.unread(say.task.parent_id)).toHaveLength(0);
    expect(await git(f.root, 'rev-parse', 'main')).toBe(baseline);
  } finally { show.resolve(); await f.close(); }
});

test('showcase booking remains pending with a visible reason until code and clean worktree are ready', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const say = await f.project.say('present later');
    f.store.update(say.task.id, { status: 'waiting' });
    f.project.stopping = false; f.project.kick = () => {}; // admit showcase, but do not start a mock invocation
    const first = await f.project.reserveTask(say.task.id, 'showcase');
    expect(first.reservation).toMatchObject({ status: 'pending' });
    expect(first.reservation.blocked_reason).toContain('没有实际文件改动');
    expect(f.store.children(say.task.id)).toHaveLength(0);
    fs.writeFileSync(path.join(say.task.workspace, 'ready.txt'), 'ready\n');
    await git(say.task.workspace, 'add', 'ready.txt'); await git(say.task.workspace, 'commit', '-m', 'ready');
    const scratch = path.join(say.task.workspace, 'uncommitted.tmp');
    fs.writeFileSync(scratch, 'user changes');
    await f.project.startReservedShowcase(say.task.id);
    expect(JSON.parse(f.store.task(say.task.id).reservation).blocked_reason).toContain('未提交修改');
    expect(f.store.children(say.task.id)).toHaveLength(0);
    fs.unlinkSync(scratch); // only our temporary test project file
    f.project.recover();
    await until(() => JSON.parse(f.store.task(say.task.id).reservation).status === 'started');
    expect(f.store.children(say.task.id)).toHaveLength(1);
    expect(f.store.task(say.task.id).status).toBe('waiting');
  } finally { await f.close(); }
});

test('pending showcase rechecks only after safe admission and never duplicates a child', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const say = await f.project.say('present once');
    f.store.update(say.task.id, { status: 'waiting' });
    f.project.stopping = false; f.project.kick = () => {};
    const blocked = await f.project.reserveTask(say.task.id, 'showcase');
    expect(blocked.reservation.blocked_reason).toContain('没有实际文件改动');
    fs.writeFileSync(path.join(say.task.workspace, 'view.txt'), 'new view\n');
    await git(say.task.workspace, 'add', 'view.txt'); await git(say.task.workspace, 'commit', '-m', 'view');
    const retried = await f.project.reserveTask(say.task.id, 'showcase');
    expect(retried.changed).toBe(false);
    expect(retried.reservation).toMatchObject({ kind: 'showcase', status: 'started' });
    expect(retried.reservation.blocked_reason).toBeUndefined();
    expect(f.store.children(say.task.id)).toHaveLength(1);
    f.project.recover();
    expect(f.store.children(say.task.id)).toHaveLength(1);
  } finally { await f.close(); }
});

test('a failed showcase leaves the say and its worktree as visible failed delivery, without merging', async () => {
  const f = fixture({ run: async ({ task, cwd }) => {
    if (task.role === 'showcase') return 'no HTML delivered';
    fs.writeFileSync(path.join(cwd, 'change.txt'), 'change\n');
    await git(cwd, 'add', 'change.txt'); await git(cwd, 'commit', '-m', 'change');
    return 'built';
  } });
  await repo(f.root);
  try {
    const say = await f.project.say('show change');
    const baseline = await git(f.root, 'rev-parse', 'main');
    await f.project.reserveTask(say.task.id, 'showcase');
    await until(() => f.store.task(say.task.id).status === 'failed');
    const parent = f.store.task(say.task.id), reservation = JSON.parse(parent.reservation);
    const child = f.store.task(reservation.child_id);
    expect(reservation.status).toBe('failed');
    expect(child.status).toBe('failed');
    expect(parent.error).toContain('report.html');
    expect(fs.existsSync(say.task.workspace)).toBe(true);
    expect(await git(f.root, 'rev-parse', 'main')).toBe(baseline);
    await expect(f.project.retry(child.id)).rejects.toThrow('cannot be retried under its ended parent');
    expect(() => f.project.retry(say.task.id)).toThrow('cannot be retried separately');
  } finally { await f.close(); }
});

test('cancelling a presenting say cancels its showcase child before ending the parent', async () => {
  const go = gate();
  const f = fixture({ run: async ({ task, cwd }) => {
    if (task.role === 'showcase') { await go.promise; return 'cancelled'; }
    fs.writeFileSync(path.join(cwd, 'cancel.txt'), 'ready\n');
    await git(cwd, 'add', 'cancel.txt'); await git(cwd, 'commit', '-m', 'cancel');
    return 'built';
  } });
  await repo(f.root);
  try {
    const say = await f.project.say('present then cancel');
    await f.project.reserveTask(say.task.id, 'showcase');
    await until(() => JSON.parse(f.store.task(say.task.id).reservation).status === 'started');
    const childId = JSON.parse(f.store.task(say.task.id).reservation).child_id;
    f.project.cancel(say.task.id, 'stop the presentation');
    expect(f.store.task(childId).status).toBe('cancelled');
    expect(f.store.task(say.task.id).status).toBe('cancelled');
    expect(JSON.parse(f.store.task(say.task.id).reservation).status).toBe('cancelled');
    expect(f.store.children(say.task.id).every(child => child.status === 'cancelled')).toBe(true);
  } finally { go.resolve(); await f.close(); }
});

test('recovery closes a say left in showcase started after its child committed settlement', async () => {
  const go = gate();
  const f = fixture({ run: async ({ task, cwd, context }) => {
    if (task.role === 'showcase') {
      await go.promise;
      fs.writeFileSync(context.showcase.report_path, '<!doctype html><p>Done</p>');
      return 'done';
    }
    fs.writeFileSync(path.join(cwd, 'recovery.txt'), 'ready\n');
    await git(cwd, 'add', 'recovery.txt'); await git(cwd, 'commit', '-m', 'recovery');
    return 'built';
  } });
  await repo(f.root);
  const settle = f.project.settleReservedShowcase;
  try {
    const say = await f.project.say('recover showcase');
    await f.project.reserveTask(say.task.id, 'showcase');
    await until(() => JSON.parse(f.store.task(say.task.id).reservation).status === 'started');
    const childId = JSON.parse(f.store.task(say.task.id).reservation).child_id;
    f.project.settleReservedShowcase = () => {}; // emulate a crash after child DB settlement, before parent DB settlement
    go.resolve();
    await until(() => f.store.task(childId).status === 'completed');
    expect(f.store.task(say.task.id).status).toBe('waiting');
    f.project.settleReservedShowcase = settle;
    f.project.recover();
    expect(f.store.task(say.task.id).status).toBe('completed');
    f.project.recover();
    expect(f.store.all("SELECT id FROM events WHERE task_id=? AND type='task.showcase_settled'", say.task.id)).toHaveLength(1);
  } finally { f.project.settleReservedShowcase = settle; go.resolve(); await f.close(); }
});

test('user approval rejects source and parent branch drift without advancing main', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const say = await f.project.say('prepare release');
    fs.writeFileSync(path.join(say.task.workspace, 'release.txt'), 'ready\n');
    await git(say.task.workspace, 'add', 'release.txt'); await git(say.task.workspace, 'commit', '-m', 'release');
    f.store.update(say.task.id, { status: 'waiting' });
    const { reservation } = await f.project.reserveTask(say.task.id, 'merge');
    expect(reservation.status).toBe('requested');
    await git(f.root, 'commit', '--allow-empty', '-m', 'external parent change');
    await expect(f.project.approveReservedMerge(say.task.id, reservation.commit, reservation.baseline))
      .rejects.toThrow('parent branch moved');
    await git(say.task.workspace, 'commit', '--allow-empty', '-m', 'late change');
    await expect(f.project.approveReservedMerge(say.task.id, reservation.commit, reservation.baseline))
      .rejects.toThrow('source branch moved');
    expect(await git(f.root, 'rev-parse', 'main')).not.toBe(reservation.commit);
    expect(f.store.task(say.task.id).integration).toBe('pending');
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
    const child = f.project.spawn(say.task.id, 'review changes', 'agent', [], 'review');
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

test('only the running direct parent Agent can integrate a frozen completed child with ff-only', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const say = await f.project.say('develop');
    const child = f.project.spawn(say.task.id, 'write child code', 'agent', [], 'write-child');
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
    await expect(new Dispatcher(f.project).dispatch('task.integrate', { id: child.id, commit }))
      .rejects.toThrow('agent only');
  } finally { await f.close(); }
});

test('child branch drift rejects the fixed commit without moving the parent', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const say = await f.project.say('develop');
    const child = f.project.spawn(say.task.id, 'write child code', 'agent', [], 'write-child');
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

test('say.submit is user-only and preserves old input.submit as a separate legacy path', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const dispatcher = new Dispatcher(f.project);
    const draft = f.project.draft('draft only');
    await expect(dispatcher.dispatch('say.submit', { draft_id: draft.id, content: 'not allowed' })).rejects.toThrow('cannot be combined');
    const sent = await dispatcher.dispatch('say.submit', { draft_id: draft.id });
    expect(sent.task.task_kind).toBe('say');
    expect(f.store.draft(draft.id).input_id).toBe(sent.id);
    const legacy = await dispatcher.dispatch('input.submit', { content: 'legacy request' });
    expect(legacy.task.role).toBe('planner');
    expect(legacy.task.task_kind).toBeNull();
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
