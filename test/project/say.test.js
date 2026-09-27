import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, repo, git, until, gate } from '../helpers.js';
import { Dispatcher } from '../../src/rpc/protocol.js';
import { assertAllowed } from '../../src/rpc/registry.js';

test('new say creates one Input and one AP in its own worktree, without planner or fast routing', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const response = await f.project.say('开发 做一个页面');
    const root = f.store.ap(response.ap.parent_id);
    expect(root).toMatchObject({ role: 'agent', ap_kind: 'main', status: 'waiting', branch: 'main', input_id: null });
    expect(response.ap).toMatchObject({ ap_kind: 'say', role: 'agent', parent_id: root.id,
      input_id: response.id, workspace: response.anchor.workspace, branch: response.anchor.branch,
      target_branch: 'main' });
    expect(f.store.get('SELECT ap_id FROM inputs WHERE id=?', response.id).ap_id).toBe(response.ap.id);
    expect(f.store.branch(response.anchor.branch).ap_id).toBe(response.ap.id);
    expect(await git(response.ap.workspace, 'symbolic-ref', '--short', 'HEAD')).toBe(response.ap.branch);
    expect(await f.project.workspaces.ensure(response.ap)).toBe(response.ap.workspace);
    expect(f.store.get("SELECT count(*) AS n FROM aps WHERE role='planner'").n).toBe(0);
    expect(f.store.get("SELECT count(*) AS n FROM events WHERE type='input.route'").n).toBe(0);
    expect((await f.project.ensureMainAP()).id).toBe(root.id);
    expect(() => f.project.message(root.id, 'run in main')).toThrow('not an unrestricted Agent inbox');
    expect(() => f.project.spawn(root.id, 'write main')).toThrow('not unrestricted spawned work');
    expect(() => f.project.cancel(root.id)).toThrow('permanent root');
    await expect(f.project.say('another', 'feature/missing')).rejects.toThrow('explicitly bound AP');
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
      created_from_commit: baseline, ap_id: old.id });
    const pending = f.store.create({ role: 'worker', goal: 'unfinished legacy work' });
    f.store.update(pending.id, { target_branch: 'external' });
    await expect(f.project.bindBranch('external', commit)).rejects.toThrow('active old AP');
    f.store.update(pending.id, { status: 'cancelled' });
    await expect(f.project.say('not yet', 'external')).rejects.toThrow('explicitly bound AP');
    await expect(f.project.bindBranch('external', baseline)).rejects.toThrow('moved');
    const owner = await new Dispatcher(f.project).dispatch('branch.bind', { branch: 'external', commit });
    expect(owner).toMatchObject({ ap_kind: 'owner', status: 'waiting', branch: 'external',
      base_commit: commit, parent_id: null, calls: 0 });
    expect(f.store.branch('external').ap_id).toBe(old.id);
    expect((await f.project.branchShow('external')).ap_id).toBe(owner.id);
    await expect(f.project.bindBranch('external', commit)).rejects.toThrow('already has a new AP owner');
    const sent = await f.project.say('new ap', 'external');
    expect(sent.ap.parent_id).toBe(owner.id);
    expect(f.store.get("SELECT count(*) AS n FROM aps WHERE role='planner'").n).toBe(0);
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
    expect(f.store.branch('outside')).toMatchObject({ parent: null, parent_relation: 'unknown', ap_id: owner.id });
    expect((await f.project.branchShow('outside')).ap_id).toBe(owner.id);
    await expect(f.project.bindBranch('main', commit)).rejects.toThrow('non-main');
    await expect(f.project.bindBranch('missing', commit)).rejects.toThrow('does not exist');
  } finally { await f.close(); }
});

test('say delivery reservations are mutually exclusive, durable and cannot be mistaken for authorization', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const say = await f.project.say('build a view');
    const legacy = f.store.create({ role: 'worker', goal: 'legacy' });
    await expect(f.project.reserveAP(legacy.id, 'merge')).rejects.toThrow('only new say');
    await expect(f.project.reserveAP(say.ap.id, 'other')).rejects.toThrow('merge or showcase');
    expect(() => assertAllowed('ap.reserve', { id: say.ap.id, kind: 'merge' }, say.ap.id))
      .toThrow('requires user approval');
    const first = await new Dispatcher(f.project).dispatch('ap.reserve', { id: say.ap.id, kind: 'merge' });
    expect(first).toMatchObject({ ap_id: say.ap.id, changed: true,
      reservation: { version: 1, kind: 'merge', status: 'pending' } });
    expect(JSON.parse(f.store.ap(say.ap.id).reservation)).toEqual(first.reservation);
    expect(f.project.inspect(say.ap.id).reservation).toEqual(first.reservation);
    expect(f.project.decorate(f.store.summaries('work')).find(ap => ap.id === say.ap.id).reservation).toEqual(first.reservation);
    expect(await f.project.reserveAP(say.ap.id, 'merge')).toEqual({ ...first, changed: false });
    await expect(f.project.reserveAP(say.ap.id, 'showcase')).rejects.toThrow('unreserve it before choosing');
    expect(f.store.all("SELECT id FROM events WHERE ap_id=? AND type='ap.reserved'", say.ap.id)).toHaveLength(1);
    expect(f.store.ap(say.ap.id).integration).toBe('none');
    expect(await git(f.root, 'rev-parse', 'main')).toBe(say.anchor.commit);
    expect(f.project.unreserveAP(say.ap.id)).toMatchObject({ changed: true, reservation: null });
    expect(f.project.unreserveAP(say.ap.id)).toMatchObject({ changed: false, reservation: null });
    expect((await f.project.reserveAP(say.ap.id, 'showcase')).reservation.kind).toBe('showcase');
    expect(f.store.all("SELECT id FROM events WHERE ap_id=? AND type='ap.unreserved'", say.ap.id)).toHaveLength(1);
  } finally { await f.close(); }
});

test('merge reservation pins source and parent tips, signals once, then requires matching user approval', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const say = await f.project.say('prepare release');
    const root = f.store.ap(say.ap.parent_id);
    fs.writeFileSync(path.join(say.ap.workspace, 'release.txt'), 'ready\n');
    await git(say.ap.workspace, 'add', 'release.txt');
    await git(say.ap.workspace, 'commit', '-m', 'release');
    const commit = await git(say.ap.workspace, 'rev-parse', 'HEAD');
    const baseline = await git(f.root, 'rev-parse', 'main');
    f.store.update(say.ap.id, { status: 'waiting', result: '已提交并测试' }); // provider has yielded; no running invocation
    expect((await f.project.graph()).nodes.find(node => node.kind === 'ap' && node.id === say.ap.id))
      .toMatchObject({ status: 'waiting', has_result: true, reservation: null });
    const booked = await new Dispatcher(f.project).dispatch('ap.reserve', { id: say.ap.id, kind: 'merge' });
    expect(booked.reservation).toMatchObject({ status: 'requested', commit, baseline, parent_id: root.id });
    expect((await f.project.graph()).nodes.find(node => node.kind === 'ap' && node.id === say.ap.id))
      .toMatchObject({ ap_kind: 'say', parent_ap_kind: 'main', reservation: { kind: 'merge', status: 'requested', commit, baseline } });
    expect(f.store.ap(say.ap.id)).toMatchObject({ status: 'completed', head_commit: commit, integration: 'pending' });
    expect(await git(f.root, 'rev-parse', 'main')).toBe(baseline);
    const signals = f.store.all('SELECT * FROM messages WHERE ap_id=? AND sender_id=?', root.id, say.ap.id);
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ signal_type: 'merge.requested', consumed: 0 });
    expect(JSON.parse(signals[0].body).payload).toEqual({ branch: say.ap.branch, commit, baseline });
    // 请求已发出：不能静默撤销（撤销是用户显式动作，另有确认弹窗），必须用同一个固定 commit + baseline 批准。
    expect(f.store.all("SELECT id FROM events WHERE ap_id=? AND type='ap.request_withdrawn'", say.ap.id)).toHaveLength(0);
    expect(f.project.branchFreeze('main')).toMatchObject({ kind: 'delivery', ap_id: say.ap.id, commit });
    await expect(f.project.approveReservedMerge(say.ap.id, baseline, baseline)).rejects.toThrow('does not match');
    await expect(f.project.approveReservedMerge(say.ap.id, commit, commit)).rejects.toThrow('does not match');
    expect(await git(f.root, 'rev-parse', 'main')).toBe(baseline);
    expect(() => assertAllowed('ap.approve_merge', { id: say.ap.id, commit, baseline }, say.ap.id))
      .toThrow('requires user approval');
    const approved = await new Dispatcher(f.project).dispatch('ap.approve_merge', { id: say.ap.id, commit, baseline });
    expect(approved.ap.integration).toBe('merged');
    expect(JSON.parse(approved.ap.reservation).status).toBe('integrated');
    expect(await git(f.root, 'rev-parse', 'main')).toBe(commit);
    expect((await f.project.approveReservedMerge(say.ap.id, commit, baseline)).already_integrated).toBe(true);
    expect(f.project.branchFreeze('main')).toBeNull();
    expect(f.store.all("SELECT id FROM events WHERE ap_id=? AND type='ap.merge_requested'", say.ap.id)).toHaveLength(1);
    expect(f.store.all('SELECT id FROM messages WHERE ap_id=? AND sender_id=?', root.id, say.ap.id)).toHaveLength(1);
  } finally { await f.close(); }
});

