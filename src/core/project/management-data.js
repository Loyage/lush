import { check, bounded, TERMINAL } from '../types.js';
import { hookRevision } from '../hooks.js';
import { workerModelSelection } from './internal.js';

export const MANAGEMENT_LIMITS = Object.freeze({ signals: 64, active: 64, actions: 32, bytes: 128 * 1024, readBytes: 512 * 1024 });
// Typed paginated projections must clip before choosing cursors, using the same
// array budget as the final generic management safety exit.
export const MANAGEMENT_READ_ITEMS = 100;
export const managementState = task => task.management ? JSON.parse(task.management) : null;
export const managementTime = project => new Date(project.hookClock()).toISOString();
// New user input authorizes only this occurrence, not the original instruction's device scope.
export function managementInstruction(project, task, state = managementState(task)) {
  if (state?.pending_signal?.origin !== 'append') return task.goal;
  const message = project.store.get('SELECT body FROM messages WHERE id=? AND task_id=? AND sender_id IS NULL',
    state.pending_signal.message_id, task.id);
  check(message, 'management append instruction is missing; do not replay the original instruction');
  return message.body;
}
export function managementAppendReason(project, task, state = managementState(task)) {
  if (task.role !== 'manager' || task.task_kind !== 'management' || !state) return '不是有效的管家身份。';
  if (state.emergency) return '此管家已急救隔离，旧授权永久失效；请另建管理指令。';
  if (project.store.executionRetired(task.id)) return '执行环境已退役，历史只读。';
  if (!['completed','waiting'].includes(task.status) || !['succeeded','skipped'].includes(state.last_execution?.status)
    || !state.last_execution?.started_at
    || ['failed','unknown'].includes(state.state) || state.pending_signal || managementUnsettled(project, task, state)) return '管家尚未正常结束并安全收口；失败、取消或未知操作不能通过追加恢复。';
  if (project.stopping || project.clearing || project.workerDeleteIds?.size || project.settingsMigrationApplying
    || project.taskSyncBusy?.has(task.id) || project.workspaces.busy.has(task.id)) return '项目或管家正在停止、清理或迁移，请稍后提交。';
  if (project.questionPending(task.id) || project.store.get('SELECT id FROM messages WHERE task_id=? AND consumed=0 LIMIT 1', task.id))
    return '管家仍有待决或未处理输入，请先核对记录。';
  if (project.managementOccupant()) return '当前项目已有管家排队、运行或尚未安全收口；请等待后再追加，输入尚未提交。';
  if (!state.enabled && project.store.get("SELECT count(*) AS n FROM tasks WHERE task_kind='management' AND json_extract(management,'$.enabled')=1").n >= MANAGEMENT_LIMITS.active)
    return '已达到活动管理绑定上限。';
  return null;
}
export const managementRevision = (task, state = managementState(task)) => hookRevision({ id: task.id, revision: state?.config_revision ?? 0 });
export function saveManagement(project, taskId, state) {
  const encoded = JSON.stringify(state);
  // Reserve fixed internal revocation diagnostics for the <=32 receipts plus the
  // emergency marker even on a pre-existing full state. No new user material is
  // admitted on an isolated Worker; never discard old receipts to make room.
  check(Buffer.byteLength(encoded) <= MANAGEMENT_LIMITS.bytes + (state.emergency ? 16 * 1024 : 0), 'management state exceeds 128 KiB');
  project.store.update(taskId, { management: encoded });
}
/** Runtime ownership outlives model return, disabling and terminal Worker status. */
export function managementUnsettled(project, task, state = managementState(task)) {
  if (project.running.has(task.id) || project.managementControlOwners?.has(task.id)) return true;
  if (!state) return false;
  const calls = state.control_calls ?? [], receipts = state.receipts ?? [];
  if (calls.some(call => project.managementControlBusy?.has(call.receipt_id))) return true;
  if ([...calls, ...receipts].some(item => ['running','unknown'].includes(item.status))) return true;
  if (calls.some(call => ['pending_confirmation','approved'].includes(call.status))
    || receipts.some(receipt => receipt.status === 'waiting')) return true;
  return Boolean(state.pending_signal && !['failed','unknown'].includes(state.state)
    && (state.enabled || ['started','returned'].includes(state.pending_signal.phase)));
}
export function managementModel(project, task) {
  // A test/offline provider need not have configurable roles. The real role is added by the provider adapter.
  if (!task.retry_profile && project.config.provider === 'mock') return { agent: 'mock', config_mode: 'lush', connection_id: null,
    model: '', thinking: '', explicit: false };
  try { return workerModelSelection(project, task); } catch { return null; }
}
export function managementEnableReason(project, task, state = managementState(task)) {
  if (!state || task.role !== 'manager' || task.task_kind !== 'management') return '不是 Valet。';
  if (state.emergency) return '此管家已急救隔离，旧授权永久失效；请另建管理指令。';
  if (TERMINAL.has(task.status) || state.consumed || ['failed','unknown'].includes(state.state))
    return '一次性绑定已消费或管理调用已中断，不能重新启用旧授权；正常收口后可追加新一轮，失败或未知结果须另建管理指令。';
  if (!state.enabled && (project.running.has(task.id) || state.pending_signal)) return '当前管理调用或操作尚未收口，等待实际退出后再启用。';
  if (project.stopping || project.clearing || project.workerDeleteIds?.size || project.settingsMigrationApplying
    || project.workspaces.busy.has(task.id)) return '项目或 Worker 正在停止、清理或迁移，等待安全点后再启用。';
  const signal = project.hookSignals().items.find(item => item.id === state.signal_id);
  if (!signal?.enabled || !signal.next_run_at || Date.parse(signal.next_run_at) <= project.hookClock()) return '信号没有启用的未来发生时间。';
  if (!state.enabled && project.store.get(`SELECT count(*) AS n FROM tasks WHERE task_kind='management'
    AND json_extract(management,'$.enabled')=1`).n >= MANAGEMENT_LIMITS.active) return '已达到活动管理绑定上限。';
  return null;
}
export function managementView(task, project) {
  const state = managementState(task);
  if (!state) return null;
  // Notice facts, scoped to this identity; never infer a kind from a receipt, title or status.
  const noticeIds = [...new Set([...(state.control_calls ?? []), ...(state.last_execution?.control_calls ?? [])]
    .map(call => call.notice_id).filter(value => Number.isSafeInteger(value) && value > 0))];
  const noticeKinds = new Map(noticeIds.length ? project.store.all(`SELECT id,kind FROM notices
    WHERE task_id=? AND id IN (${noticeIds.map(() => '?').join(',')})`, task.id, ...noticeIds)
    .map(row => [row.id, ['question','questionnaire','plan','info'].includes(row.kind) ? row.kind : null]) : []);
  const execution = value => value ? { id: value.id, signal_id: value.signal_id, name: value.name, due_at: value.due_at,
    submitted_at: value.submitted_at, started_at: value.started_at ?? null, finished_at: value.finished_at ?? null,
    status: value.status ?? state.state, ...(value.reason ? { reason: value.reason } : {}),
    actions: (value.actions ?? []).map(action => ({ receipt_id: action.receipt_id, action: action.action, target_id: action.target_id,
      target_worker_number: action.target_worker_number ?? null, status: action.status, ...(action.reason ? { reason: action.reason } : {}) })),
    control_calls: (value.control_calls ?? []).map(call => ({ receipt_id: call.receipt_id, method: call.method,
      status: call.status, notice_id: call.notice_id ?? null, notice_kind: noticeKinds.get(call.notice_id) ?? null,
      ...(call.reason ? { reason: call.reason } : {}) })) } : null;
  const enableReason = managementEnableReason(project, task, state);
  const appendReason = managementAppendReason(project, task, state);
  return { version: 1, revision: managementRevision(task, state), signal_id: state.signal_id, mode: state.mode,
    can_append: appendReason === null, append_reason: appendReason,
    origin: state.origin ?? 'signal',
    enabled: state.enabled, can_enable: enableReason === null, state: state.state,
    emergency: state.emergency ? { status: state.emergency.status, requested_at: state.emergency.requested_at,
      isolated_at: state.emergency.isolated_at ?? null } : null,
    reason: ['failed','unknown'].includes(state.state) ? state.reason ?? enableReason
      : !state.enabled && enableReason ? enableReason : state.reason ?? null,
    pending_signal: execution(state.pending_signal ? { ...state.pending_signal, actions: state.receipts, control_calls: state.control_calls ?? [] } : null),
    last_execution: execution(state.last_execution) };
}
// Hooks is an authorization control surface, not the full instruction/receipt reader. Compact every
// variable-size field before applying the list budget so active bindings cannot be hidden by long goals.
function compactText(value, length) { return typeof value === 'string' ? value.slice(0, length) : value; }
function compactExecution(execution) {
  if (!execution) return null;
  const actions = execution.actions ?? [];
  return { ...execution, name: compactText(execution.name, 64), reason: compactText(execution.reason, 128),
    actions_count: actions.length, actions_truncated: actions.length > 2,
    control_calls_count: execution.control_calls?.length ?? 0, control_calls_truncated: (execution.control_calls?.length ?? 0) > 2,
    control_calls: (execution.control_calls ?? []).slice(0, 2),
    actions: actions.slice(0, 2).map(action => ({ ...action, reason: compactText(action.reason, 96),
      target_worker_number: action.target_worker_number?.length > 128 ? null : action.target_worker_number,
      ...(action.target_worker_number?.length > 128 ? { target_worker_number_truncated: true } : {}) })) };
}
function compactWorker(project, task) {
  const view = managementView(task, project), model = managementModel(project, task);
  return { id: task.id, worker_number: task.worker_number ?? null, name: compactText(task.name, 64), goal: compactText(task.goal, 160),
    goal_truncated: task.goal.length > 160, goal_length: task.goal.length, status: task.status,
    management: { ...view, reason: compactText(view.reason, 160),
      pending_signal: compactExecution(view.pending_signal), last_execution: compactExecution(view.last_execution) },
    model_selection: model ? { ...model, model: compactText(model.model, 128), thinking: compactText(model.thinking, 64) } : null };
}
export function managementWorkers(project) {
  // Keep enabled bindings visible before bounded recent history; never scan provider sessions or profiles.
  const enabled = project.store.all(`SELECT * FROM tasks WHERE task_kind='management'
    AND json_extract(management,'$.enabled')=1 ORDER BY id DESC LIMIT ?`, MANAGEMENT_LIMITS.active);
  const recent = project.store.all(`SELECT * FROM tasks WHERE task_kind='management' AND management IS NOT NULL ORDER BY id DESC LIMIT 100`);
  const rows = [...new Map([...enabled, ...recent].map(task => [task.id, task])).values()].slice(0, 100);
  return bounded(rows.map(task => compactWorker(project, task)), MANAGEMENT_LIMITS.readBytes);
}
