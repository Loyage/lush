// One browser whitelist for both visible summaries and copied diagnostics. Never
// trust an exception/reason string, nested params/output, or a supplied link URL.
export const positiveDiagnosticId = value => Number.isSafeInteger(value) && value > 0;
const positive = positiveDiagnosticId;
const numbered = value => typeof value === 'string' && value.length <= 128 && /^(?:W[1-9]\d*(?:-[1-9]\d*)*|V[1-9]\d*)$/.test(value) ? value : null;
const method = value => typeof value === 'string' && /^[a-z_]+\.[a-z_]+$/.test(value) && value.length <= 128 ? value : null;
const stages = { admission: '请求准入', parameters: '参数校验', authorization: '授权校验', preflight: '执行前核验', execution: '执行回调', completion: '完成处理', persistence: '保存完成证据', return: '返回结果', recovery: '恢复核查', legacy: '未采集' };
const effects = { not_started: '未开始（有可信证据）', applied: '该方法已生效（不代表后续工作完成）', unknown: '未确认，可能已生效', not_applicable: '只读，无业务副作用' };
const reasons = {
  invalid_parameters: '可信执行前参数校验拒绝；请核对公开目录。', authorization_required: '本轮用户授权不足，须询问用户。',
  permission_denied: '最新权限拒绝，未进入执行。', preflight_rejected: '固定参数、目标、资源或授权的执行前核验未通过。',
  merge_dependency_cycle: '条件合并形成阶段依赖环或父子收口死锁；配置未保存，请核对等待条件。',
  execution_failed: '执行回调异常；底层原因未安全分类，副作用可能已发生。', completion_failed: '执行返回后的完成处理失败，结果未确认。',
  persistence_failed: '完成证据保存未确认，不能认定未生效。', request_failed: '请求未确认完成，底层原因未知。',
  completion_not_observed: '未观察到可信完成证据；底层原因未知，不自动重放。', in_progress: '已进入执行，尚无完成证据，不重复执行。',
  pending_confirmation: '等待真实用户批准精确请求，尚未开始执行。', approved: '等待执行前安全核验，尚未开始执行。',
  succeeded: '已保存该方法完成证据；不证明后续工作已创建、开始或完成。', read_completed: '只读请求已返回，不证明业务副作用。',
  request_returned: '管理请求已返回，但缺少独立完成证明；不能推定未开始或目标业务完成。',
  legacy_unknown: '旧收据未采集结构化诊断，无法还原最初失败阶段或原因。',
};
const evidence = ['trusted_pre_dispatch','trusted_pre_effect_rejection','confirmation_pending','approval_pending','dispatch_entered','completion_saved','read_only','completion_not_observed','legacy_missing'];
const recovery = { read_catalog: '读取公开能力目录，修正参数后提交新请求。', ask_user: '请用户决定所需授权；不要自行补写授权。', inspect_receipt: '只读核对精确持久收据与关联事实；未知副作用不得自动重放。', none: '无需重试；后续异步工作按其独立收据核查。' };
const retries = { corrected_request_only: '仅允许修正后的新请求；不是重放旧操作。', read_only: '只读查询可重新读取，不重做业务操作。', not_automatic: '不能自动重试或重放。', not_needed: '无需重试。' };
const workerStatuses = { queued: '排队', running: '运行', waiting: '等待', awaiting: '待答', paused: '暂停', completed: '正常返回', failed: '失败', cancelled: '已取消' };
const occurrenceStatuses = ['queued','running','waiting','waiting_actions','awaiting_question','stopping','stopped','failed','unknown','succeeded','cancelled','skipped','completed'];
const own = (map, key) => typeof key === 'string' && Object.hasOwn(map, key);
function outcome(value) {
  const code = own(reasons, value?.code) ? value.code : 'legacy_unknown';
  return { stage: own(stages, value?.stage) ? value.stage : 'legacy', code,
    effect: own(effects, value?.effect) ? value.effect : 'unknown', evidence: evidence.includes(value?.evidence) ? value.evidence : 'legacy_missing' };
}
export function safeBrowserDiagnostic(value) {
  const c = value?.correlation, d = value?.disposition;
  return { version: 1, ...outcome(value), original_failure: value?.original_failure ? outcome(value.original_failure) : null,
    recovery: own(recovery, value?.recovery) ? value.recovery : 'inspect_receipt', retry: own(retries, value?.retry) ? value.retry : 'not_automatic',
    correlation: { ...Object.fromEntries(['actor_id','target_id','run_id','occurrence_id','call_id','receipt_id','request_event_id'].map(key => [key, positive(c?.[key]) ? c[key] : null])),
      worker_number: numbered(c?.worker_number), target_worker_number: numbered(c?.target_worker_number) },
    disposition: { worker_status: own(workerStatuses, d?.worker_status) ? d.worker_status : null,
      occurrence_status: occurrenceStatuses.includes(d?.occurrence_status) ? d.occurrence_status : null,
      binding_enabled: typeof d?.binding_enabled === 'boolean' ? d.binding_enabled : null,
      emergency: ['stopping','isolated'].includes(d?.emergency) ? d.emergency : null } };
}
function inputFacts(value) {
  if (!value || value.coverage !== 'exact_persisted_input_facts_only') return null;
  return { mount: value.mount === 'confirmed' ? 'confirmed' : 'unknown', dispatch: ['confirmed','not_started'].includes(value.dispatch) ? value.dispatch : 'unknown',
    worker_started: value.worker_started === 'confirmed' ? 'confirmed' : 'unknown', worker_number: numbered(value.worker_number),
    ...Object.fromEntries(['mount_event_id','draft_id','source_draft_id','dispatch_event_id','input_id','worker_id','message_id'].map(key => [key, positive(value[key]) ? value[key] : null])),
    revision: positive(value.revision) ? value.revision : null, coverage: 'exact_persisted_input_facts_only' };
}
export function callDiagnosticReport(row, task, receipt = null) {
  const executions = [task?.management?.pending_signal, task?.management?.last_execution].filter(Boolean);
  const capability = executions.flatMap(item => item.control_calls || []).find(item => positive(row.receipt_id) && item.receipt_id === row.receipt_id && item.method === row.method);
  const actionType = row.method === 'worker.resume' ? 'start' : row.method === 'worker.retry' ? 'retry' : null;
  const snapshot = row.action && typeof row.action === 'object' ? row.action : row.result?.action;
  const actionId = positive(snapshot?.receipt_id) ? snapshot.receipt_id : positive(row.receipt_id) && !capability ? row.receipt_id : null;
  const currentAction = actionType ? executions.flatMap(item => item.actions || []).find(item => item.action === actionType
    && (positive(actionId) && item.receipt_id === actionId || capability && item.capability_receipt_id === capability.receipt_id)) : null;
  const rawAction = receipt?.action ?? currentAction ?? (actionType && snapshot && typeof snapshot === 'object' ? snapshot : null);
  const selectedAction = rawAction && positive(rawAction.receipt_id) && actionType && (!rawAction.action || rawAction.action === actionType)
    ? { receipt_id: rawAction.receipt_id, action: actionType,
      status: ['succeeded','waiting','skipped','unknown','pending_confirmation','approved','rejected','failed','running','cancelled'].includes(rawAction.status) ? rawAction.status : 'unknown',
      target_id: positive(rawAction.target_id) ? rawAction.target_id : null, target_worker_number: numbered(rawAction.target_worker_number),
      capability_receipt_id: positive(rawAction.capability_receipt_id) ? rawAction.capability_receipt_id : null,
      diagnostic: safeBrowserDiagnostic(rawAction.diagnostic) } : null;
  const directAction = selectedAction?.receipt_id === row.receipt_id && !capability ? selectedAction : null;
  const d = safeBrowserDiagnostic(receipt?.diagnostic ?? capability?.diagnostic ?? directAction?.diagnostic ?? row.diagnostic);
  // Current detail and call identities are authoritative, including deduplicated
  // transport calls that refer to an earlier capability/action receipt.
  d.correlation.actor_id = positive(task?.id) ? task.id : null;
  d.correlation.worker_number = numbered(task?.worker_number);
  if (positive(row.call_id)) { d.correlation.call_id = row.call_id; d.correlation.request_event_id = row.call_id; }
  const s = task?.management;
  if (s && !receipt) {
    d.disposition = safeBrowserDiagnostic({ disposition: { worker_status: task.status, occurrence_status: s.state,
      binding_enabled: s.enabled, emergency: s.emergency?.status } }).disposition;
  }
  const action = directAction ? null : selectedAction;
  const failed = !!d.original_failure || ['failed','rejected','unknown','cancelled'].includes(row.status)
    || ['completion_not_observed','merge_dependency_cycle','execution_failed','completion_failed','persistence_failed','request_failed','request_returned','invalid_parameters','permission_denied','authorization_required','preflight_rejected'].includes(d.code)
    || !!action?.diagnostic.original_failure || ['failed','rejected','unknown','cancelled'].includes(action?.status);
  return { method: method(receipt?.method ?? row.method), call_id: positive(row.call_id) ? row.call_id : null,
    receipt_id: positive(row.receipt_id) ? row.receipt_id : null,
    capability_receipt_id: positive(receipt?.capability_receipt_id) ? receipt.capability_receipt_id : capability?.receipt_id ?? selectedAction?.capability_receipt_id ?? null,
    action_receipt_id: selectedAction?.receipt_id ?? null, action,
    diagnostic: d, failed, input_emit: inputFacts(receipt?.input_emit ?? capability?.input_emit ?? row.input_emit) };
}
export function diagnosticSummaryLines(report) {
  const d = report.diagnostic, first = d.original_failure;
  const disposition = d.disposition;
  return [
    first ? `最初失败：${stages[first.stage]} · ${first.code}；${reasons[first.code]}`
      : d.code === 'legacy_unknown' ? `最初失败：${reasons.legacy_unknown}` : `已知诊断：${stages[d.stage]} · ${d.code}；${reasons[d.code]}`,
    `副作用：${effects[d.effect]}；证据：${d.evidence}。`,
    `后续处置：${[disposition.occurrence_status ? `事项 ${disposition.occurrence_status}` : '事项状态未知',
      disposition.binding_enabled === false ? '绑定已停用' : disposition.binding_enabled === true ? '绑定启用' : '绑定状态未知',
      disposition.emergency === 'isolated' ? '已急救隔离' : disposition.emergency === 'stopping' ? '急救停止收尾中' : null,
      disposition.worker_status ? `管家${workerStatuses[disposition.worker_status]}` : null].filter(Boolean).join('；')}。后续处置不改写最初失败。`,
    `下一步：${recovery[d.recovery]} ${retries[d.retry]}`,
    ...(report.action ? [actionSummary(report.action)] : []),
    ...(report.input_emit ? [`发射事实：挂载${report.input_emit.mount === 'confirmed' ? '已确认' : '未知'}；投递${report.input_emit.dispatch === 'confirmed' ? '已确认' : report.input_emit.dispatch === 'not_started' ? '未开始' : '未知'}；Worker 开始${report.input_emit.worker_started === 'confirmed' ? '有调用记录' : '未知'}。挂载不等于创建或开始。`] : []),
  ];
}
function actionSummary(action) {
  const d = action.diagnostic, first = d.original_failure;
  const labels = { waiting: '等待安全点', running: '执行中', succeeded: '生命周期请求已提交（不代表目标业务完成）', unknown: '结果未知', skipped: '已跳过', failed: '失败', rejected: '已拒绝', cancelled: '已取消', approved: '已批准', pending_confirmation: '待确认' };
  return `关联动作：${action.action} · 收据 #${action.receipt_id} · ${labels[action.status]}；副作用：${effects[d.effect]}；证据：${d.evidence}。${first ? `\n动作最初失败：${stages[first.stage]} · ${first.code}；${reasons[first.code]}` : `\n动作诊断：${reasons[d.code]}`}\n动作下一步：${recovery[d.recovery]} ${retries[d.retry]}`;
}
export const DIAGNOSTIC_TIMELINE_TYPES = ['management.call_started','management.call_finished','management.capability_requested','management.capability_started','management.capability_completed','management.capability_failed','management.capability_confirmation','management.capability_revoked','management.capability_policy_rechecked','management.unknown','management.failed','management.settled','management.binding_updated','management.emergency_requested','management.emergency_isolated','management.action_submitted','management.action_started','management.action_completed','management.action_skipped','management.action_failed'];
export function safeDiagnosticEvent(row) {
  return { seq: row.seq, type: DIAGNOSTIC_TIMELINE_TYPES.includes(row.type) ? row.type : 'unknown',
    created_at: typeof row.created_at === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(row.created_at) ? row.created_at : null,
    call_id: positive(row.call_id) ? row.call_id : null, receipt_id: positive(row.receipt_id) ? row.receipt_id : null,
    status: ['succeeded','waiting','skipped','unknown','pending_confirmation','approved','rejected','failed','running','cancelled'].includes(row.status) ? row.status : null,
    diagnostic: row.diagnostic ? safeBrowserDiagnostic(row.diagnostic) : null };
}
export function diagnosticCopyText(report, timeline) {
  return [`管家 ${report.diagnostic.correlation.worker_number ?? `#${report.diagnostic.correlation.actor_id ?? '未知'}`} · ${report.method ?? '接口未知'}`,
    ...diagnosticSummaryLines(report), '关联身份（仅白名单）：', JSON.stringify({ ...report.diagnostic.correlation, call_id: report.call_id, receipt_id: report.receipt_id,
      capability_receipt_id: report.capability_receipt_id, action_receipt_id: report.action_receipt_id }, null, 2),
    ...(report.action ? ['关联动作（独立收据，不以能力提交成功覆盖）：', JSON.stringify(report.action, null, 2)] : []),
    ...(report.input_emit ? ['发射身份与持久事实：', JSON.stringify(report.input_emit, null, 2)] : []),
    `安全时间线：${timeline?.loaded ? `已读取 ${timeline.items.length} 项；${timeline.has_more ? '仍有未读关联事件' : '已到本次关联范围末尾，不代表完整历史'}` : '尚未读取，不代表没有事件'}；coverage=linked_safe_management_events_only`,
    ...(timeline?.loaded ? timeline.items.map(item => JSON.stringify(item)) : []), '本诊断仅安全摘要，不含会话原文、参数、输出或凭证。'].join('\n');
}