test('an outstanding request freezes its parent branch: one request at a time, only the holder can land', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const parent = await f.project.say('parent');
    const plan = f.project.spawn(parent.ap.id, 'plain child work', 'agent', [], 'plain');
    const first = await f.project.say('first delivery', parent.ap.branch);
    const second = await f.project.say('second delivery', parent.ap.branch);
    for (const ap of [plan, first.ap, second.ap]) {
      const cwd = await f.project.workspaces.ensure(ap);
      fs.writeFileSync(path.join(cwd, `${ap.id}.txt`), 'work\n');
      await git(cwd, 'add', '.'); await git(cwd, 'commit', '-m', `AP ${ap.id}`);
      await f.project.workspaces.finish(f.store.ap(ap.id));
    }
    f.project.finish(plan.id, 'completed', 'plain done'); // child AP: no reservation, delivered by parent confirmation
    f.store.run('UPDATE messages SET consumed=1 WHERE ap_id=?', parent.ap.id);
    for (const ap of [first.ap, second.ap]) f.store.update(ap.id, { status: 'waiting' });
    const firstCommit = f.store.ap(first.ap.id).head_commit;
    expect((await f.project.reserveAP(first.ap.id, 'merge')).reservation.status).toBe('requested');
    expect(f.project.branchFreeze(parent.ap.branch)).toMatchObject({ kind: 'delivery', ap_id: first.ap.id, commit: firstCommit });
    // 同一个父分支不能再接受第二个未集成的请求；它保持 pending 并说清原因。
    const blocked = await f.project.reserveAP(second.ap.id, 'merge');
    expect(blocked.reservation).toMatchObject({ status: 'pending', blocked_code: 'parent_locked' });
    expect(blocked.reservation.blocked_reason).toContain('已被');
    expect(f.store.unread(parent.ap.id).filter(row => row.signal_type === 'merge.requested')).toHaveLength(1);
    // 交付锁期间父分支不接受其它写：新 say 与其它子 AP 集成都被拒，只有持有锁的请求能落地。
    await expect(f.project.say('another', parent.ap.branch)).rejects.toThrow('frozen');
    // 源分支也不能被归档：它是那次未集成交付本身，删了父分支的锁就永远没有落地对象。
    await expect(f.project.archiveBranch(first.ap.branch)).rejects.toThrow('outstanding merge request');
    f.store.update(parent.ap.id, { status: 'running' });
    await expect(f.project.integrateChild(parent.ap.id, plan.id, f.store.ap(plan.id).head_commit))
      .rejects.toThrow('frozen');
    const landed = await f.project.integrateChild(parent.ap.id, first.ap.id, firstCommit);
    expect(landed.child.integration).toBe('merged');
    expect(await git(f.root, 'rev-parse', parent.ap.branch)).toBe(firstCommit);
    // 请求集成后锁就解除；兄弟的基点早于这次落地，所以按已有源侧解分歧路径报“分歧”。
    expect(f.project.branchFreeze(parent.ap.branch)).toBeNull();
    f.store.update(second.ap.id, { status: 'waiting' });
    f.store.run('UPDATE messages SET consumed=1 WHERE ap_id=?', second.ap.id);
    const diverged = await f.project.reserveAP(second.ap.id, 'merge');
    expect(diverged.reservation).toMatchObject({ status: 'pending', blocked_code: 'diverged' });
  } finally { await f.close(); }
});

test('a request invalidated by the parent’s own commits is diagnosed, and withdrawal releases the lock', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const parent = await f.project.say('parent keeps working');
    const child = await f.project.say('child delivery', parent.ap.branch);
    const cwd = await f.project.workspaces.ensure(child.ap);
    fs.writeFileSync(path.join(cwd, 'child.txt'), 'work\n');
    await git(cwd, 'add', '.'); await git(cwd, 'commit', '-m', 'child');
    await f.project.workspaces.finish(f.store.ap(child.ap.id));
    f.store.update(child.ap.id, { status: 'waiting' });
    const commit = f.store.ap(child.ap.id).head_commit;
    expect((await f.project.reserveAP(child.ap.id, 'merge')).reservation.status).toBe('requested');
    const baseline = JSON.parse(f.store.ap(child.ap.id).reservation).baseline;
    // 父分支自己的 say Agent 提交了（daemon 阻止不了），请求因此已经不能快进。
    fs.writeFileSync(path.join(parent.ap.workspace, 'later.txt'), 'later\n');
    await git(parent.ap.workspace, 'add', '.'); await git(parent.ap.workspace, 'commit', '-m', 'parent moved');
    await f.project.workspaces.finish(f.store.ap(parent.ap.id));
    expect(await f.project.noteBranchAdvance(parent.ap.id)).toBe(child.ap.id);
    const diagnosis = JSON.parse(f.store.ap(child.ap.id).reservation);
    expect(diagnosis).toMatchObject({ status: 'requested', blocked_code: 'parent_moved' });
    expect(diagnosis.blocked_reason).toContain('撤销这个请求');
    f.store.update(parent.ap.id, { status: 'running' });
    await expect(f.project.integrateChild(parent.ap.id, child.ap.id, commit)).rejects.toThrow('fast-forward');
    expect(await f.project.noteBranchAdvance(parent.ap.id)).toBe(child.ap.id); // 仍处于失效状态，但不再重写事件
    expect(f.store.all("SELECT id FROM events WHERE ap_id=? AND type='ap.reservation_blocked'", child.ap.id)).toHaveLength(1);
    // 用户显式撤销：锁解除，AP、分支与提交都保留。
    const withdrawn = f.project.unreserveAP(child.ap.id);
    expect(withdrawn.withdrawn).toMatchObject({ commit, baseline });
    expect(f.project.branchFreeze(parent.ap.branch)).toBeNull();
    expect(f.store.all("SELECT id FROM events WHERE ap_id=? AND type='ap.request_withdrawn'", child.ap.id)).toHaveLength(1);
    expect(f.store.ap(child.ap.id)).toMatchObject({ status: 'completed', head_commit: commit, integration: 'pending', reservation: null });
    expect(await git(f.root, 'rev-parse', child.ap.branch)).toBe(commit);
    expect(await f.project.noteBranchAdvance(parent.ap.id)).toBeNull();
  } finally { await f.close(); }
});

test('a request whose commit is already contained in the parent closes idempotently without the old baseline', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const say = await f.project.say('close by containment');
    fs.writeFileSync(path.join(say.ap.workspace, 'work.txt'), 'work\n');
    await git(say.ap.workspace, 'add', '.'); await git(say.ap.workspace, 'commit', '-m', 'work');
    f.store.update(say.ap.id, { status: 'waiting' });
    const { reservation } = await f.project.reserveAP(say.ap.id, 'merge');
    expect(reservation.status).toBe('requested');
    // 用户 / 外部进程把这次固定提交直接合进了 main：main 前进了，但已包含固定提交。
    await git(f.root, 'merge', '--no-ff', '--no-edit', reservation.commit);
    const movedTo = await git(f.root, 'rev-parse', 'main');
    const closed = await f.project.approveReservedMerge(say.ap.id, reservation.commit, reservation.baseline);
    expect(closed.merge.already_integrated).toBe(true);
    expect(await git(f.root, 'rev-parse', 'main')).toBe(movedTo);
    expect(JSON.parse(f.store.ap(say.ap.id).reservation)).toMatchObject({ status: 'integrated' });
    expect(f.store.ap(say.ap.id).integration).toBe('merged');
    expect(f.project.branchFreeze('main')).toBeNull();
  } finally { await f.close(); }
});

test('a diverged completed child is repaired from both tips and runtime lands it after the parent reaches a safe point', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const parent = await f.project.say('parent with two children');
    const first = f.project.spawn(parent.ap.id, 'first child', 'agent', [], 'first');
    const second = f.project.spawn(parent.ap.id, 'second child', 'agent', [], 'second');
    for (const child of [first, second]) {
      const cwd = await f.project.workspaces.ensure(child);
      fs.writeFileSync(path.join(cwd, `${child.id}.txt`), 'work\n');
      await git(cwd, 'add', '.'); await git(cwd, 'commit', '-m', `child ${child.id}`);
      await f.project.workspaces.finish(f.store.ap(child.id));
      f.project.finish(child.id, 'completed', 'done');
      f.store.run('UPDATE messages SET consumed=1 WHERE ap_id=?', parent.ap.id);
    }
    f.store.update(parent.ap.id, { status: 'running' });
    const firstCommit = f.store.ap(first.id).head_commit;
    await f.project.integrateChild(parent.ap.id, first.id, firstCommit);
    expect(await git(f.root, 'rev-parse', parent.ap.branch)).toBe(firstCommit);
    // 兄弟先落地：第二个子 AP 的固定提交不再能快进，直接确认必须拒绝并保留现场。
    const secondCommit = f.store.ap(second.id).head_commit;
    await expect(f.project.integrateChild(parent.ap.id, second.id, secondCommit)).rejects.toThrow('fast-forward');
    expect(f.store.ap(second.id).integration).toBe('pending');
    expect(await git(f.root, 'rev-parse', parent.ap.branch)).toBe(firstCommit);
    // 只有正在跑的直接父 Agent 能派，且不能修别人的子 AP。
    expect(() => assertAllowed('ap.resolve_child_divergence', { id: second.id }, null)).toThrow('agent only');
    await expect(f.project.resolveChildDivergence(parent.ap.parent_id, second.id)).rejects.toThrow('only a new AP agent');
    await expect(f.project.resolveChildDivergence(parent.ap.id, first.id)).rejects.toThrow('whose work is not integrated yet');
    const started = await f.project.resolveChildDivergence(parent.ap.id, second.id);
    expect(started).toMatchObject({ status: 'queued', source_commit: secondCommit, parent_commit: firstCommit });
    const repair = f.store.ap(started.ap.id);
    expect(repair).toMatchObject({ parent_id: parent.ap.id, ap_kind: 'child', role: 'agent',
      base_commit: secondCommit, target_branch: parent.ap.branch });
    const repeated = await f.project.resolveChildDivergence(parent.ap.id, second.id);
    expect(repeated).toMatchObject({ status: 'existing', ap: { id: repair.id } });
    expect(f.store.children(parent.ap.id)).toHaveLength(3);
    // 解分歧工作区从固定子提交拉起（谱系直接指向父分支），只合入父分支的固定顶端。
    const cwd = await f.project.workspaces.ensure(repair);
    expect(f.store.branch(f.store.ap(repair.id).branch).parent).toBe(parent.ap.branch);
    expect(await git(cwd, 'rev-parse', 'HEAD')).toBe(secondCommit);
    await git(cwd, 'merge', '--no-ff', '--no-edit', firstCommit);
    await f.project.workspaces.finish(f.store.ap(repair.id));
    const resolved = f.store.ap(repair.id).head_commit;
    f.store.update(parent.ap.id, { status: 'waiting' }); // 父 Agent 到安全点，runtime 才能原样落地固定产物
    f.project.stopping = false; f.project.kick = () => {};
    f.project.finish(repair.id, 'completed', 'both commits tested');
    await until(() => f.store.ap(second.id).integration === 'merged');
    expect(f.store.ap(repair.id).integration).toBe('merged');
    expect(await git(f.root, 'rev-parse', parent.ap.branch)).toBe(resolved);
    // 被修复的子 AP 一并结算，且两个固定提交都在父分支里。
    expect(f.store.ap(second.id)).toMatchObject({ status: 'completed', integration: 'merged', head_commit: resolved });
    expect(f.store.all("SELECT id FROM events WHERE ap_id=? AND type='ap.divergence_integrated'", second.id)).toHaveLength(1);
    expect(await f.project.workspaces.isAncestor(f.root, secondCommit, resolved)).toBe(true);
    expect(await f.project.workspaces.isAncestor(f.root, firstCommit, resolved)).toBe(true);
    f.store.run('UPDATE messages SET consumed=1 WHERE ap_id=?', parent.ap.id);
    f.store.update(parent.ap.id, { status: 'waiting' });
    await f.project.reserveAP(parent.ap.id, 'merge');
    expect(JSON.parse(f.store.ap(parent.ap.id).reservation).status).toBe('requested');
  } finally { await f.close(); }
});

