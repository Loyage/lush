import { check, LushError } from '../types.js';

/** 批准合并的预检与三种结局。 */
export const methods = {
  /** 批量交付的只读预检：在第一项改写主树前把共同分支、脏树、审阅提交漂移与 resolver 完整性一次查完。 */
  preflightMerge(tasks) {
    return this.exclusive(async () => {
      check(Array.isArray(tasks) && tasks.length > 0, 'merge preflight needs tasks');
      const project = this.config.project;
      const targets = [...new Set(tasks.map(task => task.target_branch))];
      check(targets.length === 1 && targets[0], 'merge preflight requires one target branch');
      await this.clean(project);
      check(await this.git(project, 'symbolic-ref', '--short', 'HEAD') === targets[0], `switch to ${targets[0]} before merging`);
      for (const raw of tasks) {
        const task = this.store.task(raw.id);
        check(task.status === 'completed' && ['pending','review','conflict'].includes(task.integration), `#${task.id} is not a completed merge candidate`);
        await this.clean(task.workspace);
        check(await this.git(task.workspace, 'rev-parse', 'HEAD') === task.head_commit, `task #${task.id} branch changed after review`);
        if (task.resolves_task_id) {
          const resolved = this.store.task(task.resolves_task_id);
          check(resolved.head_commit && await this.isAncestor(project, resolved.head_commit, task.head_commit),
            `resolution #${task.id} does not contain the reviewed commit of #${resolved.id}; land a branch that keeps that work`);
        }
      }
      return { target_branch: targets[0], tasks: tasks.map(task => task.id) };
    });
  },
  /**
   * 批准一次合并。三种结局：
   *   {task, conflict: null}          合并成功，integration=merged
   *   {task, conflict: {files, output}} 内容冲突：main 已 abort 回合并前的干净状态，等用户决定下一步
   *   throw                            前置门槛不通过（脏树、分支不对、审阅后又被改、上游未合），或 abort 没成功
   * 「冲突」是正常结局，不是异常：它必须能被上层转成一个待决决定，而不是一句报错。
   */
  merge(taskId) {
    return this.exclusive(async () => {
      const task = this.store.task(taskId);
      // conflict 也在允许之列：那是「合并冲突过、现在重试」——冲突中不解决就永远走不出去。
      check(task.status === 'completed' && ['pending','review','conflict'].includes(task.integration), 'only completed tasks with pending/review/conflict changes can be merged');
      const project = this.config.project;
      await this.clean(project);
      await this.clean(task.workspace);
      check(await this.git(project, 'symbolic-ref', '--short', 'HEAD') === task.target_branch, `switch to ${task.target_branch} before merging`);
      check(await this.git(task.workspace, 'rev-parse', 'HEAD') === task.head_commit, 'task branch changed after review');
      // 解冲突任务不是普通分支：它必须真的含被并进来的那次审阅过的提交（防止「解冲突」把对方改动整个丢掉），
      // 而且只能用 --ff-only 落地——成功即证明 main 没被推走，落地的树就是 agent 测过的那棵树。
      const resolved = task.resolves_task_id ? this.store.task(task.resolves_task_id) : null;
      if (resolved) {
        check(resolved.head_commit, `#${task.id} resolves #${resolved.id}, which has no reviewed commit`);
        check(await this.isAncestor(project, resolved.head_commit, task.head_commit),
          `resolution #${task.id} does not contain the reviewed commit of #${resolved.id}; land a branch that keeps that work`);
      }
      // A stacked branch carries its upstream's commits. Merging a downstream task first would drag
      // unmerged work into the target branch, so the upstream has to be an ancestor of the target already.
      for (const edge of this.store.deps(task.id).filter(edge => edge.kind === 'code')) {
        const upstream = this.store.task(edge.depends_on);
        check(upstream.head_commit, `code dependency #${upstream.id} has no commit; inspect it before merging`);
        check(await this.isAncestor(project, upstream.head_commit, 'HEAD'),
          `code dependency #${upstream.id} is not merged into ${task.target_branch} yet; merge #${upstream.id} first so this branch does not carry it along`);
      }
      // 能快进就快进：不产生合并提交，历史保持线性；只有目标分支已经前进（HEAD 不是该提交的祖先）
      // 才退回 --no-ff 生成合并提交。解冲突任务恒为快进：它的产物就是「目标分支 + 那次提交」。
      const fastForward = resolved ? true : await this.isAncestor(project, 'HEAD', task.head_commit);
      // Persist approval before touching the main tree. On crash, never replay a merge.
      this.store.update(task.id, { integration: 'merging', integration_error: null });
      this.store.event(task.id, 'merge.approved', { commit: task.head_commit, fast_forward: fastForward });
      try {
        if (fastForward) await this.git(project, 'merge', '--ff-only', task.head_commit);
        else await this.git(project, 'merge', '--no-ff', '--no-edit', task.head_commit);
        this.store.update(task.id, { integration: 'merged' });
        this.store.event(task.id, 'merged', { commit: task.head_commit });
      } catch (error) {
        // 先取冲突明细，再决定这是「内容冲突」还是「硬失败」，最后一定把主树恢复原状。
        const files = await this.unmerged(project).catch(() => []);
        let abortError = null;
        if (await this.merging(project)) {
          try { await this.git(project, 'merge', '--abort'); } catch (err) { abortError = err.message; }
        }
        const detail = `${error.message}${abortError ? `\nCheck repository state: ${abortError}` : ''}`;
        this.store.update(task.id, { integration: 'pending', integration_error: detail });
        this.store.event(task.id, 'merge.failed', { error: error.message, files });
        // abort 没成功表示主树还卡在合并里：不能把这种现场交给解冲突 agent。
        if (abortError) throw new LushError(detail);
        if (files.length) return { task: this.store.task(task.id), conflict: { files, output: error.message } };
        throw error;
      }
      return { task: this.store.task(task.id), conflict: null };
    });
  },
};
