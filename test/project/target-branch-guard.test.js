import { test, expect, setDefaultTimeout } from 'bun:test';
setDefaultTimeout(15000);
import fs from 'node:fs';
import path from 'node:path';
import { fixture, repo, git, gate, until } from '../helpers.js';

const run = (f, id) => f.project.invoke(id, { controller: new AbortController(), token: 'test', recordId: null });
const movedEvent = (f, id) => f.store.history(id).find(event => event.type === 'invocation.target_branch_moved');

test('agent 越过 worktree 直接把提交写进目标分支时，调用按失败处理并保留现场', async () => {
  let target = null;
  const f = fixture({ resolve: () => ({ agent: 'mock' }), async run() {
    fs.writeFileSync(path.join(f.root, 'rogue.txt'), 'rogue\n');
    await git(f.root, 'add', 'rogue.txt');
    await git(f.root, 'commit', '-m', 'rogue direct commit');
    return 'done';
  } });
  f.project.stopping = true; await repo(f.root);
  try {
    const order = (await f.project.order('guarded order')).task;
    f.store.update(order.id, { status: 'waiting' });
    await run(f, order.id);
    target = f.store.task(order.id);
    expect(target.status).toBe('failed');
    expect(target.error).toContain('目标分支 main');
    const event = movedEvent(f, order.id);
    expect(event).toBeTruthy();
    expect(event.data).toMatchObject({ branch: 'main' });
    expect(event.data.commits.join('\n')).toContain('rogue direct commit');
    // 保留现场：越界提交仍在 main，worker 的 worktree 没有被清理。
    expect(await git(f.root, 'log', '--oneline', '-1')).toContain('rogue direct commit');
    expect(fs.existsSync(target.workspace)).toBe(true);
  } finally { await f.close(); }
});

test('只在自己的 worktree 内提交不会被目标分支防护误判', async () => {
  const f = fixture({ resolve: () => ({ agent: 'mock' }), async run({ cwd }) {
    fs.writeFileSync(path.join(cwd, 'own.txt'), 'own\n');
    await git(cwd, 'add', 'own.txt');
    await git(cwd, 'commit', '-m', 'own worktree commit');
    return 'done';
  } });
  f.project.stopping = true; await repo(f.root);
  try {
    const order = (await f.project.order('normal order')).task;
    f.store.update(order.id, { status: 'waiting' });
    await run(f, order.id);
    const live = f.store.task(order.id);
    expect(live.status).not.toBe('failed');
    expect(movedEvent(f, order.id)).toBeFalsy();
    // main 没动，改动留在 worker 自己的分支上。
    expect(await git(f.root, 'log', '--oneline', '-1')).toContain('initial');
    expect(live.head_commit).not.toBe(live.base_commit);
  } finally { await f.close(); }
});

test('daemon 经 Workspaces 成功写入目标分支提供精确转移，不作为越界', async () => {
  const f = fixture({ resolve: () => ({ agent: 'mock' }), async run({ api }) {
    // 模拟一次交付推进：走 daemon 的 Workspaces，记录此 ref 的实际转移。
    await api.workspaces.git(api.config.project, 'commit', '--allow-empty', '-m', 'delivery-like landing');
    return 'done';
  } });
  f.project.stopping = true; await repo(f.root);
  try {
    const order = (await f.project.order('delivery during run')).task;
    f.store.update(order.id, { status: 'waiting' });
    await run(f, order.id);
    expect(f.store.task(order.id).status).not.toBe('failed');
    expect(movedEvent(f, order.id)).toBeFalsy();
    expect(await git(f.root, 'log', '--oneline', '-1')).toContain('delivery-like landing');
  } finally { await f.close(); }
});

const commit = async (cwd, message) => git(cwd, 'commit', '--allow-empty', '-m', message);
const releasedEvidence = f => {
  expect(f.project.workspaces.refWatches.size).toBe(0);
  expect(f.project.workspaces.refOwners.size).toBe(0);
  expect(f.project.workspaces.refWrites.size).toBe(0);
};