test('repair refuses a diverged child of a locked parent and a child whose branch did not diverge', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const parent = await f.project.say('parent');
    const child = f.project.spawn(parent.ap.id, 'child', 'agent', [], 'child');
    const cwd = await f.project.workspaces.ensure(child);
    fs.writeFileSync(path.join(cwd, 'x.txt'), 'work\n');
    await git(cwd, 'add', '.'); await git(cwd, 'commit', '-m', 'child');
    await f.project.workspaces.finish(f.store.ap(child.id));
    f.project.finish(child.id, 'completed', 'done');
    f.store.run('UPDATE messages SET consumed=1 WHERE ap_id=?', parent.ap.id);
    // 还没分歧（父分支没动）：不需要也不能派解分歧子 AP。
    await expect(f.project.resolveChildDivergence(parent.ap.id, child.id)).rejects.toThrow('repair only applies to a diverged child');
    // 父分支被另一个未集成请求锁住时，先处理那个请求。
    const requester = await f.project.say('requester', parent.ap.branch);
    const requestCwd = await f.project.workspaces.ensure(requester.ap);
    fs.writeFileSync(path.join(requestCwd, 'req.txt'), 'work\n');
    await git(requestCwd, 'add', '.'); await git(requestCwd, 'commit', '-m', 'request');
    await f.project.workspaces.finish(f.store.ap(requester.ap.id));
    f.store.update(requester.ap.id, { status: 'waiting' });
    expect((await f.project.reserveAP(requester.ap.id, 'merge')).reservation.status).toBe('requested');
    await git(parent.ap.workspace, 'commit', '--allow-empty', '-m', 'parent moved');
    f.store.update(parent.ap.id, { status: 'running' });
    await expect(f.project.resolveChildDivergence(parent.ap.id, child.id)).rejects.toThrow('frozen');
    expect(f.store.children(parent.ap.id)).toHaveLength(2);
  } finally { await f.close(); }
});

test('a restart re-diagnoses already-requested merges against the current Git facts', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const say = await f.project.say('request then drift');
    fs.writeFileSync(path.join(say.ap.workspace, 'work.txt'), 'work\n');
    await git(say.ap.workspace, 'add', '.'); await git(say.ap.workspace, 'commit', '-m', 'work');
    f.store.update(say.ap.id, { status: 'waiting' });
    const { reservation } = await f.project.reserveAP(say.ap.id, 'merge');
    expect(reservation.status).toBe('requested');
    f.store.update(say.ap.id, { status: 'completed' });
    // 请求发出后 main 被外部推进（daemon 不在场）：重启后的复查要如实写成 parent_moved。
    await git(f.root, 'commit', '--allow-empty', '-m', 'moved while down');
    expect(await f.project.recheckRequestedMerge(say.ap.id)).toBe('parent_moved');
    expect(JSON.parse(f.store.ap(say.ap.id).reservation)).toMatchObject({ status: 'requested', blocked_code: 'parent_moved' });
    // 固定提交已经进了父分支：诊断为可幂等关闭，而不是“不能落地”。
    await git(f.root, 'merge', '--no-ff', '--no-edit', reservation.commit);
    expect(await f.project.recheckRequestedMerge(say.ap.id)).toBe('contained');
    expect(JSON.parse(f.store.ap(say.ap.id).reservation).blocked_code).toBe('contained');
    await f.project.approveReservedMerge(say.ap.id, reservation.commit, reservation.baseline);
    expect(JSON.parse(f.store.ap(say.ap.id).reservation)).toMatchObject({ status: 'integrated' });
    expect(JSON.parse(f.store.ap(say.ap.id).reservation).blocked_code).toBeUndefined();
    const diagnoses = f.store.all("SELECT data FROM events WHERE ap_id=? AND type='ap.reservation_blocked' ORDER BY id", say.ap.id)
      .map(row => JSON.parse(row.data).code);
    expect(diagnoses).toEqual(['parent_moved', 'contained']);
    // 源分支自己被动过：请求同样失效，不再假装还在等集成。
    const other = await f.project.say('source moved');
    await git(other.ap.workspace, 'commit', '--allow-empty', '-m', 'source');
    f.store.update(other.ap.id, { status: 'waiting' });
    const second = await f.project.reserveAP(other.ap.id, 'merge');
    expect(second.reservation.status).toBe('requested');
    f.store.update(other.ap.id, { status: 'completed' });
    await git(other.ap.workspace, 'commit', '--allow-empty', '-m', 'someone else moved it');
    expect(await f.project.recheckRequestedMerge(other.ap.id)).toBe('source_moved');
    expect(JSON.parse(f.store.ap(other.ap.id).reservation).blocked_code).toBe('source_moved');
    // 失效的请求仍然锁着 main：先显式撤销（这也是唯一退路）才能在 main 上派新的 say。
    await expect(f.project.say('still landable')).rejects.toThrow('frozen');
    expect(f.project.unreserveAP(other.ap.id).withdrawn.commit).toBe(second.reservation.commit);
    expect(f.project.branchFreeze('main')).toBeNull();
    // 仍然可以快进的请求：复查会把过期诊断清掉，而不是留着旧原因。
    const healthy = await f.project.say('still landable');
    await git(healthy.ap.workspace, 'commit', '--allow-empty', '-m', 'healthy');
    f.store.update(healthy.ap.id, { status: 'waiting' });
    const third = await f.project.reserveAP(healthy.ap.id, 'merge');
    expect(third.reservation.status).toBe('requested');
    f.store.update(healthy.ap.id, { status: 'completed' });
    f.store.run('UPDATE aps SET reservation=? WHERE id=?', JSON.stringify({ version: 1, kind: 'merge', status: 'requested',
      commit: third.reservation.commit, baseline: third.reservation.baseline, parent_id: healthy.ap.parent_id,
      blocked_reason: 'stale reason', blocked_code: 'parent_moved' }), healthy.ap.id);
    expect(await f.project.recheckRequestedMerge(healthy.ap.id)).toBe('landable');
    const cleaned = JSON.parse(f.store.ap(healthy.ap.id).reservation);
    expect(cleaned.blocked_reason).toBeUndefined();
    expect(cleaned.blocked_code).toBeUndefined();
    expect(f.store.all("SELECT id FROM events WHERE ap_id=? AND type='ap.reservation_rechecked'", healthy.ap.id)).toHaveLength(1);
  } finally { await f.close(); }
});

test('approval refuses a dirty parent and reconciles a Git-success/DB-interruption without a second write', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const say = await f.project.say('safe merge');
    fs.writeFileSync(path.join(say.ap.workspace, 'safe.txt'), 'ready\n');
    await git(say.ap.workspace, 'add', 'safe.txt'); await git(say.ap.workspace, 'commit', '-m', 'safe');
    f.store.update(say.ap.id, { status: 'waiting' });
    const { reservation } = await f.project.reserveAP(say.ap.id, 'merge');
    const scratch = path.join(f.root, 'untracked.tmp');
    fs.writeFileSync(scratch, 'do not overwrite');
    await expect(f.project.approveReservedMerge(say.ap.id, reservation.commit, reservation.baseline))
      .rejects.toThrow();
    expect(fs.readFileSync(scratch, 'utf8')).toBe('do not overwrite');
    expect(await git(f.root, 'rev-parse', 'main')).toBe(reservation.baseline);
    fs.unlinkSync(scratch); // only our temporary test project file
    const original = f.store.update.bind(f.store);
    let interrupted = true;
    f.store.update = (apId, patch) => {
      if (apId === say.ap.id && patch.integration === 'merged' && interrupted) {
        interrupted = false; throw new Error('simulated database interruption');
      }
      return original(apId, patch);
    };
    await expect(f.project.approveReservedMerge(say.ap.id, reservation.commit, reservation.baseline))
      .rejects.toThrow('simulated database interruption');
    f.store.update = original;
    expect(await git(f.root, 'rev-parse', 'main')).toBe(reservation.commit);
    expect(JSON.parse(f.store.ap(say.ap.id).reservation).status).toBe('requested');
    expect((await f.project.approveReservedMerge(say.ap.id, reservation.commit, reservation.baseline)).merge.already_integrated).toBe(true);
    expect(JSON.parse(f.store.ap(say.ap.id).reservation).status).toBe('integrated');
  } finally { await f.close(); }
});

