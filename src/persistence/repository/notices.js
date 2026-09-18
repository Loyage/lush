/**
 * The notice rows, exposed on `Repository`.
 *
 * Exported as a method group: `index.js` merges it into `Repository`. Signatures
 * are the persistence-level ones (camelCase, no wire validation) — Core decides
 * what a caller may do with them.
 */
import {
  countAwaitingNotices, createNotice, deleteNoticesOfService, detachTaskNotices, findNotice, getNotice,
  linkNoticeToIntension, listNotices, openNoticeCount, openNoticesOfTask, settleNotice,
} from '../repository_notices.js';

export const noticeMethods = {
  createNotice(sid, taskId, { kind, title, body, fields, wait }) {
    return createNotice(this, { sid, taskId, kind, title, body, fields, wait });
  },

  getNotice(noticeId) {
    return getNotice(this, noticeId);
  },

  findNotice(noticeId) {
    return findNotice(this, noticeId);
  },

  listNotices(options = {}) {
    return listNotices(this, options);
  },

  openNoticesOfTask(taskId) {
    return openNoticesOfTask(this, taskId);
  },

  countAwaitingNotices(taskId) {
    return countAwaitingNotices(this, taskId);
  },

  openNoticeCount() {
    return openNoticeCount(this);
  },

  settleNotice(noticeId, status, detail = {}) {
    return settleNotice(this, noticeId, status, detail);
  },

  detachTaskNotices(taskId) {
    return detachTaskNotices(this, taskId);
  },

  /** Point one notice at the user input it is a question about. */
  linkNoticeToIntension(noticeId, intensionId) {
    return linkNoticeToIntension(this, noticeId, intensionId);
  },

  deleteNoticesOfService(sid) {
    return deleteNoticesOfService(this, sid);
  },
};
