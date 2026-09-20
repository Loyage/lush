import { check, TERMINAL, bounded } from '../types.js';

/** 结算、取消、重试、清空与恢复。 */
export default {
  finish(taskId, status, result = null, error = null) {
    const task = this.store.task(taskId);
    if (TERMINAL.has(task.status)) return task;
    check(this.store.children(task.id).every(child => TERMINAL.has(child.status)), 'cannot finish with active children');
    this.store.transaction(() => {
      this.store.update(task.id, { status, result, error });
      this.store.run("UPDATE notices SET status='dismissed',answer='task ended' WHERE task_id=? AND status='open'", task.id);
      this.store.event(task.id, status, { result, error });
      // 一个 scheduler 要么把 spec 编成任务，要么明确 drop；取消则把未处理的 spec 还给队列，绝不静默丢弃。
      if (task.role === 'scheduler') {
        if (status === 'cancelled') this.store.releaseBatch(task.id, 'scheduler 被取消，spec 回到 pending');
        else if (status === 'completed' || status === 'failed') this.store.discardBatch(task.id, `scheduler 未覆盖该 spec（${status}）`);
      }
      if (task.parent_id && !TERMINAL.has(this.store.task(task.parent_id).status)) {
        this.store.message(task.parent_id, JSON.stringify({ child: task.id, status, result, error }), task.id);
      }
      // 检验结算后让被检验任务的详情重新渲染，看得到最新结论。
      if (task.verifies_task_id) this.store.touch(task.verifies_task_id);
      // 解冲突任务没做成（失败 / 被取消）：原任务回到待合并，冻结随之解除，错误留在解冲突任务上。
      // 分支与 worktree 都保留，用户可以重试或自己处理。
      if (task.resolves_task_id && status !== 'completed') {
        const target = this.store.task(task.resolves_task_id);
        if (target.integration === 'conflict') {
          this.store.update(target.id, { integration: 'pending',
            integration_error: `resolution task #${task.id} ${status}${error ? `: ${error}` : ''}` });
          this.store.event(target.id, 'merge.conflict.abandoned', { resolution: task.id, status });
        }
      }
    });
    if (task.parent_id) this.wake(task.parent_id);
    // A settled dependency releases every queued dependent; still-blocked ones stay queued.
    for (const edge of this.store.dependents(task.id)) this.wake(edge.task_id);
    // 一个没有父子/依赖边的 planner（根任务）也要在自己结束时把这一轮拆解交给 scheduler。
    this.kick();
    return this.store.task(task.id);
  },

  cancel(taskId, reason = 'cancelled by user', status = 'cancelled') {
    const task = this.store.task(taskId);
    if (TERMINAL.has(task.status)) return task;
    // Children first; the event loop cannot schedule their parents until this synchronous cascade ends.
    for (const child of this.store.children(task.id)) if (!TERMINAL.has(child.status)) this.cancel(child.id, reason);
    this.running.get(task.id)?.controller.abort();
    return this.finish(task.id, status, null, reason);
  },

  /**
   * 用户专属的一键清空：删掉全部已结束任务，连同 inputs / drafts / notices / events。
   * 有活动任务（或刚 abort、invocation 尚未收尾的 agent）时拒绝，不做隐式取消——
   * 删除正在被调用的任务行会让 agent 的收尾路径读到不存在的 task。
   * 先按与 task cleanup 相同的安全门回收磁盘状态（worktree 目录、对照检出、已进目标分支的分支），
   * 再清库；回收不掉的任务连同分支与目录一起保留，返回值里列出原因。
   * 状态检查是同步的（调用方立即拿到拒绝），磁盘回收在返回的 Promise 里串行执行。
   */
  clear() {
    check(this.running.size === 0, 'an agent invocation is still unwinding; clear must wait');
    check(this.workspaces.busy.size === 0, 'worktree cleanup is in progress; clear must wait');
    const active = this.store.activeTasks();
    check(active.length === 0,
      `#${active.slice(0, 20).map(task => task.id).join(', #')} still active (${active.length}); cancel them or wait until they finish`);
    // 分支名、worktree 路径与对照目录都记在即将被删的行里，所以先回收再 purge。
    const anchors = this.store.all(`SELECT id, anchor_branch, anchor_commit, anchor_workspace FROM inputs
      WHERE anchor_branch IS NOT NULL ORDER BY id`);
    return this.reclaimThenPurge(this.store.tasks(), anchors.map(input => ({ id: input.id,
      branch: input.anchor_branch, commit: input.anchor_commit, workspace: input.anchor_workspace })));
  },

  async reclaimThenPurge(tasks, anchors = []) {
    const outcomes = await this.workspaces.reclaim(tasks);
    // 输入锚点是提交那一刻的快照，没有 agent 往里提交：干净就回收，脏或被改过就留着并说明原因。
    const reclaimedAnchors = anchors.length ? await this.workspaces.reclaimAnchors(anchors) : [];
    const reason = new Map(outcomes.map(row => [row.id, row.reason]));
    const retained = this.store.all(`SELECT id, branch, workspace, baseline_workspace FROM tasks
      WHERE workspace IS NOT NULL OR baseline_workspace IS NOT NULL OR branch IS NOT NULL ORDER BY id`);
    const counts = this.store.purge();
    return {
      cleared: { tasks: counts.tasks, inputs: counts.inputs, drafts: counts.drafts, notices: counts.notices,
        messages: counts.messages, events: counts.events, task_deps: counts.task_deps, task_specs: counts.task_specs },
      reclaimed: {
        worktrees: outcomes.filter(row => row.worktree === 'removed').length,
        branches: outcomes.filter(row => row.branch === 'removed').length,
        anchors: reclaimedAnchors.filter(row => row.status === 'removed').length,
      },
      retained: { note: 'unmerged work, unreviewed branches and pi sessions stay on disk; remove them by hand',
        tasks: bounded(retained.map(row => ({ ...row, reason: reason.get(row.id) ?? null })), 200000),
        anchors: bounded(reclaimedAnchors.filter(row => row.status === 'kept'), 200000) },
      next_task_id: this.store.taskIdHigh() + 1,
      next_input_id: this.store.inputIdHigh() + 1,
    };
  },

  retry(taskId) {
    const task = this.store.task(taskId);
    check(['failed','cancelled'].includes(task.status), 'only failed/cancelled tasks can be retried');
    check(!this.running.has(task.id), 'agent is still stopping; retry shortly');
    check(!this.workspaces.busy.has(task.id), 'worktree cleanup is in progress; retry shortly');
    if (task.parent_id) check(!TERMINAL.has(this.store.task(task.parent_id).status), 'parent has ended; retry the parent or submit a new input');
    this.store.update(task.id, { status: 'queued', error: null, result: null, calls: 0 });
    this.store.event(task.id, 'retry', {}); this.kick(); return this.store.task(task.id);
  },

  recover() {
    // A credential dies with the invocation that issued it; nothing survives a restart.
    this.store.run('UPDATE tasks SET agent_token_hash=NULL');
    // Never replay an invocation with unknown filesystem side effects.
    for (const task of this.store.tasks()) if (task.status === 'running') this.cancel(task.id, 'daemon interrupted; inspect worktree and explicitly retry', 'failed');
    this.store.run("UPDATE tasks SET integration='review',integration_error='merge interrupted; inspect git history manually' WHERE integration='merging'");
    // A crash can land between committing an inbox message and queueing its owner.
    for (const task of this.store.tasks()) {
      if (!TERMINAL.has(task.status) && this.store.unread(task.id).length) this.wake(task.id);
    }
    // 中断的检验已经标成失败；对照基线是派生状态，顺手回收掉。
    for (const task of this.store.tasks()) {
      if (task.baseline_workspace && TERMINAL.has(task.status)) {
        this.workspaces.removeBaseline(task.id).catch(error => console.error(`verification ${task.id}: baseline cleanup failed: ${error.message}`));
      }
    }
    this.kick();
  },

  async shutdown() {
    this.stopping = true;
    for (const taskId of this.running.keys()) this.cancel(taskId, 'daemon stopped; inspect before retrying', 'failed');
    await Promise.allSettled([...this.running.values()].map(run => run.promise));
    await this.workspaces.queue;
  }
};
