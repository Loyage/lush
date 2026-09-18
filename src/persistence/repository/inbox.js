/**
 * The task inbox rows, exposed on `Repository`.
 *
 * Exported as a method group: `index.js` merges it into `Repository`. The
 * signatures are the persistence-level ones; Core decides who may message whom
 * and when input is handed to the agent.
 */
import {
  countSubtreeTaskMessages, countUndeliveredTaskMessages, createTaskMessage, deleteTaskInbox,
  deliverTaskMessages, listTaskMessages, recentTaskMessages, subtreeTaskMessages,
  undeliveredTaskMessages,
} from '../repository_task_inbox.js';

export const inboxMethods = {
  createTaskMessage({ toTaskId, fromTaskId = null, kind, body = '', data = {} }) {
    return createTaskMessage(this, { toTaskId, fromTaskId, kind, body, data });
  },

  undeliveredTaskMessages(taskId) {
    return undeliveredTaskMessages(this, taskId);
  },

  countUndeliveredTaskMessages(taskId) {
    return countUndeliveredTaskMessages(this, taskId);
  },

  deliverTaskMessages(ids) {
    return deliverTaskMessages(this, ids);
  },

  listTaskMessages(taskId, options = {}) {
    return listTaskMessages(this, taskId, options);
  },

  recentTaskMessages(taskId, limit = 10) {
    return recentTaskMessages(this, taskId, limit);
  },

  /** Inbox rows touching this subtree, either end, newest first (the trace). */
  subtreeTaskMessages(taskIds, limit) {
    return subtreeTaskMessages(this, taskIds, limit);
  },

  countSubtreeTaskMessages(taskIds) {
    return countSubtreeTaskMessages(this, taskIds);
  },

  deleteTaskInbox(taskId) {
    return deleteTaskInbox(this, taskId);
  },
};
