import { readPref } from './prefs.js';
import { projectBase } from './route.js';

/** Only explicit lifecycle metadata classifies notices; unknown types remain visible. */
export const noticeChannelEnabled = (row, channel) => !lifecycleNotice(row)
  || readPref('noticeChannels')[row.lifecycle_type]?.[channel] !== false;

/** Lifecycle info notices alone have unread state; old info records remain historical. */
export const lifecycleNotice = row => row?.kind === 'info' && row.status === 'sent'
  && Number.isSafeInteger(row.source_event_id) && row.source_event_id > 0;
export const noticeIdentity = row => `${projectBase()}:${row.id}:${row.task_id}:${row.source_event_id}:${row.created_at}`;
export const unreadNotice = row => lifecycleNotice(row) && !row.read_at;
/** Reading and answering are separate facts; legacy info has no inferred unread state. */
export const noticeStateLabel = row => lifecycleNotice(row) ? unreadNotice(row) ? '未读告知' : '已读告知'
  : ({ open: '待答复', answered: '已回答', dismissed: '已忽略', sent: '告知记录' }[row?.status] || row?.status || '状态未知');
/** Plain-text list preview only; the full record/form is never clipped. */
export function noticeExcerpt(row) {
  let text = row.body || '';
  if (row.kind === 'questionnaire') {
    try { const form = JSON.parse(text); text = form.body || form.questions?.map(q => q.question).join(' · ') || ''; }
    catch { return '问卷内容暂不可解析，请打开原记录核验。'; }
  }
  text = text.replace(/\s+/g, ' ').trim();
  if (text === row.title) return '';
  return text.length > 160 ? `${text.slice(0, 160)}…` : text;
}
export const automaticNotice = row => row?.status === 'answered' && row.answer_source === 'lush'
  && ['question', 'questionnaire'].includes(row.kind);
export const noticeMatches = (row, status) => status === 'all' || (status === 'unread' ? unreadNotice(row)
  : status === 'automatic' ? automaticNotice(row) : row.status === status);
export const positiveId = value => Number.isSafeInteger(value) && value > 0;
export const noticeHash = row => positiveId(row?.id) && positiveId(row?.task_id) ? `#notice-${row.id}` : '#notices';
