import fs from 'node:fs';
import path from 'node:path';
import { check, TERMINAL, bounded } from '../types.js';

/**
 * 结算提醒的文案只由任务事实拼出来：goal 可能很长，只取第一行并截断成「一句话目标」。
 * integration 口径到「是否已合入父分支 / 是否需要你处理」的映射；未知值不臆造，落回最保守的一句。
 */
const SETTLE_LABEL = { completed: '已完成', failed: '失败' };
const INTEGRATION_REMINDER = {
  merged: '已合入父分支，不需要你处理',
  pending: '有改动尚未合入父分支，需要你批准合并',
  review: '有改动尚未合入父分支，等你复查',
  merging: '正在合入父分支，暂时不需要你处理',
  conflict: '与父分支有冲突，需要你处理',
  superseded: '已被后续合并取代，不需要你处理',
  none: '没有记录到需要合入父分支的改动，不需要你处理',
};
function settlementReminder(task, status) {
  const label = SETTLE_LABEL[status];
  const goal = String(task.goal ?? '').split('\n').map(line => line.trim()).find(Boolean) ?? '';
  const brief = goal.length > 80 ? `${goal.slice(0, 80)}…` : goal;
  // 只读分析：结论就是这个 Task 的 result，没有分支 / 集成可说；直接把结论带到提醒里。
  if (task.task_kind === 'analysis') {
    const answer = String(task.result ?? '').trim();
    return {
      title: `分支 ${task.target_branch} 的分析 #${task.id} ${label}`,
      body: [
        `问题：${brief}`,
        `分支：${task.target_branch}（只读分析，没有分支改动）`,
        status === 'completed'
          ? `结论：${answer.length > 1200 ? `${answer.slice(0, 1200)}…` : answer || '（空回答）'}`
          : `分析未完成：${String(task.error ?? '').slice(0, 500) || '没有记录到原因'}`,
        `完整回答见任务 #${task.id} 详情。`,
      ].join('\n'),
    };
  }
  const reservation = task.task_kind === 'say' && task.reservation ? JSON.parse(task.reservation) : null;
  return {
    title: `分支 ${task.branch}：任务 #${task.id} ${label}`,
    body: [
      `任务 #${task.id}（${task.role}：${brief}）结算为「${label}」。`,
      `分支：${task.branch}`,
      `直接父分支：${task.target_branch ?? '（未记录）'}`,
      reservation?.kind === 'merge' && reservation.status === 'requested'
        ? `固定提交 ${reservation.commit} 的合并请求已发给父 Task #${reservation.parent_id}；当前尚未合入，须由父 Agent 或用户确认。`
        : reservation?.kind === 'showcase' && ['completed','failed','cancelled'].includes(reservation.status)
          ? `展示子 Task #${reservation.child_id} 已${reservation.status === 'completed' ? '交付' : reservation.status === 'cancelled' ? '取消' : '失败'}；展示不代表验收，也没有自动合并。`
          : `integration：${INTEGRATION_REMINDER[task.integration] ?? INTEGRATION_REMINDER.none}。`,
    ].join('\n'),
  };
}

