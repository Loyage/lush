import { check, id, TERMINAL, isSettled } from '../types.js';
import { assertTaskNotSyncing } from './iteration.js';
import { workerLabel } from '../worker-number.js';
import { storedReservation, parentMovedReason } from './order-state.js';

/** Delivery entry points, readiness barriers and reservation diagnostics across protocols. */
export default {

  /** User-only compatibility entry: resolving an order now uses the shared acceptance protocol. */
  async resolveTask(taskId) {
    const task = this.store.task(id(taskId));
    check(task.task_kind === 'order', 'only an order Worker can use the resolve compatibility entry');
    return this.acceptTask(task.id);
  },

  /** Persistent merge intention; not an authorization to mutate Git. */
  async reserveTask(taskId, kind) {
    assertTaskNotSyncing(this, id(taskId));
    check(kind === 'merge', 'reservation kind must be merge');
    const code = this.store.task(id(taskId));
    if (code.task_kind === 'child' || !code.reservation || JSON.parse(code.reservation)?.version === 2)
      return this.requestTaskMerge(taskId);
    const accepted = this.store.transaction(() => {
      const task = this.store.task(id(taskId));
      check(task.task_kind === 'order', 'only new order Workers support delivery reservations');
      check(!TERMINAL.has(task.status), 'cannot reserve an ended order Worker');
      const previous = storedReservation(task.reservation);
      check(!previous || (previous.version === 1 && previous.status === 'pending' && previous.kind === 'merge'),
        'reservation state needs inspection before changing it');
      check(!previous || previous.kind === kind, `worker ${workerLabel(task)} already reserves ${previous?.kind}; unreserve it before choosing ${kind}`);
      if (previous) return { task_id: task.id, reservation: previous, changed: false };
      const reservation = { version: 1, kind, status: 'pending', created_at: new Date().toISOString() };
      this.store.update(task.id, { reservation: JSON.stringify(reservation) });
      this.store.event(task.id, 'task.reserved', { reservation });
      return { task_id: task.id, reservation, changed: true };
    });
    try {
      const current = storedReservation(this.store.task(accepted.task_id).reservation);
      // 已发出的请求没有 pending 可推进：重查它现在是否仍可落地、已被包含，还是已经失效。
      if (current?.status === 'requested') await this.recheckRequestedMerge(accepted.task_id);
      else await this.settleReservedMerge(accepted.task_id);
    } catch (error) { this.noteReservationBlocked(accepted.task_id, error.message); }
    return { ...accepted, reservation: storedReservation(this.store.task(accepted.task_id).reservation) };
  },

  /**
   * 用户专属：把一条目标分支（例如 main）下所有已静息、待合并的 Task 一次性放进父 Task 的 merge 子任务。
   * 每条仍走与单条 `worker.reserve` 完全相同的准入（静息、工作区、固定提交、父基线、子分支收拢），
   * 所以这里只是把「逐条点请求合并」收成一个入口，不新增任何绕过校验的捷径；不满足条件的保持 pending
   * 预约并记录 `blocked_reason`，由 merge 队列按 id 顺序串行落地。返回逐条结果供界面汇总。
   */
  async reserveMergeAll(targetBranch) {
    const name = String(targetBranch ?? '').trim();
    check(name.length > 0 && name.length <= 512, 'branch name must be non-empty text');
    // 只有还停在自己分支上、尚未集成的 order/child 才有资格。
    const rows = this.store.all(`SELECT id FROM tasks
      WHERE task_kind IN ('order','say','child') AND status='waiting' AND integration='pending' AND target_branch=?
        AND (reservation IS NULL OR json_extract(reservation,'$.kind')='merge')
      ORDER BY id`, name);
    const tasks = [];
    for (const row of rows) {
      try {
        const booked = await this.reserveTask(row.id, 'merge');
        const reservation = booked.reservation ?? null;
        tasks.push({ id: row.id,
          status: reservation?.status === 'requested' ? 'requested' : 'blocked',
          reservation, blocked_reason: reservation?.blocked_reason ?? null });
      } catch (error) {
        tasks.push({ id: row.id, status: 'failed', error: error.message });
      }
    }
    return { target_branch: name, total: rows.length,
      requested: tasks.filter(task => task.status === 'requested').length,
      blocked: tasks.filter(task => task.status === 'blocked').length,
      failed: tasks.filter(task => task.status === 'failed').length, tasks };
  },

  /** 阻塞诊断：pending 是“还没能满足”，requested 是“已发出的请求失效了”。两种情况都只记录上次检查的快照。 */
  noteReservationBlocked(taskId, reason, code = null) {
    this.store.transaction(() => {
      const task = this.store.task(taskId);
      const reservation = storedReservation(task.reservation);
      if (reservation?.kind !== 'merge' || !['pending','requested','resolving'].includes(reservation.status)) return;
      const blocked_reason = String(reason).slice(0, 1000);
      if (reservation.blocked_reason === blocked_reason && (reservation.blocked_code ?? null) === code) return;
      const { blocked_code: _previousCode, ...rest } = reservation;
      this.store.update(task.id, { reservation: JSON.stringify({ ...rest, blocked_reason,
        ...(code ? { blocked_code: code } : {}) }) });
      this.store.event(task.id, 'task.reservation_blocked', { reason: blocked_reason, code });
    });
    this.scheduleTaskCompletion(taskId);
  },

  /** 清掉过期的诊断：请求重新可以快进时，旧原因不能留着误导用户。 */
  clearReservationBlocked(taskId) {
    this.store.transaction(() => {
      const task = this.store.task(id(taskId));
      const reservation = storedReservation(task.reservation);
      if (!reservation || (!reservation.blocked_reason && !reservation.blocked_code)) return;
      const { blocked_reason: previous, blocked_code: code, ...clean } = reservation;
      this.store.update(task.id, { reservation: JSON.stringify(clean) });
      this.store.event(task.id, 'task.reservation_rechecked', { previous_reason: previous ?? null, code: code ?? null });
    });
  },

  /**
   * 已发出请求的只读复查：请求发出后 Git 会变（父分支被推进、外部人动过源分支），而 pending 的复查
   * 不覆盖这种状态。重启恢复与集成/批准失败都走这里，把结果如实写进 reservation 诊断。
   */
  async recheckRequestedMerge(taskId) {
    const task = this.store.task(id(taskId));
    const reservation = storedReservation(task.reservation);
    if (task.task_kind !== 'order' || reservation?.kind !== 'merge' || reservation.status !== 'requested') return null;
    const parent = this.store.task(task.parent_id);
    const commit = reservation.commit;
    const state = await this.workspaces.branchState(task.branch).catch(() => null);
    if (!state?.parent_head || state.child_head !== commit) {
      this.noteReservationBlocked(task.id,
        `源分支 ${task.branch} 的顶端已是 ${String(state?.child_head ?? '缺失').slice(0, 12)}，不再是请求里固定的提交 ${String(commit).slice(0, 12)}；`
        + '先检查现场，必要时撤销这个请求。', 'source_moved');
      return 'source_moved';
    }
    if (await this.workspaces.isAncestor(this.config.project, commit, state.parent_head)) {
      this.noteReservationBlocked(task.id,
        `固定提交 ${String(commit).slice(0, 12)} 已经在 ${parent.branch} 里：让直接父 Agent 确认（父为指令），`
        + '或你按固定值批准（父为 main/owner），两种方式都是幂等关闭。', 'contained');
      return 'contained';
    }
    if (!(await this.workspaces.isAncestor(this.config.project, state.parent_head, commit))) {
      this.noteReservationBlocked(task.id, parentMovedReason(parent.branch, state.parent_head, commit), 'parent_moved');
      return 'parent_moved';
    }
    this.clearReservationBlocked(task.id);
    return 'landable';
  },

  /** 父分支自己提交后，复查挂在它上面的请求：不能快进的请求如实记成 parent_moved，而不是继续显示“等待集成”。
   *  返回仍处于失效状态的请求 id（没有就返回 null）；重复调用只刷新一次诊断（同因同码不重写事件）。 */
  async noteBranchAdvance(taskId) {
    const task = this.store.task(taskId);
    if (!task.branch) return null;
    const lock = this.branchFreeze(task.branch);
    if (!lock || lock.kind !== 'delivery' || lock.task_id === task.id || !lock.commit) return null;
    const head = task.head_commit;
    if (!head) return null;
    if (await this.workspaces.isAncestor(this.config.project, lock.commit, head)) return null;
    this.noteReservationBlocked(lock.task_id, parentMovedReason(task.branch, head, lock.commit), 'parent_moved');
    return lock.task_id;
  },

  /** Read-only request readiness, shared by detail and graph; Git admission still runs on reserve. */
  mergeReadiness(task) {
    if (!['order','child'].includes(task.task_kind)) return null;
    const reason = this.reservationWaitReason(task);
    if (reason) return { ready: false, reason };
    if (task.integration !== 'pending' || !task.branch || !task.head_commit
      || !task.base_commit || task.head_commit === (task.iteration_base_commit ?? task.base_commit))
      return { ready: false, reason: '没有登记的待交付提交，等待本轮工作完成' };
    return { ready: true, reason: null };
  },

  /** An observable execution barrier, not a Git verdict. A retry never skips a running invocation or unread signal. */
  reservationWaitReason(task) {
    if (this.store.executionRetired(task.id)) return '执行环境已退役；历史 Worker 只读保留';
    if (this.taskSyncBusy?.has(task.id)) return 'Worker 父分支同步正在执行，请等待安全点';
    const inbound = this.activeTaskMerge(task.id);
    if (inbound) return `等待子Worker ${workerLabel(inbound)} 的父分支执行位释放`;
    if (this.running.has(task.id) || task.status === 'running') return 'Agent 正在调用或收尾，等待本轮安全结束';
    if (task.status === 'queued') return 'Worker 等待下一轮 Agent 调用完成';
    if (task.status === 'awaiting' || this.questionPending(task.id)) return 'Worker 正在等待用户答复';
    if (task.status !== 'waiting') return `Worker 尚未静息（${task.status}）`;
    const child = this.store.children(task.id).find(row => !isSettled(row));
    if (child) return `等待子Worker ${workerLabel(child)} 结算`;
    // Deferred inputs cannot invalidate an already-fixed attempt, but do block a
    // fresh delivery until the Worker has admitted and processed its next wave.
    const booking = storedReservation(task.reservation);
    const fixed = [2, 3].includes(booking?.version) && ['requested','executing','resolving','blocked'].includes(booking.status);
    if (this.hasActionableMessages(task.id) || (!fixed && this.taskInputQueue(task).buffered))
      return '还有未处理的消息或子Worker信号，需先交给 Agent';
    return null;
  },

  unreserveTask(taskId) {
    const requested = this.store.task(id(taskId));
    assertTaskNotSyncing(this, requested.id);
    const automatic = this.autoMergeView(requested);
    // Flow configuration is read-only for every child, but historical one-shot
    // requests without a persisted locked Hook keep their original withdrawal gate.
    const lockedHook = automatic && requested.auto_merge && JSON.parse(requested.auto_merge).locked === true;
    check(!lockedHook, '父Worker派生的子Worker自动合并已锁定，不能撤销；如需停止工作，请取消 Worker');
    // A persistent hook would immediately recreate an automatic intention. Make
    // the user explicitly switch it off (with the same readiness gate) instead.
    check(!automatic?.enabled || !requested.reservation || !JSON.parse(requested.reservation).auto_merge,
      '请关闭自动合并开关，不要通过撤销请求关闭持久 hook');
    if (requested.reservation && JSON.parse(requested.reservation)?.version === 3) {
      check(this.withdrawConvergenceMember, 'convergence withdrawal is unavailable; preserve the fixed source');
      return this.withdrawConvergenceMember(requested.id);
    }
    if (['order','child'].includes(requested.task_kind) && requested.reservation
      && JSON.parse(requested.reservation)?.version === 2) {
      const booking = JSON.parse(requested.reservation);
      const abandonedRepair = booking.status === 'resolving' && ['failed','cancelled'].includes(requested.status)
        && !this.running.has(requested.id);
      check(booking.status === 'pending' || abandonedRepair,
        'a sent merge request cannot be withdrawn; wait for integration or resolve the divergence');
      this.store.transaction(() => {
        this.store.update(requested.id, { reservation: null });
        this.store.event(requested.id, 'task.unreserved', { reservation: booking });
      });
      if (abandonedRepair && booking.parent_id) this.scheduleTaskMerge(booking.parent_id);
      return { task_id: requested.id, reservation: null, changed: true };
    }
    const result = this.store.transaction(() => {
      const task = this.store.task(id(taskId));
      check(task.task_kind === 'order', 'only new order Workers support delivery reservations');
      if (task.reservation === null) return { task_id: task.id, reservation: null, changed: false };
      const previous = storedReservation(task.reservation);
      if (previous.blocked_code === 'resolving' && previous.resolution_child_id) {
        const resolution = this.store.task(previous.resolution_child_id);
        check(TERMINAL.has(resolution.status) && (resolution.integration === 'merged'
          || !resolution.branch || this.store.branch(resolution.branch)?.status === 'archived'),
        `解分歧 Worker ${workerLabel(resolution)} 仍占用冻结；先等待它落地，或取消并显式归档其分支`);
      }
      // 已发出但尚未集成的合并请求可以撤销：否则父分支会被一个不再成立的请求一直冻住。
      const withdrawable = previous.version === 1 && previous.kind === 'merge'
        && ['pending','requested'].includes(previous.status);
      check(withdrawable, 'started reservation cannot be withdrawn; inspect worker');
      this.store.update(task.id, { reservation: null });
      this.store.event(task.id, previous.status === 'requested' ? 'task.request_withdrawn' : 'task.unreserved', { reservation: previous,
        ...(previous.status === 'requested' ? { commit: previous.commit ?? null, baseline: previous.baseline ?? null,
          note: 'withdrawn without integration; the work stays on its branch' } : {}) });
      return { task_id: task.id, reservation: null, changed: true,
        withdrawn: previous.status === 'requested' ? previous : null };
    });
    return result;
  },
};
