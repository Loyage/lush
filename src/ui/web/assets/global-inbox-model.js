import { linkWorkerNumbers } from './worker-links.js';
import { automaticNotice, positiveId, unreadNotice } from './notice-kind.js';

export const INBOX_STATUSES = ['open', 'unread', 'failed', 'automatic', 'all'];
export const validProjectId = value => typeof value === 'string' && /^[a-f0-9]{16}$/.test(value);
export const pendingNotice = notice => notice?.status === 'open' && ['question', 'questionnaire'].includes(notice.kind);
// Only the source's real record token is an identity. Revision changes must not erase drafts.
export function noticeSyncIdentity(notice) {
  for (const field of ['sync_identity', 'sync_epoch']) {
    if (notice?.[field] != null && (typeof notice[field] !== 'string' || !/^[a-f0-9]{32}$/.test(notice[field]))) {
      throw new Error('事项同步身份无效，请重新核验来源');
    }
  }
  if (notice?.sync_revision != null && (!Number.isSafeInteger(notice.sync_revision) || notice.sync_revision < 0)) {
    throw new Error('事项同步版本无效，请重新核验来源');
  }
  return notice?.sync_identity ?? null;
}
export function noticeIdentitySuffix(notice) {
  const identity = noticeSyncIdentity(notice);
  return identity ? `:sync:${identity}${notice.sync_epoch ? `:${notice.sync_epoch}` : ''}` : '';
}
export const inboxIdentity = item => `${item.project_id}:${item.notice.id}:${item.notice.created_at}${noticeIdentitySuffix(item.notice)}`;
export const inboxNotificationKey = item => `lush.notice-delivered:${item.project}:${item.notice.id}:${item.notice.created_at}${noticeIdentitySuffix(item.notice)}`;
export function sameInboxRecord(original, receipt) {
  if (original.project_id !== receipt.project_id || original.notice.id !== receipt.notice.id
    || original.notice.created_at !== receipt.notice.created_at) return false;
  const identity = noticeSyncIdentity(original.notice);
  if (identity && identity !== noticeSyncIdentity(receipt.notice)) return false;
  return !identity || original.notice.sync_epoch == null || original.notice.sync_epoch === receipt.notice.sync_epoch;
}
export const inboxHash = (projectId, noticeId) => {
  if (!validProjectId(projectId) || !positiveId(noticeId)) throw new Error('无效的事项来源身份');
  return `#inbox-notice-${projectId}-${noticeId}`;
};
/** Open the exact record in its source project's 待我处理, preserving the global tab. */
export function inboxProjectHref(projectId, noticeId) {
  if (!validProjectId(projectId) || !positiveId(noticeId)) throw new Error('无效的事项来源身份');
  return `/p/${projectId}/#notices-${noticeId}`;
}
export const inboxMatches = (item, status) => status === 'all' || (status === 'open' ? pendingNotice(item.notice)
  : status === 'unread' ? unreadNotice(item.notice) : status === 'automatic' ? automaticNotice(item.notice)
    : status === 'failed' ? item.notice.lifecycle_type === 'failed' : false);

export function validateInboxItem(item) {
  const notice = item?.notice;
  if (!validProjectId(item?.project_id) || typeof item.project !== 'string' || !item.project
    || typeof item.project_name !== 'string' || typeof item.online !== 'boolean'
    || !positiveId(notice?.id) || !positiveId(notice?.task_id) || typeof notice.created_at !== 'string'
    || !notice.created_at || typeof notice.title !== 'string' || typeof notice.body !== 'string'
    || !['open', 'answered', 'dismissed', 'sent'].includes(notice.status)
    || !['info', 'question', 'questionnaire', 'plan'].includes(notice.kind)) {
    throw new Error('全局事项读面无效，请更新 Host 与项目后台');
  }
  noticeSyncIdentity(notice);
  return item;
}

export function validateInboxPage(page) {
  if (page?.version !== 1 || !Array.isArray(page.items) || !Array.isArray(page.projects)
    || typeof page.has_more !== 'boolean' || typeof page.complete !== 'boolean'
    || (page.has_more && (typeof page.cursor !== 'string' || !page.cursor))) {
    throw new Error('全局收件箱读面不可用，请更新 Host 与项目后台');
  }
  for (const item of page.items) validateInboxItem(item);
  for (const source of page.projects) {
    if (!validProjectId(source?.id) || typeof source.name !== 'string'
      || typeof source.online !== 'boolean' || typeof source.complete !== 'boolean') {
      throw new Error('全局收件箱来源状态不可用');
    }
  }
  return page;
}

/** Number links in a global view always navigate the originating project, never the root/current project. */
export function sourceWorkerLinks(root, projectId) {
  if (!validProjectId(projectId)) throw new Error('无效的事项来源项目');
  linkWorkerNumbers(root);
  for (const link of root.querySelectorAll('.worker-link')) {
    const hash = link.getAttribute('href');
    if (!/^#worker-number-W[1-9]\d*(?:-[1-9]\d*)*$/.test(hash || '')) continue;
    link.setAttribute('href', `/p/${projectId}/${hash}`);
    link.setAttribute('target', '_blank'); link.setAttribute('rel', 'noopener');
  }
  return root;
}
