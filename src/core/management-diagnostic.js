/** Pure, Node-compatible public diagnostic protocol. No arbitrary strings pass this boundary. */
import { safeWorkerQueryError } from './worker-query.js';
import { safeManagementPreflightError } from './management-guidance.js';
export const MANAGEMENT_DIAGNOSTIC_CODE = -32032;
export const MANAGEMENT_DIAGNOSTIC_ENUMS = Object.freeze({
  stage: ['admission','parameters','authorization','preflight','execution','completion','persistence','return','recovery','legacy'],
  effect: ['not_started','applied','unknown','not_applicable'],
  evidence: ['trusted_pre_dispatch','trusted_pre_effect_rejection','confirmation_pending','approval_pending','dispatch_entered','completion_saved','read_only','completion_not_observed','legacy_missing'],
  recovery: ['read_catalog','ask_user','inspect_receipt','none'],
  retry: ['corrected_request_only','read_only','not_automatic','not_needed'],
});
const reasons = Object.freeze({
  invalid_parameters: '参数在可信执行前检查中被拒绝；请读取目录并修正。',
  authorization_required: '本轮用户授权不足；须询问用户，不得自行补写授权。',
  permission_denied: '最新权限禁止本次能力；未进入执行。',
  preflight_rejected: '固定参数、目标、资源或授权的执行前核验未通过。',
  merge_dependency_cycle: '条件合并形成阶段依赖环或父子收口死锁；配置未保存，请核对等待条件。',
  execution_failed: '执行回调抛出异常；具体底层原因未被安全分类，副作用可能已发生。',
  completion_failed: '执行返回后的完成处理失败；结果尚未确认，不能自动重放。',
  persistence_failed: '完成证据保存未确认；不能据此认定操作未生效。',
  request_failed: '请求未确认完成；缺少可安全分类的底层原因。',
  completion_not_observed: '未观察到可信完成证据；副作用未知，不能自动重放。',
  in_progress: '已进入执行边界，尚无完成证据；不得重复执行。',
  pending_confirmation: '等待真实用户批准精确请求；尚未开始执行。',
  approved: '请求已获准，等待执行前安全核验；尚未开始执行。',
  succeeded: '已保存该管理方法的完成证据；不证明后续异步工作已创建、启动或完成。',
  read_completed: '只读请求已返回；不包含业务副作用的证明。',
  request_returned: '管理请求已返回，但缺少独立完成证明；不能推定未开始或目标业务已完成。',
  legacy_unknown: '旧记录未采集结构化诊断；无法还原最初失败阶段或原因。',
});
const positive = n => Number.isSafeInteger(n) && n > 0;
const member = (name, value, fallback) => MANAGEMENT_DIAGNOSTIC_ENUMS[name].includes(value) ? value : fallback;
const worker = value => typeof value === 'string' && value.length <= 128 && /^(?:W[1-9][0-9]*(?:-[1-9][0-9]*)*|V[1-9][0-9]*)$/.test(value) ? value : null;
export const MANAGEMENT_DIAGNOSTIC_CODES = Object.freeze(Object.keys(reasons));
const codes = new Set(MANAGEMENT_DIAGNOSTIC_CODES);
const failures = new Set(['invalid_parameters','authorization_required','permission_denied','preflight_rejected','merge_dependency_cycle','execution_failed',
  'completion_failed','persistence_failed','request_failed']);
