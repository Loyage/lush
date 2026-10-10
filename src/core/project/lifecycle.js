import fs from 'node:fs';
import path from 'node:path';
import { check, TERMINAL, bounded } from '../types.js';
import { assertTaskAncestorsOpen, assertTaskNotSyncing } from './iteration.js';
import { workerLabel } from '../worker-number.js';

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
function settlementReminder(store, task, status) {
  const label = SETTLE_LABEL[status];
  const goal = String(task.goal ?? '').split('\n').map(line => line.trim()).find(Boolean) ?? '';
  const brief = goal.length > 80 ? `${goal.slice(0, 80)}…` : goal;
  // 只读分析：结论就是这个 Task 的 result，没有分支 / 集成可说；直接把结论带到提醒里。
  if (task.task_kind === 'analysis') {
    const answer = String(task.result ?? '').trim();
    return {
      title: `分支 ${task.target_branch} 的分析 ${workerLabel(task)} ${label}`,
      body: [
        `问题：${brief}`,
        `分支：${task.target_branch}（只读分析，没有分支改动）`,
        status === 'completed'
          ? `结论：${answer.length > 1200 ? `${answer.slice(0, 1200)}…` : answer || '（空回答）'}`
          : `分析未完成：${String(task.error ?? '').slice(0, 500) || '没有记录到原因'}`,
        `完整回答见 Worker ${workerLabel(task)} 详情。`,
      ].join('\n'),
    };
  }
  const reservation = task.task_kind === 'order' && task.reservation ? JSON.parse(task.reservation) : null;
  return {
    title: `分支 ${task.branch}：Worker ${workerLabel(task)} ${label}`,
    body: [
      `Worker ${workerLabel(task)}（${task.role}：${brief}）结算为「${label}」。`,
      `分支：${task.branch}`,
      `直接父分支：${task.target_branch ?? '（未记录）'}`,
      reservation?.kind === 'merge' && reservation.status === 'requested'
        ? `固定提交 ${reservation.commit} 的合并请求已发给父Worker ${workerLabel(store.get('SELECT id,worker_number FROM tasks WHERE id=?', reservation.parent_id) ?? { id: reservation.parent_id })}；当前尚未合入，须由父 Agent 或用户确认。`
        : `integration：${INTEGRATION_REMINDER[task.integration] ?? INTEGRATION_REMINDER.none}。`,
    ].join('\n'),
  };
}

