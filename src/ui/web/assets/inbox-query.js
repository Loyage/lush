/** Pure shared Host/browser query contract; no device, DOM or project side effects. */
export const INBOX_CATEGORIES = Object.freeze(['notice', 'decision']);
export const INBOX_STATUSES = Object.freeze(['all', 'open', 'unread', 'automatic', 'failed', 'answered', 'dismissed', 'read']);

export const inboxCategory = notice => ['question', 'questionnaire', 'plan'].includes(notice?.kind) ? 'decision' : 'notice';

export function normalizeInboxQuery({ categories = INBOX_CATEGORIES, status = 'all', q = '', project_id = null } = {}) {
  if (!Array.isArray(categories) || !categories.every(value => INBOX_CATEGORIES.includes(value))) throw new Error('invalid inbox categories');
  if (!INBOX_STATUSES.includes(status)) throw new Error('invalid inbox status');
  if (typeof q !== 'string' || q.trim().toLowerCase().length > 500) throw new Error('inbox query must be at most 500 characters');
  if (project_id !== null && (typeof project_id !== 'string' || !/^[a-f0-9]{16}$/.test(project_id))) throw new Error('invalid source project');
  return { categories: INBOX_CATEGORIES.filter(value => categories.includes(value)), status, q: q.trim().toLowerCase(), project_id };
}

function statusMatches(notice, status) {
  if (status === 'all') return true;
  if (status === 'open') return notice.status === 'open' && ['question', 'questionnaire'].includes(notice.kind);
  if (status === 'unread') return notice.kind === 'info' && notice.status === 'sent'
    && notice.source_event_id != null && notice.read_at === null;
  if (status === 'read') return notice.kind === 'info' && notice.status === 'sent' && notice.read_at != null;
  if (status === 'automatic') return notice.status === 'answered' && notice.answer_source === 'lush'
    && ['question', 'questionnaire'].includes(notice.kind);
  if (status === 'failed') return notice.kind === 'info' && notice.lifecycle_type === 'failed';
  return notice.status === status;
}

export function inboxQueryMatches(item, query = {}) {
  const { categories, status, q, project_id } = normalizeInboxQuery(query);
  const notice = item.notice, category = inboxCategory(notice);
  if (!categories.includes(category) || (project_id !== null && item.project_id !== project_id) || !statusMatches(notice, status)) return false;
  if (!q) return true;
  const recordNumber = `${category === 'decision' ? 'D' : 'N'}${notice.id}`;
  const workerNumber = notice.task_worker_number || `#${notice.task_id}`;
  return [item.project_name, notice.title, notice.body, notice.answer, recordNumber, workerNumber]
    .some(value => typeof value === 'string' && value.toLowerCase().includes(q));
}
