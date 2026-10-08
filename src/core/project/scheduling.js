import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { check, TERMINAL, LushError, isSettled, isPlainObject } from '../types.js';
import { assertTaskAncestorsOpen, assertTaskNotSyncing, resumeTaskDelivery, taskDeliveryState, taskSyncDeliveryPaused } from './iteration.js';
import { tokenHash, workerRunProfile, workerModelSelection, profileEvent } from './internal.js';
import { AgentPreempted } from '../../agent/provider.js';
import { validateRuntimeConnection } from '../../agent/connection-runtime.js';
import { MISSING_PI_SOURCE_MESSAGE } from '../../agent/settings.js';
import { workerLabel } from '../worker-number.js';

/** A claimed boundary cannot be cancelled, even while the process is still exiting. */
function claimedStop(project, taskId, run) {
  try {
    const stop = JSON.parse(fs.readFileSync(path.join(project.config.home, 'preempt', `task-${taskId}.stop.json`), 'utf8'));
    return stop.task_id === taskId && stop.run_id === (run.recordId ?? null);
  } catch { return false; }
}

/** 调度、invocation 生命周期、凭证。 */
export default {
  questionPending(taskId) {
    return Boolean(this.store.get("SELECT id FROM notices WHERE task_id=? AND kind='questionnaire' AND status='open'", taskId));
  },

  // Called inside the notice transaction. Only messages delivered to this invocation are consumed.
  parkForQuestion(taskId, noticeId) {
    const run = this.running.get(taskId);
    const result = `等待用户回答待决问题 #${noticeId}。`;
    if (run) {
      run.parked = true;
      for (const message of run.messages || []) this.store.run('UPDATE messages SET consumed=1 WHERE id=?', message.id);
      this.store.event(taskId, 'invocation.completed', { result, suspended: true, notice_id: noticeId });
    }
    // 用户已主动暂停时不把状态改成 awaiting；待决问题保留，继续时由 pump 重新投影成 awaiting。
    if (this.store.task(taskId).status !== 'paused') this.store.update(taskId, { status: 'awaiting', result });
    this.suspendTaskMerge(taskId, `等待用户回答问卷 #${noticeId}`);
  },

  hasActionableMessages(taskId) {
    if (!this.store.get("SELECT id FROM messages WHERE task_id=? AND consumed=0 AND (signal_key IS NULL OR signal_key NOT LIKE 'merge-v2:%') LIMIT 1", taskId)) return false;
    const task = this.store.get('SELECT role,task_kind FROM tasks WHERE id=?', taskId);
    if (!(task.role === 'coordinator' || ['order','child'].includes(task.task_kind)) || !this.store.get(`SELECT id FROM tasks WHERE parent_id=?
      AND status NOT IN ('completed','failed','cancelled','awaiting_acceptance') LIMIT 1`, taskId)) return true;
    // Only runtime-attested success receipts wait; explicit messages remain urgent.
    // Runtime merge requests never wake the development Agent, even alongside a receipt.
    return Boolean(this.store.get(`SELECT m.id FROM messages m WHERE m.task_id=? AND m.consumed=0
      AND (m.signal_key IS NULL OR m.signal_key NOT LIKE 'merge-v2:%')
      AND NOT EXISTS (SELECT 1 FROM events e WHERE e.task_id=m.task_id
        AND (e.type='child.completed' OR (? AND e.type='task.signal' AND json_extract(e.data,'$.signal') IN ('child.completed','merge.completed')))
        AND json_extract(e.data,'$.message_id')=m.id) LIMIT 1`, taskId, ['order','child'].includes(task.task_kind) ? 1 : 0));
  },

  wake(taskId) {
    const task = this.store.task(taskId);
    if (this.taskSyncBusy?.has(task.id)) {
      (this.taskSyncWakePending ??= new Set()).add(task.id);
      return;
    }
    if (['main','owner','merge','management'].includes(task.task_kind)) return; // runtime-driven roots and merge orchestration never run providers
    try { assertTaskAncestorsOpen(this, task); } catch { return; }
    if (task.status === 'awaiting_acceptance' && !this.hasActionableMessages(task.id)) return;
    if (task.status === 'paused' || task.interrupt_state === 'requested') return; // 用户暂停意愿不被消息唤醒
    if (task.reservation && JSON.parse(task.reservation)?.version === 2
      && ['requested','executing','blocked'].includes(JSON.parse(task.reservation).status)) return; // only designated repair may run
    if (task.reservation && JSON.parse(task.reservation).status === 'suspended'
      && !this.questionPending(task.id) && this.hasActionableMessages(task.id)) this.resumeQueuedTaskMerge(task.id);
    if (!TERMINAL.has(task.status) && !this.running.has(task.id)) {
      const deferred = (task.role === 'coordinator' || ['order','child'].includes(task.task_kind))
        && this.store.get('SELECT id FROM messages WHERE task_id=? AND consumed=0 LIMIT 1', task.id)
        && !this.hasActionableMessages(task.id);
      this.store.update(task.id, { status: this.questionPending(task.id) ? 'awaiting' : deferred ? 'waiting' : 'queued' });
    }
    this.kick();
  },

  kick() {
    if (this.stopping || this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      if (!this.stopping) this.pump();
    });
  },

  pump() {
    if (this.stopping || this.workerDeleteIds?.size || this.settingsMigrationApplying) return;
    if (!this.refreshRuntimeConfiguration()) return;
    this.observeTaskHooks();
    this.scheduleTaskCompletion();
    for (const taskId of this.taskSyncWakePending ?? []) if (!this.taskSyncBusy?.has(taskId)) {
      this.taskSyncWakePending.delete(taskId);
      if (this.hasActionableMessages(taskId)) this.wake(taskId);
    }
    // Legacy planner/spec rows are retained on disk but no longer scheduled.
    const queued = this.store.all("SELECT * FROM tasks WHERE status='queued' AND task_kind IN ('order','say','child','management') ORDER BY id");
    const dependencies = this.store.depMap(queued.map(task => task.id));
    const freezes = new Map(this.branchFreeze().map(info => [info.branch, info]));
    const taskBranch = task => {
      if (task.branch || task.target_branch) return task.branch ?? task.target_branch;
      const seen = new Set([task.id]);
      for (let parentId = task.parent_id; parentId && !seen.has(parentId);) {
        seen.add(parentId);
        const parent = this.store.task(parentId);
        if (parent.branch || parent.target_branch) return parent.branch ?? parent.target_branch;
        parentId = parent.parent_id;
      }
      return null;
    };
    let controlRunning = [...this.running.values()].filter(run => ['planner','scheduler'].includes(run.role)).length;
    let butlerRunning = [...this.running.values()].filter(run => run.role === 'butler').length;
    let executionRunning = this.running.size - controlRunning - butlerRunning;
    for (const task of queued) {
      if (!['order','child','management'].includes(task.task_kind)) continue; // Old tasks stay untouched on disk.
      if (task.task_kind === 'management' && !this.managementReady(task)) continue;
      if (['main','owner','merge'].includes(task.task_kind)) continue; // Bound parent roots and merge orchestration do not run unrestricted providers.
      if (this.running.has(task.id) || this.taskSyncBusy?.has(task.id) || this.choiceRouteCreating(task.id)) continue;
      try { assertTaskAncestorsOpen(this, task); } catch { continue; }
      if (task.reservation && JSON.parse(task.reservation)?.version === 2
        && ['requested','executing','blocked'].includes(JSON.parse(task.reservation).status)) continue;
      const frozen = freezes.get(taskBranch(task));
      // 仅允许本次解分歧 Task 在隔离 worktree 内运行；所有其它 Agent 留在 queued，消息不丢。
      const resolution = frozen && this.store.get(`SELECT data FROM events WHERE task_id=?
        AND type='task.divergence_resolution_requested' ORDER BY id DESC LIMIT 1`, task.id);
      const deliveryRepair = task.reservation ? JSON.parse(task.reservation) : null;
      const designatedRepair = deliveryRepair?.status === 'resolving' && frozen?.task_id === task.id
        && this.activeTaskMerge(deliveryRepair.parent_id)?.id === task.id;
      if (frozen && !designatedRepair && !(resolution && (frozen.task_id === task.id || frozen.kind === 'merge_all'))
        && !(task.role === 'merger' && (frozen.task_id === task.id || frozen.kind === 'merge_all'))) continue;
      if (resolution && this.running.has(JSON.parse(resolution.data).parent_task_id)) continue;
      if (this.questionPending(task.id)) { this.store.update(task.id, { status: 'awaiting' }); continue; }
      // A queued task whose dependencies are not settled stays queued; finish() re-kicks when they are.
      if ((dependencies.get(task.id) || []).some(edge => !TERMINAL.has(edge.status))) continue;
      const control = ['planner','scheduler'].includes(task.role);
      const butler = task.role === 'butler';
      if (butler ? butlerRunning >= 1 : control ? controlRunning >= this.config.controlConcurrency : executionRunning >= this.config.concurrency) continue;
      const run = { role: task.role, controller: new AbortController(), token: randomBytes(32).toString('hex'), pid: null, promise: null, recordId: null,
        deliveryAttempt: designatedRepair ? deliveryRepair.attempt_id : null };
      if (butler) butlerRunning += 1; else if (control) controlRunning += 1; else executionRunning += 1;
      this.running.set(task.id, run);
      this.store.armAgent(task.id, tokenHash(run.token));
      run.promise = this.invoke(task.id, run).catch(error => {
        console.error(`worker ${task.id}: ${error.stack || error}`);
      }).finally(async () => {
        // Publish actual pause / release resume intent only after the invocation
        // has really exited; no new provider can overlap the old ownership.
        const released = this.store.task(task.id);
        if (!TERMINAL.has(released.status) && released.interrupt_state) this.store.transaction(() => {
          this.store.update(task.id, { interrupt_state: null,
            status: released.interrupt_state === 'requested' ? 'paused' : 'queued' });
          if (released.interrupt_state === 'requested') this.store.event(task.id, 'task.paused', { run_id: run.recordId });
        });
        this.running.delete(task.id);
        if (!this.stopping) this.drainManagementActions();
        if (!this.stopping && run.recordId) {
          const closedRun = this.store.get('SELECT status FROM agent_runs WHERE id=?', run.recordId);
          if (!run.parked) {
            if (closedRun?.status === 'completed') this.emitTaskHook(task.id, 'agent.returned');
            else if (closedRun?.status === 'preempted' && this.store.task(task.id).status !== 'paused') this.emitTaskHook(task.id, 'agent.preempted');
            else if (closedRun?.status === 'failed' || this.store.task(task.id).status === 'failed') this.emitTaskHook(task.id, 'agent.failed');
          }
          if (this.store.task(task.id).status === 'paused') this.emitTaskHook(task.id, 'agent.paused');
          if (this.store.task(task.id).status === 'cancelled') this.emitTaskHook(task.id, 'worker.cancelled');
        }
        if (!this.stopping) this.observeTaskHooks(task.id); // Before the built-in delivery Hook freezes the source.
        if (!this.stopping && ['order','child'].includes(task.task_kind)) {
          const current = this.store.task(task.id);
          const booking = current.reservation ? JSON.parse(current.reservation) : null;
          if (booking?.version === 2 && ['requested','executing','resolving','blocked'].includes(booking.status)) this.scheduleTaskMerge(booking.parent_id);
          if (booking?.status === 'resolving' && ['awaiting','paused'].includes(current.status))
            this.suspendTaskMerge(task.id, '源侧修复等待用户或已暂停');
          if (current.branch) {
            const parent = this.store.get('SELECT id FROM tasks WHERE branch=? AND task_kind IN (\'main\',\'owner\',\'order\',\'say\',\'child\')', current.branch);
            if (parent) this.scheduleTaskMerge(parent.id);
          }
        }
        // 已冻结的编排此时才能按安全点重新核对两端 tip，并派隔离的解分歧 Task。
        for (const { target, run: mergeRun } of this.store.activeBranchMergeRuns()) {
          if (mergeRun.mode === 'orchestrate' && mergeRun.waiting_safe_task_id === task.id) this.scheduleMergeRun(target);
        }
        // The credential is valid only while this invocation owns the task.
        this.store.armAgent(task.id, null);
        // A child can settle after its parent parked but before this cleanup.
        // Recheck the inbox after releasing ownership to avoid a lost wake-up.
        if (!TERMINAL.has(this.store.task(task.id).status) && this.hasActionableMessages(task.id)) this.wake(task.id);
        if (!this.stopping) {
          this.armTaskAutoMerge(task.id);
          const settled = this.store.task(task.id);
          let reservation = null;
          try { reservation = ['order','child'].includes(settled.task_kind) && settled.reservation ? JSON.parse(settled.reservation) : null; }
          catch { /* invalid state stays visible for inspection */ }
          if (settled.status === 'waiting' && reservation?.kind === 'merge' && !taskSyncDeliveryPaused(this, task.id)) {
            const settle = reservation.version === 2 ? this.settleQueuedMerge(task.id) : this.settleReservedMerge(task.id);
            await settle.catch(error => reservation.version === 2 ? this.noteCompletionMergeFailure(task.id)
              : this.noteReservationBlocked(task.id, error.message));
          }
        }
        this.scheduleTaskCompletion(task.id);
        this.kick();
      });
    }
  },

  /**
   * 安全抢占请求：用户给运行中的 Task 追加输入时，请 Agent 在**下一个安全边界**收尾，而不是杀进程。
   * 只有 pi 后端有可验证的边界（扩展在 `turn_end` 落 stop 标记，见 `agent/pi-runtime.js`）；
   * 其它后端保持“轮末投递”，不假装能抢占。真正的记账发生在 invoke 的 catch 里。
   */
  requestPreempt(taskId, reason = 'new user input', source = 'input') {
    const task = this.store.task(taskId);
    const run = this.running.get(task.id);
    if (!run || TERMINAL.has(task.status)) return false;
    if (run.agent?.agent !== 'pi' || run.invocationEnded) return false;
    if (source === 'input') run.inputPreemptRequested = true;
    if (claimedStop(this, task.id, run)) return true;
    const dir = path.join(this.config.home, 'preempt');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const request = path.join(dir, `task-${task.id}.request.json`), temporary = `${request}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify({ task_id: task.id,
        run_id: run.recordId ?? null, reason, requested_at: new Date().toISOString() }) + '\n', { mode: 0o600 });
      fs.renameSync(temporary, request);
    } finally { fs.rmSync(temporary, { force: true }); }
    this.store.event(task.id, 'preempt.requested', { run_id: run.recordId ?? null, reason });
    return true;
  },

  /**
   * 用户中断表达暂停意愿，不撤销正在安全执行的 Agent RPC，也不强杀工具。
   * Pi 在 turn_end 认领；其它后端等自然结束。只暂停当前 Worker，不级联子 Worker。
   */
  interrupt(taskId, reason = 'interrupted by user') {
    const task = this.store.task(taskId);
    assertTaskNotSyncing(this, task.id);
    check(!['main','owner'].includes(task.task_kind), 'branch owner is a permanent root; interrupt individual order Workers instead');
    check(['order','child'].includes(task.task_kind), 'only order/child Workers can be paused');
    check(!TERMINAL.has(task.status), 'worker has ended; retry it or submit a new input');
    if (task.status === 'paused' || task.interrupt_state === 'requested') return task;
    const booking = task.reservation ? JSON.parse(task.reservation) : null;
    check(!(booking?.version === 2 && ['requested','executing','blocked'].includes(booking.status)),
      'Worker is frozen for merge; wait for integration or withdraw the request before pausing');
    const run = this.running.get(task.id);
    if (run) run.resumeRequested = false;
    const active = run && !run.invocationEnded && !run.parked && !run.controller.signal.aborted && !run.boundaryClaimed && !claimedStop(this, task.id, run);
    this.store.transaction(() => {
      this.store.update(task.id, { ...(active ? { interrupt_state: 'requested' }
        : { status: 'paused', interrupt_state: null }), error: null });
      this.store.event(task.id, 'task.interrupted', { run_id: run?.recordId ?? null, reason, pending: Boolean(active) });
    });
    this.suspendTaskMerge(task.id, reason);
    if (!run) this.emitTaskHook(task.id, 'agent.paused');
    if (active) this.requestPreempt(task.id, reason, 'pause');
    return this.store.task(task.id);
  },

  /** 暂停中调整本轮运行设置：复用任务级 retry_profile，继续时生效、结算时清除，不改项目默认。 */
  configureTask(taskId, profile = null) {
    this.assertWritable('configure a worker');
    const task = this.store.task(taskId);
    assertTaskNotSyncing(this, task.id);
    check(task.status === 'paused' || task.interrupt_state === 'requested', 'only paused workers can adjust run settings');
    check(['order','child'].includes(task.task_kind), 'only order/child Workers can adjust run settings');
    const retryProfile = profile === null || profile === undefined ? null : this.agentSettings.retryProfile(task.role, profile);
    this.store.transaction(() => {
      this.store.update(task.id, { retry_profile: retryProfile ? JSON.stringify(retryProfile) : null });
      this.store.event(task.id, 'task.configured', retryProfile ? profileEvent(retryProfile) : { profile_override: false });
    });
    return this.store.task(task.id);
  },

  /** User-only narrow choice update: preserve all other run overrides, with no refresh or model call. */
  configureTaskModelSelection(taskId, selection) {
    this.assertWritable('configure a worker');
    const task = this.store.task(taskId);
    assertTaskNotSyncing(this, task.id);
    if (task.branch) this.assertBranchWritable(task.branch, 'configure a worker on it');
    check(task.status === 'paused' || task.interrupt_state === 'requested', 'only paused workers can adjust run settings');
    check(['order','child'].includes(task.task_kind), 'only order/child Workers can adjust run settings');
    check(isPlainObject(selection) && Object.keys(selection).length === 2
      && Object.keys(selection).every(key => ['connection_id','model'].includes(key)), 'invalid model_selection fields');
    check(typeof selection.connection_id === 'string'
      && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(selection.connection_id),
    'model_selection requires a connection UUID');
    check(typeof selection.model === 'string' && Buffer.byteLength(selection.model) <= 256
      && selection.model.trim() === selection.model && !/[\x00-\x1f\x7f]/.test(selection.model), 'invalid model_selection model');
    return this.store.transaction(() => {
      const current = this.store.task(task.id), base = workerRunProfile(this, current);
      check(base.agent === 'pi', 'managed connections support only Pi');
      check(base.config_mode !== 'pi', 'model selection requires Lush configuration; switch the Worker back first');
      // config() is a local public projection. Do not query, refresh OAuth, or read private runtime credentials.
      const connection = this.agentConnections.config().connections.find(item => item.id === selection.connection_id);
      check(connection && connection.enabled, 'model_selection connection is unavailable');
      check(connection.credential.status === 'configured'
        || (connection.auth_type === 'oauth' && connection.credential.status === 'expired'),
      'model_selection connection has no usable credential');
      const prefix = `${connection.provider}/`, modelId = selection.model.slice(prefix.length);
      check(selection.model.startsWith(prefix) && modelId.length > 0
        && (!connection.models.length || connection.models.includes(modelId)), 'model_selection model is outside connection scope');
      const profile = this.agentSettings.retryProfile(task.role, { ...base, ...selection });
      this.store.update(task.id, { retry_profile: JSON.stringify(profile) });
      this.store.event(task.id, 'task.configured', profileEvent(profile));
      return { id: task.id, model_selection: workerModelSelection(this, { ...current, retry_profile: JSON.stringify(profile) }, profile) };
    });
  },

  /**
   * 用户专属：移除本 Worker 的 task-local 运行覆盖（模型来源、Prompt、扩展、预算等），
   * 让下一次调用回到当前的项目/角色默认。只影响后续调用，不启动 Agent，不触碰当前调用。
   * 交付落地不再清空覆盖，因此这是把某个已合并 Worker 退回项目默认的唯一显式入口。
   */
  clearTaskProfile(taskId) {
    this.assertWritable('clear a worker profile override');
    const task = this.store.task(taskId);
    assertTaskNotSyncing(this, task.id);
    check(['order','child'].includes(task.task_kind), 'only order/child Workers keep a task-local profile');
    check(!TERMINAL.has(task.status), 'worker has ended; retry or reopen it before clearing its override');
    check(!this.running.has(task.id), 'Agent is invoking; wait for the safe point before clearing the override');
    const booking = task.reservation ? JSON.parse(task.reservation) : null;
    check(!(booking?.version === 2 && ['requested','executing','resolving','blocked','suspended'].includes(booking.status)),
      'delivery is in flight; wait for it to settle before clearing the override');
    if (task.branch) this.assertBranchWritable(task.branch, 'clear this worker override on it');
    return this.store.transaction(() => {
      if (task.retry_profile) {
        this.store.update(task.id, { retry_profile: null });
        this.store.event(task.id, 'task.configured', { profile_override: false });
      }
      const current = this.store.task(task.id);
      return { id: task.id, model_selection: workerModelSelection(this, current) };
    });
  },

  /** 继续立即接受：未认领则撤销请求；已认领则排队，内部等待旧 invocation 真实退出。 */
  resumeTask(taskId, profile = null) {
    this.assertWritable('resume a worker');
    const task = this.store.task(taskId);
    assertTaskNotSyncing(this, task.id);
    assertTaskAncestorsOpen(this, task);
    check(['order','child'].includes(task.task_kind), 'only order/child Workers can be resumed');
    // Duplicate resume is harmless, including a stale UI click after release.
    if (!task.interrupt_state && ['running','queued'].includes(task.status)) return task;
    check(task.status === 'paused' || task.interrupt_state, 'only paused workers can be resumed');
    const retryProfile = profile === null || profile === undefined ? null : this.agentSettings.retryProfile(task.role, profile);
    const run = this.running.get(task.id);
    let cancelled = false;
    if (run && task.interrupt_state === 'requested' && !run.invocationEnded && !run.parked && !run.controller.signal.aborted) {
      // unlink and Pi's rename are atomic competitors. Do not remove stop: once
      // claimed, finishing the old call and starting a new one is mandatory.
      fs.rmSync(path.join(this.config.home, 'preempt', `task-${task.id}.request.json`), { force: true });
      cancelled = !run.boundaryClaimed && !claimedStop(this, task.id, run);
      if (cancelled && run.inputPreemptRequested) this.requestPreempt(task.id, 'user message');
    }
    if (run) run.resumeRequested = !cancelled;
    this.store.transaction(() => {
      this.store.update(task.id, { status: cancelled ? 'running' : 'queued',
        interrupt_state: run && !cancelled ? 'resuming' : null, error: null,
        ...(retryProfile ? { retry_profile: JSON.stringify(retryProfile) } : {}) });
      resumeTaskDelivery(this, task.id, 'user resumed development');
      this.resumeQueuedTaskMerge(task.id);
      this.store.event(task.id, 'task.resumed', { cancelled_interrupt: cancelled, pending_exit: Boolean(run && !cancelled),
        ...(retryProfile ? { profile_override: true, ...profileEvent(retryProfile) } : { profile_override: false }) });
    });
    this.kick();
    return this.store.task(task.id);
  },

  /** Resolve an agent credential to its task. Only the invocation that was issued the token is an actor. */
  actor(token) {
    if (token === undefined || token === null || token === '') return null;
    check(typeof token === 'string', 'invalid agent token');
    const task = this.store.agentByToken(tokenHash(token));
    const run = task ? this.running.get(task.id) : null;
    if (!run) throw new LushError('invalid or expired agent token');
    check(!['explainer','butler'].includes(task.role), 'isolated agents have no RPC capability');
    check(task.status === 'running' && !run.parked && !run.controller.signal.aborted, 'agent worker is no longer active');
    this.store.touchAgent(task.id);
    return task.id;
  },

  async invoke(taskId, run) {
    let timer, timedOut = false;
    const timeoutMessage = `agent invocation timed out after ${this.config.timeout} second${this.config.timeout === 1 ? '' : 's'}`;
    const abortMessage = () => run.controller.signal.reason instanceof Error
      ? run.controller.signal.reason.message
      : typeof run.controller.signal.reason === 'string' && run.controller.signal.reason
        ? run.controller.signal.reason : 'agent invocation interrupted';
    const armDeadline = () => {
      timer = setTimeout(() => {
        timedOut = true;
        run.controller.abort(new Error(timeoutMessage));
      }, this.config.timeout * 1000);
    };
    // Deliver a bounded batch; undelivered originals stay unread for the next invocation.
    const page = this.store.unreadPage(taskId);
    const messages = page.messages;
    const messagesPage = { delivered: messages.length, has_more: page.has_more, pending: page.pending,
      truncated_bytes: page.truncated_bytes, reordered: page.reordered };
    try {
      let task = this.store.task(taskId);
      check(task.calls < this.config.maxCalls, 'worker invocation limit reached');
      // An explicit retry may freeze a complete task-local profile. It wins over dynamic
      // project defaults for every invocation in this attempt and is cleared at settlement.
      const retryProfile = task.retry_profile ? this.agentSettings.retryProfile(task.role, JSON.parse(task.retry_profile)) : null;
      let agent = retryProfile || this.provider.resolve?.(task) || { agent: this.config.provider, model: '', thinking: '', default_prompt: '', append_prompt: '' };
      // The optional trusted hook selects only a connection/model, before Run metadata is frozen.
      // No hook and explicit Worker profiles preserve the old path without credential reads or an extra async boundary.
      if (this.agentSelection.enabled && !retryProfile && agent.config_mode !== 'pi') {
        armDeadline();
        agent = await this.agentSelection.select(task, agent, { signal: run.controller.signal });
        if (run.controller.signal.aborted || this.stopping) throw new Error(abortMessage());
        const live = this.store.task(taskId);
        // A pause/resume accepted while the hook was pending must not launch the old resolved profile.
        if (live.status === 'paused' || live.interrupt_state || run.resumeRequested) return;
        check(live.status === 'queued' && !TERMINAL.has(live.status), 'worker is no longer eligible to start');
      }
      // Lush-mode Pi invocations must bind a managed source before we create a Run or a provider
      // process. Pi-default mode (`config_mode: 'pi'`) intentionally has no managed source and is skipped.
      // Refuse before starting, keep the unread input for the next attempt, and point at the configuration page.
      if (this.provider.requiresPiSource && agent.agent === 'pi' && agent.config_mode !== 'pi' && !agent.connection_id) {
        this.store.transaction(() => {
          this.store.event(taskId, 'invocation.blocked', { reason: 'missing_model_source', agent: 'pi', model: agent.model || null });
          if (!TERMINAL.has(this.store.task(taskId).status)) this.store.update(taskId, { status: 'paused' });
        });
        this.notify(taskId, 'Worker 未启动：缺少 Lush 模型来源',
          `${MISSING_PI_SOURCE_MESSAGE}。请在「Agent 配置」为项目默认选择来源，或在本 Worker 的运行设置里选择来源 / 切换为 Pi 默认配置后继续。`);
        return;
      }
      run.agent = agent;
      // Refuse incomplete or incompatible choice routes before ensure() can touch a checkout.
      const choiceFork = this.choiceFork(taskId, agent);
      // Run identity and admission counters are one durable boundary; a crash cannot leave
      // a newly inserted Run attached to a still-queued Worker.
      const record = this.store.transaction(() => {
        const record = this.store.startRun(task, agent);
        this.store.update(taskId, { status: 'running', calls: task.calls + 1, agent_wakes: task.agent_wakes + 1 });
        if (task.task_kind === 'management') this.beginManagementInvocation(taskId, record.id);
        return record;
      });
      run.recordId = record.id;
      // 新一轮拆解：上一轮被驳回的闸门清零，这一轮要不要再请你批准由 planner 自己判断。
      if (task.role === 'planner' && task.plan_gate === 'rejected') this.store.update(taskId, { plan_gate: null });
      this.store.touchAgent(taskId);
      const cwd = await this.workspaces.ensure(task);
      // 已冻结的两端 tip 必须仍成立；父 Agent 的上一轮可能恰在建立冻结前提交，外部 Git 也不受 daemon 控制。
      const fixedEvent = task.task_kind === 'child' ? this.store.get(`SELECT data FROM events WHERE task_id=?
        AND type='task.divergence_resolution_requested' ORDER BY id DESC LIMIT 1`, task.id) : null;
      if (fixedEvent) {
        const fixed = JSON.parse(fixedEvent.data);
        const state = await this.workspaces.branchState(task.target_branch);
        check(state.child_head === fixed.source_commit && state.parent_head === fixed.parent_commit,
          `解分歧两端提交在 Worker ${workerLabel(task)} 开工前已移动；保留现场，检查后再派`);
      }
      if (run.controller.signal.aborted) throw new Error('cancelled');
      task = this.store.task(taskId);
      const hookStart = this.store.event(taskId, 'invocation.started', { call: task.calls, cwd, input_delivery_tracked: true,
        message_ids: messages.map(message => message.id),
        agent: agent.agent, model: agent.model || null, thinking: agent.thinking || null });
      this.emitTaskHook(taskId, 'agent.started', hookStart);
      if (!timer) armDeadline();
      run.messages = messages;
      const context = await this.invocationContext(task, run);
      if (run.controller.signal.aborted) throw new Error(abortMessage());
      // retry_profile contains system instructions and local resource paths. It is runtime
      // configuration, not task data, so do not copy it into the provider's untrusted input JSON.
      const { retry_profile: _retryProfile, management: _privateManagement, ...providerTask } = this.progressView(task);
      const forkPointer = task.base_commit ? this.store.get(
        'SELECT session_path AS session, entry_id AS entry FROM commit_contexts WHERE commit_hash=?', task.base_commit) : null;
      const connectionRuntime = agent.connection_id ? await this.agentConnections.prepareRuntime(agent.connection_id) : null;
      if (connectionRuntime) {
        validateRuntimeConnection(agent, connectionRuntime);
        run.connectionBinding = { id: agent.connection_id, account_key: connectionRuntime.account_key, source_key: connectionRuntime.source_key };
        this.store.event(taskId, 'invocation.connection', { run_id: run.recordId, connection_id: agent.connection_id,
          account_key: connectionRuntime.account_key, model: agent.model });
      }
      if (run.controller.signal.aborted) throw new Error(abortMessage());
      // 目标分支只能由 daemon 的交付推进。记录调用前的稳定快照，结束后对照 daemon 侧 ref 写入打点：
      // agent 越过自己的 worktree 直接提交、或外部 Git 手动推进，都会在这里被如实拦下。
      const targetBranch = task.target_branch && task.target_branch !== task.branch ? task.target_branch : null;
      let targetBaseline = null, refWritesBaseline = 0;
      if (targetBranch) {
        for (let attempt = 0; attempt < 3; attempt++) {
          refWritesBaseline = this.workspaces.gitRefWrites ?? 0;
          targetBaseline = await this.workspaces.git(this.config.project, 'rev-parse', `refs/heads/${targetBranch}`).catch(() => null);
          if ((this.workspaces.gitRefWrites ?? 0) === refWritesBaseline) break;
        }
      }
      // Real backends acknowledge after preparing and launching the input-bearing process.
      // In-process/custom backends receive the payload at run(); consumption is a separate fact.
      let inputsDelivered = false;
      const onInputDelivered = () => {
        if (inputsDelivered) return;
        inputsDelivered = true;
        this.store.event(taskId, 'invocation.inputs_delivered', { run_id: run.recordId,
          message_ids: messages.map(message => message.id) });
      };
      if (!this.provider.reportsInputDelivery) onInputDelivered();
      const result = await this.provider.run({ task: providerTask, cwd, token: run.token, signal: run.controller.signal, agent, onInputDelivered,
        connectionRuntime, onConnectionObservation: connectionRuntime ? observation => this.agentConnections.observe(
          agent.connection_id, connectionRuntime.account_key, connectionRuntime.source_key, observation) : null,
        onSpawn: pid => { run.pid = pid; }, onPreempt: () => { run.boundaryClaimed = true; }, messages, messagesPage, api: this,
        context, forkPointer, choiceFork,
      });
      run.invocationEnded = true;
      clearTimeout(timer);
      if (TERMINAL.has(this.store.task(taskId).status) || run.parked) return;
      if (run.controller.signal.aborted) throw new Error(timedOut ? timeoutMessage : abortMessage());
      check(typeof result === 'string' && Buffer.byteLength(result) <= 256000, 'agent result exceeds 256000 bytes');
      // 目标分支被本次调用越过交付直接推进时，不把它当成功：保留现场、记录事件、按失败处理。
      if (targetBranch && targetBaseline) {
        let targetNow = targetBaseline, refWritesNow = this.workspaces.gitRefWrites ?? 0;
        for (let attempt = 0; attempt < 3; attempt++) {
          refWritesNow = this.workspaces.gitRefWrites ?? 0;
          targetNow = await this.workspaces.git(this.config.project, 'rev-parse', `refs/heads/${targetBranch}`).catch(() => targetBaseline);
          if ((this.workspaces.gitRefWrites ?? 0) === refWritesNow) break;
        }
        const ownerRunning = [...this.running.keys()].some(id => this.store.task(id)?.branch === targetBranch);
        if (targetNow !== targetBaseline && refWritesNow === refWritesBaseline && !ownerRunning) {
          const moved = (await this.workspaces.git(this.config.project, 'log', '--oneline',
            `${targetBaseline}..${targetNow}`).catch(() => '')).split('\n').filter(Boolean);
          this.store.event(taskId, 'invocation.target_branch_moved', { branch: targetBranch, before: targetBaseline,
            after: targetNow, commits: moved.slice(0, 20) });
          throw new Error(`目标分支 ${targetBranch} 在本次调用期间被直接推进，而不是经 daemon 交付：`
            + `${moved.slice(0, 3).join('；') || targetNow.slice(0, 12)}。本次调用按失败处理并保留现场；`
            + '请检查这次提交是否应当显式交付，或改为在自己的 worktree 内提交后再继续。');
        }
      }
      // G-02: re-check the pinned tree after the invocation. Drift or dirt means the evidence no longer
      // describes the frozen commit, so the invocation fails instead of being recorded as a pass.
      if (task.role === 'verifier' && task.review_candidate_id) {
        await this.assertCandidateVerification(this.store.candidate(task.review_candidate_id), task);
      }
      // Explicit synchronization repair is validated before recording a successful invocation.
      // The hook owns its own Git exclusive lock and never delivers into the parent.
      if (['order','child'].includes(task.task_kind) && this.store.task(taskId).status !== 'paused'
        && !this.store.task(taskId).interrupt_state && !run.resumeRequested
        && this.store.unread(taskId).every(row => messages.some(message => message.id === row.id))
        && !this.store.get("SELECT id FROM notices WHERE task_id=? AND status='open'", taskId)
        && this.store.children(taskId).every(isSettled) && this.settleTaskSyncResolution) {
        run.syncResolved = await this.settleTaskSyncResolution(taskId);
        if (run.syncResolved) {
          run.syncIntegration = this.store.task(taskId).integration;
          run.syncHead = this.store.task(taskId).head_commit;
        }
      }
      this.store.transaction(() => {
        for (const message of messages) this.store.run('UPDATE messages SET consumed=1 WHERE id=?', message.id);
        this.store.event(taskId, 'invocation.completed', { result, run_id: run.recordId });
        this.store.update(taskId, { result });
        this.store.finishRun(run.recordId, 'completed', { result });
        const verification = task.role === 'verifier' ? this.verificationEvidence(task) : {
          status: 'unverified', tested_commit: null, baseline_commit: null, commands: [],
          summary: 'This invocation did not perform verification.', report: { task_id: task.id,
            path: this.reportPath(task.id), available: false }, failures: [],
          unverified: ['The worker role was not verifier.'], baseline_failures: [], residual_risks: [],
        };
        this.store.addArtifact({ task_id: taskId, run_id: run.recordId, input_id: task.input_id, kind: 'run.result',
          payload: { schema_version: 2, invocation: { status: 'completed' }, outcome: 'success', summary: result,
            changes: [], evidence: [], decisions: [], risks: [], artifacts: [], followups: [], verification },
          metadata: { role: task.role, call: task.calls, agent: agent.agent, model: agent.model || null, thinking: agent.thinking || null } });
      });
      // 暂停中的 Task 即使本轮正常返回也只保留结果，不自动推进状态；用户点「继续」时才恢复调度。
      if (this.store.task(taskId).status === 'paused' || this.store.task(taskId).interrupt_state || run.resumeRequested) return;
      if (task.task_kind === 'management') { this.completeManagementInvocation(taskId, run.recordId); return; }
      if (task.role === 'butler') await this.completeButler(taskId, result);
      if (TERMINAL.has(this.store.task(taskId).status)) return;
      // Deliver actionable arrivals next time; ordinary coordinator receipts wait for the wave.
      if (this.hasActionableMessages(taskId)) { this.store.update(taskId, { status: 'queued' }); return; }
      if (this.store.get("SELECT id FROM notices WHERE task_id=? AND status='open'", taskId)) {
        this.store.update(taskId, { status: 'awaiting' }); return;
      }
      if (this.store.children(taskId).some(child => !isSettled(child))) {
        this.store.update(taskId, { status: 'waiting' }); return;
      }
      await this.workspaces.finish(this.store.task(taskId));
      // git is asynchronous: input, cancellation or delegation may have arrived meanwhile.
      if (TERMINAL.has(this.store.task(taskId).status) || this.store.task(taskId).status === 'paused'
        || this.store.task(taskId).interrupt_state || run.resumeRequested) return;
      if (this.hasActionableMessages(taskId)) { this.store.update(taskId, { status: 'queued' }); return; }
      if (this.store.get("SELECT id FROM notices WHERE task_id=? AND status='open'", taskId)) {
        this.store.update(taskId, { status: 'awaiting' }); return;
      }
      if (this.store.children(taskId).some(child => !isSettled(child))) {
        this.store.update(taskId, { status: 'waiting' }); return;
      }
      if (['order','child'].includes(task.task_kind)) {
        if (run.syncResolved) {
          check(this.store.task(taskId).head_commit === run.syncHead, 'synchronization repair HEAD changed before settlement');
          this.store.transaction(() => {
            this.store.update(taskId, { integration: run.syncIntegration,
              status: run.syncIntegration === 'merged' ? 'awaiting_acceptance' : 'waiting' });
            const eventId = this.store.event(taskId, 'task.idle', { run_id: run.recordId,
              head_commit: this.store.task(taskId).head_commit, sync_resolved: true });
            this.notifyTaskLifecycle(taskId, eventId);
          });
          return;
        }
        const booking = this.store.task(taskId).reservation ? JSON.parse(this.store.task(taskId).reservation) : null;
        if (booking?.version === 2 && booking.status === 'resolving') this.store.transaction(() => {
          check(run.deliveryAttempt === booking.attempt_id, 'stale repair response cannot advance a new attempt');
          this.store.update(taskId, { reservation: JSON.stringify({ ...booking, repair_ready: true, repair_run_id: run.recordId }) });
          this.store.event(taskId, 'merge.divergence_ready', { attempt_id: booking.attempt_id,
            run_id: run.recordId, head_commit: this.store.task(taskId).head_commit });
        });
        // Spawned children already carry a merge reservation; the invocation cleanup
        // releases ownership before requesting their automatic delivery. A user-created
        // order still keeps its branch until the user explicitly reserves or ends it.
        // 这条分支自己前进了（本轮新提交）：挂在它上面的未集成请求要如实变成失效状态，
        // 而不是继续显示“等待集成”。daemon 阻止不了这次提交，所以只如实记录检查结果。
        await this.noteBranchAdvance(taskId);
        const live = this.store.task(taskId);
        const delivery = live.iteration_base_commit && !live.reservation ? await taskDeliveryState(this, live) : null;
        if (this.hasActionableMessages(taskId)) { this.store.update(taskId, { status: 'queued' }); return; }
        if (TERMINAL.has(this.store.task(taskId).status) || this.store.task(taskId).status === 'paused'
          || this.store.task(taskId).interrupt_state || run.resumeRequested) return;
        if (this.store.get("SELECT id FROM notices WHERE task_id=? AND status='open'", taskId)) {
          this.store.update(taskId, { status: 'awaiting' }); return;
        }
        if (this.store.children(taskId).some(child => !isSettled(child))) {
          this.store.update(taskId, { status: 'waiting' }); return;
        }
        this.store.transaction(() => {
          this.store.update(taskId, { status: delivery && delivery !== 'pending' ? 'awaiting_acceptance' : 'waiting',
            ...(delivery ? { integration: delivery } : {}) });
          const eventId = this.store.event(taskId, 'task.idle', { run_id: run.recordId, head_commit: this.store.task(taskId).head_commit });
          this.notifyTaskLifecycle(taskId, eventId);
        });
        return;
      }
      this.finish(taskId, 'completed', result);
    } catch (error) {
      run.invocationEnded = true;
      // 安全抢占：Agent 在本轮工具都结束后自行收尾，不是失败、不是超时也不是取消。
      // 工作区按现状保留，这条输入下一轮就会被读到；不重建、不重放本轮已发生的副作用。
      if (taskId && this.store.task(taskId).task_kind === 'management') {
        if (run.recordId && this.store.get('SELECT status FROM agent_runs WHERE id=?', run.recordId)?.status === 'running')
          this.store.finishRun(run.recordId, 'failed', { error: 'management invocation interrupted; no automatic replay' });
        this.failManagementOccurrence(taskId, 'failed');
        return;
      }
      if (error instanceof AgentPreempted) {
        if (run.recordId && this.store.get('SELECT status FROM agent_runs WHERE id=?', run.recordId)?.status === 'running') {
          this.store.finishRun(run.recordId, 'preempted', { error: error.details?.reason ?? 'preempted by new input' });
        }
        const paused = this.store.task(taskId).status === 'paused' || this.store.task(taskId).interrupt_state === 'requested';
        if (!run.parked && !TERMINAL.has(this.store.task(taskId).status)) {
          this.store.transaction(() => {
            this.store.event(taskId, 'invocation.preempted', { run_id: run.recordId, ...error.details });
            // 用户主动中断停在 paused；普通追加输入触发的抢占仍回到 queued/waiting。
            if (!paused) this.store.update(taskId, { status: run.resumeRequested || this.hasActionableMessages(taskId) ? 'queued' : 'waiting' });
          });
          if (!paused) this.kick();
        }
        return;
      }
      // Provider adapters may only know that their AbortSignal fired. The scheduler owns the deadline,
      // so normalize that generic interruption into an exact timeout and keep user cancellation distinct.
      const message = timedOut ? timeoutMessage : run.controller.signal.aborted ? abortMessage() : error.message;
      if (run.recordId && this.store.get('SELECT status FROM agent_runs WHERE id=?', run.recordId)?.status === 'running') {
        this.store.finishRun(run.recordId, timedOut ? 'failed' : run.controller.signal.aborted ? 'cancelled' : 'failed', { error: message });
      }
      const current = this.store.task(taskId);
      if (!run.parked && !TERMINAL.has(current.status) && current.status !== 'paused') this.cancel(taskId, message, 'failed');
    } finally {
      delete run.connectionBinding;
      clearTimeout(timer);
      if (run.recordId && this.store.get('SELECT status FROM agent_runs WHERE id=?', run.recordId)?.status === 'running') {
        const task = this.store.task(taskId);
        this.store.finishRun(run.recordId, task.status === 'cancelled' ? 'cancelled' : task.status === 'failed' ? 'failed' : 'completed',
          { result: task.result, error: task.error });
      }
      // 对照基线 / 只读分析检出都是派生的只读检出：invocation 一结束就回收，不把每次调用都堆在磁盘上。
      // 失败也不保留——结论/错误已入库，重建一次很便宜；下次调用会在那时的分支顶端重建。
      const settled = this.store.task(taskId);
      if (settled.verifies_task_id || settled.review_candidate_id || settled.task_kind === 'analysis') {
        await this.workspaces.removeBaseline(taskId).catch(error => console.error(`derived checkout ${taskId}: ${error.message}`));
      }
    }
  }
};
