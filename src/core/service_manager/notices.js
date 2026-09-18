/**
 * The notice verbs as RPC / CLI / agent-tool callers see them. Each one is a
 * thin signature plus a call into `core/notices.js`, which owns the rules — the
 * layer exists so the wire names (`notice_list {status, task_id, sid, limit}`,
 * `notice_answer {notice_id, answer}`) stay exactly where callers expect them.
 *
 * Exported as a method group: `index.js` merges it into `ServiceManager`.
 */
import { answer, awaitingCount, dismiss, inspect, list, openCount, post, summary, terminate } from '../notices.js';

export const noticeLayer = {
  /**
   * `notice` agent tool: report to the user. The reporter is the calling task;
   * `sid` is derived from it. Returns the compact notice summary — the answer
   * comes back as this task's next input, never as this call's result.
   */
  postNotice({ taskId, kind = 'report', title, body = '', fields = undefined, wait = true }) {
    return summary(post(this, { taskId, kind, title, body, fields, wait }));
  },

  /**
   * `notice.post`: the same report, for a caller that is not an in-process
   * agent — an external agent (pi) driving Lush through the CLI. It returns the
   * open notice immediately and never blocks: with `wait` the reporter is
   * attached to the notice (it parks in `awaiting`) and the settled answer is
   * handed to it as inbox input by `notice.answer` / `notice.dismiss`.
   */
  noticePost(taskId, title, kind = 'report', body = '', fields = undefined, wait = true) {
    return post(this, { taskId, kind, title, body, fields, wait });
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

  /** How many notices this task reported that the user has not settled yet. */
  awaitingNoticeCount(taskId) {
    return awaitingCount(this, taskId);
  },

  /** A dying task's open notices are dismissed with this reason. */
  terminateNotices(taskId, reason) {
    return terminate(this, taskId, reason);
  },
};
