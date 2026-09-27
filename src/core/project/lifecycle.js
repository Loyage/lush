import fs from 'node:fs';
import path from 'node:path';
import { check, TERMINAL, bounded } from '../types.js';

/**
 * 结算提醒的文案只由 AP 事实拼出来：goal 可能很长，只取第一行并截断成「一句话目标」。
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
function settlementReminder(ap, status) {
  const label = SETTLE_LABEL[status];
  const goal = String(ap.goal ?? '').split('\n').map(line => line.trim()).find(Boolean) ?? '';
  const brief = goal.length > 80 ? `${goal.slice(0, 80)}…` : goal;
  // 只读分析：结论就是这个 AP 的 result，没有分支 / 集成可说；直接把结论带到提醒里。
  if (ap.ap_kind === 'analysis') {
    const answer = String(ap.result ?? '').trim();
    return {
      title: `分支 ${ap.target_branch} 的分析 #${ap.id} ${label}`,
      body: [
        `问题：${brief}`,
        `分支：${ap.target_branch}（只读分析，没有分支改动）`,
        status === 'completed'
          ? `结论：${answer.length > 1200 ? `${answer.slice(0, 1200)}…` : answer || '（空回答）'}`
          : `分析未完成：${String(ap.error ?? '').slice(0, 500) || '没有记录到原因'}`,
        `完整回答见 AP #${ap.id} 详情。`,
      ].join('\n'),
    };
  }
  const reservation = ap.ap_kind === 'say' && ap.reservation ? JSON.parse(ap.reservation) : null;
  return {
    title: `分支 ${ap.branch}：AP #${ap.id} ${label}`,
    body: [
      `AP #${ap.id}（${ap.role}：${brief}）结算为「${label}」。`,
      `分支：${ap.branch}`,
      `直接父分支：${ap.target_branch ?? '（未记录）'}`,
      reservation?.kind === 'merge' && reservation.status === 'requested'
        ? `固定提交 ${reservation.commit} 的合并请求已发给父 AP #${reservation.parent_id}；当前尚未合入，须由父 Agent 或用户确认。`
        : reservation?.kind === 'showcase' && ['completed','failed','cancelled'].includes(reservation.status)
          ? `展示子 AP #${reservation.child_id} 已${reservation.status === 'completed' ? '交付' : reservation.status === 'cancelled' ? '取消' : '失败'}；展示不代表验收，也没有自动合并。`
          : `integration：${INTEGRATION_REMINDER[ap.integration] ?? INTEGRATION_REMINDER.none}。`,
    ].join('\n'),
  };
}

/** 结算、取消、重试、清空与恢复。 */
export default {
  finish(apId, status, result = null, error = null, options = {}) {
    const ap = this.store.ap(apId);
    if (TERMINAL.has(ap.status)) return ap;
    const resolutionEvent = ap.ap_kind === 'child' ? this.store.get(`SELECT data FROM events WHERE ap_id=?
      AND type='ap.divergence_resolution_requested' ORDER BY id DESC LIMIT 1`, ap.id) : null;
    const resolutionSource = resolutionEvent ? JSON.parse(resolutionEvent.data).source_ap_id : ap.resolves_ap_id;
    const request = options.mergeRequest ?? null;
    const showcaseSettlement = options.showcaseSettlement ?? null;
    // 用户对一次「只想了解」的 say 显式收尾：没有代码改动，也不产生合并请求。
    const resolvedByUser = options.resolvedByUser === true;
    check(!request || !showcaseSettlement, 'a say AP cannot merge and showcase together');
    if (resolvedByUser) {
      check(ap.ap_kind === 'say' && status === 'completed' && !request && !showcaseSettlement,
        'a user-resolved settlement belongs to a new say AP');
    } else if (ap.ap_kind === 'say' && (status === 'completed' || showcaseSettlement)) {
      const reservation = ap.reservation ? JSON.parse(ap.reservation) : null;
      if (request) {
        check(reservation?.kind === 'merge' && reservation.status === 'pending'
          && ap.status === 'waiting' && ap.head_commit === request.commit && ap.parent_id === request.parent_id,
        'a new say AP completes only with its pinned merge request');
        const parent = this.store.ap(ap.parent_id);
        check(['main','owner','say'].includes(parent.ap_kind) && !TERMINAL.has(parent.status),
          'merge request parent is no longer active');
      } else {
        const child = showcaseSettlement ? this.store.ap(showcaseSettlement) : null;
        check(reservation?.kind === 'showcase' && ['preparing','started'].includes(reservation.status)
          && reservation.child_id === child?.id && child.parent_id === ap.id
          && child.role === 'showcase' && child.ap_kind === 'showcase' && TERMINAL.has(child.status)
          && ap.status === 'waiting'
          && status === (child.status === 'completed' ? 'completed' : child.status === 'cancelled' ? 'cancelled' : 'failed'),
        'a new say AP completes only after its reserved showcase child settles');
      }
    } else check(!request && !showcaseSettlement, 'delivery settlement belongs to a say AP');
    if (ap.role === 'butler' && status !== 'completed') {
      const source = this.butlerContext(ap.id);
      this.finishSleepChoice(source.choice_id, { status: 'interrupted', reason: error || '管家中断，未执行选择' });
    }
    if (ap.role === 'showcase' && status !== 'completed') void this.stopShowcasePreview(ap.id);
    check(this.store.children(ap.id).every(child => TERMINAL.has(child.status)), 'cannot finish with active children');
    this.store.transaction(() => {
      // A retry profile is scoped to this attempt. Terminal settlement removes it so a later
      // explicit retry starts from the then-current project/role profile unless the user adjusts it again.
      if (showcaseSettlement) {
        const reservation = JSON.parse(ap.reservation);
        const { blocked_reason: _previousReason, blocked_code: _previousCode, ...cleanReservation } = reservation;
        this.store.update(ap.id, { reservation: JSON.stringify({ ...cleanReservation, status,
          settled_at: new Date().toISOString() }) });
        this.store.event(ap.id, 'ap.showcase_settled', { child_id: showcaseSettlement, status });
      }
      if (request) {
        const reservation = JSON.parse(ap.reservation);
        const { blocked_reason: _previousReason, blocked_code: _previousCode, ...cleanReservation } = reservation;
        const requested = { ...cleanReservation, status: 'requested', commit: request.commit, baseline: request.baseline,
          parent_id: request.parent_id, requested_at: new Date().toISOString() };
        const key = `merge:${ap.id}:${request.commit}`;
        const payload = { branch: ap.branch, commit: request.commit, baseline: request.baseline };
        const body = JSON.stringify({ version: 1, signal: 'merge.requested', key, source_ap_id: ap.id,
          target_ap_id: request.parent_id, payload });
        const row = this.store.signal(request.parent_id, ap.id, 'merge.requested', key, body);
        this.store.event(ap.id, 'ap.merge_requested', { ...payload, parent_id: request.parent_id, message_id: row.id });
        if (row.inserted) this.store.event(request.parent_id, 'ap.signal', { message_id: row.id,
          source_ap_id: ap.id, signal: 'merge.requested', key });
        this.store.update(ap.id, { reservation: JSON.stringify(requested) });
      }
      this.store.update(ap.id, { status, result, error, retry_profile: null,
        ...(resolvedByUser ? { reservation: null } : {}) });
      if (resolvedByUser) this.store.event(ap.id, 'ap.resolved', { head_commit: ap.head_commit ?? null });
      this.store.run("UPDATE notices SET status='dismissed',answer='AP ended' WHERE ap_id=? AND status='open'", ap.id);
      // 结算提醒：completed / failed 且 AP 有自己的分支或是一次只读分析时落且只落一条纯信息 notice。
      // 它 kind='info' / status='sent'，与这次结算同一个事务，且顺序在「关掉 open notice」之后；
      // cancelled 不提醒，没有分支的 AP（planner / scheduler / coordinator / research / verifier）也不提醒。
      if ((status === 'completed' || status === 'failed') && (ap.branch || ap.ap_kind === 'analysis')) {
        const reminder = settlementReminder(this.store.ap(ap.id), status);
        this.notify(ap.id, reminder.title, reminder.body);
      }
      const settlementEvent = this.store.event(ap.id, status, { result, error });
      // 一个 scheduler 要么把 spec 编成 AP，要么明确 drop；取消则把未处理的 spec 还给队列，绝不静默丢弃。
      if (ap.role === 'scheduler') {
        if (status === 'cancelled') this.store.releaseBatch(ap.id, 'scheduler 被取消，spec 回到 pending');
        else if (status === 'completed' || status === 'failed') this.store.discardBatch(ap.id, `scheduler 未覆盖该 spec（${status}）`);
      }
      if (ap.parent_id && !resolutionEvent && !request && !TERMINAL.has(this.store.ap(ap.parent_id).status)
        && !(['say','analysis','merge'].includes(ap.ap_kind) && ['main','owner'].includes(this.store.ap(ap.parent_id).ap_kind))) {
        const parent = this.store.ap(ap.parent_id);
        if ((ap.ap_kind === 'child' && ['say','child'].includes(parent.ap_kind))
          || (ap.ap_kind === 'showcase' && parent.ap_kind === 'say')) {
          const key = `${ap.ap_kind}:${ap.id}:settlement:${settlementEvent}`;
          const type = `${ap.ap_kind}.${status}`;
          const payload = { result: result?.slice(0, 2000) ?? null, error,
            result_truncated: (result?.length ?? 0) > 2000, commit: this.store.ap(ap.id).head_commit };
          const body = JSON.stringify({ version: 1, signal: type, key, source_ap_id: ap.id,
            target_ap_id: parent.id, payload });
          const row = this.store.signal(parent.id, ap.id, type, key, body);
          if (row.inserted) this.store.event(parent.id, 'ap.signal', { message_id: row.id,
            source_ap_id: ap.id, signal: type, key });
        } else {
          const messageId = this.store.message(ap.parent_id, JSON.stringify({ child: ap.id, status,
            result: result?.slice(0, 2000) ?? null, error, result_truncated: (result?.length ?? 0) > 2000 }), ap.id);
          if (status === 'completed') this.store.event(ap.parent_id, 'child.completed', { child: ap.id, message_id: messageId });
        }
      }
      // Verification settles either a worker detail or a frozen review candidate.
      if (ap.verifies_ap_id) this.store.touch(ap.verifies_ap_id);
      if (ap.role === 'showcase' && status === 'completed') this.notify(ap.id, `效果展示已就绪 #${ap.id}`,
        `${JSON.parse(ap.showcase).branch} 的展示页已生成。展示不代表检验通过，也没有自动合并。`);
      if (ap.review_candidate_id) {
        const hasReport = this.hasReport(ap.id);
        const verification = this.verificationResult(ap.id);
        // Invocation completed 只说明 agent 正常返回；Candidate 仅在固定 commit 的结构化证据明确 pass
        // 且人类报告存在时进入 ready。fail / partial / unverified / 旧记录 unknown 都保持可见但不放行。
        const candidateStatus = status === 'completed' && hasReport && verification.status === 'pass' ? 'ready' : 'failed';
        // Candidate 的当前状态和 report_ap_id 必须与这个 verifier 同时匹配；一条条件 UPDATE
        // 把检查和写入留在当前事务内，迟到回调不能覆盖拒绝、反馈、替代版本或更新的 verifier。
        const settlement = this.store.settleCandidateVerification(ap.review_candidate_id, ap.id, candidateStatus);
        if (settlement.applied) {
          this.store.event(ap.id, 'candidate.verified', { candidate: ap.review_candidate_id, status,
            candidate_status: candidateStatus, verification_status: verification.status, has_report: hasReport });
        } else {
          // AP / Run / Artifact 照常保留；另加明确事件说明为什么这份结果没有改变 Candidate。
          this.store.event(ap.id, 'candidate.verification_ignored', { candidate: ap.review_candidate_id, status,
            candidate_status: settlement.candidate.status, current_report_ap_id: settlement.candidate.report_ap_id,
            verification_status: verification.status, has_report: hasReport });
        }
      }
      // 解冲突 AP 没做成（失败 / 被取消）：原 AP 回到待合并，冻结随之解除，错误留在解冲突 AP 上。
      // 分支与 worktree 都保留，用户可以重试或自己处理。
      if (resolutionSource && status !== 'completed') {
        const target = this.store.ap(resolutionSource);
        if (target.integration === 'conflict') {
          this.store.update(target.id, { integration: 'pending',
            integration_error: `resolution AP #${ap.id} ${status}${error ? `: ${error}` : ''}` });
          this.store.event(target.id, 'merge.conflict.abandoned', { resolution: ap.id, status });
        } else {
          // 终态 say 的独立解分歧子 AP 没做成：把预约落回可分派的 diverged，保留失败现场。
          this.noteTerminalDivergenceFailure({ ...ap, resolves_ap_id: resolutionSource }, status, error);
        }
      }
    });
    // A reserved showcase child closes the original say only after its own terminal fact is committed.
    // If we crash here, recover() repeats this DB-only, idempotent step.
    if (ap.ap_kind === 'showcase' && ap.parent_id) this.settleReservedShowcase(ap.parent_id);
    // 终态 say 的独立解分歧子 AP 完成：由 runtime 把产物推进回 say 分支并重新发合并请求。
    if (resolutionSource && status === 'completed') this.scheduleTerminalDivergenceFinalize(ap.id);
    // Work compiled from a Plan is automatically aggregated inside the private Intent branch. The user still
    // approves only the frozen Review Candidate when it moves from the Intent branch to the target branch.
    const compiled = status === 'completed' && ap.role === 'worker'
      && Boolean(this.store.get("SELECT id FROM events WHERE ap_id=? AND type='plan.materialized' LIMIT 1", ap.id));
    if (ap.input_id && ap.branch && (compiled || ap.role === 'merger')) this.scheduleIntentIntegration(ap.input_id);
    // 一键合并 / 合并编排若正等这个 merger 或解分歧子 AP，结算后自动继续下一步。
    if (ap.role === 'merger' || ap.resolves_ap_id !== null) this.resumeMergeRun(ap.id);
    if (ap.parent_id && !resolutionEvent
      && !(ap.ap_kind === 'say' && ['main','owner'].includes(this.store.ap(ap.parent_id).ap_kind)))
      this.wake(ap.parent_id);
    // A settled dependency releases every queued dependent; still-blocked ones stay queued.
    for (const edge of this.store.dependents(ap.id)) this.wake(edge.ap_id);
    // 一个没有父子/依赖边的 planner（根 AP）也要在自己结束时把这一轮拆解交给 scheduler。
    this.kick();
    // 结算可能正好满足某条分支的效果展示预约，重扫一次（只在触发点调度，不挂进每次 kick）。
    this.scheduleShowcaseSweep();
    return this.store.ap(ap.id);
  },

  cancel(apId, reason = 'cancelled by user', status = 'cancelled') {
    const ap = this.store.ap(apId);
    check(!['main','owner'].includes(ap.ap_kind), 'branch owner is a permanent root; cancel individual say APs instead');
    if (TERMINAL.has(ap.status)) return ap;
    // 合并编排 AP 直接经 ap.cancel 取消时，也要先清运行释放冻结、取消等待中的解分歧子 AP，
    // 与 branch.orchestrate_cancel 同一收尾；否则残留 run 会继续驱动并冻结目标分支。
    if (ap.ap_kind === 'merge') {
      for (const { target, run } of this.store.activeBranchMergeRuns()) {
        if (run.mode !== 'orchestrate' || run.ap_id !== ap.id) continue;
        this.store.transaction(() => {
          this.store.setBranchMergeRun(target, null);
          this.store.event(ap.id, 'merge.orchestrate.cancelled', { target, done: run.done ?? [], via: 'ap.cancel' });
        });
        const waiting = run.waiting_ap_id ? this.store.ap(run.waiting_ap_id) : null;
        if (waiting && !TERMINAL.has(waiting.status)) this.cancel(waiting.id, reason);
        break;
      }
    }
    // Children first; the event loop cannot schedule their parents until this synchronous cascade ends.
    for (const child of this.store.children(ap.id)) if (!TERMINAL.has(child.status)) this.cancel(child.id, reason);
    this.running.get(ap.id)?.controller.abort(new Error(reason));
    return this.finish(ap.id, status, null, reason);
  },

  /**
   * 用户专属的一键清空：删掉全部已结束 AP，连同 inputs / drafts / notices / events。
   * 有活动 AP（或刚 abort、invocation 尚未收尾的 agent）时拒绝，不做隐式取消——
   * 删除正在被调用的 AP 行会让 agent 的收尾路径读到不存在的 AP。
   * 先按与 ap cleanup 相同的安全门回收磁盘状态（worktree 目录、对照检出、已进目标分支的分支），
   * 再清库；回收不掉的 AP 连同分支与目录一起保留，返回值里列出原因。
   * 状态检查是同步的（调用方立即拿到拒绝），磁盘回收在返回的 Promise 里串行执行。
   */
  clear() {
    check(!this.clearing, 'clear is already in progress');
    check(!this.sleepStatus().enabled && !this.sleepTickPromise, '请先关闭托管模式并等待管家操作结束，再清空项目');
    check(this.running.size === 0, 'an agent invocation is still unwinding; clear must wait');
    check(this.store.activeBranchMergeRuns().length === 0, 'a one-click merge is in progress; finish or cancel it before clearing');
    check(this.workspaces.busy.size === 0, 'worktree cleanup is in progress; clear must wait');
    const active = this.store.activeAPs();
    check(active.length === 0,
      `#${active.slice(0, 20).map(ap => ap.id).join(', #')} still active (${active.length}); cancel them or wait until they finish`);
    // 分支名、worktree 路径与对照目录都记在即将被删的行里，所以先回收再 purge。
    const anchors = this.store.all(`SELECT id, anchor_branch, anchor_commit, anchor_workspace FROM inputs
      WHERE anchor_branch IS NOT NULL ORDER BY id`);
    // The checks above are synchronous, so from here on every new write is refused until purge is done.
    // A write already in flight re-checks this flag after its asynchronous Git step (see inputs/say).
    this.clearing = true;
    return this.reclaimThenPurge(this.store.aps(), anchors.map(input => ({ id: input.id,
      branch: input.anchor_branch, commit: input.anchor_commit, workspace: input.anchor_workspace })))
      .finally(() => { this.clearing = false; });
  },

  async reclaimThenPurge(aps, anchors = []) {
    // Writes admitted before the gate closed finish first; new ones are already refused.
    await this.drainWrites();
    const outcomes = await this.workspaces.reclaim(aps);
    // 输入锚点是提交那一刻的快照，没有 agent 往里提交：干净就回收，脏或被改过就留着并说明原因。
    const reclaimedAnchors = anchors.length ? await this.workspaces.reclaimAnchors(anchors) : [];
    const reason = new Map(outcomes.map(row => [row.id, row.reason]));
    const retained = this.store.all(`SELECT id, branch, workspace, baseline_workspace FROM aps
      WHERE workspace IS NOT NULL OR baseline_workspace IS NOT NULL OR branch IS NOT NULL ORDER BY id`);
    const counts = this.store.purge();
    return {
      cleared: { aps: counts.aps, inputs: counts.inputs, drafts: counts.drafts, notices: counts.notices,
        messages: counts.messages, events: counts.events, ap_deps: counts.ap_deps, ap_specs: counts.ap_specs },
      reclaimed: {
        worktrees: outcomes.filter(row => row.worktree === 'removed').length,
        branches: outcomes.filter(row => row.branch === 'removed').length,
        anchors: reclaimedAnchors.filter(row => row.status === 'removed').length,
      },
      retained: { note: 'unmerged work, unreviewed branches and pi sessions stay on disk; remove them by hand',
        aps: bounded(retained.map(row => ({ ...row, reason: reason.get(row.id) ?? null })), 200000),
        anchors: bounded(reclaimedAnchors.filter(row => row.status === 'kept'), 200000) },
      next_ap_id: this.store.apIdHigh() + 1,
      next_input_id: this.store.inputIdHigh() + 1,
    };
  },

  /**
   * 用户专属的定向删除（`ap.delete` / `lush ap delete`）：把一条已结束 AP 连同它的全部已结束后代
   * 从库里删掉。这是除 clear 之外唯一会丢掉 AP 历史的路径，所以安全门比 clear 更细，范围却只有这一棵子树：
   * - 子树里任何一条还在跑 / 排队 / 等答复：拒绝，不做隐式取消（同 clear）；
   * - 它的 invocation 还在收尾、或 cleanup 正在走它的 worktree：拒绝；
   * - 子树里的 planner 还留着未编排的 pending spec：拒绝——删掉那些条目等于替用户丢掉还没处理的拆解；
   * - 集合外还有 verifier / resolver / 验收候选用外键指着它：拒绝并点名，先删引用方（它们是独立记录，不跟它一起走）；
   * - 磁盘状态（worktree / 对照检出 / 已进目标分支的分支）走与 cleanup 相同的安全门回收，有一条收不回来
   *   就整体不删（已经收掉的保持回收状态）并列出原因，绝不为了删一行库而丢未合并的成果。
   * 这五条都过了才真删：AP 行与它们的子行一起消失，另留一条 `ap_id=NULL` 的项目级事件 `ap.deleted`，
   * 把被删的 id / 角色 / 状态与各表行数记在 data 里（那条事件没有 AP 可挂，要查用 SQL）。id 不复用。
   * 有意不动 `branches.ap_id` / `inputs.ap_id` 这类历史指针（它们刻意没有外键）：删掉一条输入锚点的
   * 根 planner 后，这条输入不再出现在 intent 列表里——那个列表由 `inputs JOIN aps` 派生。
   * 状态检查是同步的（调用方立即拿到拒绝），磁盘回收在返回的 Promise 里串行执行。
   */
  deleteAP(apId) {
    const root = this.store.ap(apId);
    const subtree = this.subtreeAPs(root.id);
    const ids = subtree.map(ap => ap.id);
    const active = subtree.filter(ap => !TERMINAL.has(ap.status));
    check(active.length === 0,
      `#${active.slice(0, 20).map(ap => ap.id).join(', #')} still active (${active.length}); cancel them or wait until they finish`);
    check(ids.every(value => !this.running.has(value)), 'agent is still stopping; delete must wait');
    check(ids.every(value => !this.workspaces.busy.has(value)), 'worktree cleanup is in progress; delete must wait');
    // 冻结中的分支（一键合并 / 未结束的 merger）不允许删 AP：删除会连带走它的分支与 worktree。
    for (const ap of subtree) if (ap.branch) this.assertBranchWritable(ap.branch, 'delete an AP on it');
    const unhandled = subtree.filter(ap => ap.role === 'planner'
      && this.store.get("SELECT count(*) AS value FROM ap_specs WHERE planner_ap_id=? AND status='pending'", ap.id).value > 0);
    check(unhandled.length === 0,
      `planner #${unhandled[0]?.id} still has pending specs; compile, approve or drop them first`);
    const referrers = this.store.referringAPs(ids);
    check(referrers.length === 0, `#${root.id} is still referenced by ${referrers.join(', ')}; delete the referrer first`);
    return this.forgetAPs(root, subtree, ids);
  },

  /** 这棵子树的 AP（含根）。终态 AP 不允许有活动后代，但结构归结构，不看 status 猜。 */
  subtreeAPs(apId) {
    const out = [];
    const queue = [this.store.ap(apId)];
    while (queue.length) {
      const ap = queue.pop();
      out.push(ap);
      queue.push(...this.store.children(ap.id));
    }
    return out;
  },

  /** deleteAP 的异步尾部：先按 cleanup 的安全门收磁盘，收不干净就整体不删，再清库并留一条审计事件。 */
  async forgetAPs(root, subtree, ids) {
    const outcomes = await this.workspaces.reclaim(subtree);
    // 目录、分支或对照检出收不回来（未合并、脏、被别处检出）：AP 行不动，让用户先处理磁盘。
    const kept = outcomes.filter(row => row.worktree === 'kept' || row.branch === 'kept');
    check(kept.length === 0,
      `${kept.map(row => `#${row.id} (${row.reason})`).join('; ')} cannot be reclaimed; finish or clean it up first (lush ap cleanup ID)`);
    const counts = this.store.deleteAPs(ids);
    this.store.event(null, 'ap.deleted', { ap_id: root.id,
      aps: subtree.map(ap => ({ id: ap.id, parent_id: ap.parent_id, input_id: ap.input_id,
        role: ap.role, status: ap.status, branch: ap.branch })), counts });
    return {
      deleted: { root: root.id, ids, ...counts },
      reclaimed: {
        worktrees: outcomes.filter(row => row.worktree === 'removed').length,
        branches: outcomes.filter(row => row.branch === 'removed').length,
      },
      next_ap_id: this.store.apIdHigh() + 1,
    };
  },

  retry(apId, profile = null) {
    this.assertWritable('retry an AP');
    const ap = this.store.ap(apId);
    check(['failed','cancelled'].includes(ap.status), 'only failed/cancelled aps can be retried');
    check(!this.running.has(ap.id), 'agent is still stopping; retry shortly');
    check(!this.workspaces.busy.has(ap.id), 'worktree cleanup is in progress; retry shortly');
    check(ap.role !== 'butler', '管家决定不允许重放；请手动处理原 Notice');
    const divergenceChild = ap.ap_kind === 'child' && this.store.get(
      "SELECT id FROM events WHERE ap_id=? AND type='ap.divergence_resolution_requested' LIMIT 1", ap.id);
    check(!divergenceChild, '解分歧子 AP 不重放未知文件副作用：先检查现场，显式归档旧分支，再从源 say 重新派独立子 AP');
    // 冻结中的分支不接受重试：重试会重新产出提交、推进分支，扰动正在进行的合并。
    if (ap.branch) this.assertBranchWritable(ap.branch, 'retry an AP on it');
    if (ap.role === 'showcase') return this.retryShowcase(ap.id);
    if (ap.ap_kind === 'say' && ap.reservation) {
      const reservation = JSON.parse(ap.reservation);
      check(reservation.kind !== 'showcase' || !['completed','failed','cancelled'].includes(reservation.status),
        'a settled showcase and its parent cannot be retried separately; submit a new say');
    }
    if (ap.parent_id) check(!TERMINAL.has(this.store.ap(ap.parent_id).status), 'parent has ended; retry the parent or submit a new input');
    const retryProfile = profile === null || profile === undefined ? null : this.agentSettings.retryProfile(ap.role, profile);
    this.store.update(ap.id, { status: 'queued', error: null, result: null, calls: 0,
      retry_profile: retryProfile ? JSON.stringify(retryProfile) : null });
    this.store.event(ap.id, 'retry', retryProfile ? {
      profile_override: true, agent: retryProfile.agent, model: retryProfile.model || null,
      thinking: retryProfile.thinking || null, default_prompt_overridden: Boolean(retryProfile.default_prompt),
      append_prompt: Boolean(retryProfile.append_prompt), extensions: retryProfile.extensions.length,
      skills: retryProfile.skills.length, soft_budget: retryProfile.soft_budget || null,
    } : { profile_override: false });
    this.kick(); return this.store.ap(ap.id);
  },

  recover() {
    // Legacy automation authorization is retained on disk but is not reactivated.
    // 抢占通道是进程内运行时状态：重启后不可能还有 invocation 在跑，残留请求必须清掉，
    // 否则下一次调用会在第一个安全边界被一条早已失效的请求误停。
    fs.rmSync(path.join(this.config.home, 'preempt'), { recursive: true, force: true });
    // A credential dies with the invocation that issued it; nothing survives a restart.
    this.store.run('UPDATE aps SET agent_token_hash=NULL');
    // Historical quick-intro rows are retained unchanged; the feature is no longer resumed.
    // Never replay an invocation with unknown filesystem side effects.
    for (const ap of this.store.aps()) if (ap.status === 'running' && ['say','child'].includes(ap.ap_kind))
      this.cancel(ap.id, 'daemon interrupted; inspect worktree and explicitly retry', 'failed');
    this.store.run("UPDATE aps SET integration='review',integration_error='merge interrupted; inspect git history manually' WHERE integration='merging' AND ap_kind IN ('say','child')");
    // A crash can land between committing an inbox message and queueing its owner.
    for (const ap of this.store.aps()) {
      if (['say','child'].includes(ap.ap_kind) && !TERMINAL.has(ap.status) && this.hasActionableMessages(ap.id)) this.wake(ap.id);
    }
    // 中断的检验已经标成失败；对照基线是派生状态，顺手回收掉。
    for (const ap of this.store.aps()) {
      if (['say','child'].includes(ap.ap_kind) && ap.baseline_workspace && TERMINAL.has(ap.status)) {
        this.workspaces.removeBaseline(ap.id).catch(error => console.error(`verification ${ap.id}: baseline cleanup failed: ${error.message}`));
      }
    }
    this.kick();
    // 只续推已经静息的预约；running invocation 的未知文件副作用仍保留现场，不自动重播。
    for (const ap of this.store.aps()) if (ap.ap_kind === 'say' && ap.status === 'waiting' && ap.reservation) {
      let pendingMerge = false;
      try { const value = JSON.parse(ap.reservation); pendingMerge = value.kind === 'merge' && value.status === 'pending'; }
      catch { /* invalid state remains visible for inspection */ }
      if (pendingMerge) void this.settleReservedMerge(ap.id).catch(error =>
        this.noteReservationBlocked(ap.id, error.message));
    }
    // 已发出的请求也要复查：重启期间父分支可能被推进、源分支可能被外部改动，而 pending 复查不覆盖它。
    for (const ap of this.store.aps()) if (ap.ap_kind === 'say' && ap.reservation) {
      let requested = false;
      try { requested = JSON.parse(ap.reservation)?.status === 'requested'; } catch { /* leave corrupt state visible */ }
      if (requested) void this.recheckRequestedMerge(ap.id).catch(error =>
        this.noteReservationBlocked(ap.id, error.message));
    }
    // 崩溃可能落在「独立解分歧子 AP 已结算」与「runtime 推进 say 分支」之间：重启后补跑收尾。
    for (const ap of this.store.aps()) {
      if (ap.status === 'completed' && (ap.resolves_ap_id !== null
        || (ap.ap_kind === 'child' && this.store.get("SELECT id FROM events WHERE ap_id=? AND type='ap.divergence_resolution_requested' LIMIT 1", ap.id))))
        this.scheduleTerminalDivergenceFinalize(ap.id);
    }
    // Legacy orchestrations and showcases remain on disk, without resuming their side effects.
  },

  async shutdown() {
    this.stopping = true;
    clearInterval(this.sleepTimer); this.sleepTimer = null;
    await this.sleepWatchPromise;
    await this.sleepTickPromise;
    for (const [apId, run] of this.running) {
      if (run.parked) run.controller.abort();
      else this.cancel(apId, 'daemon stopped; inspect before retrying', 'failed');
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