test('pending merge is diagnosable and replayed after recovery only from a clean committed idle branch', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const say = await f.project.say('commit later');
    f.store.update(say.ap.id, { status: 'waiting' });
    const initial = await f.project.reserveAP(say.ap.id, 'merge');
    expect(initial.reservation).toMatchObject({ status: 'pending', blocked_reason: 'no committed source changes yet' });
    fs.writeFileSync(path.join(say.ap.workspace, 'later.txt'), 'uncommitted\n');
    f.project.recover();
    await until(() => JSON.parse(f.store.ap(say.ap.id).reservation).blocked_reason !== initial.reservation.blocked_reason);
    expect(f.store.ap(say.ap.id).status).toBe('waiting');
    expect(f.store.unread(say.ap.parent_id)).toHaveLength(0);
    await git(say.ap.workspace, 'add', 'later.txt'); await git(say.ap.workspace, 'commit', '-m', 'ready');
    f.project.recover();
    await until(() => JSON.parse(f.store.ap(say.ap.id).reservation).status === 'requested');
    expect(f.store.ap(say.ap.id).status).toBe('completed');
    expect(f.store.unread(say.ap.parent_id)).toHaveLength(1);
  } finally { await f.close(); }
});

test('pending merge can be explicitly rechecked without duplicate bookings or skipping unread messages', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const say = await f.project.say('ship after review');
    const first = await f.project.reserveAP(say.ap.id, 'merge');
    expect(first.reservation).toMatchObject({ status: 'pending' });
    expect(first.reservation.blocked_reason).toContain('下一轮 Agent');
    const repeat = await f.project.reserveAP(say.ap.id, 'merge');
    expect(repeat.changed).toBe(false);
    expect(f.store.all("SELECT id FROM events WHERE ap_id=? AND type='ap.reserved'", say.ap.id)).toHaveLength(1);
    fs.writeFileSync(path.join(say.ap.workspace, 'review.txt'), 'ready\n');
    await git(say.ap.workspace, 'add', 'review.txt'); await git(say.ap.workspace, 'commit', '-m', 'ready');
    f.store.update(say.ap.id, { status: 'waiting' });
    const messageId = f.store.message(say.ap.id, 'review this before delivery', say.ap.parent_id);
    const blocked = await f.project.reserveAP(say.ap.id, 'merge');
    expect(blocked.reservation.blocked_reason).toContain('未处理的消息');
    expect(f.store.unread(say.ap.parent_id)).toHaveLength(0);
    f.store.run('UPDATE messages SET consumed=1 WHERE id=?', messageId); // mock the next invocation in this temporary project
    const ready = await f.project.reserveAP(say.ap.id, 'merge');
    expect(ready.changed).toBe(false);
    expect(ready.reservation.status).toBe('requested');
    expect(ready.reservation.blocked_reason).toBeUndefined();
    expect(f.store.unread(say.ap.parent_id)).toHaveLength(1);
    expect(f.store.all("SELECT id FROM events WHERE ap_id=? AND type='ap.reserved'", say.ap.id)).toHaveLength(1);
  } finally { await f.close(); }
});

test('a diverged pending say freezes both branches and runtime lands its source-side repair', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const say = await f.project.say('deliver despite a moving parent');
    fs.writeFileSync(path.join(say.ap.workspace, 'mine.txt'), 'from say\n');
    await git(say.ap.workspace, 'add', 'mine.txt'); await git(say.ap.workspace, 'commit', '-m', 'mine');
    const sourceCommit = await git(say.ap.workspace, 'rev-parse', 'HEAD');
    await git(f.root, 'commit', '--allow-empty', '-m', 'parent changed');
    const parentCommit = await git(f.root, 'rev-parse', 'main');
    f.store.update(say.ap.id, { status: 'waiting' });
    const blocked = await f.project.reserveAP(say.ap.id, 'merge');
    expect(blocked.reservation).toMatchObject({ status: 'pending', blocked_code: 'diverged' });
    expect(await git(f.root, 'rev-parse', 'main')).toBe(parentCommit);
    f.project.stopping = false; f.project.kick = () => {}; // deterministic mock: manual child invocation only
    const dispatcher = new Dispatcher(f.project);
    const started = await dispatcher.dispatch('ap.resolve_divergence', { id: say.ap.id });
    expect(started.status).toBe('queued');
    const child = f.store.ap(started.ap.id);
    expect(child).toMatchObject({ parent_id: say.ap.id, ap_kind: 'child', role: 'agent',
      base_commit: sourceCommit, target_branch: say.ap.branch });
    const repeated = await f.project.resolveSayDivergence(say.ap.id);
    expect(repeated).toMatchObject({ status: 'existing', ap: { id: child.id } });
    expect(f.project.branchFreeze('main')).toMatchObject({ kind: 'resolution', ap_id: child.id });
    expect(f.project.branchFreeze(say.ap.branch)).toMatchObject({ kind: 'resolution', ap_id: child.id });
    expect(() => f.project.spawn(say.ap.id, '不能在冻结时派新子 AP')).toThrow('frozen');
    await expect(f.project.say('不能在冻结时创建 main 子 AP')).rejects.toThrow('frozen');
    expect(f.store.children(say.ap.id)).toHaveLength(1);
    expect(() => assertAllowed('ap.resolve_divergence', { id: say.ap.id }, say.ap.id)).toThrow('requires user approval');
    expect(() => assertAllowed('ap.integrate', { id: child.id, commit: sourceCommit }, null)).toThrow('agent only');
    expect(JSON.parse(f.store.ap(say.ap.id).reservation).resolution_child_id).toBe(child.id);
    const cwd = await f.project.workspaces.ensure(child);
    expect(await git(cwd, 'rev-parse', 'HEAD')).toBe(sourceCommit);
    await git(cwd, 'merge', '--no-ff', '--no-edit', parentCommit);
    await f.project.workspaces.finish(f.store.ap(child.id));
    const resolvedCommit = f.store.ap(child.id).head_commit;
    f.project.finish(child.id, 'completed', 'both commits tested');
    await until(() => JSON.parse(f.store.ap(say.ap.id).reservation).status === 'requested');
    expect(f.store.ap(child.id).integration).toBe('merged');
    expect(await git(say.ap.workspace, 'rev-parse', 'HEAD')).toBe(resolvedCommit);
    expect(await git(f.root, 'rev-parse', 'main')).toBe(parentCommit);
    const ready = { reservation: JSON.parse(f.store.ap(say.ap.id).reservation) };
    expect(ready.reservation).toMatchObject({ status: 'requested', commit: resolvedCommit, baseline: parentCommit });
    expect(await git(f.root, 'rev-parse', 'main')).toBe(parentCommit);
    await f.project.approveReservedMerge(say.ap.id, ready.reservation.commit, ready.reservation.baseline);
    expect(await git(f.root, 'rev-parse', 'main')).toBe(resolvedCommit);
  } finally { await f.close(); }
});

test('a resolution freezes affected AP scheduling while an unrelated sibling keeps working', async () => {
  const hold = gate();
  const f = fixture({ run: async () => { await hold.promise; return 'done'; } });
  f.project.stopping = true; await repo(f.root);
  try {
    const source = await f.project.say('source');
    await git(source.ap.workspace, 'commit', '--allow-empty', '-m', 'source');
    await git(f.root, 'commit', '--allow-empty', '-m', 'main moved');
    const sibling = await f.project.say('unrelated sibling');
    f.store.update(source.ap.id, { status: 'waiting' });
    await f.project.reserveAP(source.ap.id, 'merge');
    f.project.stopping = false; f.project.kick = () => {};
    const { ap: repair } = await f.project.resolveSayDivergence(source.ap.id);
    const freeze = f.project.branchFreeze();
    expect(freeze).toContainEqual(expect.objectContaining({ branch: 'main', kind: 'resolution', ap_id: repair.id }));
    expect(freeze).toContainEqual(expect.objectContaining({ branch: source.ap.branch, kind: 'resolution', ap_id: repair.id }));
    expect(freeze.some(row => row.branch === sibling.ap.branch)).toBe(false);
    const graph = await f.project.apGraph();
    expect(graph.nodes.find(node => node.id === source.ap.id).waiting_reason).toContain('冻结');
    f.project.pump();
    await until(() => f.project.running.has(repair.id) && f.project.running.has(sibling.ap.id));
    expect(f.project.running.has(source.ap.id)).toBe(false);
    expect(f.store.ap(repair.id).status).toBe('running');
  } finally { hold.resolve(); await f.close(); }
});

test('resolution waits for a writable parent Agent safe point before freezing fixed tips', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const parent = await f.project.say('parent');
    const child = await f.project.say('nested say', parent.ap.branch);
    await git(child.ap.workspace, 'commit', '--allow-empty', '-m', 'source');
    await git(parent.ap.workspace, 'commit', '--allow-empty', '-m', 'parent');
    f.store.update(child.ap.id, { status: 'waiting' });
    await f.project.reserveAP(child.ap.id, 'merge');
    f.store.update(parent.ap.id, { status: 'running' });
    await expect(f.project.resolveSayDivergence(child.ap.id)).rejects.toThrow('安全点');
    expect(f.project.branchFreeze(parent.ap.branch)).toBeNull();
    f.store.update(parent.ap.id, { status: 'waiting' });
    f.project.stopping = false; f.project.kick = () => {};
    const repair = await f.project.resolveSayDivergence(child.ap.id);
    expect(repair.ap.parent_id).toBe(child.ap.id);
    expect(f.project.branchFreeze(parent.ap.branch)).toMatchObject({ kind: 'resolution', ap_id: repair.ap.id });
  } finally { await f.close(); }
});

test('resolution recovery reconciles an already fast-forwarded source without replaying Agent work', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const source = await f.project.say('source');
    await git(source.ap.workspace, 'commit', '--allow-empty', '-m', 'source');
    await git(f.root, 'commit', '--allow-empty', '-m', 'parent');
    const fixedParent = await git(f.root, 'rev-parse', 'main');
    f.store.update(source.ap.id, { status: 'waiting' });
    await f.project.reserveAP(source.ap.id, 'merge');
    f.project.stopping = false; f.project.kick = () => {};
    const { ap: repair } = await f.project.resolveSayDivergence(source.ap.id);
    const cwd = await f.project.workspaces.ensure(repair);
    await git(cwd, 'merge', '--no-ff', '--no-edit', fixedParent);
    await f.project.workspaces.finish(f.store.ap(repair.id));
    const resolved = f.store.ap(repair.id).head_commit;
    f.project.stopping = true; f.project.finish(repair.id, 'completed', 'tested');
    await f.project.workspaces.fastForwardBranch(source.ap.branch, resolved); // Git 已写、DB 尚未记账
    f.project.stopping = false;
    await f.project.finalizeTerminalDivergence(repair.id);
    expect(JSON.parse(f.store.ap(source.ap.id).reservation)).toMatchObject({
      status: 'requested', commit: resolved, baseline: fixedParent });
    expect(f.store.ap(repair.id).integration).toBe('merged');
    expect(await git(f.root, 'rev-parse', 'main')).toBe(fixedParent);
  } finally { await f.close(); }
});

