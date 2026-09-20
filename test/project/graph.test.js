import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, git } from '../helpers.js';
import { setup, change } from '../workspaces/harness.js';

// 分支图读模型：节点 / 边 / ahead-behind / merged / 缺失容错 / 只读 / 上限。
// 每个用例自给自足：setup() 造一个真 git 仓库 + 一个可派活的 coordinator 父任务。

test('graph reports code stacking, ahead/behind and merge state', async () => {
  const f = await setup();
  try {
    const task = f.task;
    await change(f, task, 'A\n');
    const child = f.project.spawn(task.parent_id, 'continue on top', 'worker', [{ id: task.id, kind: 'code' }], 'stacked');
    await change(f, child, 'B\n');

    const graph = await f.project.graph();
    expect(graph.git).toBe(true);
    expect(graph.error).toBeNull();
    expect(graph.current_branch).toBe('main');
    const nodes = new Map(graph.nodes.map(node => [node.id, node]));
    const upstream = nodes.get(task.id);
    const downstream = nodes.get(child.id);
    expect(upstream.kind).toBe('task');
    expect(upstream.branch_state).toBe('present');
    expect(upstream.workspace_state).toBe('present');
    expect(upstream.ahead).toBe(1); expect(upstream.behind).toBe(0); expect(upstream.merged).toBe(false);
    expect(downstream.target_branch).toBe('main');
    expect(downstream.ahead).toBe(2); expect(downstream.merged).toBe(false);
    expect(downstream.current).toBe(false);

    const mainBranch = graph.nodes.find(node => node.kind === 'branch' && node.name === 'main');
    expect(mainBranch.id).toBe('branch:main');
    expect(mainBranch.current).toBe(true);

    expect(graph.edges).toContainEqual({ kind: 'code', from: task.id, to: child.id });
    expect(graph.edges).toContainEqual({ kind: 'target', from: task.id, to: 'branch:main' });
    expect(graph.edges).toContainEqual({ kind: 'target', from: child.id, to: 'branch:main' });

    // 上游落地后：merged=true，ahead 归零；下游仍领先一条自己的提交。
    await f.project.workspaces.merge(task.id);
    const after = await f.project.graph();
    const byId = new Map(after.nodes.map(node => [node.id, node]));
    expect(byId.get(task.id).merged).toBe(true);
    expect(byId.get(task.id).ahead).toBe(0); expect(byId.get(task.id).behind).toBe(0);
    expect(byId.get(child.id).merged).toBe(false);
    expect(byId.get(child.id).ahead).toBe(1);
  } finally { await f.close(); }
});

test('graph carries resolve and verify edges and tolerates missing worktree/branch', async () => {
  const f = await setup();
  try {
    await change(f, f.task, 'A\n');
    const merger = f.store.create({ input_id: null, role: 'merger', goal: 'resolve x', name: 'resolve-x', resolves_task_id: f.task.id });
    f.store.update(merger.id, { branch: 'lush/test/resolve-x', workspace: path.join(f.config.home, 'worktrees', 'gone-merger') });
    const verifier = f.store.create({ input_id: null, role: 'verifier', goal: 'verify x', name: 'verify-x', verifies_task_id: f.task.id });
    f.store.update(verifier.id, { baseline_workspace: path.join(f.config.home, 'worktrees', 'gone-baseline') });

    const graph = await f.project.graph();
    expect(graph.edges).toContainEqual({ kind: 'resolve', from: merger.id, to: f.task.id });
    expect(graph.edges).toContainEqual({ kind: 'verify', from: verifier.id, to: f.task.id });
    const mergerNode = graph.nodes.find(node => node.id === merger.id);
    expect(mergerNode.workspace_state).toBe('missing');
    expect(mergerNode.branch_state).toBe('missing');
    const verifierNode = graph.nodes.find(node => node.id === verifier.id);
    expect(verifierNode).toBeTruthy();
    expect(verifierNode.workspace_state).toBe('missing');

    // 目录是在跑图之后才被删的：下一次取值报 missing，而且不抛。
    const worker = f.store.task(f.task.id);
    fs.rmSync(worker.workspace, { recursive: true, force: true });
    const again = await f.project.graph();
    expect(again.nodes.find(node => node.id === f.task.id).workspace_state).toBe('missing');
  } finally { await f.close(); }
});

