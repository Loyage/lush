import { workerLabel } from './worker-number.js';
import { inputNumber, noticeNumber } from '../core/record-number.js';

function inputReceiptOutcome(value, entry) {
  const result = value?.receipt_id ? value.status === 'succeeded' ? value.result : null : value;
  if (['input draft create','input draft update'].includes(entry?.path) && result?.kind === 'draft'
    && Number.isSafeInteger(result.id) && result.id > 0 && Number.isSafeInteger(result.revision))
    return { status: 'saved', effect: 'applied', evidence: 'saved_draft_revision', draft_id: result.id, revision: result.revision };
  if (!['order','input draft submit'].includes(entry?.path) || result?.emitted !== true || !Number.isSafeInteger(result.draft_id)) return null;
  const dispatch = result.dispatch;
  if (dispatch?.state === 'unknown') return { status: 'unknown', effect: 'unknown', draft_id: result.draft_id };
  if (dispatch?.state === 'succeeded' && (Number.isSafeInteger(dispatch.input_id) || Number.isSafeInteger(dispatch.message_id)))
    return { status: 'delivered', effect: 'applied', evidence: 'durable_input_dispatch_receipt', draft_id: result.draft_id,
      ...(dispatch.input_id ? { input_id: dispatch.input_id } : {}), ...(dispatch.message_id ? { message_id: dispatch.message_id } : {}) };
  if (['queued','waiting_conditions'].includes(dispatch?.state)) return { status: 'scheduled', effect: 'applied',
    evidence: 'durable_emission_mount', draft_id: result.draft_id, note: '只证明可靠挂载，不证明已投递、调用或完成。' };
  return null;
}
export function resultEnvelope(value, entry, warnings = []) {
  const page = value && typeof value === 'object' && !Array.isArray(value) ? value.page : null;
  const diagnostic = value?.diagnostic;
  const input = inputReceiptOutcome(value, entry);
  const outcome = input ?? (diagnostic ? { effect: diagnostic.effect, code: diagnostic.code, recovery: diagnostic.recovery,
    ...(diagnostic.correlation ? { correlation: diagnostic.correlation } : {}) }
    : value?.outcome ?? (entry?.operation === 'write' ? { effect: 'unknown', status: value?.status ?? 'returned',
      note: 'CLI 返回不是后续副作用完成证明；以 data 中真实收据和状态为准。' } : undefined));
  return { version: 1, data: value, ...(page ? { page } : {}), ...(outcome ? { outcome } : {}), ...(warnings.length ? { warnings } : {}) };
}
function rowLabel(row) {
  if (!row || typeof row !== 'object') return String(row);
  if ('worker_number' in row || 'task_kind' in row || 'goal' in row) return workerLabel(row);
  if ('kind' in row && 'title' in row && 'task_id' in row) return noticeNumber(row);
  if (row.kind === 'input') return inputNumber(row.id);
  return row.id === undefined ? '' : `#${row.id}`;
}
function line(row) {
  if (!row || typeof row !== 'object') return String(row);
  const title = row.display_title || row.auto_title || row.title || row.goal || row.name || row.content || row.description || '';
  return [rowLabel(row), row.status || row.state || '', String(title).replaceAll('\n', ' ').slice(0, 180)].filter(Boolean).join('\t');
}
export function humanResult(value, entry) {
  if (value === null || value === undefined) return '(无返回数据)';
  if (typeof value !== 'object') return String(value);
  if (Array.isArray(value)) return value.length ? value.map(line).join('\n') : '(empty)';
  const lines = [];
  const input = inputReceiptOutcome(value, entry);
  if (input) lines.push(`${input.status}${input.draft_id ? ` · draft #${input.draft_id}` : ''}${input.note ? ` · ${input.note}` : ''}`);
  if (value.task) lines.push(line(value.task));
  else if (rowLabel(value) || value.status || value.title || value.goal) lines.push(line(value));
  for (const key of ['summary','message','reason','note','coverage','revision','expected_revision','receipt_id','input_id','message_id','draft_id','integration','result','error'])
    if (value[key] !== undefined && value[key] !== null) lines.push(`${key}: ${typeof value[key] === 'object' ? '[结构化详情见 --json]' : String(value[key]).slice(0, 4000)}`);
  for (const key of ['items','tasks','workers','active','history','results','notices','events','steps','connections','models','packages','drafts','commands','resources','signals']) if (Array.isArray(value[key])) {
    lines.push(`${key}: ${value[key].length}`, ...value[key].map(line));
  }
  for (const key of ['saved','scheduled','delivered','unknown','has_more','total','limit','next_cursor','next_after','cursor'])
    if (value[key] !== undefined && value[key] !== null) lines.push(`${key}: ${value[key]}`);
  if (value.page) lines.push(`has_more: ${value.page.has_more}; next_cursor: ${value.page.next_cursor ?? '(none)'}`);
  if (value.diagnostic) lines.push(`effect: ${value.diagnostic.effect}; recovery: ${value.diagnostic.recovery}`);
  if (!lines.length) lines.push(`${entry?.description ?? '请求已返回'}；详情使用 --json。`);
  if (entry?.operation === 'write') lines.push('仅报告本次请求返回；等待／未知不等于动作完成，不自动重发。');
  return lines.join('\n');
}

export function cliExitCode(error) {
  if (Number.isInteger(error?.exitCode)) return error.exitCode;
  if (error?.execution === 'unknown') return 5;
  if (error?.kind === 'authorization_required' || error?.kind === 'permission_denied') return 3;
  if (error?.code === 'ABORT_ERR') return 130;
  return 1;
}
export function reportCLIError(error, executable) {
  if (error?.cliJSON) console.log(JSON.stringify({ version: 1, data: null,
    outcome: { effect: error.execution ?? 'unknown', kind: error.kind ?? 'request_failed', help: error.help ?? `${executable} help` },
    warnings: [error.message] }));
  else console.error(`${executable}: ${error.message}`);
  process.exitCode = process.env.LUSH_CLI_TRIAL && error.code === -32021 ? 75 : cliExitCode(error);
}
