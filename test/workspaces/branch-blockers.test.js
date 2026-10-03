import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, repo, git } from '../helpers.js';

/** `workspaces.branchState(...).blockers` 的结构校验：没合拢的子分支会挡住父分支的合并请求。 */
async function commitWork(task, file) {
  const cwd = await task;
  fs.writeFileSync(path.join(cwd, file), `${file}\n`);
  await git(cwd, 'add', file); await git(cwd, 'commit', '-m', file);
  return cwd;
}

test('有未收拢子 Task 的分支不能先合进父分支；子 Task 落地后父 Task 才拿到请求', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const order = await f.project.order('stacked work');
    await commitWork(order.task.workspace, 'parent.txt');
    await f.project.workspaces.finish(f.store.task(order.task.id));
    f.store.update(order.task.id, { status: 'waiting' });

    const child = await f.project.spawn(order.task.id, 'child work');
    await commitWork(child.workspace, 'child.txt');
    await f.project.workspaces.finish(f.store.task(child.id));
    f.store.update(child.id, { status: 'waiting' });

    // 子分支还在：父 Task 的合并请求只能停在 pending，并说清在等谁。
    const blocked = await f.project.reserveTask(order.task.id, 'merge');
    expect(blocked.reservation).toMatchObject({ kind: 'merge', status: 'pending' });
    expect(blocked.reservation.blocked_reason).toContain(`等待子Worker #${child.id} 结算`);
    expect(await git(f.root, 'rev-parse', 'main')).not.toBe(await git(order.task.workspace, 'rev-parse', 'HEAD'));

    // 子 Task 先走 v2 队列合进父分支：落地后结构上就只剩父 Task 自己这一条 blocker。
    // （父 Task 的预约留在 pending 等待它自己的 Agent 处理子任务信号，见 merge-queue 的用例。）
    await f.project.reserveTask(child.id, 'merge');
    f.project.stopping = false;
    await f.project.driveTaskMerge(order.task.id);
    expect(f.store.task(child.id)).toMatchObject({ status: 'awaiting_acceptance', integration: 'merged' });
    f.project.stopping = true;
    expect((await f.project.workspaces.branchState(order.task.branch)).blockers).toEqual([`task:#${order.task.id}`]);
  } finally { await f.close(); }
});