test('resolution refuses a moved frozen tip before invoking its Agent and preserves the worktree', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const source = await f.project.say('source');
    await git(source.ap.workspace, 'commit', '--allow-empty', '-m', 'source');
    await git(f.root, 'commit', '--allow-empty', '-m', 'parent moved');
    f.store.update(source.ap.id, { status: 'waiting' });
    await f.project.reserveAP(source.ap.id, 'merge');
    f.project.stopping = false; f.project.kick = () => {};
    const { ap: repair } = await f.project.resolveSayDivergence(source.ap.id);
    await git(f.root, 'commit', '--allow-empty', '-m', 'external parent drift');
    f.project.pump();
    await until(() => f.store.ap(repair.id).status === 'failed');
    expect(f.store.all("SELECT id FROM events WHERE ap_id=? AND type='invocation.started'", repair.id)).toHaveLength(0);
    expect(f.store.ap(repair.id).workspace).not.toBeNull();
    expect(f.project.branchFreeze('main')).toBeNull();
    expect(JSON.parse(f.store.ap(source.ap.id).reservation).blocked_code).toBe('diverged');
  } finally { await f.close(); }
});

test('source-side resolution refuses unbooked, non-diverged and dirty say branches without creating children', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const say = await f.project.say('resolve only real divergence');
    f.store.update(say.ap.id, { status: 'waiting' });
    await expect(f.project.resolveSayDivergence(say.ap.id)).rejects.toThrow('pending say merge reservation');
    await f.project.reserveAP(say.ap.id, 'merge');
    await expect(f.project.resolveSayDivergence(say.ap.id)).rejects.toThrow('only applies to a diverged branch');
    await git(say.ap.workspace, 'commit', '--allow-empty', '-m', 'source');
    await git(f.root, 'commit', '--allow-empty', '-m', 'parent');
    const scratch = path.join(say.ap.workspace, 'uncommitted.txt');
    fs.writeFileSync(scratch, 'preserve user changes');
    await expect(f.project.resolveSayDivergence(say.ap.id)).rejects.toThrow();
    expect(fs.readFileSync(scratch, 'utf8')).toBe('preserve user changes');
    expect(f.store.children(say.ap.id)).toHaveLength(0);
  } finally { await f.close(); }
});

test('an invalid completed resolution keeps its branch until explicit archive, then creates a fresh child', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const say = await f.project.say('diverged source');
    await git(say.ap.workspace, 'commit', '--allow-empty', '-m', 'source');
    const source = await git(say.ap.workspace, 'rev-parse', 'HEAD');
    await git(f.root, 'commit', '--allow-empty', '-m', 'parent');
    const parent = await git(f.root, 'rev-parse', 'main');
    f.store.update(say.ap.id, { status: 'waiting' });
    await f.project.reserveAP(say.ap.id, 'merge');
    f.project.stopping = false; f.project.kick = () => {};
    const { ap: child } = await f.project.resolveSayDivergence(say.ap.id);
    const cwd = await f.project.workspaces.ensure(child);
    await git(cwd, 'commit', '--allow-empty', '-m', 'did not merge parent');
    await f.project.workspaces.finish(f.store.ap(child.id));
    f.project.finish(child.id, 'completed', 'incomplete');
    await until(() => f.store.all("SELECT id FROM events WHERE ap_id=? AND type='resolution.finalize_failed'", child.id).length > 0);
    expect(f.store.ap(child.id).integration).not.toBe('merged');
    expect(f.project.branchFreeze(say.ap.branch)).toMatchObject({ kind: 'resolution', ap_id: child.id });
    const held = await f.project.resolveSayDivergence(say.ap.id);
    expect(held.status).toBe('needs_review');
    expect(held.ap.id).toBe(child.id);
    expect(held.reason).toContain('显式归档');
    expect(f.store.children(say.ap.id)).toHaveLength(1);
    f.store.update(say.ap.id, { status: 'waiting' });
    f.store.run('UPDATE messages SET consumed=1 WHERE ap_id=?', say.ap.id);
    await expect(f.project.resolveSayDivergence(say.ap.id)).resolves.toMatchObject({ status: 'needs_review' });
    const oldBranch = f.store.ap(child.id).branch;
    const archived = await f.project.archiveBranch(oldBranch);
    expect(archived.archived).toBe(true);
    expect(f.store.branch(oldBranch).status).toBe('archived');
    expect(f.store.ap(child.id).status).toBe('completed');
    expect(f.store.ap(child.id).workspace).toBeNull();
    expect(f.project.inspect(child.id).divergence_resolution).toMatchObject({
      source_commit: source, parent_commit: parent, branch_status: 'archived' });
    expect(f.store.all("SELECT * FROM events WHERE ap_id=? AND type='ap.divergence_resolution_requested'", child.id)).toHaveLength(1);
    const next = await f.project.resolveSayDivergence(say.ap.id);
    expect(next.status).toBe('queued');
    expect(next.ap.id).not.toBe(child.id);
    expect(f.store.ap(next.ap.id)).toMatchObject({ parent_id: say.ap.id, base_commit: source,
      target_branch: say.ap.branch });
    expect(f.store.children(say.ap.id)).toHaveLength(2);
    expect(await git(say.ap.workspace, 'rev-parse', 'HEAD')).toBe(source);
    expect(await git(f.root, 'rev-parse', 'main')).toBe(parent);
  } finally { await f.close(); }
});

test('a failed dirty resolution requires explicit discard during archive; failure is not replayed', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const say = await f.project.say('preserve failed conflict work');
    await git(say.ap.workspace, 'commit', '--allow-empty', '-m', 'source');
    const source = await git(say.ap.workspace, 'rev-parse', 'HEAD');
    await git(f.root, 'commit', '--allow-empty', '-m', 'parent');
    const parent = await git(f.root, 'rev-parse', 'main');
    f.store.update(say.ap.id, { status: 'waiting' });
    await f.project.reserveAP(say.ap.id, 'merge');
    f.project.stopping = false; f.project.kick = () => {};
    const { ap: child } = await f.project.resolveSayDivergence(say.ap.id);
    const cwd = await f.project.workspaces.ensure(child);
    const scratch = path.join(cwd, 'uncommitted.txt');
    fs.writeFileSync(scratch, 'valuable conflict work');
    f.project.finish(child.id, 'failed', null, 'agent stopped during conflict');
    expect(() => f.project.retry(child.id)).toThrow('不重放未知文件副作用');
    f.store.run('UPDATE messages SET consumed=1 WHERE ap_id=?', say.ap.id);
    f.store.update(say.ap.id, { status: 'waiting' });
    const blocked = await f.project.resolveSayDivergence(say.ap.id);
    expect(blocked).toMatchObject({ status: 'needs_review', ap: { id: child.id } });
    expect(fs.readFileSync(scratch, 'utf8')).toBe('valuable conflict work');
    await expect(f.project.archiveBranch(f.store.ap(child.id).branch)).rejects.toThrow('archive keeps');
    expect(fs.readFileSync(scratch, 'utf8')).toBe('valuable conflict work');
    expect(f.store.children(say.ap.id)).toHaveLength(1);
    const archived = await f.project.archiveBranch(f.store.ap(child.id).branch, { discard_worktree: true });
    expect(archived.discarded).toBe(true);
    expect(f.store.ap(child.id).error).toBe('agent stopped during conflict');
    const next = await f.project.resolveSayDivergence(say.ap.id);
    expect(next).toMatchObject({ status: 'queued', source_commit: source, parent_commit: parent });
    expect(next.ap.id).not.toBe(child.id);
    expect(await git(f.root, 'rev-parse', say.ap.branch)).toBe(source);
    expect(await git(f.root, 'rev-parse', 'main')).toBe(parent);
  } finally { await f.close(); }
});

test('a resolution child cancelled before its branch exists can be replaced without archiving any work', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const say = await f.project.say('cancel before checkout');
    await git(say.ap.workspace, 'commit', '--allow-empty', '-m', 'source');
    await git(f.root, 'commit', '--allow-empty', '-m', 'parent');
    f.store.update(say.ap.id, { status: 'waiting' });
    await f.project.reserveAP(say.ap.id, 'merge');
    f.project.stopping = false; f.project.kick = () => {};
    const { ap: first } = await f.project.resolveSayDivergence(say.ap.id);
    expect(f.store.ap(first.id).branch).toBeNull();
    f.project.cancel(first.id);
    expect(() => f.project.retry(first.id)).toThrow('不重放未知文件副作用');
    f.store.run('UPDATE messages SET consumed=1 WHERE ap_id=?', say.ap.id);
    f.store.update(say.ap.id, { status: 'waiting' });
    const next = await f.project.resolveSayDivergence(say.ap.id);
    expect(next.status).toBe('queued');
    expect(next.ap.id).not.toBe(first.id);
    expect(f.store.children(say.ap.id)).toHaveLength(2);
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
    const booked = await f.project.reserveAP(say.ap.id, 'merge');
    expect(booked.reservation.status).toBe('pending');
    expect(f.store.ap(say.ap.id).status).not.toBe('completed');
    proceed.resolve();
    await until(() => JSON.parse(f.store.ap(say.ap.id).reservation).status === 'requested');
    expect(f.store.ap(say.ap.id).status).toBe('completed');
    expect(f.store.unread(say.ap.parent_id)).toHaveLength(1);
    expect(await git(f.root, 'rev-parse', 'main')).toBe(say.anchor.commit);
  } finally { proceed.resolve(); await f.close(); }
});

