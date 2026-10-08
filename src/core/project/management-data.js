import { check, bounded, TERMINAL } from '../types.js';
import { hookRevision } from '../hooks.js';
import { workerModelSelection } from './internal.js';

export const MANAGEMENT_LIMITS = Object.freeze({ signals: 64, active: 64, actions: 32, bytes: 128 * 1024, readBytes: 512 * 1024 });
export const managementState = task => task.management ? JSON.parse(task.management) : null;
export const managementTime = project => new Date(project.hookClock()).toISOString();
export const managementRevision = (task, state = managementState(task)) => hookRevision({ id: task.id, revision: state?.config_revision ?? 0 });
export function saveManagement(project, taskId, state) {
  const encoded = JSON.stringify(state);
  check(Buffer.byteLength(encoded) <= MANAGEMENT_LIMITS.bytes, 'management state exceeds 128 KiB');
  project.store.update(taskId, { management: encoded });
}
export function managementModel(project, task) {
  // A test/offline provider need not have configurable roles. The real role is added by the provider adapter.
  if (!task.retry_profile && project.config.provider === 'mock') return { agent: 'mock', config_mode: 'lush', connection_id: null,
    model: '', thinking: '', explicit: false };
  try { return workerModelSelection(project, task); } catch { return null; }
}
export function managementEnableReason(project, task, state = managementState(task)) {
  if (!state || task.role !== 'manager' || task.task_kind !== 'management') return '不是管理型 Worker。';
  if (TERMINAL.has(task.status) || state.consumed || ['failed','unknown'].includes(state.state))
    return '一次性已消费或管理调用已中断；请另建管理指令，不重放旧授权。';
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
  const execution = value => value ? { id: value.id, signal_id: value.signal_id, name: value.name, due_at: value.due_at,
    submitted_at: value.submitted_at, started_at: value.started_at ?? null, finished_at: value.finished_at ?? null,
    status: value.status ?? state.state, ...(value.reason ? { reason: value.reason } : {}),
    actions: (value.actions ?? []).map(action => ({ receipt_id: action.receipt_id, action: action.action, target_id: action.target_id,
      target_worker_number: action.target_worker_number ?? null, status: action.status, ...(action.reason ? { reason: action.reason } : {}) })) } : null;
  const enableReason = managementEnableReason(project, task, state);
  return { version: 1, revision: managementRevision(task, state), signal_id: state.signal_id, mode: state.mode,
    enabled: state.enabled, can_enable: enableReason === null, state: state.state,
    reason: !state.enabled && enableReason ? enableReason : state.reason ?? null,
    pending_signal: execution(state.pending_signal ? { ...state.pending_signal, actions: state.receipts } : null),
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
    actions: actions.slice(0, 2).map(action => ({ ...action, reason: compactText(action.reason, 96),
      target_worker_number: action.target_worker_number?.length > 128 ? null : action.target_worker_number,
      ...(action.target_worker_number?.length > 128 ? { target_worker_number_truncated: true } : {}) })) };
}
function compactWorker(project, task) {
  const view = managementView(task, project), model = managementModel(project, task);
  return { id: task.id, name: compactText(task.name, 64), goal: compactText(task.goal, 160),
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
