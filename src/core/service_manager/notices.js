/**
 * The notice verbs as RPC / CLI / agent-tool callers see them. Each one is a
 * thin signature plus a call into `core/notices.js`, which owns the rules — the
 * layer exists so the wire names (`notice_list {status, task_id, sid, limit}`,
 * `notice_answer {notice_id, answer}`) stay exactly where callers expect them.
 *
 * Exported as a method group: `index.js` merges it into `ServiceManager`.
 */
import { answer, dismiss, inspect, list, openCount, post, summary, terminate, waitForNotice } from '../notices.js';

export const noticeLayer = {
  /**
   * `notice` agent tool: report to the user. The reporter is the calling task;
   * `sid` is derived from it. Returns the compact notice summary.
   */
  postNotice({ taskId, kind = 'report', title, body = '', fields = undefined, wait = true }) {
    return summary(post(this, { taskId, kind, title, body, fields, wait }));
  },

  noticeList(status = null, taskId = null, sid = null, limit = 200) {
    return list(this, { status, taskId, sid, limit });
  },

  noticeInspect(noticeId) {
    return inspect(this, noticeId);
  },

  noticeAnswer(noticeId, value) {
    return answer(this, noticeId, value);
  },

  noticeDismiss(noticeId, reason = null) {
    return dismiss(this, noticeId, reason);
  },

  openNoticeCount() {
    return openCount(this);
  },

  /** Block until one notice is settled (used by the `notice` agent tool). */
  waitForNotice(noticeId, fromTaskId = null) {
    return waitForNotice(this, noticeId, fromTaskId);
  },

  /** A dying task's open notices are dismissed with this reason. */
  terminateNotices(taskId, reason) {
    return terminate(this, taskId, reason);
  },
};