test('a requested say child can only be integrated by its direct running parent Agent', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const parent = await f.project.say('parent');
    const child = await f.project.say('child', parent.ap.branch);
    fs.writeFileSync(path.join(child.ap.workspace, 'child.txt'), 'ready\n');
    await git(child.ap.workspace, 'add', 'child.txt'); await git(child.ap.workspace, 'commit', '-m', 'child');
    f.store.update(child.ap.id, { status: 'waiting' });
    const { reservation } = await f.project.reserveAP(child.ap.id, 'merge');
    expect(reservation.status).toBe('requested');
    expect(f.store.unread(parent.ap.id)).toHaveLength(1);
    const before = await git(f.root, 'rev-parse', parent.ap.branch);
    await expect(f.project.integrateChild(parent.ap.id, child.ap.id, reservation.commit)).rejects.toThrow('must be running');
    expect(await git(f.root, 'rev-parse', parent.ap.branch)).toBe(before);
    f.store.update(parent.ap.id, { status: 'running' });
    await expect(f.project.integrateChild(parent.ap.parent_id, child.ap.id, reservation.commit)).rejects.toThrow('only a direct child');
    const result = await f.project.integrateChild(parent.ap.id, child.ap.id, reservation.commit);
    expect(result.child.integration).toBe('merged');
    expect(JSON.parse(result.child.reservation).status).toBe('integrated');
    expect(await git(f.root, 'rev-parse', parent.ap.branch)).toBe(reservation.commit);
    expect(await git(f.root, 'rev-parse', 'main')).toBe(before);
  } finally { await f.close(); }
});

test('showcase booking creates a detached child and finishes the say only after the report is delivered', async () => {
  const show = gate();
  const f = fixture({ run: async ({ ap, cwd, context }) => {
    if (ap.role === 'showcase') {
      if (context.showcase.phase === 'preparing') return 'prepared';
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
    const booked = await f.project.reserveAP(say.ap.id, 'showcase');
    expect(['preparing','started']).toContain(booked.reservation.status);
    await until(() => JSON.parse(f.store.ap(say.ap.id).reservation).status === 'started');
    const current = f.store.ap(say.ap.id), reservation = JSON.parse(current.reservation);
    const child = f.store.ap(reservation.child_id);
    expect(child).toMatchObject({ parent_id: say.ap.id, role: 'showcase', ap_kind: 'showcase' });
    expect(current.status).toBe('waiting');
    expect(f.store.activeAPs().some(row => row.id === child.id)).toBe(true);
    expect(JSON.parse(child.showcase)).toMatchObject({ commit: reservation.commit, baseline_commit: reservation.baseline });
    expect(() => f.project.message(say.ap.id, 'interrupt the presentation')).toThrow('presenting');
    await expect(f.project.say('too late', say.ap.branch)).rejects.toThrow('presenting');
    expect(await git(f.root, 'rev-parse', 'main')).toBe(baseline);
    show.resolve();
    await until(() => f.store.ap(say.ap.id).status === 'completed');
    expect(f.store.ap(child.id).status).toBe('completed');
    expect(f.project.inspect(child.id).report).toContain(`showcase/${child.id}/report.html`);
    expect(JSON.parse(f.store.ap(say.ap.id).reservation).status).toBe('completed');
    expect(f.store.ap(say.ap.id).integration).toBe('pending');
    expect(f.store.unread(say.ap.id)).toMatchObject([{ signal_type: 'showcase.completed', sender_id: child.id }]);
    expect(f.store.unread(say.ap.parent_id)).toHaveLength(0);
    expect(await git(f.root, 'rev-parse', 'main')).toBe(baseline);
  } finally { show.resolve(); await f.close(); }
});

test('a delivered showcase leaves the completed say able to issue a fixed merge request, which a user then approves', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const say = await f.project.say('present then merge');
    fs.writeFileSync(path.join(say.ap.workspace, 'screen.txt'), 'ready\n');
    await git(say.ap.workspace, 'add', 'screen.txt');
    await git(say.ap.workspace, 'commit', '-m', 'screen');
    const commit = await git(say.ap.workspace, 'rev-parse', 'HEAD');
    const baseline = await git(f.root, 'rev-parse', 'main');
    f.store.update(say.ap.id, { status: 'waiting' });
    const booked = await f.project.reserveAP(say.ap.id, 'showcase');
    const child = f.store.ap(booked.reservation.child_id);
    // 直接让展示子 AP 结算；这里只验证原 say 终结后的合并补口，不跑一次真实展示。
    f.store.update(child.id, { status: 'completed', result: 'report ready' });
    expect(f.project.settleReservedShowcase(say.ap.id).status).toBe('completed');
    expect(JSON.parse(f.store.ap(say.ap.id).reservation)).toMatchObject({ kind: 'showcase', status: 'completed' });

    // 终态 say 永远等不到 pending 预约；展示交付后应直接补发固定提交的 requested 请求。
    const requested = await f.project.reserveAP(say.ap.id, 'merge');
    expect(requested).toMatchObject({ changed: true,
      reservation: { version: 1, kind: 'merge', status: 'requested', commit, baseline } });
    expect(f.store.unread(say.ap.parent_id)).toMatchObject([{ signal_type: 'merge.requested', sender_id: say.ap.id }]);
    expect(await git(f.root, 'rev-parse', 'main')).toBe(baseline);

    const approved = await f.project.approveReservedMerge(say.ap.id, commit, baseline);
    expect(approved.merge.merged).toBe(true);
    expect(f.store.ap(say.ap.id).integration).toBe('merged');
    expect(await git(f.root, 'rev-parse', 'main')).toBe(commit);
  } finally { await f.close(); }
});

test('a diverged delivered showcase resolves through a standalone child, then re-requests the fixed merge', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const say = await f.project.say('present then diverge');
    fs.writeFileSync(path.join(say.ap.workspace, 'screen.txt'), 'ready\n');
    await git(say.ap.workspace, 'add', 'screen.txt');
    await git(say.ap.workspace, 'commit', '-m', 'screen');
    const sourceCommit = await git(say.ap.workspace, 'rev-parse', 'HEAD');
    // 让展示交付并把原 say 结算为 completed（不跑一次真实展示）。
    f.store.update(say.ap.id, { status: 'waiting' });
    const booked = await f.project.reserveAP(say.ap.id, 'showcase');
    const showcaseChild = f.store.ap(booked.reservation.child_id);
    f.store.update(showcaseChild.id, { status: 'completed', result: 'report ready' });
    expect(f.project.settleReservedShowcase(say.ap.id).status).toBe('completed');
    // 展示之后 main 自己前进：终态 say 的分支与直接父分支分歧。
    await git(f.root, 'commit', '--allow-empty', '-m', 'parent changed');
    const parentCommit = await git(f.root, 'rev-parse', 'main');

    // 「请求合并」不再直接抛错，而是留下 pending/diverged 预约，等用户派独立解分歧子 AP。
    const blocked = await f.project.reserveAP(say.ap.id, 'merge');
    expect(blocked).toMatchObject({ changed: true,
      reservation: { kind: 'merge', status: 'pending', blocked_code: 'diverged' } });
    expect(f.project.branchFreeze('main')).toBeNull();
    expect(await git(f.root, 'rev-parse', 'main')).toBe(parentCommit);

    // 独立子 AP 不在终态 say 的子树里，用 resolves_ap_id 关联。
    f.project.stopping = false; f.project.kick = () => {};
    const started = await f.project.resolveSayDivergence(say.ap.id);
    expect(started).toMatchObject({ status: 'queued', source_commit: sourceCommit, parent_commit: parentCommit });
    const repair = f.store.ap(started.ap.id);
    expect(repair).toMatchObject({ parent_id: say.ap.parent_id, ap_kind: 'child', role: 'agent',
      resolves_ap_id: say.ap.id, base_commit: sourceCommit, target_branch: say.ap.branch });
    const graph = await f.project.apGraph();
    expect(graph.edges).toContainEqual({ from: say.ap.parent_id, to: repair.id });
    expect(graph.nodes.find(node => node.id === repair.id).resolves_ap_id).toBe(say.ap.id);
    expect(f.store.children(say.ap.id).some(child => child.id === repair.id)).toBe(false);
    expect(await f.project.resolveSayDivergence(say.ap.id)).toMatchObject({ status: 'existing', ap: { id: repair.id } });

    // 子 AP 把固定的父提交合进以固定源提交为基线的工作区，测试后提交。
    const cwd = await f.project.workspaces.ensure(repair);
    expect(await git(cwd, 'rev-parse', 'HEAD')).toBe(sourceCommit);
    await git(cwd, 'merge', '--no-ff', '--no-edit', parentCommit);
    await f.project.workspaces.finish(f.store.ap(repair.id));
    const resolvedCommit = f.store.ap(repair.id).head_commit;
    expect(await f.project.workspaces.isAncestor(f.root, sourceCommit, resolvedCommit)).toBe(true);
    expect(await f.project.workspaces.isAncestor(f.root, parentCommit, resolvedCommit)).toBe(true);
    f.project.finish(repair.id, 'completed', 'both commits tested');

    // runtime 收尾：快进 say 分支到同时含两端固定提交的提交，并按当前父基线重新发请求。
    await until(() => {
      const value = JSON.parse(f.store.ap(say.ap.id).reservation);
      return value.status === 'requested' || value.blocked_code !== 'resolving';
    });
    const ready = JSON.parse(f.store.ap(say.ap.id).reservation);
    expect(ready).toMatchObject({ kind: 'merge', status: 'requested', commit: resolvedCommit, baseline: parentCommit });
    expect(f.store.ap(repair.id).integration).toBe('merged');
    expect(await git(f.root, 'rev-parse', say.ap.branch)).toBe(resolvedCommit);
    expect(await git(f.root, 'rev-parse', 'main')).toBe(parentCommit);
    expect(f.store.unread(say.ap.parent_id).some(row => row.signal_type === 'merge.requested')).toBe(true);

    await f.project.approveReservedMerge(say.ap.id, ready.commit, ready.baseline);
    expect(f.store.ap(say.ap.id).integration).toBe('merged');
    expect(await git(f.root, 'rev-parse', 'main')).toBe(resolvedCommit);
  } finally { await f.close(); }
});

