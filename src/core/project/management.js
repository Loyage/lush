import { check, id, text, isPlainObject, TERMINAL, bounded } from '../types.js';
import { assertTaskAncestorsOpen } from './iteration.js';
import { hookRevision } from '../hooks.js';
import { inheritedRunProfile, tokenHash } from './internal.js';
import { MANAGEMENT_LIMITS, managementState, saveManagement, managementTime, managementRevision,
  managementView, managementWorkers, managementEnableReason } from './management-data.js';

const unknownReason = '管理调用或操作曾中断，副作用未知；绑定已停用，不自动重放。';
const failedReason = '管理调用未完成；绑定已停用，请检查执行记录后另建管理指令。';
// Compare submitted definitions, not runtime defaults. Object key order is not a semantic difference.
function creationFingerprint(options) {
  function canonical(value, depth = 0) {
    check(depth < 20, 'management definition nesting exceeds its limit');
    if (Array.isArray(value)) return value.map(item => canonical(item, depth + 1));
    if (isPlainObject(value)) return Object.fromEntries(Object.keys(value).sort()
      .filter(key => value[key] !== undefined).map(key => [key, canonical(value[key], depth + 1)]));
    return value;
  }
  const definition = canonical({ name: options.name.trim(), instruction: options.instruction,
    signal_id: options.signal_id, mode: options.mode ?? 'once',
    ...(options.profile === undefined ? {} : { profile: options.profile }) });
  check(Buffer.byteLength(JSON.stringify(definition)) <= MANAGEMENT_LIMITS.bytes, 'management definition exceeds 128 KiB');
  return hookRevision(definition);
}
function assertManager(project, actorId) {
  const task = project.store.task(id(actorId)), state = managementState(task), run = project.running.get(task.id);
  check(task.role === 'manager' && task.task_kind === 'management' && state?.version === 1, 'only a management Worker can use management tools');
  check(task.status === 'running' && run && !run.parked && !run.invocationEnded && !run.controller.signal.aborted
    && typeof run.token === 'string' && task.agent_token_hash === tokenHash(run.token), 'management invocation is not active');
  check(state.enabled && state.state === 'running' && state.pending_signal?.phase === 'started'
    && state.pending_signal.run_id === run.recordId, 'management binding or signal authorization is not active');
  return { task, state };
}
function targetGate(project, target, action) {
  if (!target || !['order','child'].includes(target.task_kind)) return { skip: '目标不存在或不是可管理的开发 Worker。' };
  if (TERMINAL.has(target.status) && target.status !== 'failed') return { skip: '目标已取消或验收，不通过管理信号复活。' };
  if (target.branch && ['archived','deleted'].includes(project.store.branch(target.branch)?.status)) return { skip: '目标已归档或分支已回收。' };
  try { assertTaskAncestorsOpen(project, target); } catch { return { skip: '目标的祖先已关闭，不通过管理信号复活。' }; }
  const choice = project.store.get('SELECT status FROM choice_rechoices WHERE task_id=?', target.id);
  if (choice?.status === 'creating') return { wait: '重选路线正在创建，已提交并等待安全点。' };
  if (choice && choice.status !== 'created') return { skip: '重选创建未完成或副作用未知，需用户检查现场，不通过管理信号重放。' };
  if (action === 'start' && (target.status !== 'paused' || target.interrupt_state)) return { skip: '目标不是已生效的暂停／待开始状态，本次操作不适用。' };
  if (action === 'retry' && target.status !== 'failed') return { skip: '目标不是失败状态，本次重试不适用。' };
  if (action === 'retry' && project.store.get("SELECT id FROM events WHERE task_id=? AND type='task.divergence_resolution_requested' LIMIT 1", target.id))
    return { skip: '解分歧 Worker 不重放未知文件副作用，需用户检查现场。' };
  if (project.clearing || project.workerDeleteIds?.size || project.settingsMigrationApplying) return { wait: '项目正在清理或迁移，已提交并等待安全点。' };
  if (project.taskSyncBusy?.has(target.id)) return { wait: '目标正在同步，已提交并等待安全点。' };
  if (project.workspaces.busy.has(target.id)) return { wait: '目标工作区正在清理，已提交并等待安全点。' };
  if (target.branch && project.branchFreeze(target.branch)) return { wait: '目标分支冻结，已提交并等待安全点。' };
  const reservation = target.reservation ? JSON.parse(target.reservation) : null;
  if (reservation?.version === 2 && ['requested','executing','blocked','resolving'].includes(reservation.status))
    return { wait: '目标交付被冻结，已提交并等待安全点。' };
  if (project.running.has(target.id)) return { wait: '目标旧调用尚未实际退出，已提交并等待安全点。' };
  return {};
}
function receiptView(receipt) {
  return { status: receipt.status, target_id: receipt.target_id, target_worker_number: receipt.target_worker_number ?? null,
    receipt_id: receipt.receipt_id, ...(receipt.reason ? { reason: receipt.reason } : {}) };
}
function queryView(project, target) {
  const candidate = target.status === 'failed' ? 'retry' : 'start';
  const gate = targetGate(project, target, candidate);
  return { id: target.id, worker_number: target.worker_number ?? null, name: target.name, task_kind: target.task_kind,
    goal: target.goal.slice(0, 500), status: target.status, integration: target.integration,
    ...(gate.skip ? { available_actions: [], reason: gate.skip } : { available_actions: [candidate], reason: gate.wait ?? null }) };
}

