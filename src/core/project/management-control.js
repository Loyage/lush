import { check, id, isPlainObject } from '../types.js';
import { hookRevision } from '../hooks.js';
import { questionnaire } from '../questionnaire.js';
import { workerLabel } from '../worker-number.js';
import { assertManager } from './management-auth.js';
import { MANAGEMENT_LIMITS, MANAGEMENT_READ_ITEMS, managementState, saveManagement, managementTime } from './management-data.js';
import { managementCatalog, effectiveManagementPolicy, validateManagementCall, managementDispatchParams } from '../../rpc/management-policy.js';
import { hasManagementConfirmation } from './management-code.js';

const unresolved = new Set(['pending_confirmation','approved','running']);
export const managementControlPending = state => (state.control_calls ?? []).some(call => unresolved.has(call.status));
const safeFailure = '管理操作未确认完成；检查现场，不自动重放。';
class ManagementPermissionError extends Error {}
function executionAuthorization(project, task, call) {
  const authorization = project.managementPermissionsSnapshot();
  const policy = effectiveManagementPolicy(call.method, authorization);
  if (policy.access === 'unavailable') throw new ManagementPermissionError('最新项目权限禁止此未开始操作；请调整权限后新建请求，不自动重放。');
  if (policy.access === 'confirmation' && !hasManagementConfirmation(project, task.id, call))
    throw new ManagementPermissionError('最新项目权限要求重新精确确认；此操作未开始，请新建请求。');
  validateManagementCall(call.method, call.params, task.goal, authorization);
  return { ...authorization, permissions: { [call.method]: policy.access } };
}
function closePolicyNotice(project, taskId, call) {
  if (!call.notice_id) return;
  project.store.run("UPDATE notices SET status='dismissed',answer='project management permissions changed' WHERE id=? AND task_id=? AND status='open'", call.notice_id, taskId);
  project.store.run(`UPDATE messages SET consumed=1 WHERE task_id=? AND sender_id IS NULL AND consumed=0
    AND CASE WHEN json_valid(body) THEN json_extract(body,'$.notice_id') END=?`, taskId, call.notice_id);
}
function trackControlJob(project, taskId, job) {
  project.managementControlJobs ??= new Set();
  project.managementControlOwners ??= new Map();
  project.managementControlOwners.set(taskId, (project.managementControlOwners.get(taskId) ?? 0) + 1);
  const tracked = job.finally(() => {
    const remaining = project.managementControlOwners.get(taskId) - 1;
    if (remaining) project.managementControlOwners.set(taskId, remaining);
    else project.managementControlOwners.delete(taskId);
    project.managementControlJobs.delete(tracked);
    project.settleManagementOccurrence(taskId);
    const signal = managementState(project.store.task(taskId))?.pending_signal;
    if (!remaining && (!signal || signal.phase === 'pending')) project.kick();
  });
  project.managementControlJobs.add(tracked);
  tracked.catch(() => {});
  return tracked;
}
const requestKey = value => check(value === undefined || (typeof value === 'string' && value.length > 0 && value.length <= 128
  && value === value.trim() && !/[\x00-\x1f\x7f]/.test(value)), 'invalid management request_id');
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  return isPlainObject(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
}
function callView(call) {
  return { receipt_id: call.receipt_id, method: call.method, status: call.status,
    ...(call.notice_id ? { notice_id: call.notice_id } : {}), ...(call.reason ? { reason: call.reason } : {}),
    ...(call.result === undefined ? {} : { result: call.result }) };
}
async function resourcePreflight(project, method, params) {
  const targetId = method === 'worker.spawn' ? params.parent : params.id;
  const root = method.startsWith('worker.') && Number.isSafeInteger(targetId) ? project.store.task(targetId) : null;
  const tasks = root ? project.subtreeTasks(root.id) : [];
  check(tasks.length <= 200, 'management resource preflight exceeds 200 Workers');
  check(!root || root.task_kind !== 'management', 'management agents cannot mutate management identities');
  const rows = [];
  for (const task of tasks) {
    let tip = null, dirty = null;
    if (task.branch) tip = await project.workspaces.git(project.config.project, 'rev-parse', '--verify', `refs/heads/${task.branch}^{commit}`).catch(() => null);
    if (task.workspace) dirty = await project.workspaces.git(task.workspace, 'status', '--porcelain', '--untracked-files=all').catch(() => 'unavailable');
    rows.push({ id: task.id, worker_number: task.worker_number, status: task.status, integration: task.integration,
      head: task.head_commit, branch: task.branch, target_branch: task.target_branch, workspace: task.workspace,
      parent_id: task.parent_id, task_kind: task.task_kind, reservation: task.reservation, interrupt: task.interrupt_state,
      freeze: task.branch ? project.branchFreeze(task.branch) : null, syncing: Boolean(project.taskSyncBusy?.has(task.id)), tip, dirty,
      live: project.running.has(task.id),
      unread: project.store.get('SELECT count(*) AS n FROM messages WHERE task_id=? AND consumed=0', task.id).n,
      open: project.store.get("SELECT count(*) AS n FROM notices WHERE task_id=? AND status='open'", task.id).n });
  }
  let branch = null;
  if (method === 'branch.archive') {
    check(typeof params.branch === 'string', 'branch must be explicit');
    branch = (await project.branchArchivability([params.branch])).get(params.branch) ?? null;
  }
  return { fingerprint: hookRevision({ rows, branch }), summary: {
    workers: rows.map(({ id, worker_number, status, integration, dirty, live, unread, open }) => ({ id, worker_number,
      status, integration, dirty: dirty === null ? 'not_inspected' : dirty === 'unavailable' ? 'unknown' : dirty.length > 0,
      active_invocation: live, unread_inputs: unread, open_decisions: open })),
    ...(branch ? { branch } : {}),
    note: '只读预检，不执行回收、不清除脏现场；执行时再次核验并通过原安全引擎。' } };
}
function targetSnapshot(project, method, params) {
  const targetId = method === 'worker.spawn' && Number.isSafeInteger(params.parent) ? params.parent
    : method.startsWith('worker.') && Number.isSafeInteger(params.id) ? params.id
    : Number.isSafeInteger(params.worker_id) ? params.worker_id : null;
  if (!targetId) return null;
  const task = project.store.task(targetId);
  return hookRevision({ id: task.id, status: task.status, integration: task.integration, head: task.head_commit,
    base: task.base_commit, workspace: task.workspace, branch: task.branch, parent_id: task.parent_id,
    updated_at: task.updated_at, calls: task.calls, reservation: task.reservation, interrupt: task.interrupt_state });
}
// This is a second, deliberately conservative exit. The ordinary user config APIs are not credential-safe.
export function managementSafeResult(value, limits = {}) {
  const blocked = new Set(['retry_profile','agent_token','agent_token_hash','token','credential','credentials','authorization',
    'env','values','default_prompt','append_prompt','prompt','agent_config','raw','session_path','session','config']);
  function clean(entry, depth = 0) {
    if (depth > 20) { limits.truncated = true; return null; }
    if (typeof entry === 'string') { if (entry.length > 4000) limits.truncated = true; return entry.slice(0, 4000); }
    if (!entry || typeof entry !== 'object') return entry;
    if (Array.isArray(entry)) { if (entry.length > MANAGEMENT_READ_ITEMS) limits.truncated = true; return entry.slice(0, MANAGEMENT_READ_ITEMS).map(item => clean(item, depth + 1)); }
    return Object.fromEntries(Object.entries(entry).filter(([key, child]) => !blocked.has(key)
      && !(['hooks','auto_merge','management'].includes(key) && typeof child === 'string'))
      .map(([key, child]) => [key, clean(child, depth + 1)]));
  }
  const result = clean(value);
  check(Buffer.byteLength(JSON.stringify(result) ?? 'null') <= 100000, 'management result exceeds safe response limit');
  return result;
}