test('showcase booking creates the child immediately and signals only once code and worktree are ready', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const say = await f.project.say('present later');
    f.store.update(say.ap.id, { status: 'waiting' });
    f.project.stopping = false; f.project.kick = () => {}; // create the child, but do not start a mock invocation
    const first = await f.project.reserveAP(say.ap.id, 'showcase');
    expect(first.reservation).toMatchObject({ kind: 'showcase', status: 'preparing' });
    expect(typeof first.reservation.child_id).toBe('number');
    const child = f.store.ap(first.reservation.child_id);
    expect(child).toMatchObject({ parent_id: say.ap.id, role: 'showcase', ap_kind: 'showcase', status: 'queued' });
    // 准备阶段完成（这里直接置为 waiting，不跑 mock 调用）后才会尝试发信号。
    f.store.update(child.id, { status: 'waiting' });
    expect(await f.project.signalReservedShowcase(say.ap.id)).toBe(false);
    expect(JSON.parse(f.store.ap(say.ap.id).reservation).blocked_reason).toContain('没有实际文件改动');
    fs.writeFileSync(path.join(say.ap.workspace, 'ready.txt'), 'ready\n');
    await git(say.ap.workspace, 'add', 'ready.txt'); await git(say.ap.workspace, 'commit', '-m', 'ready');
    const scratch = path.join(say.ap.workspace, 'uncommitted.tmp');
    fs.writeFileSync(scratch, 'user changes');
    await f.project.signalReservedShowcase(say.ap.id);
    expect(JSON.parse(f.store.ap(say.ap.id).reservation).blocked_reason).toContain('未提交修改');
    fs.unlinkSync(scratch); // only our temporary test project file
    const signaled = await f.project.signalReservedShowcase(say.ap.id);
    expect(signaled.id).toBe(first.reservation.child_id);
    expect(JSON.parse(f.store.ap(say.ap.id).reservation)).toMatchObject({ kind: 'showcase', status: 'started',
      child_id: first.reservation.child_id });
    expect(f.store.children(say.ap.id)).toHaveLength(1);
    expect(f.store.ap(say.ap.id).status).toBe('waiting');
  } finally { await f.close(); }
});

test('showcase reservation rechecks never duplicate a child and only signal after admission', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const say = await f.project.say('present once');
    f.store.update(say.ap.id, { status: 'waiting' });
    f.project.stopping = false; f.project.kick = () => {};
    const booked = await f.project.reserveAP(say.ap.id, 'showcase');
    f.store.update(booked.reservation.child_id, { status: 'waiting' });
    await f.project.signalReservedShowcase(say.ap.id);
    expect(JSON.parse(f.store.ap(say.ap.id).reservation).blocked_reason).toContain('没有实际文件改动');
    fs.writeFileSync(path.join(say.ap.workspace, 'view.txt'), 'new view\n');
    await git(say.ap.workspace, 'add', 'view.txt'); await git(say.ap.workspace, 'commit', '-m', 'view');
    const retried = await f.project.reserveAP(say.ap.id, 'showcase');
    expect(retried.changed).toBe(false);
    expect(retried.reservation).toMatchObject({ kind: 'showcase', status: 'started' });
    expect(retried.reservation.blocked_reason).toBeUndefined();
    expect(f.store.children(say.ap.id)).toHaveLength(1);
    f.project.recover();
    expect(f.store.children(say.ap.id)).toHaveLength(1);
  } finally { await f.close(); }
});

test('a failed showcase leaves the say and its worktree as visible failed delivery, without merging', async () => {
  const f = fixture({ run: async ({ ap, cwd }) => {
    if (ap.role === 'showcase') return 'no HTML delivered';
    fs.writeFileSync(path.join(cwd, 'change.txt'), 'change\n');
    await git(cwd, 'add', 'change.txt'); await git(cwd, 'commit', '-m', 'change');
    return 'built';
  } });
  await repo(f.root);
  try {
    const say = await f.project.say('show change');
    const baseline = await git(f.root, 'rev-parse', 'main');
    await f.project.reserveAP(say.ap.id, 'showcase');
    await until(() => f.store.ap(say.ap.id).status === 'failed');
    const parent = f.store.ap(say.ap.id), reservation = JSON.parse(parent.reservation);
    const child = f.store.ap(reservation.child_id);
    expect(reservation.status).toBe('failed');
    expect(child.status).toBe('failed');
    expect(parent.error).toContain('report.html');
    expect(fs.existsSync(say.ap.workspace)).toBe(true);
    expect(await git(f.root, 'rev-parse', 'main')).toBe(baseline);
    await expect(f.project.retry(child.id)).rejects.toThrow('cannot be retried under its ended parent');
    expect(() => f.project.retry(say.ap.id)).toThrow('cannot be retried separately');
  } finally { await f.close(); }
});

test('cancelling a presenting say cancels its showcase child before ending the parent', async () => {
  const go = gate();
  const f = fixture({ run: async ({ ap, cwd, context }) => {
    if (ap.role === 'showcase') { if (context.showcase.phase === 'preparing') return 'prepared'; await go.promise; return 'cancelled'; }
    fs.writeFileSync(path.join(cwd, 'cancel.txt'), 'ready\n');
    await git(cwd, 'add', 'cancel.txt'); await git(cwd, 'commit', '-m', 'cancel');
    return 'built';
  } });
  await repo(f.root);
  try {
    const say = await f.project.say('present then cancel');
    await f.project.reserveAP(say.ap.id, 'showcase');
    await until(() => JSON.parse(f.store.ap(say.ap.id).reservation).status === 'started');
    const childId = JSON.parse(f.store.ap(say.ap.id).reservation).child_id;
    f.project.cancel(say.ap.id, 'stop the presentation');
    expect(f.store.ap(childId).status).toBe('cancelled');
    expect(f.store.ap(say.ap.id).status).toBe('cancelled');
    expect(JSON.parse(f.store.ap(say.ap.id).reservation).status).toBe('cancelled');
    expect(f.store.children(say.ap.id).every(child => child.status === 'cancelled')).toBe(true);
  } finally { go.resolve(); await f.close(); }
});

test('a preparation-phase showcase failure settles the say instead of leaving it preparing', async () => {
  const f = fixture({ run: async ({ ap, cwd, context }) => {
    if (ap.role === 'showcase') {
      if (context.showcase.phase === 'preparing') throw new Error('prep blew up');
      return 'unreachable';
    }
    fs.writeFileSync(path.join(cwd, 'prep.txt'), 'ready\n');
    await git(cwd, 'add', 'prep.txt'); await git(cwd, 'commit', '-m', 'prep');
    return 'built';
  } });
  await repo(f.root);
  try {
    const say = await f.project.say('fail prep');
    await f.project.reserveAP(say.ap.id, 'showcase');
    await until(() => f.store.ap(say.ap.id).status === 'failed');
    const reservation = JSON.parse(f.store.ap(say.ap.id).reservation);
    expect(reservation.status).toBe('failed');
    expect(f.store.ap(reservation.child_id).status).toBe('failed');
    expect(f.store.ap(say.ap.id).error).toContain('prep blew up');
  } finally { await f.close(); }
});

test('recovery closes a say left in showcase started after its child committed settlement', async () => {
  const go = gate();
  const f = fixture({ run: async ({ ap, cwd, context }) => {
    if (ap.role === 'showcase') {
      if (context.showcase.phase === 'preparing') return 'prepared';
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
    await f.project.reserveAP(say.ap.id, 'showcase');
    await until(() => JSON.parse(f.store.ap(say.ap.id).reservation).status === 'started');
    const childId = JSON.parse(f.store.ap(say.ap.id).reservation).child_id;
    f.project.settleReservedShowcase = () => {}; // emulate a crash after child DB settlement, before parent DB settlement
    go.resolve();
    await until(() => f.store.ap(childId).status === 'completed');
    expect(f.store.ap(say.ap.id).status).toBe('waiting');
    f.project.settleReservedShowcase = settle;
    f.project.recover();
    expect(f.store.ap(say.ap.id).status).toBe('completed');
    f.project.recover();
    expect(f.store.all("SELECT id FROM events WHERE ap_id=? AND type='ap.showcase_settled'", say.ap.id)).toHaveLength(1);
  } finally { f.project.settleReservedShowcase = settle; go.resolve(); await f.close(); }
});

test('user approval rejects source and parent branch drift without advancing main', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const say = await f.project.say('prepare release');
    fs.writeFileSync(path.join(say.ap.workspace, 'release.txt'), 'ready\n');
    await git(say.ap.workspace, 'add', 'release.txt'); await git(say.ap.workspace, 'commit', '-m', 'release');
    f.store.update(say.ap.id, { status: 'waiting' });
    const { reservation } = await f.project.reserveAP(say.ap.id, 'merge');
    expect(reservation.status).toBe('requested');
    await git(f.root, 'commit', '--allow-empty', '-m', 'external parent change');
    await expect(f.project.approveReservedMerge(say.ap.id, reservation.commit, reservation.baseline))
      .rejects.toThrow('parent branch moved');
    await git(say.ap.workspace, 'commit', '--allow-empty', '-m', 'late change');
    await expect(f.project.approveReservedMerge(say.ap.id, reservation.commit, reservation.baseline))
      .rejects.toThrow('source branch moved');
    expect(await git(f.root, 'rev-parse', 'main')).not.toBe(reservation.commit);
    expect(f.store.ap(say.ap.id).integration).toBe('pending');
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

test('new say AP can spawn independent agent child and its settlement sends a typed parent signal', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const say = await f.project.say('develop');
    const child = f.project.spawn(say.ap.id, 'review changes', 'agent', [], 'review');
    expect(child).toMatchObject({ role: 'agent', ap_kind: 'child', parent_id: say.ap.id });
    const workspace = await f.project.workspaces.ensure(child);
    const stored = f.store.ap(child.id);
    expect(stored.target_branch).toBe(say.ap.branch);
    expect(f.store.branch(stored.branch).parent).toBe(say.ap.branch);
    expect(workspace).not.toBe(say.ap.workspace);
    f.project.finish(child.id, 'completed', 'child done');
    expect(f.store.ap(say.ap.id).status).toBe('queued');
    const unread = f.store.unread(say.ap.id);
    expect(unread).toHaveLength(1);
    expect(unread[0].signal_type).toBe('child.completed');
    expect(JSON.parse(unread[0].body).payload.result).toBe('child done');
    f.project.finish(child.id, 'completed', 'duplicate');
    expect(f.store.unread(say.ap.id)).toHaveLength(1);
    await expect(f.project.approveMerge(child.id)).rejects.toThrow('parent confirmation');
    await expect(f.project.approveBranchMerge(stored.branch)).rejects.toThrow('legacy branch.merge');
    expect(await git(f.root, 'rev-parse', 'main')).toBe(say.anchor.commit);
  } finally { await f.close(); }
});

test('graph plots a spawned agent child as its own AP node, but not the main root', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const say = await f.project.say('develop');
    const child = f.project.spawn(say.ap.id, 'review changes', 'agent', [], 'review');
    await f.project.workspaces.ensure(child);
    const stored = f.store.ap(child.id);
    const graph = await f.project.graph();
    // child 有自己的分支与 worktree，必须像 say 一样画成 AP 行，否则分支节点报有 AP 却点不进去。
    expect(graph.nodes.find(node => node.kind === 'ap' && node.id === child.id)).toMatchObject({
      role: 'agent', ap_kind: 'child', parent_id: say.ap.id, branch: stored.branch,
    });
    expect(graph.nodes.find(node => node.kind === 'branch' && node.name === stored.branch).aps.total).toBe(1);
    // main/owner 根 AP 是分支所有者而不是工作分支：信息在 branch 节点上，不重复画成 AP 行。
    expect(graph.nodes.find(node => node.kind === 'ap' && node.id === say.ap.parent_id)).toBeUndefined();
  } finally { await f.close(); }
});

