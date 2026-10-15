import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, git } from '../helpers.js';
import { setup, change } from '../workspaces/harness.js';
import { Dispatcher } from '../../src/rpc/dispatcher.js';

// 分支图读模型：节点 / 边 / ahead-behind / merged / 缺失容错 / 只读 / 上限。
// 每个用例自给自足：setup() 造一个真 git 仓库 + 一个可派活的 coordinator 父任务。

test('graph reports branch stacking, ahead/behind and merge state', async () => {
  const f = await setup();
  try {
    const task = f.task;
    f.project.reportProgressPlan(task.id, [
      { key: 'inspect', label: '确认现状' }, { key: 'implement', label: '实现功能' }, { key: 'test', label: '运行测试' },
    ]);
    f.project.completeProgressStep(task.id, 'inspect');
    await change(f, task, 'A\n');
    // 派活只发生在还没结算的父 Task 上：父分支上已经有 A，child 从这里长出来。
    f.store.update(task.id, { status: 'waiting' });
    const child = await f.project.spawn(task.id, 'continue on top', undefined, [], 'stacked');
    await change(f, child, 'B\n');
    f.store.update(task.id, { status: 'completed' });

    const graph = await f.project.graph();
    expect(graph.git).toBe(true);
    expect(graph.error).toBeNull();
    expect(graph.current_branch).toBe('main');
    const nodes = new Map(graph.nodes.map(node => [node.id, node]));
    const upstream = nodes.get(task.id);
    const downstream = nodes.get(child.id);
    expect(upstream.kind).toBe('task');
    expect(upstream.progress).toMatchObject({ completed: 1, total: 3, current: { key: 'implement', label: '实现功能' } });
    expect(upstream.progress.current.started_at).toBeTruthy();
    expect(upstream.progress_plan).toBeUndefined();
    expect(upstream.branch_state).toBe('present');
    expect(upstream.workspace_state).toBe('present');
    expect(upstream.ahead).toBe(1); expect(upstream.behind).toBe(0); expect(upstream.merged).toBe(false);
    expect(downstream.target_branch).toBe(upstream.branch);
    expect(downstream.ahead).toBe(1); expect(downstream.merged).toBe(false);
    expect(downstream.current).toBe(false);

    const mainBranch = graph.nodes.find(node => node.kind === 'branch' && node.name === 'main');
    expect(mainBranch.id).toBe('branch:main');
    expect(mainBranch.current).toBe(true);
    const branchChanges = graph.nodes.find(node => node.name === upstream.branch)?.diagnostics?.changes;
    expect(branchChanges).toMatchObject({ status: 'ok', files_total: 1, added: 1, deleted: 1 });
    expect(branchChanges.base_commit).toBe(f.store.branch(upstream.branch).created_from_commit);
    expect(mainBranch.diagnostics.changes.reason).toBe('missing_baseline');

    // 新模型没有依赖边：父子分支关系写在 branches.parent 上，图里以 fork 边表达。
    expect(graph.edges).toContainEqual(expect.objectContaining({ kind: 'fork',
      from: `branch:${upstream.branch}`, to: `branch:${f.store.task(child.id).branch}` }));
    expect(graph.edges).toContainEqual({ kind: 'target', from: task.id, to: `branch:${f.store.task(task.id).target_branch}` });
    expect(graph.edges).toContainEqual({ kind: 'target', from: child.id, to: `branch:${f.store.task(child.id).target_branch}` });

    // 子分支没合拢之前父分支合不动（活约束）：先落子分支，再落父分支，两次过渡都能看出来。
    await f.project.workspaces.merge(child.id);
    const afterChild = await f.project.graph();
    const childById = new Map(afterChild.nodes.map(node => [node.id, node]));
    expect(childById.get(child.id).merged).toBe(true);
    expect(childById.get(child.id).ahead).toBe(0);

    await f.project.workspaces.merge(task.id);
    const after = await f.project.graph();
    const byId = new Map(after.nodes.map(node => [node.id, node]));
    expect(byId.get(task.id).merged).toBe(true);
    expect(byId.get(task.id).ahead).toBe(0); expect(byId.get(task.id).behind).toBe(0);
    expect(byId.get(child.id).merged).toBe(true);
    // 合入父分支后仍是「相对创建起点」的规模，不随着 ahead 归零（分支 tip 本身已经前进）。
    expect(after.nodes.find(node => node.name === upstream.branch)?.diagnostics?.changes)
      .toMatchObject({ status: branchChanges.status, files_total: branchChanges.files_total,
        added: branchChanges.added, deleted: branchChanges.deleted, base_commit: branchChanges.base_commit });
  } finally { await f.close(); }
});

test('graph caps nodes at 200 and marks the result truncated', async () => {
  const f = await setup();
  try {
    f.store.transaction(() => {
      for (let index = 0; index < 205; index += 1) {
        const task = f.store.create({ input_id: null, role: 'worker', goal: `task ${index}` });
        f.store.update(task.id, { branch: `lush/test/${task.id}-node` });
      }
    });
    const graph = await f.project.graph();
    expect(graph.truncated).toBe(true);
    expect(graph.nodes.length).toBe(200);
    // 当前检出分支一定在（给分支节点预留了额度）。
    expect(graph.nodes.some(node => node.kind === 'branch' && node.name === 'main')).toBe(true);
  } finally { await f.close(); }
});
