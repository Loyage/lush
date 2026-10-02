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
export const noticeMatches = (row, status) => status === 'all' || (status === 'unread' ? unreadNotice(row) : row.status === status);
export const positiveId = value => Number.isSafeInteger(value) && value > 0;
export const noticeHash = row => positiveId(row?.id) && positiveId(row?.task_id) ? `#notice-${row.id}` : '#notices';