for (const timing of ['parent still active', 'parent returned first', 'child starts after first commit', 'parent invoked twice', 'unattributed move after parent']) {
  test(`父自己的合法提交不会依赖子结束时的 running 状态：${timing}`, async () => {
    const parentStarted = gate(), childStarted = gate(), allowParentCommit = gate(), parentCommitted = gate(), releaseParent = gate();
    let parent, parentPromise, childPromise;
    const f = fixture({ resolve: () => ({ agent: 'mock' }), async run({ task, cwd }) {
      if (task.id === parent.id) {
        if (timing === 'child starts after first commit') await commit(cwd, 'parent commit before child snapshot');
        parentStarted.resolve(); await allowParentCommit.promise;
        await commit(cwd, `legal parent call ${task.calls}`); parentCommitted.resolve();
        if (timing === 'parent still active') await releaseParent.promise;
        return 'parent waiting for child';
      }
      childStarted.resolve(); await parentCommitted.promise;
      if (timing !== 'parent still active') await parentPromise;
      if (timing === 'parent invoked twice') await run(f, parent.id);
      if (timing === 'unattributed move after parent') await commit(parent.workspace, 'rogue after parent returned');
      await commit(cwd, 'own child commit');
      return 'child done';
    } });
    f.project.stopping = true; await repo(f.root);
    try {
      parent = (await f.project.order('parent owns branch')).task;
      f.store.update(parent.id, { status: 'waiting' });
      const child = await f.project.spawn(parent.id, 'child under parent');
      f.store.update(child.id, { status: 'waiting' });
      parentPromise = run(f, parent.id); await parentStarted.promise;
      childPromise = run(f, child.id); await childStarted.promise;
      allowParentCommit.resolve(); await childPromise;
      const shouldFail = timing === 'unattributed move after parent';
      expect(f.store.task(child.id).status === 'failed').toBe(shouldFail);
      expect(Boolean(movedEvent(f, child.id))).toBe(shouldFail);
      const observations = f.store.history(parent.id).filter(event => event.type === 'invocation.branch_observed');
      expect(observations.length).toBe(['parent invoked twice', 'child starts after first commit'].includes(timing) ? 2 : 1);
      expect(observations[0].data).toMatchObject({ branch: parent.branch, source: 'worker_ownership_window' });
      expect(observations[0].data.run_id).toBeNumber();
      releaseParent.resolve(); await parentPromise;
      expect(await git(child.workspace, 'log', '--oneline', '-1')).toContain('own child commit');
      releasedEvidence(f);
    } finally {
      allowParentCommit.resolve(); parentCommitted.resolve(); releaseParent.resolve();
      await Promise.allSettled([parentPromise, childPromise].filter(Boolean)); await f.close();
    }
  });
}

for (const distraction of ['other branch', 'failed target write', 'commit-tree', 'snapshot ref', 'legal target before rogue', 'legal target after rogue']) {
  test(`无关或不完整 daemon 转移不能抵消目标分支异常：${distraction}`, async () => {
    const f = fixture({ resolve: () => ({ agent: 'mock' }), async run({ api, cwd }) {
      const project = api.config.project;
      if (distraction === 'other branch') await api.workspaces.git(cwd, 'commit', '--allow-empty', '-m', 'unrelated own branch');
      if (distraction === 'failed target write') await expect(api.workspaces.git(project, 'commit', '--invalid-guard-option')).rejects.toThrow();
      if (distraction === 'commit-tree' || distraction === 'snapshot ref') {
        const head = await git(project, 'rev-parse', 'HEAD');
        const tree = await git(project, 'rev-parse', 'HEAD^{tree}');
        const object = await api.workspaces.git(project, 'commit-tree', tree, '-p', head, '-m', 'object only');
        if (distraction === 'snapshot ref') await api.workspaces.git(project, 'update-ref', 'refs/lush/choice-snapshots/99', object);
      }
      if (distraction === 'legal target before rogue') await api.workspaces.git(project, 'commit', '--allow-empty', '-m', 'legitimate target');
      await commit(project, 'rogue target movement');
      if (distraction === 'legal target after rogue') await api.workspaces.git(project, 'commit', '--allow-empty', '-m', 'legitimate target');
      return 'done';
    } });
    f.project.stopping = true; await repo(f.root);
    try {
      const order = (await f.project.order('guard exact ref')).task;
      f.store.update(order.id, { status: 'waiting' }); await run(f, order.id);
      expect(f.store.task(order.id).status).toBe('failed');
      expect(f.store.task(order.id).error).toContain('未归因');
      expect(movedEvent(f, order.id).data.reason).toBe('unattributed_ref_movement');
      expect(await git(f.root, 'log', '--oneline', '-2')).toContain('rogue target movement');
      releasedEvidence(f);
    } finally { await f.close(); }
  });
}