/** 结算、取消、重试、清空与恢复。 */
export default {
  finish(taskId, status, result = null, error = null, options = {}) {
    const task = this.store.task(taskId);
    if (TERMINAL.has(task.status)) return task;
    const request = options.mergeRequest ?? null;
    const showcaseSettlement = options.showcaseSettlement ?? null;
    check(!request || !showcaseSettlement, 'a say Task cannot merge and showcase together');
    if (task.task_kind === 'say' && (status === 'completed' || showcaseSettlement)) {
      const reservation = task.reservation ? JSON.parse(task.reservation) : null;
      if (request) {
        check(reservation?.kind === 'merge' && reservation.status === 'pending'
          && task.status === 'waiting' && task.head_commit === request.commit && task.parent_id === request.parent_id,
        'a new say Task completes only with its pinned merge request');
        const parent = this.store.task(task.parent_id);
        check(['main','owner','say'].includes(parent.task_kind) && !TERMINAL.has(parent.status),
          'merge request parent is no longer active');
      } else {
        const child = showcaseSettlement ? this.store.task(showcaseSettlement) : null;
        check(reservation?.kind === 'showcase' && reservation.status === 'started'
          && reservation.child_id === child?.id && child.parent_id === task.id
          && child.role === 'showcase' && child.task_kind === 'showcase' && TERMINAL.has(child.status)
          && task.status === 'waiting'
          && status === (child.status === 'completed' ? 'completed' : child.status === 'cancelled' ? 'cancelled' : 'failed'),
        'a new say Task completes only after its reserved showcase child settles');
      }
    } else check(!request && !showcaseSettlement, 'delivery settlement belongs to a say Task');
    if (task.role === 'butler' && status !== 'completed') {
      const source = this.butlerContext(task.id);
      this.finishSleepChoice(source.choice_id, { status: 'interrupted', reason: error || '管家中断，未执行选择' });
    }
    if (task.role === 'showcase' && status !== 'completed') void this.stopShowcasePreview(task.id);
    check(this.store.children(task.id).every(child => TERMINAL.has(child.status)), 'cannot finish with active children');
    this.store.transaction(() => {
      // A retry profile is scoped to this attempt. Terminal settlement removes it so a later
      // explicit retry starts from the then-current project/role profile unless the user adjusts it again.
      if (showcaseSettlement) {
        const reservation = JSON.parse(task.reservation);
        const { blocked_reason: _previousReason, blocked_code: _previousCode, ...cleanReservation } = reservation;
        this.store.update(task.id, { reservation: JSON.stringify({ ...cleanReservation, status,
          settled_at: new Date().toISOString() }) });
        this.store.event(task.id, 'task.showcase_settled', { child_id: showcaseSettlement, status });
      }
      if (request) {
        const reservation = JSON.parse(task.reservation);
        const { blocked_reason: _previousReason, blocked_code: _previousCode, ...cleanReservation } = reservation;
        const requested = { ...cleanReservation, status: 'requested', commit: request.commit, baseline: request.baseline,
          parent_id: request.parent_id, requested_at: new Date().toISOString() };
        const key = `merge:${task.id}:${request.commit}`;
        const payload = { branch: task.branch, commit: request.commit, baseline: request.baseline };
        const body = JSON.stringify({ version: 1, signal: 'merge.requested', key, source_task_id: task.id,
          target_task_id: request.parent_id, payload });
        const row = this.store.signal(request.parent_id, task.id, 'merge.requested', key, body);
        this.store.event(task.id, 'task.merge_requested', { ...payload, parent_id: request.parent_id, message_id: row.id });
        if (row.inserted) this.store.event(request.parent_id, 'task.signal', { message_id: row.id,
          source_task_id: task.id, signal: 'merge.requested', key });
        this.store.update(task.id, { reservation: JSON.stringify(requested) });
      }
      this.store.update(task.id, { status, result, error, retry_profile: null });
      this.store.run("UPDATE notices SET status='dismissed',answer='task ended' WHERE task_id=? AND status='open'", task.id);
      // 结算提醒：completed / failed 且任务有自己的分支或是一次只读分析时落且只落一条纯信息 notice。
      // 它 kind='info' / status='sent'，与这次结算同一个事务，且顺序在「关掉 open notice」之后；
      // cancelled 不提醒，没有分支的任务（planner / scheduler / coordinator / research / verifier）也不提醒。
      if ((status === 'completed' || status === 'failed') && (task.branch || task.task_kind === 'analysis')) {
        const reminder = settlementReminder(this.store.task(task.id), status);
        this.notify(task.id, reminder.title, reminder.body);
      }
      const settlementEvent = this.store.event(task.id, status, { result, error });
      // 一个 scheduler 要么把 spec 编成任务，要么明确 drop；取消则把未处理的 spec 还给队列，绝不静默丢弃。
      if (task.role === 'scheduler') {
        if (status === 'cancelled') this.store.releaseBatch(task.id, 'scheduler 被取消，spec 回到 pending');
        else if (status === 'completed' || status === 'failed') this.store.discardBatch(task.id, `scheduler 未覆盖该 spec（${status}）`);
      }
      if (task.parent_id && !request && !TERMINAL.has(this.store.task(task.parent_id).status)
        && !(['say','analysis'].includes(task.task_kind) && ['main','owner'].includes(this.store.task(task.parent_id).task_kind))) {
        const parent = this.store.task(task.parent_id);
        if ((task.task_kind === 'child' && ['say','child'].includes(parent.task_kind))
          || (task.task_kind === 'showcase' && parent.task_kind === 'say')) {
          const key = `${task.task_kind}:${task.id}:settlement:${settlementEvent}`;
          const type = `${task.task_kind}.${status}`;
          const payload = { result: result?.slice(0, 2000) ?? null, error,
            result_truncated: (result?.length ?? 0) > 2000, commit: this.store.task(task.id).head_commit };
          const body = JSON.stringify({ version: 1, signal: type, key, source_task_id: task.id,
            target_task_id: parent.id, payload });
          const row = this.store.signal(parent.id, task.id, type, key, body);
          if (row.inserted) this.store.event(parent.id, 'task.signal', { message_id: row.id,
            source_task_id: task.id, signal: type, key });
        } else {
          const messageId = this.store.message(task.parent_id, JSON.stringify({ child: task.id, status,
            result: result?.slice(0, 2000) ?? null, error, result_truncated: (result?.length ?? 0) > 2000 }), task.id);
          if (status === 'completed') this.store.event(task.parent_id, 'child.completed', { child: task.id, message_id: messageId });
        }
      }
      // Verification settles either a worker detail or a frozen review candidate.
      if (task.verifies_task_id) this.store.touch(task.verifies_task_id);
      if (task.role === 'showcase' && status === 'completed') this.notify(task.id, `效果展示已就绪 #${task.id}`,
        `${JSON.parse(task.showcase).branch} 的展示页已生成。展示不代表检验通过，也没有自动合并。`);
      if (task.review_candidate_id) {
        const hasReport = this.hasReport(task.id);
        const verification = this.verificationResult(task.id);
        // Invocation completed 只说明 agent 正常返回；Candidate 仅在固定 commit 的结构化证据明确 pass
        // 且人类报告存在时进入 ready。fail / partial / unverified / 旧记录 unknown 都保持可见但不放行。
        const candidateStatus = status === 'completed' && hasReport && verification.status === 'pass' ? 'ready' : 'failed';
        // Candidate 的当前状态和 report_task_id 必须与这个 verifier 同时匹配；一条条件 UPDATE
        // 把检查和写入留在当前事务内，迟到回调不能覆盖拒绝、反馈、替代版本或更新的 verifier。
        const settlement = this.store.settleCandidateVerification(task.review_candidate_id, task.id, candidateStatus);
        if (settlement.applied) {
          this.store.event(task.id, 'candidate.verified', { candidate: task.review_candidate_id, status,
            candidate_status: candidateStatus, verification_status: verification.status, has_report: hasReport });
        } else {
          // Task / Run / Artifact 照常保留；另加明确事件说明为什么这份结果没有改变 Candidate。
          this.store.event(task.id, 'candidate.verification_ignored', { candidate: task.review_candidate_id, status,
            candidate_status: settlement.candidate.status, current_report_task_id: settlement.candidate.report_task_id,
            verification_status: verification.status, has_report: hasReport });
        }
      }
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
    // A reserved showcase child closes the original say only after its own terminal fact is committed.
    // If we crash here, recover() repeats this DB-only, idempotent step.
    if (task.task_kind === 'showcase' && task.parent_id) this.settleReservedShowcase(task.parent_id);
    // Work compiled from a Plan is automatically aggregated inside the private Intent branch. The user still
    // approves only the frozen Review Candidate when it moves from the Intent branch to the target branch.
    const compiled = status === 'completed' && task.role === 'worker'
      && Boolean(this.store.get("SELECT id FROM events WHERE task_id=? AND type='plan.materialized' LIMIT 1", task.id));
    if (task.input_id && task.branch && (compiled || task.role === 'merger')) this.scheduleIntentIntegration(task.input_id);
    // 一键合并若正等这个 merger 子任务，结算后自动继续下一步。
    if (task.role === 'merger') this.resumeMergeRun(task.id);
    if (task.parent_id && !(task.task_kind === 'say' && ['main','owner'].includes(this.store.task(task.parent_id).task_kind)))
      this.wake(task.parent_id);
    // A settled dependency releases every queued dependent; still-blocked ones stay queued.
    for (const edge of this.store.dependents(task.id)) this.wake(edge.task_id);
    // 一个没有父子/依赖边的 planner（根任务）也要在自己结束时把这一轮拆解交给 scheduler。
    this.kick();
    // 结算可能正好满足某条分支的效果展示预约，重扫一次（只在触发点调度，不挂进每次 kick）。
    this.scheduleShowcaseSweep();
    return this.store.task(task.id);
  },

  cancel(taskId, reason = 'cancelled by user', status = 'cancelled') {
    const task = this.store.task(taskId);
    check(!['main','owner'].includes(task.task_kind), 'branch owner is a permanent root; cancel individual say Tasks instead');
    if (TERMINAL.has(task.status)) return task;
    // Children first; the event loop cannot schedule their parents until this synchronous cascade ends.
    for (const child of this.store.children(task.id)) if (!TERMINAL.has(child.status)) this.cancel(child.id, reason);
    this.running.get(task.id)?.controller.abort(new Error(reason));
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
    check(!this.sleepStatus().enabled && !this.sleepTickPromise, '请先关闭托管模式并等待管家操作结束，再清空项目');
    check(this.running.size === 0, 'an agent invocation is still unwinding; clear must wait');
    check(this.store.activeBranchMergeRuns().length === 0, 'a one-click merge is in progress; finish or cancel it before clearing');
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

  /**
   * 用户专属的定向删除（`task.delete` / `lush task delete`）：把一条已结束任务连同它的全部已结束后代
   * 从库里删掉。这是除 clear 之外唯一会丢掉任务历史的路径，所以安全门比 clear 更细，范围却只有这一棵子树：
   * - 子树里任何一条还在跑 / 排队 / 等答复：拒绝，不做隐式取消（同 clear）；
   * - 它的 invocation 还在收尾、或 cleanup 正在走它的 worktree：拒绝；
   * - 子树里的 planner 还留着未编排的 pending spec：拒绝——删掉那些条目等于替用户丢掉还没处理的拆解；
   * - 集合外还有 verifier / resolver / 验收候选用外键指着它：拒绝并点名，先删引用方（它们是独立记录，不跟它一起走）；
   * - 磁盘状态（worktree / 对照检出 / 已进目标分支的分支）走与 cleanup 相同的安全门回收，有一条收不回来
   *   就整体不删（已经收掉的保持回收状态）并列出原因，绝不为了删一行库而丢未合并的成果。
   * 这五条都过了才真删：任务行与它们的子行一起消失，另留一条 `task_id=NULL` 的项目级事件 `task.deleted`，
   * 把被删的 id / 角色 / 状态与各表行数记在 data 里（那条事件没有任务可挂，要查用 SQL）。id 不复用。
   * 有意不动 `branches.task_id` / `inputs.task_id` 这类历史指针（它们刻意没有外键）：删掉一条输入锚点的
   * 根 planner 后，这条输入不再出现在 intent 列表里——那个列表由 `inputs JOIN tasks` 派生。
   * 状态检查是同步的（调用方立即拿到拒绝），磁盘回收在返回的 Promise 里串行执行。
   */
  deleteTask(taskId) {
    const root = this.store.task(taskId);
    const subtree = this.subtreeTasks(root.id);
    const ids = subtree.map(task => task.id);
    const active = subtree.filter(task => !TERMINAL.has(task.status));
    check(active.length === 0,
      `#${active.slice(0, 20).map(task => task.id).join(', #')} still active (${active.length}); cancel them or wait until they finish`);
    check(ids.every(value => !this.running.has(value)), 'agent is still stopping; delete must wait');
    check(ids.every(value => !this.workspaces.busy.has(value)), 'worktree cleanup is in progress; delete must wait');
    // 冻结中的分支（一键合并 / 未结束的 merger）不允许删任务：删除会连带走它的分支与 worktree。
    for (const task of subtree) if (task.branch) this.assertBranchWritable(task.branch, 'delete a task on it');
    const unhandled = subtree.filter(task => task.role === 'planner'
      && this.store.get("SELECT count(*) AS value FROM task_specs WHERE planner_task_id=? AND status='pending'", task.id).value > 0);
    check(unhandled.length === 0,
      `planner #${unhandled[0]?.id} still has pending specs; compile, approve or drop them first`);
    const referrers = this.store.referringTasks(ids);
    check(referrers.length === 0, `#${root.id} is still referenced by ${referrers.join(', ')}; delete the referrer first`);
    return this.forgetTasks(root, subtree, ids);
  },

  /** 这棵子树的任务（含根）。终态任务不允许有活动后代，但结构归结构，不看 status 猜。 */
  subtreeTasks(taskId) {
    const out = [];
    const queue = [this.store.task(taskId)];
    while (queue.length) {
      const task = queue.pop();
      out.push(task);
      queue.push(...this.store.children(task.id));
    }
    return out;
  },

  /** deleteTask 的异步尾部：先按 cleanup 的安全门收磁盘，收不干净就整体不删，再清库并留一条审计事件。 */
  async forgetTasks(root, subtree, ids) {
    const outcomes = await this.workspaces.reclaim(subtree);
    // 目录、分支或对照检出收不回来（未合并、脏、被别处检出）：任务行不动，让用户先处理磁盘。
    const kept = outcomes.filter(row => row.worktree === 'kept' || row.branch === 'kept');
    check(kept.length === 0,
      `${kept.map(row => `#${row.id} (${row.reason})`).join('; ')} cannot be reclaimed; finish or clean it up first (lush task cleanup ID)`);
    const counts = this.store.deleteTasks(ids);
    this.store.event(null, 'task.deleted', { task_id: root.id,
      tasks: subtree.map(task => ({ id: task.id, parent_id: task.parent_id, input_id: task.input_id,
        role: task.role, status: task.status, branch: task.branch })), counts });
    return {
      deleted: { root: root.id, ids, ...counts },
      reclaimed: {
        worktrees: outcomes.filter(row => row.worktree === 'removed').length,
        branches: outcomes.filter(row => row.branch === 'removed').length,
      },
      next_task_id: this.store.taskIdHigh() + 1,
    };
  },

  retry(taskId, profile = null) {
    const task = this.store.task(taskId);
    check(['failed','cancelled'].includes(task.status), 'only failed/cancelled tasks can be retried');
    check(!this.running.has(task.id), 'agent is still stopping; retry shortly');
    check(!this.workspaces.busy.has(task.id), 'worktree cleanup is in progress; retry shortly');
    check(task.role !== 'butler', '管家决定不允许重放；请手动处理原 Notice');
    const divergenceChild = task.task_kind === 'child' && this.store.get(
      "SELECT id FROM events WHERE task_id=? AND type='task.divergence_resolution_requested' LIMIT 1", task.id);
    check(!divergenceChild, '解分歧子 Task 不重放未知文件副作用：先检查现场，显式归档旧分支，再从源 say 重新派独立子任务');
    // 冻结中的分支不接受重试：重试会重新产出提交、推进分支，扰动正在进行的合并。
    if (task.branch) this.assertBranchWritable(task.branch, 'retry a task on it');
    if (task.role === 'showcase') return this.retryShowcase(task.id);
    if (task.task_kind === 'say' && task.reservation) {
      const reservation = JSON.parse(task.reservation);
      check(reservation.kind !== 'showcase' || !['completed','failed','cancelled'].includes(reservation.status),
        'a settled showcase and its parent cannot be retried separately; submit a new say');
    }
    if (task.parent_id) check(!TERMINAL.has(this.store.task(task.parent_id).status), 'parent has ended; retry the parent or submit a new input');
    const retryProfile = profile === null || profile === undefined ? null : this.agentSettings.retryProfile(task.role, profile);
    this.store.update(task.id, { status: 'queued', error: null, result: null, calls: 0,
      retry_profile: retryProfile ? JSON.stringify(retryProfile) : null });
    this.store.event(task.id, 'retry', retryProfile ? {
      profile_override: true, agent: retryProfile.agent, model: retryProfile.model || null,
      thinking: retryProfile.thinking || null, default_prompt_overridden: Boolean(retryProfile.default_prompt),
      append_prompt: Boolean(retryProfile.append_prompt), extensions: retryProfile.extensions.length,
      skills: retryProfile.skills.length, soft_budget: retryProfile.soft_budget || null,
    } : { profile_override: false });
    this.kick(); return this.store.task(task.id);
  },

  recover() {
    this.recoverSleep();
    // 抢占通道是进程内运行时状态：重启后不可能还有 invocation 在跑，残留请求必须清掉，
    // 否则下一次调用会在第一个安全边界被一条早已失效的请求误停。
    fs.rmSync(path.join(this.config.home, 'preempt'), { recursive: true, force: true });
    // A credential dies with the invocation that issued it; nothing survives a restart.
    this.store.run('UPDATE tasks SET agent_token_hash=NULL');
    // 快速介绍的直连调用也随进程结束，遗留在 running 的记录如实落成失败。
    this.store.introFailRunning('daemon interrupted; retry the quick intro');
    // Never replay an invocation with unknown filesystem side effects.
    for (const task of this.store.tasks()) if (task.status === 'running') this.cancel(task.id, 'daemon interrupted; inspect worktree and explicitly retry', 'failed');
    this.store.run("UPDATE tasks SET integration='review',integration_error='merge interrupted; inspect git history manually' WHERE integration='merging'");
    // A crash can land between committing an inbox message and queueing its owner.
    for (const task of this.store.tasks()) {
      if (!TERMINAL.has(task.status) && this.hasActionableMessages(task.id)) this.wake(task.id);
    }
    // 中断的检验已经标成失败；对照基线是派生状态，顺手回收掉。
    for (const task of this.store.tasks()) {
      if (task.role !== 'showcase' && task.baseline_workspace && TERMINAL.has(task.status)) {
        this.workspaces.removeBaseline(task.id).catch(error => console.error(`verification ${task.id}: baseline cleanup failed: ${error.message}`));
      }
    }
    this.kick();
    // 只续推已经静息的预约；running invocation 的未知文件副作用仍保留现场，不自动重播。
    for (const task of this.store.tasks()) if (task.task_kind === 'say' && task.status === 'waiting' && task.reservation) {
      let pendingMerge = false;
      try { const value = JSON.parse(task.reservation); pendingMerge = value.kind === 'merge' && value.status === 'pending'; }
      catch { /* invalid state remains visible for inspection */ }
      if (pendingMerge) void this.settleReservedMerge(task.id).catch(error =>
        this.noteReservationBlocked(task.id, error.message));
    }
    // 已发出的请求也要复查：重启期间父分支可能被推进、源分支可能被外部改动，而 pending 复查不覆盖它。
    for (const task of this.store.tasks()) if (task.task_kind === 'say' && task.reservation) {
      let requested = false;
      try { requested = JSON.parse(task.reservation)?.status === 'requested'; } catch { /* leave corrupt state visible */ }
      if (requested) void this.recheckRequestedMerge(task.id).catch(error =>
        this.noteReservationBlocked(task.id, error.message));
    }
    for (const task of this.store.tasks()) if (task.task_kind === 'say' && task.reservation) {
      let reservation = null;
      try { reservation = JSON.parse(task.reservation); } catch { /* leave corrupt state visible */ }
      if (reservation?.kind === 'showcase' && reservation.status === 'started') this.settleReservedShowcase(task.id);
      if (reservation?.kind === 'showcase' && reservation.status === 'pending' && task.status === 'waiting') {
        void this.startReservedShowcase(task.id).catch(error => this.noteReservationBlocked(task.id, error.message));
      }
    }
    // 重启后重扫全部预约：资格可能已经满足，或者需要在新的准入下重新挂起。
    this.scheduleShowcaseSweep();
  },

  async shutdown() {
    this.stopping = true;
    clearInterval(this.sleepTimer); this.sleepTimer = null;
    await this.sleepWatchPromise;
    await this.sleepTickPromise;
    for (const [taskId, run] of this.running) {
      if (run.parked) run.controller.abort();
      else this.cancel(taskId, 'daemon stopped; inspect before retrying', 'failed');
    }
    const startingPreviews = [...this.previewStarting.values()];
    for (const controller of startingPreviews) controller.abort();
    await Promise.allSettled(startingPreviews.map(controller => controller.promise));
    await Promise.allSettled([...this.previews.values()].map(entry => entry.stop()));
    for (const entry of this.introRunning.values()) entry.controller.abort(new Error('daemon stopped; retry the quick intro'));
    await Promise.allSettled([...this.introRunning.values()].map(entry => entry.promise));
    await Promise.allSettled([...this.running.values()].map(run => run.promise));
    await this.workspaces.queue;
  }
};
