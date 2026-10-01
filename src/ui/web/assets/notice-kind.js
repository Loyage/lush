/** Lifecycle info notices alone have unread state; old info records remain historical. */
export const lifecycleNotice = row => row?.kind === 'info' && row.status === 'sent'
  && Number.isSafeInteger(row.source_event_id) && row.source_event_id > 0;
export const unreadNotice = row => lifecycleNotice(row) && !row.read_at;
export const noticeMatches = (row, status) => status === 'all' || (status === 'unread' ? unreadNotice(row) : row.status === status);
export const positiveId = value => Number.isSafeInteger(value) && value > 0;
export const noticeHash = row => positiveId(row?.id) && positiveId(row?.task_id) ? `#notice-${row.id}` : '#notices';