for (const level of ['merge', 'accept', 'archive']) test(`项目新指令默认 ${level} 不会把未归因目标移动推进到自动链`, async () => {
  const f = fixture({ resolve: () => ({ agent: 'mock' }), async run({ api, cwd }) {
    await commit(cwd, 'own work under project defaults');
    await commit(api.config.project, 'unattributed target under project defaults');
    return 'must not auto-complete';
  } });
  f.project.stopping = true; await repo(f.root);
  try {
    f.project.setCompletionDefaults(true, level, f.project.completionDefaults().revision);
    const order = (await f.project.order(`new order default ${level}`)).task;
    expect(f.project.taskHooks(order.id).completion.level).toBe(level);
    f.project.stopping = false; f.project.kick();
    await until(() => f.store.task(order.id).status === 'failed' && !f.project.running.has(order.id), 10000);
    await f.project.completionQueue;
    expect(movedEvent(f, order.id).data.reason).toBe('unattributed_ref_movement');
    expect(f.store.history(order.id).filter(event => ['task.merge_integrated', 'task.accepted', 'branch.archive'].includes(event.type))).toEqual([]);
    expect(f.store.branch(order.branch).status).toBe('active');
    expect(fs.existsSync(order.workspace)).toBe(true);
    releasedEvidence(f);
  } finally { await f.close(); }
});

test('provider 提交自己的分支后失败，保留观测和现场但释放所有调用期状态', async () => {
  const f = fixture({ resolve: () => ({ agent: 'mock' }), async run({ cwd }) {
    await commit(cwd, 'preserve failed invocation work'); throw new Error('provider failed after own commit');
  } });
  f.project.stopping = true; await repo(f.root);
  try {
    const order = (await f.project.order('failed provider')).task;
    f.store.update(order.id, { status: 'waiting' }); await run(f, order.id);
    expect(f.store.task(order.id).status).toBe('failed');
    expect(f.store.task(order.id).error).toBe('provider failed after own commit');
    expect(f.store.history(order.id).some(event => event.type === 'invocation.branch_observed')).toBe(true);
    expect(await git(order.workspace, 'log', '--oneline', '-1')).toContain('preserve failed invocation work');
    expect(movedEvent(f, order.id)).toBeFalsy();
    releasedEvidence(f);
  } finally { await f.close(); }
});

test('仅 running Map 中的父身份没有观测证据时，不能豁免目标移动', async () => {
  let parent;
  const f = fixture({ resolve: () => ({ agent: 'mock' }), async run() {
    await commit(parent.workspace, 'unattributed target despite running entry'); return 'done';
  } });
  f.project.stopping = true; await repo(f.root);
  try {
    parent = (await f.project.order('parent')).task;
    f.store.update(parent.id, { status: 'waiting' });
    const child = await f.project.spawn(parent.id, 'child'); f.store.update(child.id, { status: 'waiting' });
    f.project.running.set(parent.id, {});
    await run(f, child.id);
    expect(f.store.task(child.id).status).toBe('failed');
    expect(movedEvent(f, child.id)).toBeTruthy();
    releasedEvidence(f);
  } finally { if (parent) f.project.running.delete(parent.id); await f.close(); }
});
