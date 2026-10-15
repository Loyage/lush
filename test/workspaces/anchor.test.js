import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, repo, git } from '../helpers.js';

// 输入锚点：order 从指定父分支创建聚合分支与检出，Task 的基线不随开工时间漂移。
// 这里只碰 Git 边界与输入落库的接缝；现行指令行为在 test/project/order.test.js。

test('new order creates a real aggregate branch checkout and runs there', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const head = await git(f.root, 'rev-parse', 'HEAD');
    const input = await f.project.order('work');
    expect(input.anchor).toMatchObject({ branch: `lush/${f.project.workspaces.namespace}/input-${input.id}`, commit: head, target: 'main' });
    expect(fs.existsSync(input.anchor.workspace)).toBe(true);
    // 检出真的停在输入分支上；根 planner 的 cwd 也固定到这里。
    expect(await git(input.anchor.workspace, 'symbolic-ref', '--short', 'HEAD')).toBe(input.anchor.branch);
    expect(await f.project.workspaces.ensure(input.task)).toBe(input.anchor.workspace);
    // 谱系在分支创建那一刻写下：parent = 提交输入时的检出分支，created_from_commit = 当时的 HEAD
    expect(f.store.branch(input.anchor.branch)).toMatchObject({ parent: 'main', parent_relation: 'recorded',
      created_from_commit: head, task_id: input.task.id, worktree: input.anchor.workspace, status: 'active' });
    // 意图视图与事件都带上锚点，review 时看得到「这份代码是什么时候冻的」
    expect(f.project.inputs()[0]).toMatchObject({ anchor_branch: input.anchor.branch, anchor_commit: head,
      anchor_workspace: input.anchor.workspace, anchor_target_branch: 'main' });
    expect(f.store.history(input.task.id).find(row => row.type === 'input.anchor').data)
      .toMatchObject({ input_id: input.id, branch: input.anchor.branch, commit: head, target_branch: 'main' });
  } finally { await f.close(); }
});

test('父分支自己前进之后，child 从父分支当时的 tip 长出来，基线不再是锚点', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const order = await f.project.order('stack two things');
    const orderBranch = order.task.branch;
    fs.writeFileSync(path.join(order.task.workspace, 'upstream.txt'), 'upstream\n');
    await git(order.task.workspace, 'add', '.'); await git(order.task.workspace, 'commit', '-m', 'upstream change');
    await f.project.workspaces.finish(f.store.task(order.task.id));
    f.store.update(order.task.id, { status: 'waiting' });

    const child = await f.project.spawn(order.task.id, 'downstream');
    const task = f.store.task(child.id);
    expect(task.base_commit).toBe(f.store.task(order.task.id).head_commit);
    expect(task.base_commit).not.toBe(order.anchor.commit);
    expect(task.target_branch).toBe(orderBranch);
    expect(f.store.branch(task.branch)).toMatchObject({ parent: orderBranch, created_from_commit: task.base_commit });
  } finally { await f.close(); }
});