export default {
  submitManagementInstruction(options) {
    check(isPlainObject(options) && Object.keys(options).every(key => ['instruction','profile','client_request_id'].includes(key)),
      'invalid management submit fields');
    const task = this.createManagementWorker({ ...options, name: '管理输入', signal_id: null });
    this.kick();
    return { management: true, task };
  },

  managementCapabilityCatalog(actorId) {
    assertManager(this, actorId);
    return managementCatalog(this.managementPermissionsSnapshot());
  },

  managementHistory(actorId, options = {}) {
    this.assertManagementPermission(actorId, 'manager.history');
    check(isPlainObject(options) && Object.keys(options).every(key => ['id','before','limit'].includes(key)), 'invalid management history fields');
    const limit = options.limit ?? 30;
    check(Number.isSafeInteger(limit) && limit > 0 && limit <= 100, 'history limit must be 1..100');
    const before = options.before === undefined ? null : id(options.before);
    const target = options.id === undefined ? null : id(options.id);
    if (target !== null) this.store.task(target);
    const conditions = [], args = [];
    if (before !== null) { conditions.push('r.id<?'); args.push(before); }
    if (target !== null) { conditions.push('r.task_id=?'); args.push(target); }
    const rows = this.store.all(`SELECT r.id,r.task_id,t.worker_number,r.role,r.provider,r.model,r.thinking,r.status,r.started_at,r.ended_at,
      (SELECT count(*) FROM events e WHERE e.task_id=r.task_id AND e.created_at>=r.started_at
        AND (r.ended_at IS NULL OR e.created_at<=r.ended_at)) AS event_count
      FROM agent_runs r LEFT JOIN tasks t ON t.id=r.task_id ${conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''}
      ORDER BY r.id DESC LIMIT ?`, ...args, limit + 1);
    return { items: rows.slice(0, limit).map(row => ({ ...row,
      duration_ms: row.ended_at ? Math.max(0, Date.parse(row.ended_at) - Date.parse(row.started_at)) : null })),
      next_cursor: rows.length > limit ? rows[limit - 1].id : null,
      scope: 'current_project', coverage: '调用状态、耗时、模型与事件数量；不读取原始提示词、工具参数、输出、凭证或会话文件。' };
  },

  async callManagementCapability(actorId, method, params = {}, requestId = undefined) {
    this.assertWritable('request a management capability');
    const { task } = assertManager(this, actorId);
    requestKey(requestId);
    let policy = validateManagementCall(method, params, task.goal, this.managementPermissionsSnapshot());
    if (method === 'worker.spawn') {
      check(params.parent !== undefined, 'Valet delegation requires an explicit development parent');
      check(['order','child'].includes(this.store.task(id(params.parent)).task_kind), 'Valet can only delegate under a development Worker');
    }
    if (method === 'worker.message' || method === 'worker.accept') {
      check(['order','child'].includes(this.store.task(id(params.id)).task_kind), 'Valet collaboration requires a development Worker');
    }
    if (method === 'notice.post') check(params.task === undefined || id(params.task) === actorId,
      'Valet may post decision notices only for itself');
    const lifecycleAction = method === 'worker.resume' ? 'start' : method === 'worker.retry' ? 'retry' : null;
    if (lifecycleAction) check(Object.keys(params).length === 1 && Object.hasOwn(params, 'id'),
      'management start/retry requires only id and preserves saved configuration');
    if (['notice.answer','notice.dismiss'].includes(method) && Number.isSafeInteger(params.id)) {
      const decision = this.store.get('SELECT n.id,t.task_kind FROM notices n JOIN tasks t ON t.id=n.task_id WHERE n.id=?', params.id);
      check(decision?.task_kind !== 'management', 'management confirmations require the user interface, not another management capability');
    }
    check(typeof this.managementDispatch === 'function', 'trusted management dispatcher is unavailable');
    const copied = canonical(JSON.parse(JSON.stringify(params))), fingerprint = hookRevision({ method, params: copied });
    check(policy.access !== 'confirmation' || JSON.stringify(copied, null, 2).length <= 6500,
      'confirmation parameters exceed readable preview limit');
    if (policy.access === 'read') {
      // Do not ask the user-facing status handler for private full configuration.
      const result = method === 'system.status' ? this.status(false)
        : method === 'manager.catalog' ? this.managementCapabilityCatalog(actorId)
        : method === 'manager.query' ? this.managementQuery(actorId, copied.id)
        : method === 'manager.history' ? this.managementHistory(actorId, copied)
        : await this.managementDispatch(method, copied, actorId);
      assertManager(this, actorId);
      const limits = {};
      return { status: 'succeeded', method, result: managementSafeResult(result, limits),
        ...(limits.truncated ? { truncated: true, coverage: 'bounded_management_projection' } : {}) };
    }
    let state = managementState(this.store.task(task.id));
    const key = requestId ?? fingerprint;
    const previous = (state.control_calls ?? []).find(call => call.request_id === key && call.occurrence_id === state.pending_signal.id);
    if (previous) {
      check(previous.fingerprint === fingerprint, 'request_id already refers to different management parameters');
      return callView(previous);
    }
    check((state.control_calls?.length ?? 0) + state.receipts.length < MANAGEMENT_LIMITS.actions, 'management occurrence action limit reached');
    if (method === 'worker.delete') {
      const preview = await this.deleteTaskPreview(id(copied.id), { force: copied.force === true });
      check(preview.can_delete && copied.revision === preview.revision && copied.confirm === true,
        'delete requires the current resource preview and exact revision with confirm:true');
    }
    let preflight = policy.access === 'confirmation' ? await resourcePreflight(this, method, copied) : null;
    // Delete/resource preflight can yield across a project permission update.
    policy = validateManagementCall(method, copied, task.goal, this.managementPermissionsSnapshot());
    if (policy.access === 'confirmation' && !preflight) preflight = await resourcePreflight(this, method, copied);
    policy = validateManagementCall(method, copied, task.goal, this.managementPermissionsSnapshot());
    check(policy.access !== 'confirmation' || JSON.stringify(copied, null, 2).length <= 6500,
      'confirmation parameters exceed readable preview limit');
    const snapshot = targetSnapshot(this, method, copied);
    assertManager(this, actorId);
    state = managementState(this.store.task(task.id));
    // Re-read after asynchronous preflight so parallel model tool calls cannot overwrite each other.
    const duplicate = (state.control_calls ?? []).find(call => call.request_id === key && call.occurrence_id === state.pending_signal.id);
    if (duplicate) { check(duplicate.fingerprint === fingerprint, 'request_id already refers to different management parameters'); return callView(duplicate); }
    check((state.control_calls?.length ?? 0) + state.receipts.length < MANAGEMENT_LIMITS.actions, 'management occurrence action limit reached');
    let call;
    this.store.transaction(() => {
      const receiptId = this.store.event(task.id, 'management.capability_requested', { method, access: policy.access,
        occurrence_id: state.pending_signal.id, fingerprint });
      call = { receipt_id: receiptId, method, params: copied, fingerprint, request_id: key,
        occurrence_id: state.pending_signal.id, target_snapshot: snapshot, preflight_fingerprint: preflight?.fingerprint ?? null,
        status: policy.access === 'confirmation' ? 'pending_confirmation' : 'approved', created_at: managementTime(this) };
      state.control_calls ??= []; state.control_calls.push(call);
      if (policy.access === 'confirmation') {
        check(!this.questionPending(task.id), 'another management confirmation is already pending; finish it first');
        const title = `Valet ${workerLabel(task)} 操作确认：${method}`;
        const previewText = JSON.stringify(preflight?.summary ?? {}, null, 2);
        check(previewText.length <= 2500 && previewText.length + JSON.stringify(copied, null, 2).length <= 7200,
          'management preflight summary exceeds confirmation limit; use the user interface');
        const body = questionnaire(`Valet ${workerLabel(task)} 请求执行 ${method}。确认仅授权以下固定参数；目标发生变化会拒绝执行。\n\n${JSON.stringify(copied, null, 2)}\n\n只读预检：\n${previewText}\n\n资源回收、终态操作、设置或服务变化可能不可逆。`,
          [{ header: '操作授权', question: `是否授权 Valet ${workerLabel(task)} 执行本次 ${method}？`, options: [
            { label: '拒绝此次操作（推荐）', description: '不执行，保留管理诊断及请求收据。' },
            { label: '批准上述精确操作', description: '只执行本次固定参数；仍须通过原生命周期、资源与权限安全门。' },
          ] }]);
        const row = this.store.run("INSERT INTO notices(task_id,title,body,kind,source_event_id) VALUES (?,?,?,'questionnaire',?)",
          task.id, title, body, receiptId);
        call.notice_id = Number(row.lastInsertRowid);
        this.store.event(task.id, 'notice.opened', { notice_id: call.notice_id, title, kind: 'questionnaire', management_receipt_id: receiptId });
      }
      saveManagement(this, task.id, state);
    });
    if (call.status === 'approved') await this.executeManagementCapability(task.id, call.receipt_id);
    return callView(managementState(this.store.task(task.id)).control_calls.find(item => item.receipt_id === call.receipt_id));
  },

  /** Withdraw only unstarted effects. Running/unknown receipts remain deletion and lane barriers. */
  revokeManagementCapabilities(taskId, state) {
    for (const call of state.control_calls ?? []) if (['pending_confirmation','approved'].includes(call.status)) {
      call.status = 'rejected'; call.reason = '用户已停止管理授权，未执行的操作已撤销。';
      if (call.notice_id) {
        this.store.run("UPDATE notices SET status='dismissed',answer='management authorization stopped' WHERE id=? AND task_id=? AND status='open'", call.notice_id, taskId);
        this.store.run(`UPDATE messages SET consumed=1 WHERE task_id=? AND sender_id IS NULL AND consumed=0
          AND CASE WHEN json_valid(body) THEN json_extract(body,'$.notice_id') END=?`, taskId, call.notice_id);
      }
      this.store.event(taskId, 'management.capability_revoked', { receipt_id: call.receipt_id, notice_id: call.notice_id ?? null });
    }
  },

  isManagementConfirmationNotice(noticeId) {
    try {
      const notice = this.store.get(`SELECT n.id,n.task_id,n.kind,n.source_event_id,e.type,e.data,t.task_kind,t.role
        FROM notices n JOIN tasks t ON t.id=n.task_id
        JOIN events e ON e.id=n.source_event_id AND e.task_id=n.task_id WHERE n.id=?`, id(noticeId));
      if (!notice || notice.kind !== 'questionnaire' || notice.task_kind !== 'management' || notice.role !== 'manager'
        || notice.type !== 'management.capability_requested') return false;
      const state = managementState(this.store.task(notice.task_id)), event = JSON.parse(notice.data);
      return (state?.control_calls ?? []).some(call => call.notice_id === notice.id
        && call.receipt_id === notice.source_event_id && call.method === event.method && call.fingerprint === event.fingerprint);
    } catch { return false; }
  },

  // The Notice boundary needs a synchronous recognition result to avoid waking
  // a model to execute a user-confirmed operation. Async ownership stays explicit.
  resolveManagementConfirmation(noticeId) {
    if (!this.isManagementConfirmationNotice(noticeId)) return false;
    const notice = this.store.get('SELECT task_id,status FROM notices WHERE id=?', noticeId);
    if (notice.status === 'open') return true; // Await the real user event, not a no-op async job/pump loop.
    const job = this.resolveManagementConfirmationUnsafe(noticeId).catch(() => {
      try {
        const notice = this.store.get('SELECT task_id FROM notices WHERE id=?', noticeId);
        const state = notice ? managementState(this.store.task(notice.task_id)) : null;
        const call = state?.control_calls?.find(item => item.notice_id === noticeId);
        if (call && unresolved.has(call.status)) {
          call.status = call.status === 'running' ? 'unknown' : 'failed'; call.reason = safeFailure;
          saveManagement(this, notice.task_id, state);
          this.settleManagementOccurrence(notice.task_id);
        }
      } catch { /* Shutdown/closed Store cannot be used to replay an operation. */ }
    });
    trackControlJob(this, notice.task_id, job);
    return true;
  },

  async resolveManagementConfirmationUnsafe(noticeId) {
    const notice = this.store.get('SELECT * FROM notices WHERE id=?', id(noticeId));
    if (!notice || notice.status === 'open') return false;
    const task = this.store.task(notice.task_id), state = managementState(task);
    const call = state?.control_calls?.find(item => item.notice_id === notice.id && item.status === 'pending_confirmation');
    if (!call) return false;
    let answer;
    try { answer = JSON.parse(notice.answer); } catch { answer = null; }
    const choice = answer?.answers?.[0];
    const approved = notice.status === 'answered' && notice.answer_source === 'user'
      && choice?.selected?.length === 1 && choice.selected[0] === 1 && !choice.custom;
    call.status = approved && state.enabled ? 'approved' : 'rejected';
    call.reason = call.status === 'approved' ? null : '用户未批准精确操作，或管理授权已停止。';
    this.store.transaction(() => {
      saveManagement(this, task.id, state);
      // The runtime has handled this exact answer. Keep its Message history, but
      // never deliver a prior operation authorization to a later manager model run.
      this.store.run(`UPDATE messages SET consumed=1 WHERE task_id=? AND sender_id IS NULL AND consumed=0
        AND CASE WHEN json_valid(body) THEN json_extract(body,'$.notice_id') END=?`, task.id, notice.id);
      this.store.event(task.id, 'management.capability_confirmation', { receipt_id: call.receipt_id, notice_id: notice.id, status: call.status });
    });
    if (call.status === 'approved') await this.executeManagementCapability(task.id, call.receipt_id);
    this.settleManagementOccurrence(task.id);
    return true;
  },

  executeManagementCapability(taskId, receiptId) {
    return trackControlJob(this, taskId, this.executeManagementCapabilityUnsafe(taskId, receiptId));
  },

  async executeManagementCapabilityUnsafe(taskId, receiptId) {
    this.managementControlBusy ??= new Set();
    if (this.managementControlBusy.has(receiptId)) return;
    let task = this.store.task(taskId), state = managementState(task);
    let call = state?.control_calls?.find(item => item.receipt_id === receiptId);
    if (this.managementOccupant()?.id !== taskId || !state?.enabled || !state.pending_signal || call?.status !== 'approved'
      || call.occurrence_id !== state.pending_signal.id) return;
    if (this.stopping || this.maintenancePaused() || this.clearing || this.workerDeleteIds?.size || this.settingsMigrationApplying) return;
    this.managementControlBusy.add(receiptId);
    try {
      check(typeof this.managementDispatch === 'function', 'trusted management dispatcher is unavailable');
      executionAuthorization(this, task, call);
      check(call.fingerprint === hookRevision({ method: call.method, params: canonical(call.params) }), 'fixed management parameters changed');
      check(call.target_snapshot === targetSnapshot(this, call.method, call.params), 'management target changed; request a new confirmation');
      if (call.preflight_fingerprint) {
        const checked = await resourcePreflight(this, call.method, call.params);
        check(checked.fingerprint === call.preflight_fingerprint, 'management resources changed; request a new confirmation');
      }
      // Async Git preflight may cross a shutdown/maintenance boundary. Leave an
      // unstarted approval durable for the existing timer/recovery gate, not replay.
      if (this.stopping || this.maintenancePaused() || this.clearing || this.workerDeleteIds?.size || this.settingsMigrationApplying) return;
      const action = call.method === 'worker.resume' ? 'start' : call.method === 'worker.retry' ? 'retry' : null;
      const result = await this.write('execute confirmed management capability', () => {
        // Authorization becomes fixed inside the write admission boundary. An
        // asynchronous preflight or queued writer must not turn stale approval into authority.
        task = this.store.task(taskId); state = managementState(task);
        call = state?.control_calls?.find(item => item.receipt_id === receiptId);
        check(state?.enabled && call?.status === 'approved' && state.pending_signal
          && call.occurrence_id === state.pending_signal.id && this.managementOccupant()?.id === taskId,
          'management authorization is no longer active');
        check(!this.stopping && !this.maintenancePaused(), 'management execution is paused');
        const authorization = executionAuthorization(this, task, call);
        check(call.fingerprint === hookRevision({ method: call.method, params: canonical(call.params) }), 'fixed management parameters changed');
        check(call.target_snapshot === targetSnapshot(this, call.method, call.params), 'management target changed during preflight');
        call.execution_authorization = authorization;
        call.status = 'running'; call.started_at = managementTime(this); saveManagement(this, taskId, state);
        this.store.event(taskId, 'management.capability_started', { receipt_id: receiptId, method: call.method });
        return action ? this.submitManagementAction(taskId, action, call.params.id, receiptId)
          : this.managementDispatch(call.method, managementDispatchParams(call.method, call.params), taskId, receiptId);
      });
      // Another asynchronous tool/confirmation may have appended a receipt while this operation ran.
      state = managementState(this.store.task(taskId)); call = state.control_calls.find(item => item.receipt_id === receiptId);
      call.status = 'succeeded'; call.finished_at = managementTime(this);
      // Mutations return only a narrow receipt, not user-only config or destructive result payloads.
      call.result = { submitted: true, ...(action ? { action: result } : {}), ...(Number.isSafeInteger(result?.id) ? { id: result.id } : {}),
        ...(Number.isSafeInteger(result?.task_id) ? { task_id: result.task_id } : {}),
        ...(typeof result?.auto_title === 'string' ? { auto_title: result.auto_title, changed: result.changed } : {}),
        ...(typeof result?.worker_number === 'string' ? { worker_number: result.worker_number } : {}),
        ...(result?.emitted === true ? { emitted: true, draft_id: result.draft_id } : {}) };
      saveManagement(this, taskId, state);
      this.store.event(taskId, 'management.capability_completed', { receipt_id: receiptId, method: call.method });
    } catch (error) {
      state = managementState(this.store.task(taskId)); call = state?.control_calls?.find(item => item.receipt_id === receiptId);
      if (call && call.status !== 'rejected') {
        call.status = call.status === 'running' ? 'unknown' : 'failed';
        call.reason = call.status === 'unknown' ? safeFailure : error instanceof ManagementPermissionError ? error.message
          : '固定参数、目标、资源或授权发生变化；操作未开始，请重新预检确认。';
        saveManagement(this, taskId, state);
        this.store.event(taskId, 'management.capability_failed', { receipt_id: receiptId, method: call.method, status: call.status });
      }
    } finally { this.managementControlBusy.delete(receiptId); this.settleManagementOccurrence(taskId); }
  },

  drainManagementCapabilities(taskId) {
    const ids = (managementState(this.store.task(taskId))?.control_calls ?? []).map(call => call.receipt_id);
    for (const receiptId of ids) {
      const state = managementState(this.store.task(taskId)), call = state.control_calls.find(item => item.receipt_id === receiptId);
      if (call.status === 'pending_confirmation') {
        const notice = this.store.get('SELECT status FROM notices WHERE id=? AND task_id=?', call.notice_id, taskId);
        const policy = effectiveManagementPolicy(call.method, this.managementPermissionsSnapshot());
        if (notice?.status === 'open' && policy.access !== 'confirmation') {
          call.status = policy.access === 'unavailable' ? 'rejected' : 'approved';
          call.reason = policy.access === 'unavailable' ? '最新项目权限禁止此未开始操作。' : null;
          this.store.transaction(() => {
            closePolicyNotice(this, taskId, call); saveManagement(this, taskId, state);
            this.store.event(taskId, 'management.capability_policy_rechecked', { receipt_id: call.receipt_id, status: call.status });
          });
          if (call.status === 'approved') void this.executeManagementCapability(taskId, call.receipt_id).catch(() => {});
        } else this.resolveManagementConfirmation(call.notice_id);
      } else if (call.status === 'approved') void this.executeManagementCapability(taskId, call.receipt_id).catch(() => {});
    }
  },

  recoverManagementCapabilities(taskId) {
    const state = managementState(this.store.task(taskId));
    for (const call of state?.control_calls ?? []) if (call.status === 'running') {
      const proof = this.store.get("SELECT id FROM events WHERE task_id=? AND type='management.capability_completed' AND json_extract(data,'$.receipt_id')=? LIMIT 1", taskId, call.receipt_id);
      call.status = proof ? 'succeeded' : 'unknown';
      if (!proof) call.reason = safeFailure;
    }
    saveManagement(this, taskId, state);
  },
};