test('graph covers recorded branches, untracked refs and placeholder parents with fork edges', async () => {
  const f = await setup();
  try {
    // 模拟提交输入时创建的锚点分支：有记录、没有任务、parent 是 main（不调用主树未提交的 anchor）。
    f.store.recordBranch({ branch: 'lush/test/input-1-anchor', parent: 'main', worktree: path.join(f.config.home, 'worktrees', 'anchor') });
    // 用户在 git 里新建、既没记录也没任务的本地分支。
    await git(f.root, 'branch', 'feature/scratch');
    // 记录里提到、却既无记录也无 ref 的父分支名：补占位节点，不让子分支从图上掉下去。
    f.store.recordBranch({ branch: 'lush/test/orphan-child', parent: 'lush/test/gone-parent' });

    const graph = await f.project.graph();
    expect(graph.git).toBe(true);
    const nodes = new Map(graph.nodes.map(node => [node.id, node]));

    // branches 表的每条记录都有 branch 节点：没有 ref 的锚点也在，head_commit 现算成 null。
    const anchor = nodes.get('branch:lush/test/input-1-anchor');
    expect(anchor).toMatchObject({ kind: 'branch', current: false, tracked: true, placeholder: false, head_commit: null });
    expect(nodes.get('branch:lush/test/orphan-child')).toMatchObject({ kind: 'branch', tracked: true });

    // 有 ref 但没有记录的本地分支：tracked:false，head_commit 与 current 现算。
    const scratch = nodes.get('branch:feature/scratch');
    expect(scratch).toMatchObject({ kind: 'branch', tracked: false, placeholder: false, current: false });
    expect(scratch.head_commit).toBe(await git(f.root, 'rev-parse', 'refs/heads/feature/scratch'));
    expect(nodes.get('branch:main')).toMatchObject({ current: true, tracked: false });

    // 只被 parent 指针提到的名字：占位节点，不假装分支还在。
    const gone = nodes.get('branch:lush/test/gone-parent');
    expect(gone).toMatchObject({ kind: 'branch', tracked: false, placeholder: true, head_commit: null });

    // 谱系边：记录了 parent 的分支都给出 fork 边，两端都在节点集合里（含占位父）。
    expect(graph.edges).toContainEqual({ kind: 'fork', from: 'branch:main', to: 'branch:lush/test/input-1-anchor' });
    expect(graph.edges).toContainEqual({ kind: 'fork', from: 'branch:lush/test/gone-parent', to: 'branch:lush/test/orphan-child' });
  } finally { await f.close(); }
});

test('graph returns an empty, non-throwing result for a non-git project', async () => {
  const f = fixture();
  try {
    f.project.stopping = true;
    const graph = await f.project.graph();
    expect(graph.git).toBe(false);
    expect(graph.error).toBeTruthy();
    expect(graph.nodes).toEqual([]);
    expect(graph.edges).toEqual([]);
    expect(graph.truncated).toBe(false);
  } finally { await f.close(); }
});

test('graph is read-only: it never changes the main tree, its HEAD, or the event log', async () => {
  const f = await setup();
  try {
    await change(f, f.task, 'A\n');
    const beforeStatus = await git(f.root, 'status', '--porcelain');
    const beforeHead = await git(f.root, 'rev-parse', 'HEAD');
    const beforeEvents = f.store.get('SELECT count(*) AS c FROM events').c;
    await f.project.graph();
    expect(await git(f.root, 'status', '--porcelain')).toBe(beforeStatus);
    expect(await git(f.root, 'rev-parse', 'HEAD')).toBe(beforeHead);
    expect(f.store.get('SELECT count(*) AS c FROM events').c).toBe(beforeEvents);
  } finally { await f.close(); }
});

test('graph caps nodes at 200 and marks the result truncated', async () => {
  const f = await setup();
  try {
    for (let index = 0; index < 205; index += 1) {
      const task = f.store.create({ input_id: null, role: 'worker', goal: `task ${index}` });
      f.store.update(task.id, { branch: `lush/test/${task.id}-node` });
    }
    const graph = await f.project.graph();
    expect(graph.truncated).toBe(true);
    expect(graph.nodes.length).toBe(200);
    // 当前检出分支一定在（给分支节点预留了额度）。
    expect(graph.nodes.some(node => node.kind === 'branch' && node.name === 'main')).toBe(true);
  } finally { await f.close(); }
});

test('graph caps edges at 2000 and marks the result truncated', async () => {
  const f = await setup();
  try {
    const created = [];
    for (let index = 0; index < 70; index += 1) {
      const task = f.store.create({ input_id: null, role: 'worker', goal: `task ${index}` });
      f.store.update(task.id, { branch: `lush/test/${task.id}-edge` });
      created.push(task.id);
    }
    f.store.transaction(() => {
      for (let i = 0; i < created.length; i += 1) {
        for (let j = i + 1; j < created.length; j += 1) f.store.addDep(created[j], created[i], 'order');
      }
    });
    const graph = await f.project.graph();
    expect(graph.truncated).toBe(true);
    expect(graph.edges.length).toBe(2000);
    expect(graph.edges.every(edge => edge.kind === 'order')).toBe(true);
  } finally { await f.close(); }
});
