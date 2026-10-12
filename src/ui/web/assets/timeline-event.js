import { eventLabel, noticeNumber } from './format.js';
import { previewHistoryEvent, eventMetadata } from './reading-projection.js';

export const TIMELINE_CATEGORIES = [
  ['input', '用户输入', true, 'var(--completed)'],
  ['output', 'Worker 结果', true, 'var(--queued)'],
  ['decision', '决策', true, 'var(--accent)'],
  ['lifecycle', '关键生命周期', true, 'var(--running)'],
  ['delivery', '交付与合并', true, 'var(--awaiting)'],
  ['failure', '失败与受阻', true, 'var(--failed)'],
  ['other', '系统与 Worker 通信', false, 'var(--muted)'],
  ['detail', '细粒度事件', false, 'var(--muted)'],
];
const lifecycle = new Set(['created', 'completed', 'cancelled', 'retry', 'invocation.started', 'invocation.completed',
  'invocation.preempted', 'task.idle', 'task.delivered', 'task.start_pending', 'task.iteration_started', 'task.interrupted',
  'task.paused', 'task.resumed', 'task.accepted', 'task.archived', 'task.reopened', 'task.resolved',
  'management.created', 'management.binding_updated', 'management.signal_skipped', 'management.signal_submitted',
  'management.invocation_started', 'management.action_submitted', 'management.action_skipped', 'management.action_completed', 'management.settled']);
export function timelineEventCategory(event) {
  const type = event.type || '';
  if (event.error || /(?:failed|failure|conflict|blocked|divergence|unknown|timeout|unavailable)/.test(type)
    || type === 'automation.operation_finished' && ['failed', 'unknown'].includes(event.data?.status)) return 'failure';
  if (['automation.operation_submitted', 'automation.operation_finished'].includes(type)
    && ['request_merge', 'accept_worker', 'integrate_deliveries'].includes(event.data?.tool)
    || ['delivery.requested', 'completion.execution_submitted'].includes(type)) return 'delivery';
  if (type === 'notice.opened' && event.data?.kind === 'info') return 'detail';
  if (/^(?:notice\.(?:opened|answered|reselected)|plan\.(?:proposed|approved|rejected))$/.test(type)) return 'decision';
  if (/^(?:merge\.|convergence\.|resolution\.|child\.(?:integrat|integration)|worker\.merge_|task\.(?:merge_|divergence_|delivery_|acceptance_))/.test(type)
    || ['merged', 'task.delivered', 'task.accepted', 'branch.merged'].includes(type)) return 'delivery';
  if (lifecycle.has(type)) return 'lifecycle';
  return 'detail';
}
export function timelineEventEntry(raw) {
  const event = previewHistoryEvent(raw), data = event.data, category = timelineEventCategory(event);
  const text = event.reading_text ?? ['body', 'result', 'answer'].filter(key => data[key] != null)
    .map(key => typeof data[key] === 'string' ? data[key] : JSON.stringify(data[key])).join('\n');
  const label = eventLabel(event);
  const summary = event.error ? `记录不可读：${event.error}`
    : [Number.isSafeInteger(data.notice_id) ? noticeNumber({ id: data.notice_id, kind: data.notice_kind ?? data.kind }) : null,
      data.title, data.error, data.reason, data.commit || data.head_commit || data.source_commit, data.branch || data.target_branch,
      data.call != null ? `第 ${data.call} 次调用` : null, data.no_changes ? '无代码变更' : null].filter(Boolean).join(' · ')
      || (category === 'failure' ? text : '') || (Object.keys(data).length ? JSON.stringify(eventMetadata(data)) : '无附加字段');
  return { key: `history:${event.id}`, side: 'event', category, kind: label, eventType: event.type,
    eventId: event.id, at: event.created_at, sequence: event.id, text, metadata: data,
    summary: summary.length > 240 ? summary.slice(0, 240) + '…' : summary,
    truncated: !event.error && Boolean(event.text_truncated), totalChars: event.total_chars,
    recordKind: 'event', recordId: event.id, limitations: event.limitations, unreadable: event.error };
}
