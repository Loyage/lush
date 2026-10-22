import { check, id, text, isPlainObject, TERMINAL, bounded } from '../types.js';
import { assertTaskAncestorsOpen } from './iteration.js';
import { hookRevision } from '../hooks.js';
import { workerLabel } from '../worker-number.js';
import { inheritedRunProfile } from './internal.js';
import { assertManager } from './management-auth.js';
import { managementAudit, managementPhase, capabilityDiagnostic } from './management-diagnostic.js';
import { managementActionView } from './management-receipt.js';
import controlMethods, { managementControlPending, trackControlJob } from './management-control.js';
import permissionMethods from './management-permissions.js';
import emergencyMethods, { managementEmergencyBlockers } from './management-emergency.js';
import { effectiveManagementPolicy } from '../../rpc/management-policy.js';
import { managementDraftRequest } from './management-drafts.js';
import { inputOptions, inputEmission } from './input-emission-data.js';
import { safeInvocationMessage } from '../../agent/invocation-error.js';
import { hasManagementConfirmation } from './management-code.js';
import { MANAGEMENT_LIMITS, managementState, saveManagement, managementTime, managementRevision,
  managementView, managementWorkers, managementEnableReason, managementUnsettled, managementAppendReason, managementInstruction, managementAuthority, managementAcceptanceFacts,
  closeManagementExecution, retainManagementExecution, assertManagementReceiptRoom } from './management-data.js';

const unknownReason = '管理调用或操作曾中断，副作用未知；绑定已停用，不自动重放。';
const failureAction = '管理授权已停用，不自动重放。请先核对执行记录与受控操作收据，确认安全并修复原因后再另建管理指令。';
const failedReason = `管理调用未完成，未记录可用的具体原因。\n${failureAction}`;
function creationFields(options) {
  check(isPlainObject(options) && Object.keys(options).every(key => ['name','instruction','signal_id','mode','profile','client_request_id'].includes(key)), 'invalid management creation fields');
}
function revokeOwnQuestion(project, taskId, state) {
  if (state.pending_signal?.phase !== 'question') return;
  project.store.run("UPDATE notices SET status='dismissed',answer='management authorization stopped' WHERE id=? AND task_id=? AND status='open'",
    state.pending_signal.question_notice_id, taskId);
  state.pending_signal.phase = 'returned'; delete state.pending_signal.question_notice_id;
}
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
function queryView(project, target, snapshot) {
  const candidate = target.status === 'failed' ? 'retry' : 'start';
  const gate = targetGate(project, target, candidate);
  const policy = effectiveManagementPolicy(candidate === 'start' ? 'worker.resume' : 'worker.retry', snapshot);
  if (policy.access === 'unavailable') gate.skip ??= policy.reason;
  return { id: target.id, worker_number: target.worker_number ?? null, name: target.name, task_kind: target.task_kind,
    goal: target.goal.slice(0, 500), status: target.status, integration: target.integration,
    ...(gate.skip ? { available_actions: [], reason: gate.skip } : { available_actions: [candidate], reason: gate.wait ?? null }) };
}