function outcome(value = {}) {
  value = value && typeof value === 'object' ? value : {};
  const code = codes.has(value.code) ? value.code : 'legacy_unknown';
  return { stage: member('stage', value.stage, 'legacy'), code,
    reason: `${failures.has(code) ? '管理请求被拒绝或未确认完成；' : ''}${reasons[code]}${code === 'request_failed' ? '用法可读取 lush_cli help；执行证据见 management.receipt。' : ''}`,
    effect: member('effect', value.effect, 'unknown'), evidence: member('evidence', value.evidence, 'legacy_missing') };
}
export function safeManagementDiagnostic(value = {}) {
  value = value && typeof value === 'object' ? value : {};
  const c = value.correlation ?? {}, d = value.disposition ?? {};
  return { version: 1, ...outcome(value), original_failure: value.original_failure ? outcome(value.original_failure) : null,
    recovery: member('recovery', value.recovery, 'inspect_receipt'), retry: member('retry', value.retry, 'not_automatic'),
    correlation: { ...Object.fromEntries(['actor_id','target_id','run_id','occurrence_id','call_id','receipt_id','request_event_id']
      .map(key => [key, positive(c[key]) ? c[key] : null])), worker_number: worker(c.worker_number), target_worker_number: worker(c.target_worker_number) },
    disposition: { worker_status: ['queued','running','waiting','awaiting','paused','completed','failed','cancelled'].includes(d.worker_status) ? d.worker_status : null,
      occurrence_status: ['queued','running','waiting','waiting_actions','awaiting_question','stopping','stopped','failed','unknown','succeeded','cancelled','skipped','completed'].includes(d.occurrence_status) ? d.occurrence_status : null,
      binding_enabled: typeof d.binding_enabled === 'boolean' ? d.binding_enabled : null,
      emergency: ['stopping','isolated'].includes(d.emergency) ? d.emergency : null } };
}
export function managementDiagnostic(code, stage, effect, evidence, correlation = {}, previous = null) {
  const failure = failures.has(code);
  return safeManagementDiagnostic({ code, stage, effect, evidence, correlation,
    original_failure: previous?.original_failure ?? (failure ? { code, stage, effect, evidence } : null),
    recovery: code === 'invalid_parameters' ? 'read_catalog' : code === 'authorization_required' ? 'ask_user'
      : ['succeeded','read_completed'].includes(code) ? 'none' : 'inspect_receipt',
    retry: effect === 'not_applicable' ? 'read_only' : code === 'invalid_parameters' && effect === 'not_started' ? 'corrected_request_only'
      : code === 'succeeded' ? 'not_needed' : 'not_automatic' });
}
/** Both bridge endpoints revalidate the complete code-owned envelope, not exception text. */
export function safeManagementDiagnosticError(error) {
  if (error?.code !== MANAGEMENT_DIAGNOSTIC_CODE) return null;
  let value;
  try { value = error.diagnostic ? error : JSON.parse(error.message ?? error.error); } catch { return null; }
  if (!value || !value.diagnostic || value.diagnostic.version !== 1) return null;
  const diagnostic = safeManagementDiagnostic(value.diagnostic);
  if (JSON.stringify(diagnostic) !== JSON.stringify(value.diagnostic)) return null;
  // error is reconstructed from the whitelist, never copied from the supplied envelope.
  const preflight = diagnostic.effect === 'not_started'
    ? safeWorkerQueryError(value.preflight) ?? safeManagementPreflightError(value.preflight) : null;
  return { error: preflight?.error ?? diagnostic.reason, code: MANAGEMENT_DIAGNOSTIC_CODE, diagnostic,
    kind: preflight?.kind ?? diagnostic.code, execution: diagnostic.effect, recovery: preflight?.recovery ?? diagnostic.recovery,
    ...(preflight ? { preflight } : {}) };
}
export function managementDiagnosticErrorMessage(diagnostic, error) {
  const preflight = diagnostic.effect === 'not_started' ? safeWorkerQueryError(error) ?? safeManagementPreflightError(error) : null;
  return JSON.stringify({ diagnostic: safeManagementDiagnostic(diagnostic), ...(preflight ? { preflight } : {}) });
}

export const MANAGEMENT_RECEIPT_PARAMETERS = ['receipt_id','after','limit'];
export const MANAGEMENT_RECEIPT_CAPABILITIES = Object.freeze({
  'management.receipt': { schema: { type: 'object', properties: {
    receipt_id: { type: 'integer', minimum: 1, description: '当前项目 capability_requested、action_submitted 或可信 call_started/call_finished 的 Event ID。' },
    after: { type: 'integer', minimum: 0, default: 0, description: '使用上页 next_cursor，排除该 Event。' },
    limit: { type: 'integer', minimum: 1, maximum: 100, default: 30 },
  }, required: ['receipt_id'], additionalProperties: false },
  examples: [{ receipt_id: 123, limit: 30 }],
  pagination: '关联安全事件按 ID 正序；has_more 来自额外一条，next_cursor 是实际末项；不读取会话。' },
});
export function validManagementReceiptParams(params) {
  return params && typeof params === 'object' && !Array.isArray(params)
    && Object.keys(params).every(key => MANAGEMENT_RECEIPT_PARAMETERS.includes(key)) && positive(params.receipt_id)
    && (params.after === undefined || Number.isSafeInteger(params.after) && params.after >= 0)
    && (params.limit === undefined || Number.isSafeInteger(params.limit) && params.limit >= 1 && params.limit <= 100);
}