export default {
  managementWorkers() { return managementWorkers(this); },
  managementView(taskOrId) { return managementView(typeof taskOrId === 'object' ? taskOrId : this.store.task(taskOrId), this); },

  createManagementWorker(options) {
    this.assertWritable('create a management Worker');
    check(isPlainObject(options) && Object.keys(options).every(key => ['name','instruction','signal_id','mode','profile','client_request_id'].includes(key)), 'invalid management creation fields');
    text(options.instruction, 'management instruction');
    check(typeof options.name === 'string' && options.name.trim().length > 0 && options.name.length <= 200, 'management name must be non-empty text (max 200 characters)');
    const mode = options.mode ?? 'once'; check(['once','persistent'].includes(mode), 'management mode must be once or persistent');
    const requestId = options.client_request_id;
    check(requestId === undefined || (typeof requestId === 'string' && requestId.length > 0 && requestId.length <= 128
      && requestId.trim() === requestId && !/[\x00-\x1f\x7f]/.test(requestId)),
      'client_request_id must be non-empty, unpadded and free of control characters (max 128 characters)');
    const fingerprint = requestId === undefined ? null : creationFingerprint(options);
    if (requestId !== undefined) {
      const existing = this.store.get(`SELECT id,management FROM tasks WHERE task_kind='management'
        AND json_extract(management,'$.client_request_id')=?`, requestId);
      if (existing) {
        check(managementState(existing).creation_fingerprint === fingerprint, 'client_request_id is already used for a different management definition');
        return this.inspect(existing.id); // Even emitted/removed signals or changed defaults cannot hide a saved receipt.
      }
    }
    const signal = this.hookSignals().items.find(item => item.id === options.signal_id);
    check(signal?.enabled && signal.next_run_at && Date.parse(signal.next_run_at) > this.hookClock(), 'choose an enabled future signal');
    check(this.store.get("SELECT count(*) AS n FROM tasks WHERE task_kind='management' AND json_extract(management,'$.enabled')=1").n < MANAGEMENT_LIMITS.active,
      'active management binding limit reached');
    check(this.store.get("SELECT count(*) AS n FROM tasks WHERE status NOT IN ('completed','failed','cancelled')").n < 1000, 'too many active workers');
    const profile = options.profile === undefined ? this.config.provider === 'mock' ? null
      : inheritedRunProfile(this, { role: 'manager', retry_profile: null })
      : this.agentSettings.retryProfile('manager', options.profile);
    check(!profile || profile.agent === 'pi', 'management Workers require the restricted Pi adapter, not the legacy Codex CLI');
    check(!profile || profile.config_mode === 'pi' || profile.connection_id, 'management Worker requires a configured model source or Pi default mode');
    const task = this.store.transaction(() => {
      const task = this.store.create({ role: 'manager', task_kind: 'management', input_id: null,
        goal: options.instruction, name: options.name.trim() });
      this.store.update(task.id, { status: 'waiting', retry_profile: profile ? JSON.stringify(profile) : null });
      saveManagement(this, task.id, { version: 1, config_revision: 1, signal_id: signal.id, mode, enabled: true,
        state: 'waiting', reason: '等待下一信号；不保证 Agent 准点获得运行槽。', consumed: false,
        pending_signal: null, last_execution: null, receipts: [],
        ...(requestId === undefined ? {} : { client_request_id: requestId, creation_fingerprint: fingerprint }) });
      this.store.event(task.id, 'management.created', { signal_id: signal.id, mode });
      return this.store.task(task.id);
    });
    this.armScheduledHookTimer();
    return this.inspect(task.id);
  },

  updateManagementBinding(taskId, enabled, expectedRevision) {
    this.assertWritable('configure a management binding');
    const task = this.store.task(id(taskId)), state = managementState(task);
    check(task.task_kind === 'management' && state, 'not a management Worker');
    check(typeof enabled === 'boolean', 'management enabled must be boolean');
    check(typeof expectedRevision === 'string' && expectedRevision === managementRevision(task, state), 'management revision changed; reload before editing');
    if (enabled) {
      check(!TERMINAL.has(task.status) && !state.consumed && !['failed','unknown'].includes(state.state), 'consumed or interrupted management binding cannot be replayed; create a new instruction');
      check(state.enabled || (!this.running.has(task.id) && !state.pending_signal), 'wait for the current management occurrence to settle before re-enabling');
      const signal = this.hookSignals().items.find(item => item.id === state.signal_id);
      check(signal?.enabled && signal.next_run_at && Date.parse(signal.next_run_at) > this.hookClock(), 'signal is not enabled for a future occurrence');
      check(state.enabled || this.store.get("SELECT count(*) AS n FROM tasks WHERE task_kind='management' AND json_extract(management,'$.enabled')=1").n < MANAGEMENT_LIMITS.active,
        'active management binding limit reached');
      const unavailable = managementEnableReason(this, task, state);
      check(!unavailable, unavailable);
    }
    this.store.transaction(() => {
      state.enabled = enabled; state.config_revision += 1;
      if (!enabled) {
        for (const receipt of state.receipts) if (receipt.status === 'waiting') {
          receipt.status = 'skipped'; receipt.reason = '用户撤销待执行的管理授权。';
          this.store.event(task.id, 'management.action_skipped', { occurrence_id: state.pending_signal?.id, ...receipt });
        }
        if (state.pending_signal?.phase === 'pending') {
          state.last_execution = { ...state.pending_signal, status: 'skipped', finished_at: managementTime(this), reason: '用户撤销尚未开始的管理调用。', actions: state.receipts };
          state.pending_signal = null;
          this.store.update(task.id, { status: 'waiting' });
        }
        if (!state.pending_signal) state.state = 'stopped';
        state.reason = '用户已停用绑定；不撤回已经完成的操作。';
      } else if (!state.pending_signal) { state.state = 'waiting'; state.reason = '等待未来信号；不订阅历史 occurrence。'; }
      saveManagement(this, task.id, state);
      this.store.event(task.id, 'management.binding_updated', { signal_id: state.signal_id, enabled });
    });
    this.settleManagementOccurrence(task.id);
    this.armScheduledHookTimer();
    return this.inspect(task.id);
  },

  submitManagementSignal(taskId, signal) {
    const task = this.store.task(taskId), state = managementState(task);
    if (!state?.enabled || state.consumed || TERMINAL.has(task.status)) return;
    if (state.pending_signal || this.running.has(task.id)) {
      this.store.event(task.id, 'management.signal_skipped', { signal_id: signal.signal_id, occurrence_id: signal.id,
        due_at: signal.due_at, reason: '已有调用或待执行操作，本次信号不堆积。' });
      return;
    }
    state.pending_signal = { ...signal, phase: 'pending' }; state.state = 'queued'; state.receipts = [];
    state.reason = '信号已提交，等待 Agent 运行槽。';
    saveManagement(this, task.id, state);
    this.store.update(task.id, { status: 'queued', error: null });
    this.store.event(task.id, 'management.signal_submitted', { signal_id: signal.signal_id, occurrence_id: signal.id, due_at: signal.due_at });
    this.kick();
  },

  managementReady(task) {
    const state = managementState(task);
    return task.role === 'manager' && state?.enabled && state.state === 'queued' && !state.consumed && state.pending_signal?.phase === 'pending';
  },

  beginManagementInvocation(taskId, runId) {
    const task = this.store.task(taskId), state = managementState(task);
    check(this.managementReady(task), 'management occurrence is no longer eligible');
    state.pending_signal.phase = 'started'; state.pending_signal.run_id = runId;
    state.pending_signal.started_at = managementTime(this); state.state = 'running'; state.reason = null;
    saveManagement(this, taskId, state);
    this.store.event(taskId, 'management.invocation_started', { occurrence_id: state.pending_signal.id, run_id: runId });
  },

  managementContext(task) {
    const state = managementState(task);
    return { instruction: task.goal, signal: state.pending_signal ? { id: state.pending_signal.id,
      signal_id: state.pending_signal.signal_id, name: state.pending_signal.name, due_at: state.pending_signal.due_at } : null,
      authorization: { scope: 'current_project', operations: ['query','start','retry'], target_kinds: ['order','child'],
        start_status: 'paused', retry_status: 'failed' }, management: managementView(task, this) };
  },

  managementQuery(actorId, targetId = undefined) {
    assertManager(this, actorId);
    if (targetId !== undefined && targetId !== null) return queryView(this, this.store.task(id(targetId)));
    return { workers: bounded(this.store.all("SELECT * FROM tasks WHERE task_kind IN ('order','say','child') ORDER BY id DESC LIMIT 100")
      .map(task => queryView(this, task)), 100000), limit: 100 };
  },

  requestManagementAction(actorId, action, targetId) {
    this.assertWritable('request a management operation');
    const { task, state } = assertManager(this, actorId);
    check(['start','retry'].includes(action), 'management operation is not authorized');
    const target = this.store.task(id(targetId));
    const previous = state.receipts.find(receipt => receipt.action === action && receipt.target_id === target.id);
    if (previous) return receiptView(previous);
    check(state.receipts.length < MANAGEMENT_LIMITS.actions, 'management occurrence action limit reached');
    const receipt = this.store.transaction(() => {
      const receiptId = this.store.event(task.id, 'management.action_submitted', { occurrence_id: state.pending_signal.id, action, target_id: target.id });
      const receipt = { receipt_id: receiptId, action, target_id: target.id, target_worker_number: target.worker_number,
        occurrence_id: state.pending_signal.id, status: 'waiting' };
      state.receipts.push(receipt); saveManagement(this, task.id, state); return receipt;
    });
    this.executeManagementAction(task.id, receipt.receipt_id);
    this.armScheduledHookTimer();
    return receiptView(managementState(this.store.task(task.id)).receipts.find(item => item.receipt_id === receipt.receipt_id));
  },

  executeManagementAction(taskId, receiptId) {
    if (this.maintenancePaused()) return;
    const task = this.store.task(taskId), state = managementState(task);
    const receipt = state?.receipts.find(item => item.receipt_id === receiptId);
    if (!state?.enabled || !['started','returned'].includes(state.pending_signal?.phase)
      || receipt?.status !== 'waiting' || receipt.occurrence_id !== state.pending_signal.id) return;
    const target = this.store.get('SELECT * FROM tasks WHERE id=?', receipt.target_id), gate = targetGate(this, target, receipt.action);
    if (gate.wait) {
      if (receipt.reason !== gate.wait) { receipt.reason = gate.wait; state.reason = gate.wait; saveManagement(this, taskId, state); }
      return;
    }
    if (gate.skip) {
      receipt.status = 'skipped'; receipt.reason = gate.skip;
      this.store.transaction(() => {
        saveManagement(this, taskId, state);
        this.store.event(taskId, 'management.action_skipped', { occurrence_id: state.pending_signal.id, ...receipt });
      });
      return;
    }
    // Once begun, an unexpected exception is not a temporary gate. Atomic DB effects and the exact receipt
    // share a second boundary, leaving a conservative started/unknown diagnostic if the process disappears.
    receipt.status = 'running'; delete receipt.reason; saveManagement(this, taskId, state);
    try {
      this.store.transaction(() => {
        if (receipt.action === 'start') this.resumeTask(target.id);
        else this.retry(target.id);
        receipt.status = 'succeeded';
        saveManagement(this, taskId, state);
        this.store.event(taskId, 'management.action_completed', { occurrence_id: state.pending_signal.id, ...receipt });
      });
    } catch {
      receipt.status = 'unknown'; receipt.reason = unknownReason;
      this.store.transaction(() => { saveManagement(this, taskId, state); this.failManagementOccurrence(taskId, 'unknown'); });
    }
  },

  drainManagementActions() {
    if (this.stopping || this.maintenancePaused() || this.recoveringHooks || this.clearing || this.workerDeleteIds?.size || this.settingsMigrationApplying) return;
    for (const task of this.store.all(`SELECT id,management FROM tasks WHERE task_kind='management'
      AND json_extract(management,'$.enabled')=1 AND json_extract(management,'$.pending_signal') IS NOT NULL ORDER BY id`)) {
      const state = managementState(task);
      if (!state.enabled || !state.pending_signal) continue;
      for (const receipt of state.receipts) if (receipt.status === 'waiting') this.executeManagementAction(task.id, receipt.receipt_id);
      this.settleManagementOccurrence(task.id);
    }
  },

  /** A verified safe boundary retains occurrence identity and completed action receipts. */
  pauseManagementInvocation(taskId, runId) {
    const task = this.store.task(taskId), state = managementState(task);
    if (state?.pending_signal?.run_id !== runId || state.pending_signal.phase !== 'started' || !state.enabled) return;
    check(!state.receipts.some(receipt => ['running','unknown'].includes(receipt.status)), 'management effect is unknown; inspect before continuing');
    state.pending_signal.phase = 'pending';
    delete state.pending_signal.run_id; delete state.pending_signal.started_at;
    state.state = 'queued'; state.reason = '项目维护暂停，等待显式全部继续。';
    saveManagement(this, taskId, state);
    this.store.update(taskId, { status: 'queued' });
  },

  completeManagementInvocation(taskId, runId) {
    const state = managementState(this.store.task(taskId));
    if (state?.pending_signal?.run_id !== runId || state.pending_signal.phase !== 'started') return;
    state.pending_signal.phase = 'returned'; state.state = 'waiting_actions';
    state.reason = '管理调用已返回；受阻操作仍由后台等待安全点。';
    saveManagement(this, taskId, state);
    this.store.update(taskId, { status: 'waiting' });
    this.settleManagementOccurrence(taskId);
  },

  settleManagementOccurrence(taskId) {
    const task = this.store.task(taskId), state = managementState(task);
    if (!state?.pending_signal || state.pending_signal.phase !== 'returned'
      || state.receipts.some(receipt => ['waiting','running'].includes(receipt.status))) return;
    if (state.receipts.some(receipt => receipt.status === 'unknown')) { this.failManagementOccurrence(taskId, 'unknown'); return; }
    const skipped = state.receipts.some(receipt => receipt.status === 'skipped') || !state.enabled;
    this.store.transaction(() => {
      state.last_execution = { ...state.pending_signal, status: skipped ? 'skipped' : 'succeeded',
        finished_at: managementTime(this), actions: state.receipts };
      state.pending_signal = null;
      state.consumed = state.mode === 'once';
      if (state.consumed) state.enabled = false;
      state.state = state.enabled ? 'waiting' : state.consumed ? state.last_execution.status : 'stopped';
      state.reason = state.enabled ? '等待下一信号。' : state.consumed ? '一次性绑定已执行，不自动重放。' : '绑定已停用。';
      saveManagement(this, taskId, state);
      this.store.update(taskId, { status: state.consumed ? 'completed' : 'waiting' });
      this.store.event(taskId, 'management.settled', { occurrence_id: state.last_execution.id, status: state.last_execution.status });
    });
  },

  failManagementOccurrence(taskId, outcome = 'failed') {
    const task = this.store.task(taskId), state = managementState(task);
    // A later Provider exception must not downgrade an already durable unknown effect to failed,
    // replace its receipt diagnostics, or emit a second occurrence-failure decision.
    if (!state || (!state.enabled && ['failed','unknown'].includes(state.state))) return;
    this.store.transaction(() => {
      state.enabled = false; state.state = outcome; state.reason = outcome === 'unknown' ? unknownReason : failedReason;
      for (const receipt of state.receipts) if (receipt.status === 'waiting') { receipt.status = 'skipped'; receipt.reason = '管理授权已停止。'; }
      state.last_execution = state.pending_signal ? { ...state.pending_signal, status: outcome,
        finished_at: managementTime(this), reason: state.reason, actions: state.receipts } : state.last_execution;
      // Keep the original pending identity in unknown/failed diagnostics, but it can never be admitted again.
      saveManagement(this, taskId, state);
      this.store.update(taskId, { status: task.status === 'cancelled' ? 'cancelled' : 'failed', error: state.reason });
      this.store.event(taskId, `management.${outcome}`, { occurrence_id: state.pending_signal?.id ?? null, reason: state.reason });
    });
  },

  recoverManagementWorkers() {
    for (const task of this.store.all(`SELECT id,management FROM tasks WHERE task_kind='management'
      AND json_extract(management,'$.pending_signal') IS NOT NULL ORDER BY id`)) {
      const state = managementState(task);
      if (!state.pending_signal || ['failed','unknown'].includes(state.state)) continue;
      let unknown = false;
      for (const receipt of state.receipts) if (receipt.status === 'running') {
        const proof = this.store.get(`SELECT id FROM events WHERE task_id=? AND type='management.action_completed'
          AND json_extract(data,'$.receipt_id')=? AND json_extract(data,'$.occurrence_id')=?
          AND json_extract(data,'$.target_id')=? AND json_extract(data,'$.action')=? LIMIT 1`,
          task.id, receipt.receipt_id, state.pending_signal.id, receipt.target_id, receipt.action);
        if (proof) receipt.status = 'succeeded';
        else { receipt.status = 'unknown'; receipt.reason = unknownReason; unknown = true; }
      }
      if (state.pending_signal.phase === 'started') {
        const proof = this.store.get(`SELECT r.id FROM agent_runs r JOIN events e ON e.task_id=r.task_id
          WHERE r.id=? AND r.task_id=? AND r.status='completed' AND e.type='invocation.completed'
          AND json_extract(e.data,'$.run_id')=r.id LIMIT 1`, state.pending_signal.run_id, task.id);
        if (proof) state.pending_signal.phase = 'returned'; else unknown = true;
      }
      if (unknown) {
        saveManagement(this, task.id, state); this.failManagementOccurrence(task.id, 'unknown'); continue;
      }
      saveManagement(this, task.id, state);
      if (state.pending_signal.phase === 'pending' && state.enabled) this.store.update(task.id, { status: 'queued' });
      else if (state.pending_signal.phase === 'returned') {
        this.store.update(task.id, { status: 'waiting' }); this.settleManagementOccurrence(task.id);
      }
    }
  },
};