/** 结算、取消、重试、清空与恢复。 */
export default {
  finish(taskId, status, result = null, error = null, options = {}) {
    const task = this.store.task(taskId);
    if (TERMINAL.has(task.status)) return task;
    if (task.task_kind === 'management' && status !== 'completed') this.failManagementOccurrence(task.id, 'failed');
    const resolutionEvent = task.task_kind === 'child' ? this.store.get(`SELECT data FROM events WHERE task_id=?
      AND type='task.divergence_resolution_requested' ORDER BY id DESC LIMIT 1`, task.id) : null;
    const resolutionSource = resolutionEvent ? JSON.parse(resolutionEvent.data).source_task_id : task.resolves_task_id;
    const request = options.mergeRequest ?? null;
    // Current order acceptance is handled by acceptTask; this is the historical pinned-request path.
    if (task.task_kind === 'order' && status === 'completed') {
      const reservation = task.reservation ? JSON.parse(task.reservation) : null;
      check(request, 'a new order Worker completes only through acceptance or its historical pinned merge request');
      {
        check(reservation?.kind === 'merge' && reservation.status === 'pending'
          && task.status === 'waiting' && task.head_commit === request.commit && task.parent_id === request.parent_id,
        'a new order Worker completes only with its pinned merge request');
        const parent = this.store.task(task.parent_id);
        check(['main','owner','order'].includes(parent.task_kind) && !TERMINAL.has(parent.status),
          'merge request parent is no longer active');
      }
    } else check(!request, 'delivery settlement belongs to a order Worker');
    if (task.role === 'butler' && status !== 'completed') {
      const source = this.butlerContext(task.id);
      this.finishSleepChoice(source.choice_id, { status: 'interrupted', reason: error || '管家中断，未执行选择' });
    }
    check(this.store.children(task.id).every(child => TERMINAL.has(child.status)), 'cannot finish with active or unaccepted children');
    this.store.transaction(() => {
      // New Worker run settings are persistent selections, not one-attempt retry hints.
      // Keep them across failures/settlement so a later retry cannot silently switch config modes.
      // Historical task protocols retain their attempt-scoped behavior.
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
      this.store.update(task.id, { status, result, error,
        retry_profile: ['order','say','child','management'].includes(task.task_kind) ? task.retry_profile : null, interrupt_state: null });
      this.store.run("UPDATE notices SET status='dismissed',answer='worker ended' WHERE task_id=? AND status='open'", task.id);
      // Historical branch settlements keep their old info reminder. User-created order/analysis
      // use the lifecycle hook below instead, so a failure cannot create two notices.
      // Both remain info/sent, outside every open-decision/blocking query.
      if ((status === 'completed' || status === 'failed') && task.branch
        && !['order','analysis'].includes(task.task_kind)) {
        const reminder = settlementReminder(this.store, this.store.task(task.id), status);
        this.notify(task.id, reminder.title, reminder.body);
      }
      const settlementEvent = this.store.event(task.id, status, { result, error });
      this.notifyTaskLifecycle(task.id, settlementEvent);
      // 一个 scheduler 要么把 spec 编成任务，要么明确 drop；取消则把未处理的 spec 还给队列，绝不静默丢弃。
      if (task.role === 'scheduler') {
        if (status === 'cancelled') this.store.releaseBatch(task.id, 'scheduler 被取消，spec 回到 pending');
        else if (status === 'completed' || status === 'failed') this.store.discardBatch(task.id, `scheduler 未覆盖该 spec（${status}）`);
      }
      if (task.parent_id && !resolutionEvent && !request && !TERMINAL.has(this.store.task(task.parent_id).status)
        && !(['order','analysis','merge'].includes(task.task_kind) && ['main','owner'].includes(this.store.task(task.parent_id).task_kind))) {
        const parent = this.store.task(task.parent_id);
        if (task.task_kind === 'child' && ['order','child'].includes(parent.task_kind)) {
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
      if (resolutionSource && status !== 'completed') {
        const target = this.store.task(resolutionSource);
        if (target.integration === 'conflict') {
          this.store.update(target.id, { integration: 'pending',
            integration_error: `resolution worker ${workerLabel(task)} ${status}${error ? `: ${error}` : ''}` });
          this.store.event(target.id, 'merge.conflict.abandoned', { resolution: task.id, status });
        } else {
          // 终态 order 的独立解分歧子 Task 没做成：把预约落回可分派的 diverged，保留失败现场。
          this.noteTerminalDivergenceFailure({ ...task, resolves_task_id: resolutionSource }, status, error);
        }
      }
    });
    // 终态 order 的独立解分歧子 Task 完成：由 runtime 把产物推进回 order 分支并重新发合并请求。
    if (resolutionSource && status === 'completed') this.scheduleTerminalDivergenceFinalize(task.id);
    // Work compiled from a Plan is automatically aggregated inside the private Intent branch. The user still
    // approves only the frozen Review Candidate when it moves from the Intent branch to the target branch.
    const compiled = status === 'completed' && task.role === 'worker'
      && Boolean(this.store.get("SELECT id FROM events WHERE task_id=? AND type='plan.materialized' LIMIT 1", task.id));
    if (task.input_id && task.branch && (compiled || task.role === 'merger')) this.scheduleIntentIntegration(task.input_id);
    // 一键合并 / 合并编排若正等这个 merger 或解分歧子任务，结算后自动继续下一步。
    if (task.role === 'merger' || task.resolves_task_id !== null) this.resumeMergeRun(task.id);
    if (task.parent_id && !resolutionEvent
      && !(task.task_kind === 'order' && ['main','owner'].includes(this.store.task(task.parent_id).task_kind)))
      this.wake(task.parent_id);
    // A settled dependency releases every queued dependent; still-blocked ones stay queued.
    for (const edge of this.store.dependents(task.id)) this.wake(edge.task_id);
    // 一个没有父子/依赖边的 planner（根任务）也要在自己结束时把这一轮拆解交给 scheduler。
    this.kick();
    return this.store.task(task.id);
  },

  cancel(taskId, reason = 'cancelled by user', status = 'cancelled') {
    const task = this.store.task(taskId);
    assertTaskNotSyncing(this, task.id);
    check(!['main','owner'].includes(task.task_kind), 'branch owner is a permanent root; cancel individual order Workers instead');
    if (TERMINAL.has(task.status)) return task;
    const mergeBooking = task.reservation ? JSON.parse(task.reservation) : null;
    const inbound = this.activeTaskMerge(task.id);
    check(!inbound || !JSON.parse(inbound.reservation).landing_receipt,
      'child landing may have modified this branch; inspect its blocked execution slot before cancelling');
    if (mergeBooking?.version === 2 && mergeBooking.kind === 'merge'
      && ['pending','requested','executing','resolving','suspended','blocked'].includes(mergeBooking.status)) {
      check(!mergeBooking.landing_receipt, 'merge is applying or reconciling a Git update; wait for its safe point');
      this.store.transaction(() => {
        this.store.update(task.id, { reservation: JSON.stringify({ ...mergeBooking,
          status: status === 'failed' ? 'suspended' : 'withdrawn', repair_ready: false,
          retry_status: status === 'failed' ? 'pending' : null }) });
        this.store.event(task.id, 'task.request_withdrawn', { reason, parent_id: mergeBooking.parent_id });
        if (mergeBooking.parent_id) this.store.run("UPDATE messages SET consumed=1 WHERE task_id=? AND sender_id=? AND signal_key LIKE 'merge-v2:%'",
          mergeBooking.parent_id, task.id);
        this.store.run("UPDATE messages SET consumed=1 WHERE task_id=? AND signal_type='merge.repair'", task.id);
      });
      if (status === 'failed') this.emitTaskHook(task.id, 'delivery.suspended');
      if (mergeBooking.parent_id) this.scheduleTaskMerge(mergeBooking.parent_id);
    }
    // 合并编排 Worker 直接经 worker.cancel 取消时，也要先清运行释放冻结、取消等待中的解分歧子任务，
    // 与 branch.orchestrate_cancel 同一收尾；否则残留 run 会继续驱动并冻结目标分支。
    if (task.task_kind === 'merge') {
      for (const { target, run } of this.store.activeBranchMergeRuns()) {
        if (run.mode !== 'orchestrate' || run.task_id !== task.id) continue;
        this.store.transaction(() => {
          this.store.setBranchMergeRun(target, null);
          this.store.event(task.id, 'merge.orchestrate.cancelled', { target, done: run.done ?? [], via: 'task.cancel' });
        });
        const waiting = run.waiting_task_id ? this.store.task(run.waiting_task_id) : null;
        if (waiting && !TERMINAL.has(waiting.status)) this.cancel(waiting.id, reason);
        break;
      }
    }
    // Children first; the event loop cannot schedule their parents until this synchronous cascade ends.
    for (const child of this.store.children(task.id)) if (!TERMINAL.has(child.status)) this.cancel(child.id, reason);
    this.running.get(task.id)?.controller.abort(new Error(reason));
    const result = this.finish(task.id, status, null, reason);
    if (!this.running.has(task.id) && !(this.recoveringHooks && this.hookRecoveredWorkers?.has(task.id)))
      this.emitTaskHook(task.id, status === 'failed' ? 'agent.failed' : 'worker.cancelled');
    return result;
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
    this.assertWritable('clear the project');
    check(!this.clearing, 'clear is already in progress');
    check(!this.sleepStatus().enabled && !this.sleepTickPromise, '请先关闭托管模式并等待管家操作结束，再清空项目');
    check(this.running.size === 0, 'an agent invocation is still unwinding; clear must wait');
    check(this.introRunning.size === 0, 'a model explanation request is still running; clear must wait');
    check(this.store.activeBranchMergeRuns().length === 0, 'a one-click merge is in progress; finish or cancel it before clearing');
    check(this.workspaces.busy.size === 0, 'worktree cleanup is in progress; clear must wait');
    check(!this.taskSyncBusy?.size, 'Worker parent synchronization is in flight; clear must wait');
    const active = this.store.activeTasks();
    check(active.length === 0,
      `${active.slice(0, 20).map(workerLabel).join(', ')} still active (${active.length}); cancel them or wait until they finish`);
    // 分支名、worktree 路径与对照目录都记在即将被删的行里，所以先回收再 purge。
    const anchors = this.store.all(`SELECT id, anchor_branch, anchor_commit, anchor_workspace FROM inputs
      WHERE anchor_branch IS NOT NULL ORDER BY id`);
    // The checks above are synchronous, so from here on every new write is refused until purge is done.
    // A write already in flight re-checks this flag after its asynchronous Git step (see inputs/order).
    this.clearing = true;
    return this.reclaimThenPurge(this.store.tasks(), anchors.map(input => ({ id: input.id,
      branch: input.anchor_branch, commit: input.anchor_commit, workspace: input.anchor_workspace })))
      .finally(() => { this.clearing = false; });
  },

  async reclaimThenPurge(tasks, anchors = []) {
    // Writes admitted before the gate closed finish first; new ones are already refused.
    await this.drainWrites();
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

  retry(taskId, profile = null) {
    this.assertWritable('retry a worker');
    let task = this.store.task(taskId);
    assertTaskNotSyncing(this, task.id);
    check(['failed','cancelled'].includes(task.status), 'only failed/cancelled workers can be retried');
    check(!this.running.has(task.id), 'agent is still stopping; retry shortly');
    check(!this.workspaces.busy.has(task.id), 'worktree cleanup is in progress; retry shortly');
    check(task.role !== 'butler', '管家决定不允许重放；请手动处理原 Notice');
    check(task.task_kind !== 'management', 'management invocations do not replay; create a new authorized instruction');
    const divergenceChild = task.task_kind === 'child' && this.store.get(
      "SELECT id FROM events WHERE task_id=? AND type='task.divergence_resolution_requested' LIMIT 1", task.id);
    check(!divergenceChild, '解分歧子Worker不重放未知文件副作用：先检查现场，显式归档旧分支，再从源指令重新派独立子Worker');
    // 冻结中的分支不接受重试：重试会重新产出提交、推进分支，扰动正在进行的合并。
    if (task.branch) this.assertBranchWritable(task.branch, 'retry a worker on it');
    check(task.role !== 'showcase' && task.task_kind !== 'showcase', 'showcase functionality has been removed; historical Workers are read-only');
    this.restoreUnrequestedTaskParent(task.id);
    task = this.store.task(task.id);
    assertTaskAncestorsOpen(this, task);
    if (task.task_kind === 'order' && task.reservation) {
      const reservation = JSON.parse(task.reservation);
      check(reservation.kind === 'merge', 'historical delivery reservation is no longer supported');
    }
    if (task.parent_id) {
      const parent = this.store.task(task.parent_id);
      if (parent.task_kind === 'merge' && parent.name === 'merge' && parent.status === 'completed'
        && ['order','child'].includes(task.task_kind) && task.integration !== 'merged') {
        check(!TERMINAL.has(this.store.task(parent.parent_id).status), 'original parent has ended; inspect the branch');
        this.store.update(parent.id, { status: 'waiting' });
        this.store.event(parent.id, 'merge.queue_reopened', { task_id: task.id });
      } else check(!TERMINAL.has(parent.status), 'parent has ended; retry the parent or submit a new input');
    }
    const retryProfile = profile === null || profile === undefined ? null : this.agentSettings.retryProfile(task.role, profile);
    const booking = task.reservation ? JSON.parse(task.reservation) : null;
    this.store.update(task.id, { status: 'queued', error: null, result: null, calls: 0,
      ...(booking?.version === 2 && booking.status === 'withdrawn' ? { reservation:
        task.status === 'failed' && booking.retry_status
          ? JSON.stringify({ version: 2, kind: 'merge', status: 'pending', auto_merge: booking.auto_merge }) : null } : {}),
      retry_profile: retryProfile ? JSON.stringify(retryProfile)
        : ['order','say','child'].includes(task.task_kind) ? task.retry_profile : null });
    this.resumeQueuedTaskMerge(task.id);
    this.store.event(task.id, 'retry', retryProfile ? {
      profile_override: true, agent: retryProfile.agent, model: retryProfile.model || null,
      thinking: retryProfile.thinking || null, default_prompt_overridden: Boolean(retryProfile.default_prompt),
      append_prompt: Boolean(retryProfile.append_prompt), extensions: retryProfile.extensions.length,
      skills: retryProfile.skills.length, soft_budget: retryProfile.soft_budget || null,
    } : { profile_override: false });
    this.kick(); return this.store.task(task.id);
  },

  recover() {
    this.recoverChoiceSnapshots();
    this.scheduledHookRecoveryClock = this.hookClock();
    this.recoveringHooks = true;
    this.hookRecoveredWorkers = new Set();
    this.agentUsage.start();
    this.agentConnections.start();
    this.startRuntimeSettingsMonitor();
    // Legacy automation authorization is retained on disk but is not reactivated.
    // 抢占通道是进程内运行时状态：重启后不可能还有 invocation 在跑，残留请求必须清掉，
    // 否则下一次调用会在第一个安全边界被一条早已失效的请求误停。
    fs.rmSync(path.join(this.config.home, 'preempt'), { recursive: true, force: true });
    // A credential dies with the invocation that issued it; nothing survives a restart.
    this.store.transaction(() => {
      this.store.run('UPDATE tasks SET agent_token_hash=NULL');
      // The new host observes an interruption, not the actual exit time of an external
      // process. Close every orphan Run (including parked/legacy ones), without replay
      // or fabricated success evidence; preserve completed historical Runs unchanged.
      for (const run of this.store.all("SELECT id,task_id FROM agent_runs WHERE status='running' ORDER BY id")) {
        const closed = this.store.finishRun(run.id, 'failed', {
          error: 'daemon interrupted; ended_at records recovery observation, not actual process exit',
        });
        const recoveredEvent = this.store.event(run.task_id, 'invocation.recovered', { run_id: run.id,
          observed_at: closed.ended_at, actual_exit_at: null });
        this.hookRecoveredWorkers.add(run.task_id);
        this.emitTaskHook(run.task_id, 'agent.failed', recoveredEvent);
      }
      // Never replay an invocation with unknown filesystem side effects.
      for (const task of this.store.tasks()) if ((task.status === 'running' || task.interrupt_state === 'resuming')
        && ['order','child','analysis'].includes(task.task_kind))
        this.cancel(task.id, 'daemon interrupted; inspect worktree and explicitly retry', 'failed');
      for (const task of this.store.tasks()) if (task.interrupt_state === 'requested')
        this.store.update(task.id, { status: 'paused', interrupt_state: null });
    });
    // Never replay model requests. New-style interrupted explanations fail; historical rows remain unchanged.
    this.store.quickExplanationFailRunning('项目后台曾中断，本次解释未完成，请重新发起');
    this.store.followupFailRunning('项目后台曾中断，本次追问未完成，请重新发起');
    this.store.run("UPDATE tasks SET integration='review',integration_error='merge interrupted; inspect git history manually' WHERE integration='merging' AND task_kind IN ('order','say','child')");
    this.recoverTaskDeliveries();
    // Older retries discarded a withdrawn booking while leaving the source under its queue.
    // Restore the audited owner before wake/settlement; no approval or invocation is recreated.
    for (const task of this.store.tasks()) if (['order','child'].includes(task.task_kind)) {
      try { this.restoreUnrequestedTaskParent(task.id); }
      catch (error) { this.store.update(task.id, { integration_error: error.message }); }
    }
    // A crash can land between committing an inbox message and queueing its owner.
    for (const task of this.store.tasks()) {
      if (['order','child'].includes(task.task_kind) && !TERMINAL.has(task.status) && this.hasActionableMessages(task.id)) this.wake(task.id);
    }
    // 中断的检验已经标成失败；对照基线是派生状态，顺手回收掉。
    for (const task of this.store.tasks()) {
      if (['order','child'].includes(task.task_kind) && task.baseline_workspace && TERMINAL.has(task.status)) {
        this.workspaces.removeBaseline(task.id).catch(error => console.error(`verification ${task.id}: baseline cleanup failed: ${error.message}`));
      }
    }
    this.recoverTaskHooks();
    this.recoverTaskCompletion();
    this.kick();
    // Re-arm only persisted hooks; NULL historical settings never acquire new intent.
    for (const task of this.store.tasks()) if (task.status === 'waiting') this.armTaskAutoMerge(task.id);
    // 只续推已经静息的预约；running invocation 的未知文件副作用仍保留现场，不自动重播。
    for (const task of this.store.tasks()) if (['order','child'].includes(task.task_kind) && task.status === 'waiting' && task.reservation) {
      let pendingMerge = false;
      try { const value = JSON.parse(task.reservation); pendingMerge = value.kind === 'merge' && value.status === 'pending'; }
      catch { /* invalid state remains visible for inspection */ }
      if (pendingMerge) {
        const booking = JSON.parse(task.reservation);
        void (booking.version === 2 ? this.settleQueuedMerge(task.id) : this.settleReservedMerge(task.id)).catch(error =>
          booking.version === 2 ? this.noteCompletionMergeFailure(task.id) : this.noteReservationBlocked(task.id, error.message));
      }
    }
    // 已发出的请求也要复查：重启期间父分支可能被推进、源分支可能被外部改动，而 pending 复查不覆盖它。
    for (const task of this.store.tasks()) if (['order','child'].includes(task.task_kind) && task.reservation) {
      let requested = false;
      try { requested = JSON.parse(task.reservation)?.status === 'requested'; } catch { /* leave corrupt state visible */ }
      if (requested) {
        const booking = JSON.parse(task.reservation);
        if (booking.version === 2) this.scheduleTaskMerge(booking.parent_id);
        else void this.recheckRequestedMerge(task.id).catch(error =>
          this.noteReservationBlocked(task.id, error.message));
      }
    }
    // A returned source must not resume an invocation with unknown side effects after restart.
    for (const task of this.store.tasks()) if (['order','child'].includes(task.task_kind) && task.reservation) {
      let booking;
      try { booking = JSON.parse(task.reservation); } catch { continue; }
      if (booking.version === 2 && booking.status === 'resolving' && task.status === 'queued') {
        this.suspendTaskMerge(task.id, 'daemon interrupted divergence repair; inspect and explicitly retry');
        this.store.transaction(() => {
          this.store.update(task.id, { status: 'failed', error: 'daemon interrupted divergence repair; inspect and explicitly retry' });
          const eventId = this.store.event(task.id, 'merge.repair_interrupted', {});
          this.notifyTaskLifecycle(task.id, eventId);
        });
      }
      if (booking.version === 2 && booking.status === 'integrated') {
        // Integration no longer auto-archives; make sure a crash between landing and the parent
        // restore still returns the Task to its original parent for the user to reclaim. This also
        // backfills Tasks that an older daemon archived right after landing (their branch is gone,
        // but the booking still records the original parent).
        try { this.restoreMergedTaskParent(task.id); }
        catch (error) { this.store.update(task.id, { integration_error: `已合并；归还原父Worker受阻：${error.message}` }); }
      }
    }
    // 崩溃可能落在「独立解分歧子 Task 已结算」与「runtime 推进 order 分支」之间：重启后补跑收尾。
    for (const task of this.store.tasks()) {
      if (task.status === 'completed' && (task.resolves_task_id !== null
        || (task.task_kind === 'child' && this.store.get("SELECT id FROM events WHERE task_id=? AND type='task.divergence_resolution_requested' LIMIT 1", task.id))))
        this.scheduleTerminalDivergenceFinalize(task.id);
    }
    // Observe device authorization only AFTER orphan invocations, tokens and delivery recovery.
    // This may answer pending questions, but never replays interrupted/unknown invocation effects.
    this.startDeviceAutomationMonitor();
    // Legacy orchestrations and showcases remain on disk, without resuming their side effects.
  },

  async shutdown() {
    this.stopping = true;
    this.stopScheduledHookTimer();
    this.stopRuntimeSettingsMonitor();
    this.stopDeviceAutomationMonitor();
    const usageStopped = this.agentUsage.stop();
    const connectionsStopped = this.agentConnections.stop();
    const packagesStopped = Promise.allSettled([this.agentPackageManager.stop(), this.deviceAgentPackageManager?.stop()]);
    clearInterval(this.sleepTimer); this.sleepTimer = null;
    await this.sleepWatchPromise;
    await this.sleepTickPromise;
    for (const [taskId, run] of this.running) {
      if (run.parked) run.controller.abort();
      else this.cancel(taskId, 'daemon stopped; inspect before retrying', 'failed');
    }
    for (const entry of this.introRunning.values()) entry.controller.abort(new Error('daemon stopped; retry the quick intro'));
    await Promise.allSettled([...this.introRunning.values()].map(entry => entry.promise));
    await Promise.allSettled([...this.running.values()].map(run => run.promise));
    await this.hookQueue;
    await Promise.allSettled([...(this.shortcutCommandJobs ?? [])]);
    await this.completionQueue;
    await this.workspaces.queue;
    await usageStopped;
    await connectionsStopped;
    await packagesStopped;
  }
};