test('only the running direct parent Agent can integrate a frozen completed child with ff-only', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const say = await f.project.say('develop');
    const child = f.project.spawn(say.ap.id, 'write child code', 'agent', [], 'write-child');
    const workspace = await f.project.workspaces.ensure(child);
    fs.writeFileSync(path.join(workspace, 'child.txt'), 'work\n');
    await git(workspace, 'add', 'child.txt'); await git(workspace, 'commit', '-m', 'child work');
    await f.project.workspaces.finish(f.store.ap(child.id));
    f.project.finish(child.id, 'completed', 'written');
    const commit = f.store.ap(child.id).head_commit;
    expect(commit).toBe(await git(workspace, 'rev-parse', 'HEAD'));
    await expect(f.project.integrateChild(say.ap.id, child.id, commit)).rejects.toThrow('must be running');
    f.store.update(say.ap.id, { status: 'running' });
    await expect(f.project.integrateChild(say.ap.id, child.id, 'a'.repeat(40))).rejects.toThrow('fixed head_commit');
    const mainBefore = await git(f.root, 'rev-parse', 'main');
    const outcome = await f.project.integrateChild(say.ap.id, child.id, commit);
    expect(outcome.child.integration).toBe('merged');
    expect(await git(say.ap.workspace, 'rev-parse', 'HEAD')).toBe(commit);
    expect(await git(f.root, 'rev-parse', 'main')).toBe(mainBefore);
    expect((await f.project.integrateChild(say.ap.id, child.id, commit)).merge.already_integrated).toBe(true);
    await expect(new Dispatcher(f.project).dispatch('ap.integrate', { id: child.id, commit }))
      .rejects.toThrow('agent only');
  } finally { await f.close(); }
});

test('child branch drift rejects the fixed commit without moving the parent', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const say = await f.project.say('develop');
    const child = f.project.spawn(say.ap.id, 'write child code', 'agent', [], 'write-child');
    const workspace = await f.project.workspaces.ensure(child);
    fs.writeFileSync(path.join(workspace, 'child.txt'), 'first\n');
    await git(workspace, 'add', 'child.txt'); await git(workspace, 'commit', '-m', 'first');
    await f.project.workspaces.finish(f.store.ap(child.id));
    f.project.finish(child.id, 'completed', 'written');
    const commit = f.store.ap(child.id).head_commit;
    fs.writeFileSync(path.join(workspace, 'child.txt'), 'second\n');
    await git(workspace, 'add', 'child.txt'); await git(workspace, 'commit', '-m', 'second');
    f.store.update(say.ap.id, { status: 'running' });
    await expect(f.project.integrateChild(say.ap.id, child.id, commit)).rejects.toThrow('moved');
    expect(await git(say.ap.workspace, 'rev-parse', 'HEAD')).toBe(say.anchor.commit);
    expect(f.store.ap(child.id).integration).not.toBe('merged');
  } finally { await f.close(); }
});

test('say.submit is user-only and preserves old input.submit as a separate legacy path', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const dispatcher = new Dispatcher(f.project);
    const draft = f.project.draft('draft only');
    await expect(dispatcher.dispatch('say.submit', { draft_id: draft.id, content: 'not allowed' })).rejects.toThrow('cannot be combined');
    const sent = await dispatcher.dispatch('say.submit', { draft_id: draft.id });
    expect(sent.ap.ap_kind).toBe('say');
    expect(f.store.draft(draft.id).input_id).toBe(sent.id);
    const legacy = await dispatcher.dispatch('input.submit', { content: 'legacy request' });
    expect(legacy.ap.role).toBe('planner');
    expect(legacy.ap.ap_kind).toBeNull();
    await expect(dispatcher.dispatch('say.submit', { content: 'bad', _token: 'fake' })).rejects.toThrow();
  } finally { await f.close(); }
});

test('say Agent becomes idle after a call, can wake again, and can own another say child without waking main', async () => {
  const f = fixture(); await repo(f.root);
  try {
    const sent = await f.project.say('simple answer');
    await until(() => f.store.ap(sent.ap.id).status === 'waiting' && f.store.ap(sent.ap.id).calls === 1);
    expect(f.store.ap(sent.ap.id).head_commit).toBe(sent.anchor.commit);
    expect(f.store.ap(sent.ap.id).integration).toBe('none');
    expect(f.store.ap(sent.ap.parent_id)).toMatchObject({ status: 'waiting', calls: 0 });
    expect(f.store.unread(sent.ap.parent_id)).toEqual([]);
    f.project.message(sent.ap.id, 'please continue');
    await until(() => f.store.ap(sent.ap.id).status === 'waiting' && f.store.ap(sent.ap.id).calls === 2);
    const next = await f.project.say('follow-up on this branch', sent.ap.branch);
    expect(next.ap.parent_id).toBe(sent.ap.id);
    expect(next.ap.workspace).not.toBe(sent.ap.workspace);
    expect(f.store.get("SELECT count(*) AS n FROM aps WHERE role='planner'").n).toBe(0);
  } finally { await f.close(); }
});

test('user marks a no-change say resolved: completed + integration none, answer kept, one info notice', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const sent = await f.project.say('只是想了解：预约是怎么工作的？');
    f.store.update(sent.ap.id, { status: 'waiting', result: '预约是 say 上的一种互斥意图。' });
    const before = f.store.ap(sent.ap.id);
    const resolved = await new Dispatcher(f.project).dispatch('ap.resolve', { id: sent.ap.id });
    expect(resolved).toMatchObject({ status: 'completed', integration: 'none', reservation: null,
      result: '预约是 say 上的一种互斥意图。', branch: before.branch, base_commit: before.base_commit });
    expect(resolved.head_commit).toBe(before.base_commit);
    expect(f.store.all("SELECT id FROM events WHERE ap_id=? AND type='ap.resolved'", sent.ap.id)).toHaveLength(1);
    const notices = f.store.all("SELECT * FROM notices WHERE ap_id=? AND kind='info'", sent.ap.id);
    expect(notices).toHaveLength(1);
    expect(notices[0].title).toContain(`分支 ${before.branch}`);
    expect(notices[0].body).toContain('没有记录到需要合入父分支的改动');
    // 终态不能重复结算，也不能再被 message 唤醒。
    await expect(f.project.resolveAP(sent.ap.id)).rejects.toThrow('already ended');
  } finally { await f.close(); }
});

test('resolving a say refuses committed work, in-flight delivery, and active invocations; user-only', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const committed = await f.project.say('写点东西');
    f.store.update(committed.ap.id, { status: 'waiting' });
    fs.writeFileSync(path.join(committed.ap.workspace, 'work.txt'), 'work\n');
    await git(committed.ap.workspace, 'add', 'work.txt');
    await git(committed.ap.workspace, 'commit', '-m', 'work');
    await expect(f.project.resolveAP(committed.ap.id)).rejects.toThrow('已经有提交');
    expect(f.store.ap(committed.ap.id).status).toBe('waiting');

    // 先建好全部 say，再伪造各态：requested 预约会冻结 main，之后就不能再往 main 发 say。
    const requested = await f.project.say('已经请求合并');
    const shown = await f.project.say('预约了展示');
    const busy = await f.project.say('正在调用');

    f.store.update(requested.ap.id, { status: 'waiting', reservation: JSON.stringify({ version: 1, kind: 'merge',
      status: 'requested', commit: 'a'.repeat(40), baseline: 'b'.repeat(40), parent_id: 1 }) });
    await expect(f.project.resolveAP(requested.ap.id)).rejects.toThrow('合并请求');

    f.store.update(shown.ap.id, { status: 'waiting', reservation: JSON.stringify({ version: 1, kind: 'showcase',
      status: 'preparing', child_id: 1 }) });
    await expect(f.project.resolveAP(shown.ap.id)).rejects.toThrow('展示预约');

    f.store.update(busy.ap.id, { status: 'running' });
    f.project.running.set(busy.ap.id, { controller: new AbortController() });
    try { await expect(f.project.resolveAP(busy.ap.id)).rejects.toThrow('正在调用'); }
    finally { f.project.running.delete(busy.ap.id); }

    expect(() => assertAllowed('ap.resolve', { id: busy.ap.id }, busy.ap.id)).toThrow('requires user approval');
  } finally { await f.close(); }
});