export default {
  ...controlMethods,
  ...permissionMethods,
  ...emergencyMethods,
  assertManagementPermission(actorId, method) {
    const audit = managementAudit(), previous = audit ? { stage: audit.stage, effect: audit.effect, evidence: audit.evidence, failure_code: audit.failure_code } : null;
    managementPhase('authorization', 'not_started', 'trusted_pre_dispatch', 'permission_denied');
    const result = this.withManagementPermissionAdmission(() => {
      const actor = assertManager(this, actorId);
      const policy = effectiveManagementPolicy(method, this.managementPermissionsSnapshot());
      check(policy.access !== 'unavailable', policy.reason);
      return { ...actor, policy };
    });
    if (audit) Object.assign(audit, previous);
    return result;
  },
  /** Own decision questions suspend the existing occurrence, not a new management identity. */
  holdManagementQuestion(taskId, noticeId) {
    const task = this.store.task(taskId), state = managementState(task), run = this.running.get(taskId);
    check(task.task_kind === 'management' && state?.enabled && state.pending_signal?.phase === 'started'
      && state.pending_signal.run_id === run?.recordId, 'management question requires the current invocation');
    check(!state.pending_signal.elevation, 'a single elevated input cannot suspend for a password-free follow-up question; use a fresh password-confirmed input');
    state.pending_signal.phase = 'question'; state.pending_signal.question_notice_id = noticeId;
    state.state = 'awaiting_question'; state.reason = '等待用户答复当前管家的决策问题。';
    saveManagement(this, taskId, state);
  },

  resumeManagementQuestion(taskId, noticeId) {
    const task = this.store.task(taskId), state = managementState(task);
    if (!state?.enabled || state.pending_signal?.elevation || state.pending_signal?.phase !== 'question'
      || state.pending_signal.question_notice_id !== noticeId || ['failed','cancelled','completed'].includes(task.status)) return false;
    check(!this.store.get("SELECT id FROM notices WHERE task_id=? AND status='open' LIMIT 1", taskId), 'management question is still open');
    state.pending_signal.phase = 'pending'; delete state.pending_signal.run_id; delete state.pending_signal.started_at;
    delete state.pending_signal.question_notice_id;
    state.state = 'queued'; state.reason = '用户已答复管家决策，继续同一个授权事项。';
    saveManagement(this, taskId, state); this.store.update(taskId, { status: 'queued' }); this.kick();
    return true;
  },

  managementWorkers() { return managementWorkers(this); },
  managementView(taskOrId) { return managementView(typeof taskOrId === 'object' ? taskOrId : this.store.task(taskOrId), this); },

  // Existing submitted signals queue fairly by occurrence identity, not Worker age.
  // An admitted occurrence retains the project-local lane until actual cleanup and effects settle.
  managementOccupant() {
    const activeIds = [...new Set([...this.running.keys(), ...(this.managementControlOwners?.keys() ?? [])])];
    return this.store.all(`SELECT * FROM tasks WHERE task_kind='management' AND
      (json_extract(management,'$.pending_signal') IS NOT NULL
        OR json_extract(management,'$.emergency.status')='stopping'
        OR EXISTS (SELECT 1 FROM json_each(tasks.management,'$.control_calls') WHERE json_extract(value,'$.status') IN ('pending_confirmation','approved','running','unknown'))
        OR EXISTS (SELECT 1 FROM json_each(tasks.management,'$.receipts') WHERE json_extract(value,'$.status') IN ('waiting','running','unknown'))
        ${activeIds.length ? ` OR id IN (${activeIds.map(() => '?').join(',')})` : ''}) ORDER BY id`, ...activeIds)
      .filter(task => {
        const state = managementState(task);
        // Isolation releases only historical lane barriers, never actual runtime ownership.
        return state?.emergency ? state.emergency.status !== 'isolated' || managementEmergencyBlockers(this, task, state).length > 0
          : managementUnsettled(this, task, state);
      }).sort((a, b) => {
        const priority = task => this.running.has(task.id) || managementState(task)?.pending_signal?.phase !== 'pending' ? 0 : 1;
        return priority(a) - priority(b)
          || (managementState(a)?.pending_signal?.id ?? a.id) - (managementState(b)?.pending_signal?.id ?? b.id) || a.id - b.id;
      })[0] ?? null;
  },

  /** Async intake only: receipt reads/appends keep working without restoring a missing main.
   * Native creation below remains synchronous with draft/elevation receipt transactions. */
  async prepareManagementCreation(options) {
    this.assertWritable('prepare a management Worker');
    const request = options.client_request_id;
    if (typeof request === 'string' && (this.managementElevationRequestUsed(request) || managementDraftRequest(this, request)
      || this.store.get("SELECT id FROM tasks WHERE task_kind='management' AND json_extract(management,'$.client_request_id')=?", request))) return;
    if (options.draft_id !== undefined) {
      const draft = this.store.draft(id(options.draft_id));
      if (inputEmission(draft)?.kind === 'management' || inputOptions(draft).target_id != null) return;
    }
    return this.workspaces.exclusive(async () => {
      try { await this.workspaces.git(this.config.project, 'rev-parse', '--verify', 'refs/heads/main^{commit}'); }
      catch { check(false, '新建 Valet 需要已有真实本地 refs/heads/main；不会自动初始化 Git 或创建分支。'); }
      return this.ensureMainTask();
    });
  },

  async createManagementWorker(options) {
    creationFields(options);
    await this.prepareManagementCreation(options);
    return this.createPreparedManagementWorker(options);
  },

  /** Internal synchronous phase, only after async intake; shares the caller's receipt transaction. */
  createPreparedManagementWorker(options) {
    this.assertWritable('create a management Worker');
    creationFields(options);
    text(options.instruction, 'management instruction');
    check(typeof options.name === 'string' && options.name.trim().length > 0 && options.name.length <= 200, 'management name must be non-empty text (max 200 characters)');
    const mode = options.mode ?? 'once'; check(['once','persistent'].includes(mode), 'management mode must be once or persistent');
    const requestId = options.client_request_id;
    check(requestId === undefined || (typeof requestId === 'string' && requestId.length > 0 && requestId.length <= 128
      && requestId.trim() === requestId && !/[\x00-\x1f\x7f]/.test(requestId)),
      'client_request_id must be non-empty, unpadded and free of control characters (max 128 characters)');
    const fingerprint = requestId === undefined ? null : creationFingerprint(options);
    if (requestId !== undefined) {
      check(!this.managementElevationRequestUsed(requestId), 'client_request_id belongs to a password-elevated input; inspect its receipt instead of replaying ordinary input');
      check(!managementDraftRequest(this, requestId), 'client_request_id belongs to a management draft submission; inspect its original receipt');
      const existing = this.store.get(`SELECT id,management FROM tasks WHERE task_kind='management'
        AND json_extract(management,'$.client_request_id')=?`, requestId);
      if (existing) {
        check(managementState(existing).creation_fingerprint === fingerprint, 'client_request_id is already used for a different management definition');
        return this.inspect(existing.id); // Even emitted/removed signals or changed defaults cannot hide a saved receipt.
      }
    }
    const immediate = options.signal_id === null;
    check(!immediate || mode === 'once', 'immediate management input is once only');
    const occupant = this.managementOccupant();
    check(!occupant, '当前项目已有管家 occurrence 排队、运行或尚未安全收口；请等待其实际退出及操作收尾后再创建管家。');
    const signal = immediate ? null : this.hookSignals().items.find(item => item.id === options.signal_id);
    check(immediate || signal?.enabled && signal.next_run_at && Date.parse(signal.next_run_at) > this.hookClock(), 'choose an enabled future signal');
    check(this.store.get("SELECT count(*) AS n FROM tasks WHERE task_kind='management' AND json_extract(management,'$.enabled')=1").n < MANAGEMENT_LIMITS.active,
      'active management binding limit reached');
    check(this.store.get("SELECT count(*) AS n FROM tasks WHERE status NOT IN ('completed','failed','cancelled')").n < 1000, 'too many active workers');
    const profile = options.profile === undefined ? this.config.provider === 'mock' ? null
      : inheritedRunProfile(this, { role: 'manager', retry_profile: null })
      : this.agentSettings.retryProfile('manager', options.profile);
    check(!profile || profile.agent === 'pi', 'management Workers require the restricted Pi adapter, not the legacy Codex CLI');
    check(!profile || profile.config_mode === 'pi' || profile.connection_id, 'management Worker requires a configured model source or Pi default mode');
    const task = this.store.transaction(() => {
      // Identity/ownership only. Never inherit a development branch, profile, context or child lifecycle.
      const roots = this.store.all("SELECT id,status FROM tasks WHERE task_kind='main' AND branch='main' ORDER BY id");
      check(roots.length === 1 && !TERMINAL.has(roots[0].status),
        '新建 Valet 需要真实 main Worker；请先通过管理入口核验已有 refs/heads/main，不会创建伪 main。');
      const task = this.store.create({ parent_id: roots[0].id, role: 'manager', task_kind: 'management', input_id: null,
        goal: options.instruction, name: options.name.trim(), input_source: { kind: 'user', worker_id: null, worker_number: null } });
      this.store.update(task.id, { status: immediate ? 'queued' : 'waiting', retry_profile: profile ? JSON.stringify(profile) : null });
      const occurrence = immediate ? this.store.event(task.id, 'management.input_submitted', { mode: 'once' }) : null;
      saveManagement(this, task.id, { version: 1, config_revision: 1, signal_id: signal?.id ?? null, mode, enabled: true,
        origin: immediate ? 'input' : 'signal', permissions_snapshot: this.managementPermissionsSnapshot(),
        state: immediate ? 'queued' : 'waiting', reason: immediate ? '管理输入已提交，等待运行槽。' : '等待下一信号；不保证 Agent 准点获得运行槽。', consumed: false,
        pending_signal: immediate ? { id: occurrence, signal_id: null, name: '管理输入', due_at: managementTime(this), submitted_at: managementTime(this), phase: 'pending' } : null,
        last_execution: null, receipts: [], control_calls: [],
        ...(requestId === undefined ? {} : { client_request_id: requestId, creation_fingerprint: fingerprint }) });
      this.store.event(task.id, 'management.created', { signal_id: signal?.id ?? null, mode, origin: immediate ? 'input' : 'signal' });
      return this.store.task(task.id);
    });
    this.armScheduledHookTimer();
    return this.inspect(task.id);
  },

  appendManagementInstruction(taskId, instruction) {
    this.assertWritable('append a management instruction');
    text(instruction, 'management instruction');
    const task = this.store.task(id(taskId)), state = managementState(task);
    const reason = managementAppendReason(this, task, state);
    check(!reason, reason);
    assertTaskAncestorsOpen(this, task);
    this.store.transaction(() => {
      const messageId = this.store.appendMessage(task.id, instruction);
      this.store.event(task.id, 'message', { sender: null, body: instruction, message_id: messageId,
        append_number: null, user_append: true, input_source: { kind: 'user', worker_id: null, worker_number: null } });
      const occurrenceId = this.store.event(task.id, 'management.input_submitted', { mode: 'append', message_id: messageId });
      state.pending_signal = { id: occurrenceId, signal_id: null, name: '追加管理输入',
        due_at: managementTime(this), submitted_at: managementTime(this), phase: 'pending',
        origin: 'append', message_id: messageId, restore_enabled: state.enabled };
      state.enabled = true; state.consumed = false; state.config_revision += 1;
      state.state = 'queued'; state.reason = '追加管理输入已提交，等待运行槽；不重放旧操作。';
      retainManagementExecution(state);
      state.receipts = []; state.control_calls = [];
      saveManagement(this, task.id, state);
      this.store.update(task.id, { status: 'queued', error: null });
    });
    this.kick();
    return { ...this.store.task(task.id), input_queue: { buffered: 0, reason: null } };
  },

  updateManagementBinding(taskId, enabled, expectedRevision) {
    this.assertWritable('configure a management binding');
    const task = this.store.task(id(taskId)), state = managementState(task);
    check(task.task_kind === 'management' && state, 'not a management Worker');
    const acceptance = managementAcceptanceFacts(this.store, task);
    check(!acceptance.accepted && !acceptance.acceptance_recovery && !acceptance.acceptance_blocked && !this.acceptanceBusy?.has(task.id), 'Valet is archived or acceptance recovery is unfinished; history is read-only');
    check(typeof enabled === 'boolean', 'management enabled must be boolean');
    check(typeof expectedRevision === 'string' && expectedRevision === managementRevision(task, state), 'management revision changed; reload before editing');
    if (enabled) {
      check(!state.emergency && !TERMINAL.has(task.status) && !state.consumed && !['failed','unknown'].includes(state.state), 'consumed or interrupted management binding cannot be replayed; create a new instruction');
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
      if (state.pending_signal?.origin === 'append') state.pending_signal.restore_enabled = enabled;
      if (!enabled) {
        revokeOwnQuestion(this, task.id, state);
        this.revokeManagementCapabilities(task.id, state);
        for (const receipt of state.receipts) if (receipt.status === 'waiting') {
          receipt.status = 'skipped'; receipt.reason = '用户撤销待执行的管理授权。';
          if (receipt.diagnostic) capabilityDiagnostic(this, task.id, receipt, 'preflight_rejected', 'authorization', 'not_started', 'trusted_pre_dispatch');
          this.store.event(task.id, 'management.action_skipped', { occurrence_id: state.pending_signal?.id, ...receipt });
        }
        if (state.pending_signal?.phase === 'pending') {
          closeManagementExecution(state, { status: 'skipped', finished_at: managementTime(this), reason: '用户撤销尚未开始的管理调用。' });
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
    this.kick();
    return this.inspect(task.id);
  },

  cancelManagementWorker(taskId, reason, status = 'cancelled') {
    const task = this.store.task(taskId), state = managementState(task);
    if (!state) return task;
    if (TERMINAL.has(task.status) && !state.enabled
      && !state.receipts.some(receipt => receipt.status === 'waiting')
      && !(state.control_calls ?? []).some(call => ['pending_confirmation','approved'].includes(call.status))) return this.inspect(task.id);
    this.store.transaction(() => {
      state.enabled = false; state.config_revision += 1;
      revokeOwnQuestion(this, task.id, state);
      this.revokeManagementCapabilities(task.id, state);
      for (const receipt of state.receipts) if (receipt.status === 'waiting') {
        receipt.status = 'skipped'; receipt.reason = '用户撤销待执行的管理授权。';
        if (receipt.diagnostic) capabilityDiagnostic(this, task.id, receipt, 'preflight_rejected', 'authorization', 'not_started', 'trusted_pre_dispatch');
        this.store.event(task.id, 'management.action_skipped', { occurrence_id: receipt.occurrence_id, ...receipt });
      }
      state.reason = reason;
      // A started occurrence must remain owned until Provider and asynchronous actions exit.
      if (state.pending_signal?.phase === 'pending') {
        closeManagementExecution(state, { status: 'skipped', finished_at: managementTime(this), reason });
        state.pending_signal = null;
      }
      state.state = state.pending_signal ? 'stopping' : 'stopped';
      saveManagement(this, task.id, state);
      this.store.update(task.id, { status, error: reason, interrupt_state: null });
      this.store.event(task.id, status, { reason });
    });
    this.invalidateMaintenanceWorker(task.id, status);
    this.running.get(task.id)?.controller.abort(new Error(reason));
    this.settleManagementOccurrence(task.id);
    this.armScheduledHookTimer(); this.kick();
    return this.inspect(task.id);
  },

  submitManagementSignal(taskId, signal) {
    check(isPlainObject(signal) && Object.keys(signal).every(key => ['id','signal_id','name','due_at','submitted_at'].includes(key)),
      'management signals cannot contain elevation or unregistered input fields');
    const task = this.store.task(taskId), state = managementState(task);
    if (!state?.enabled || state.consumed || TERMINAL.has(task.status)) return;
    if (state.pending_signal || this.running.has(task.id)) {
      this.store.event(task.id, 'management.signal_skipped', { signal_id: signal.signal_id, occurrence_id: signal.id,
        due_at: signal.due_at, reason: '已有调用或待执行操作，本次信号不堆积。' });
      return;
    }
    retainManagementExecution(state);
    state.pending_signal = { ...signal, phase: 'pending' }; state.state = 'queued'; state.receipts = []; state.control_calls = [];
    state.reason = '信号已提交，等待 Agent 运行槽。';
    saveManagement(this, task.id, state);
    this.store.update(task.id, { status: 'queued', error: null });
    this.store.event(task.id, 'management.signal_submitted', { signal_id: signal.signal_id, occurrence_id: signal.id, due_at: signal.due_at });
    this.kick();
  },

  managementReady(task) {
    const state = managementState(task);
    return !this.managementRecoveryBlocked?.has(task.id) && task.role === 'manager' && state?.enabled && state.state === 'queued' && !state.consumed
      && !this.managementControlOwners?.has(task.id)
      && !(state.control_calls ?? []).some(call => ['running','unknown'].includes(call.status))
      && state.pending_signal?.phase === 'pending' && this.managementOccupant()?.id === task.id;
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
    const state = managementState(task), authority = managementAuthority(state.pending_signal), view = managementView(task, this);
    // User history retains the prior occurrence; an ordinary model must not inherit its high-authority material.
    if (authority.mode === 'ordinary') {
      if (view.last_execution?.authority.mode === 'administrator') view.last_execution = null;
      delete view.first_failure;
    }
    const decisions = (state.control_calls ?? []).filter(call => call.method === 'notice.post' && call.status === 'succeeded'
      && call.occurrence_id === state.pending_signal?.id && Number.isSafeInteger(call.result?.id))
      .map(call => this.store.get('SELECT id,kind,status,answer,answer_source FROM notices WHERE id=? AND task_id=?', call.result.id, task.id))
      .filter(notice => notice && ['answered','dismissed'].includes(notice.status))
      .map(notice => ({ notice_id: notice.id, kind: notice.kind, status: notice.status, answer_source: notice.answer_source,
        answer: String(notice.answer ?? '').slice(0, 4000), text_truncated: String(notice.answer ?? '').length > 4000,
        total_chars: String(notice.answer ?? '').length }));
    return { instruction: managementInstruction(this, task, state), decisions, signal: state.pending_signal ? { id: state.pending_signal.id,
      signal_id: state.pending_signal.signal_id, name: state.pending_signal.name, due_at: state.pending_signal.due_at } : null,
      authorization: authority.mode === 'administrator' ? { ...authority, project: this.config.project, operations: ['administrator'],
        dangerous_operations: 'this_password_confirmed_input_only', consistency_checks: 'unchanged', device_scope: 'unavailable' }
        : { ...authority, operations: ['query','start','retry','catalog','history','call'],
          dangerous_operations: 'latest_device_permissions', permission_changes: 'exact_user_confirmation',
          device_scope: 'explicit_instruction_and_parameter', target_kinds: ['order','child'],
          start_status: 'paused', retry_status: 'failed' }, management: view };
  },

  managementQuery(actorId, targetId = undefined) {
    this.assertManagementPermission(actorId, 'manager.query');
    const permissions = this.managementPermissionsSnapshot();
    if (targetId !== undefined && targetId !== null) return queryView(this, this.store.task(id(targetId)), permissions);
    return { workers: bounded(this.store.all("SELECT * FROM tasks WHERE task_kind IN ('order','say','child') ORDER BY id DESC LIMIT 100")
      .map(task => queryView(this, task, permissions)), 100000), limit: 100 };
  },

  requestManagementAction(actorId, action, targetId) {
    this.assertWritable('request a management operation');
    check(['start','retry'].includes(action), 'management operation is not authorized');
    const { task, policy } = this.assertManagementPermission(actorId, action === 'start' ? 'worker.resume' : 'worker.retry');
    if (policy.access === 'confirmation') return this.callManagementCapability(actorId,
      action === 'start' ? 'worker.resume' : 'worker.retry', { id: id(targetId) });
    managementPhase('preflight', 'not_started', 'trusted_pre_dispatch', 'preflight_rejected');
    return this.submitManagementAction(task.id, action, targetId);
  },

  // Trusted execution helper: both dedicated tools and confirmed manager.call
  // use the original target gates, saved configuration, dedup and waiting engine.
  submitManagementAction(taskId, action, targetId, capabilityReceipt = null) {
    const task = this.store.task(taskId), state = managementState(task);
    const target = this.store.task(id(targetId));
    const previous = state.receipts.find(receipt => receipt.action === action && receipt.target_id === target.id);
    if (previous) return managementActionView(this, task, previous);
    check(state.receipts.length + (state.control_calls?.length ?? 0) < MANAGEMENT_LIMITS.actions, 'management occurrence action limit reached');
    const receipt = this.store.transaction(() => {
      const audit = managementAudit(), origin = (state.control_calls ?? []).find(call => call.receipt_id === capabilityReceipt);
      const callId = audit?.call_id ?? origin?.call_id ?? null, runId = audit?.run_id ?? origin?.run_id ?? null;
      const receiptId = this.store.event(task.id, 'management.action_submitted', { occurrence_id: state.pending_signal.id, action, target_id: target.id,
        call_id: callId, run_id: runId, capability_receipt_id: capabilityReceipt });
      const receipt = { receipt_id: receiptId, action, target_id: target.id, target_worker_number: target.worker_number,
        occurrence_id: state.pending_signal.id, status: 'waiting', capability_receipt_id: capabilityReceipt,
        call_id: callId, run_id: runId };
      capabilityDiagnostic(this, task.id, receipt, 'approved', 'preflight', 'not_started', 'approval_pending');
      state.receipts.push(receipt); assertManagementReceiptRoom(state);
      saveManagement(this, task.id, state); return receipt;
    });
    this.executeManagementAction(task.id, receipt.receipt_id);
    this.armScheduledHookTimer();
    return managementActionView(this, this.store.task(task.id), managementState(this.store.task(task.id)).receipts.find(item => item.receipt_id === receipt.receipt_id));
  },

  executeManagementAction(taskId, receiptId) {
    return this.withManagementPermissionAdmission(() => this.executeManagementActionAdmitted(taskId, receiptId));
  },

  executeManagementActionAdmitted(taskId, receiptId) {
    if (this.maintenancePaused() || this.managementRecoveryBlocked?.has(taskId)) return;
    const task = this.store.task(taskId);
    let state = managementState(task), receipt = state?.receipts.find(item => item.receipt_id === receiptId);
    if (this.managementOccupant()?.id !== taskId || !state?.enabled || !['started','returned'].includes(state.pending_signal?.phase)
      || receipt?.status !== 'waiting' || receipt.occurrence_id !== state.pending_signal.id) return;
    const target = this.store.get('SELECT * FROM tasks WHERE id=?', receipt.target_id), gate = targetGate(this, target, receipt.action);
    const method = receipt.action === 'start' ? 'worker.resume' : 'worker.retry';
    const policy = effectiveManagementPolicy(method, this.managementPermissionsSnapshot());
    const capability = state.control_calls?.find(call => (call.receipt_id === receipt.capability_receipt_id
      || call.result?.action?.receipt_id === receipt.receipt_id)
      && call.method === method && call.params.id === receipt.target_id && call.occurrence_id === receipt.occurrence_id);
    if (policy.access === 'unavailable' || policy.access === 'confirmation' && !hasManagementConfirmation(this, taskId, capability)) {
      gate.skip = policy.access === 'confirmation' ? '最新管家权限要求重新精确确认；此操作未开始，请新建请求。'
        : '最新管家权限禁止此未开始操作；请调整权限后新建请求，不自动重放。';
      delete gate.wait;
    }
    if (gate.wait) {
      if (receipt.reason !== gate.wait) { receipt.reason = gate.wait; state.reason = gate.wait; saveManagement(this, taskId, state); }
      return;
    }
    if (gate.skip) {
      receipt.status = 'skipped'; receipt.reason = gate.skip;
      if (receipt.diagnostic) capabilityDiagnostic(this, taskId, receipt,
        policy.access === 'unavailable' || policy.access === 'confirmation' && !hasManagementConfirmation(this, taskId, capability)
          ? 'permission_denied' : 'preflight_rejected', 'preflight', 'not_started', 'trusted_pre_dispatch');
      this.store.transaction(() => {
        saveManagement(this, taskId, state);
        this.store.event(taskId, 'management.action_skipped', { occurrence_id: state.pending_signal.id, ...receipt });
      });
      return;
    }
    // Once begun, an unexpected exception is not a temporary gate. Atomic DB effects and the exact receipt
    // share a second boundary, leaving a conservative started/unknown diagnostic if the process disappears.
    receipt.status = 'running'; delete receipt.reason;
    if (receipt.diagnostic) capabilityDiagnostic(this, taskId, receipt, 'in_progress', 'execution', 'unknown', 'dispatch_entered');
    this.store.transaction(() => {
      saveManagement(this, taskId, state);
      this.store.event(taskId, 'management.action_started', { occurrence_id: state.pending_signal.id, ...receipt });
    });
    let stage = 'execution';
    managementPhase('execution', 'unknown', 'dispatch_entered', 'execution_failed');
    try {
      this.store.transaction(() => {
        if (receipt.action === 'start') this.resumeTask(target.id);
        else this.retry(target.id);
        stage = 'completion';
        managementPhase('completion', 'unknown', 'dispatch_entered', 'completion_failed');
        receipt.status = 'succeeded';
        if (receipt.diagnostic) capabilityDiagnostic(this, taskId, receipt, 'succeeded', 'completion', 'applied', 'completion_saved');
        stage = 'persistence';
        managementPhase('persistence', 'unknown', 'dispatch_entered', 'persistence_failed');
        saveManagement(this, taskId, state);
        this.store.event(taskId, 'management.action_completed', { occurrence_id: state.pending_signal.id, ...receipt });
      });
    } catch {
      // Rollback does not prove that a lifecycle callback had no external effect.
      state = managementState(this.store.task(taskId)); receipt = state.receipts.find(item => item.receipt_id === receiptId);
      receipt.status = 'unknown'; receipt.reason = unknownReason;
      if (receipt.diagnostic) capabilityDiagnostic(this, taskId, receipt, stage === 'execution' ? 'execution_failed'
        : stage === 'completion' ? 'completion_failed' : 'persistence_failed', stage, 'unknown', 'dispatch_entered');
      this.store.transaction(() => {
        saveManagement(this, taskId, state);
        this.store.event(taskId, 'management.action_failed', { occurrence_id: receipt.occurrence_id, ...receipt });
        this.failManagementOccurrence(taskId, 'unknown');
      });
    }
  },

  drainManagementActions() {
    if (this.stopping || this.maintenancePaused() || this.recoveringHooks || this.clearing || this.workerDeleteIds?.size || this.settingsMigrationApplying) return;
    for (const task of this.store.all(`SELECT id,management FROM tasks WHERE task_kind='management'
      AND json_extract(management,'$.enabled')=1 AND json_extract(management,'$.pending_signal') IS NOT NULL ORDER BY id`)) {
      if (this.managementRecoveryBlocked?.has(task.id)) continue;
      const state = managementState(task);
      if (!state.enabled || !state.pending_signal) continue;
      this.drainManagementCapabilities(task.id);
      for (const receipt of state.receipts) if (receipt.status === 'waiting') this.executeManagementAction(task.id, receipt.receipt_id);
      this.settleManagementOccurrence(task.id);
    }
  },

  /** A verified safe boundary retains occurrence identity and completed action receipts. */
  pauseManagementInvocation(taskId, runId) {
    const task = this.store.task(taskId), state = managementState(task);
    if (state?.pending_signal?.run_id !== runId || state.pending_signal.phase !== 'started' || !state.enabled) return;
    check(!state.receipts.some(receipt => ['running','unknown'].includes(receipt.status))
      && !(state.control_calls ?? []).some(call => ['running','unknown'].includes(call.status)), 'management effect is unknown; inspect before continuing');
    state.pending_signal.phase = 'pending';
    delete state.pending_signal.run_id; delete state.pending_signal.started_at;
    state.state = 'queued'; state.reason = '项目维护暂停，等待显式全部继续。';
    saveManagement(this, taskId, state);
    this.store.update(taskId, { status: 'queued' });
    return true;
  },

  completeManagementInvocation(taskId, runId) {
    const state = managementState(this.store.task(taskId));
    if (state?.emergency || state?.pending_signal?.run_id !== runId || state.pending_signal.phase !== 'started') return;
    state.pending_signal.phase = 'returned'; state.state = 'waiting_actions';
    state.reason = '管理调用已返回；受阻操作仍由后台等待安全点。';
    saveManagement(this, taskId, state);
    if (!TERMINAL.has(this.store.task(taskId).status)) this.store.update(taskId, { status: 'waiting' });
    this.settleManagementOccurrence(taskId);
  },

  settleManagementOccurrence(taskId) {
    const task = this.store.task(taskId), state = managementState(task);
    if (state?.emergency) return this.settleManagementEmergency(taskId);
    if (this.managementRecoveryBlocked?.has(taskId)) return;
    if (!this.running.has(taskId) && state?.state === 'stopping' && state.pending_signal?.phase === 'started') {
      state.pending_signal.phase = 'returned';
      saveManagement(this, taskId, state);
    }
    if (this.running.has(taskId) || this.managementControlOwners?.has(taskId)
      || (state?.control_calls ?? []).some(call => this.managementControlBusy?.has(call.receipt_id))
      || !state?.pending_signal || state.pending_signal.phase !== 'returned'
      || state.receipts.some(receipt => ['waiting','running'].includes(receipt.status))) return;
    if (managementControlPending(state)) {
      this.store.update(taskId, { status: (state.control_calls ?? []).some(call => call.status === 'pending_confirmation') ? 'awaiting' : 'waiting' });
      return;
    }
    if ((state.control_calls ?? []).some(call => call.status === 'unknown') || state.receipts.some(receipt => receipt.status === 'unknown')) { this.failManagementOccurrence(taskId, 'unknown'); return; }
    const skipped = state.receipts.some(receipt => receipt.status === 'skipped')
      || (state.control_calls ?? []).some(call => ['failed','rejected'].includes(call.status)) || !state.enabled;
    this.store.transaction(() => {
      closeManagementExecution(state, { status: skipped ? 'skipped' : 'succeeded', finished_at: managementTime(this) });
      if (state.pending_signal.origin === 'append') state.enabled = state.enabled && state.pending_signal.restore_enabled;
      state.pending_signal = null;
      state.consumed = state.mode === 'once';
      if (state.consumed) state.enabled = false;
      state.state = state.enabled ? 'waiting' : state.consumed ? state.last_execution.status : 'stopped';
      state.reason = state.enabled ? '等待下一信号。' : state.consumed ? '一次性绑定已执行，不自动重放。' : '绑定已停用。';
      saveManagement(this, taskId, state);
      this.store.update(taskId, { status: TERMINAL.has(task.status) ? task.status : state.consumed ? 'completed' : 'waiting' });
      this.store.event(taskId, 'management.settled', { occurrence_id: state.last_execution.id, status: state.last_execution.status });
    });
    this.kick();
  },

  failManagementOccurrence(taskId, outcome = 'failed', error = null) {
    const task = this.store.task(taskId), state = managementState(task);
    // A later Provider exception must not downgrade an already durable unknown effect to failed,
    // replace its receipt diagnostics, or emit a second occurrence-failure decision.
    if (!state || state.emergency || (!state.enabled && ['failed','unknown'].includes(state.state))) return;
    this.store.transaction(() => {
      const diagnostic = safeInvocationMessage(error);
      state.enabled = false; state.state = outcome;
      state.reason = outcome === 'unknown' ? unknownReason : diagnostic ? `${diagnostic}\n${failureAction}` : failedReason;
      this.revokeManagementCapabilities(task.id, state);
      for (const receipt of state.receipts) if (receipt.status === 'waiting') {
        receipt.status = 'skipped'; receipt.reason = '管理授权已停止。';
        if (receipt.diagnostic) capabilityDiagnostic(this, task.id, receipt, 'preflight_rejected', 'authorization', 'not_started', 'trusted_pre_dispatch');
        this.store.event(task.id, 'management.action_skipped', { occurrence_id: receipt.occurrence_id, ...receipt });
      }
      if (state.pending_signal) closeManagementExecution(state, { status: outcome,
        finished_at: managementTime(this), reason: state.reason });
      // Keep the original pending identity in unknown/failed diagnostics, but it can never be admitted again.
      saveManagement(this, taskId, state);
      this.store.update(taskId, { status: task.status === 'cancelled' ? 'cancelled' : 'failed', error: state.reason });
      this.store.event(taskId, `management.${outcome}`, { occurrence_id: state.pending_signal?.id ?? null, reason: state.reason });
    });
  },

  recoverManagementWorkers() {
    for (const task of this.store.all(`SELECT id,worker_number,management FROM tasks WHERE task_kind='management'
      AND (json_extract(management,'$.pending_signal') IS NOT NULL OR json_extract(management,'$.emergency.status')='stopping') ORDER BY id`)) {
      try {
        // Recovery is atomic per identity. A failed save must leave its original
        // state/receipts intact, not prevent recovery of the remaining project.
        this.store.transaction(() => this.recoverManagementWorker(task.id));
      } catch {
        (this.managementRecoveryBlocked ??= new Set()).add(task.id);
        const reason = '管家启动恢复无法持久化；原始状态与收据已保留，未重放操作。请核对管理执行记录并由用户处理。';
        try {
          this.store.transaction(() => {
            this.store.update(task.id, { status: 'failed', error: reason });
            this.store.event(task.id, 'management.recovery_failed', { reason, effect: 'unknown', replayed: false });
          });
        } catch { /* A broken Store must not erase the original state or trigger replay. */ }
        console.error(`Valet ${workerLabel(task)}: ${reason}`);
      }
    }
  },

  recoverManagementWorker(taskId) {
    const task = this.store.task(taskId);
    this.recoverManagementCapabilities(task.id);
    const state = managementState(this.store.task(task.id));
    if (state.emergency) { this.settleManagementEmergency(task.id); return; }
    if (!state.pending_signal || ['failed','unknown'].includes(state.state)) return;
    let unknown = (state.control_calls ?? []).some(call => call.status === 'unknown');
    for (const receipt of state.receipts) if (receipt.status === 'running') {
      const proof = this.store.get(`SELECT id FROM events WHERE task_id=? AND type='management.action_completed'
        AND json_extract(data,'$.receipt_id')=? AND json_extract(data,'$.occurrence_id')=?
        AND json_extract(data,'$.target_id')=? AND json_extract(data,'$.action')=? LIMIT 1`,
        task.id, receipt.receipt_id, state.pending_signal.id, receipt.target_id, receipt.action);
      if (proof) receipt.status = 'succeeded';
      else { receipt.status = 'unknown'; receipt.reason = unknownReason; unknown = true; }
      if (receipt.diagnostic) capabilityDiagnostic(this, task.id, receipt, proof ? 'succeeded' : 'completion_not_observed', 'recovery',
        proof ? 'applied' : 'unknown', proof ? 'completion_saved' : 'completion_not_observed');
    }
    if (state.pending_signal.phase === 'question') {
      const question = this.store.get('SELECT status FROM notices WHERE id=? AND task_id=?', state.pending_signal.question_notice_id, task.id);
      if (!question) unknown = true;
      else if (question.status !== 'open') {
        if (!unknown && this.resumeManagementQuestion(task.id, state.pending_signal.question_notice_id)) return;
        unknown = true;
      }
      else this.store.update(task.id, { status: 'awaiting' });
    }
    if (state.pending_signal.phase === 'started') {
      const proof = this.store.get(`SELECT r.id FROM agent_runs r JOIN events e ON e.task_id=r.task_id
        WHERE r.id=? AND r.task_id=? AND r.status='completed' AND e.type='invocation.completed'
        AND json_extract(e.data,'$.run_id')=r.id LIMIT 1`, state.pending_signal.run_id, task.id);
      if (proof) state.pending_signal.phase = 'returned'; else unknown = true;
    }
    if (unknown) {
      saveManagement(this, task.id, state); this.failManagementOccurrence(task.id, 'unknown'); return;
    }
    saveManagement(this, task.id, state);
    if (state.pending_signal.phase === 'pending' && state.enabled) this.store.update(task.id, { status: 'queued' });
    else if (state.pending_signal.phase === 'returned') {
      this.store.update(task.id, { status: 'waiting' }); this.settleManagementOccurrence(task.id);
    }
  },
};
