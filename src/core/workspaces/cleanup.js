import { check } from '../types.js';

/** 分支回收与安全清理。 */
export const methods = {
  /**
   * 任务分支是恢复点，只有能证明「这次工作已经是目标分支的一部分」时才删。
   * 不做 force：先要求分支顶端仍是审阅过的那次提交，再用 update-ref 的 compare-and-delete
   * 原子删除——检查之后分支被谁动过就拒绝，历史不会丢。
   */
  async dropBranch(task) {
    const branch = task.branch;
    if (!branch) return { branch: null, status: 'absent', reason: null };
    const project = this.config.project;
    let tip;
    try { tip = await this.git(project, 'rev-parse', `refs/heads/${branch}`); }
    catch { return { branch, status: 'absent', reason: null }; }
    const reviewed = task.head_commit || task.base_commit;
    if (!reviewed) return { branch, status: 'kept', reason: 'no reviewed commit is recorded for this task' };
    if (tip !== reviewed) return { branch, status: 'kept', reason: task.head_commit
      ? `branch tip ${tip.slice(0, 12)} is not the reviewed commit ${reviewed.slice(0, 12)}`
      : `branch carries commits the task never recorded (tip ${tip.slice(0, 12)}, base ${reviewed.slice(0, 12)})` };
    if (!task.target_branch) return { branch, status: 'kept', reason: 'no target branch is recorded for this task' };
    if (!(await this.isAncestor(project, tip, `refs/heads/${task.target_branch}`)))
      return { branch, status: 'kept', reason: `${tip.slice(0, 12)} is not in ${task.target_branch} yet` };
    if (await this.checkedOut(branch)) return { branch, status: 'kept', reason: 'branch is checked out in a worktree' };
    await this.git(project, 'update-ref', '-d', `refs/heads/${branch}`, tip);
    return { branch, status: 'removed', reason: null };
  },
  /**
   * 回收一个已结束任务的磁盘状态：它自己的 worktree、检验对照检出与任务分支。
   * 任何一步不安全就抛错——cleanup 把它报给用户，clear 记下原因并保留那条任务。
   */
  async release(task, { keepBranch = false } = {}) {
    // 检验任务没有 branch/integration，只有派生出来的对照检出。
    if (task.verifies_task_id) {
      if (!task.baseline_workspace) return { id: task.id, worktree: 'absent', branch: 'absent', reason: null };
      const dir = task.baseline_workspace;
      await this.git(this.config.project, 'worktree', 'remove', '--force', dir);
      this.store.update(task.id, { baseline_workspace: null });
      this.store.event(task.id, 'baseline.removed', { workspace: dir });
      return { id: task.id, worktree: 'removed', branch: 'absent', reason: null };
    }
    // merged/none：这条线已经收尾；superseded：这一轮解冲突被下一轮取代，分支留作恢复点，不强留工作区。
    check(['merged','none','superseded'].includes(task.integration), 'unmerged work must be kept');
    let worktree = 'absent';
    if (task.workspace) {
      const dir = task.workspace;
      await this.clean(dir);
      const head = await this.git(dir, 'rev-parse', 'HEAD');
      // Even failed/cancelled tasks may contain valuable committed changes.
      if (head !== task.base_commit) await this.git(this.config.project, 'merge-base', '--is-ancestor', head, 'HEAD');
      await this.git(this.config.project, 'worktree', 'remove', dir);
      worktree = 'removed';
      this.store.update(task.id, { workspace: null });
      this.store.event(task.id, 'workspace.removed', { branch: task.branch, workspace: dir });
    }
    const branch = keepBranch
      ? { branch: task.branch, status: task.branch ? 'kept' : 'absent', reason: task.branch ? 'kept by --keep-branch' : null }
      : await this.dropBranch(task);
    if (branch.status === 'removed') {
      // 库反映磁盘：分支不在了就不该再指着一个不存在的 ref。
      this.store.update(task.id, { branch: null });
      this.store.event(task.id, 'branch.removed', { branch: branch.branch });
    }
    return { id: task.id, worktree, branch: branch.status, reason: branch.reason };
  },
  /** 用户明确回收：worktree（与对照检出）加任务分支，一次做完。 */
  cleanup(taskId, { keepBranch = false } = {}) {
    return this.exclusive(async () => {
      this.busy.add(taskId);
      try {
        const task = this.store.task(taskId);
        check(['completed','failed','cancelled'].includes(task.status), 'task must have stopped');
        return { ...this.store.task(task.id), cleanup: await this.release(task, { keepBranch }) };
      } finally { this.busy.delete(taskId); }
    });
  },
  /** clear 用：逐个回收，一个任务被安全门挡住不影响其余的；返回每条任务的去向与原因。 */
  reclaim(tasks) {
    return this.exclusive(async () => {
      const outcomes = [];
      for (const snapshot of tasks) {
        this.busy.add(snapshot.id);
        try { outcomes.push(await this.release(this.store.task(snapshot.id))); }
        catch (error) { outcomes.push({ id: snapshot.id, worktree: 'kept', branch: snapshot.branch ? 'kept' : 'absent', reason: error.message }); }
        finally { this.busy.delete(snapshot.id); }
      }
      return outcomes;
    });
  },
};
