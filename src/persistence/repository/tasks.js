/**
 * The task rows as the class exposes them. Every method forwards to
 * `repository_tasks.js`, which holds the statements and the row decoding.
 *
 * Exported as a method group: `index.js` merges it into `Repository`.
 */
import * as tasks from '../repository_tasks.js';

export const taskMethods = {
  /** `createTask` opens a unit of work on one service; the root task is its own root. */
  createTask(sid, parentTaskId, goal, options) {
    return tasks.createTask(this, sid, parentTaskId, goal, options);
  },

  getTask(taskId) {
    return tasks.getTask(this, taskId);
  },

  findTask(taskId) {
    return tasks.findTask(this, taskId);
  },

  listTasks(options) {
    return tasks.listTasks(this, options);
  },

  tasksOfService(sid) {
    return tasks.tasksOfService(this, sid);
  },

  childTasks(taskId) {
    return tasks.childTasks(this, taskId);
  },

  activeTasks(options) {
    return tasks.activeTasks(this, options);
  },

  activeTaskOfService(sid) {
    return tasks.activeTaskOfService(this, sid);
  },

  transitionTask(taskId, target, options) {
    return tasks.transitionTask(this, taskId, target, options);
  },

  updateTaskState(taskId, patch) {
    return tasks.updateTaskState(this, taskId, patch);
  },

  taskEvent(taskId, kind, data) {
    return tasks.taskEvent(this, taskId, kind, data);
  },

  taskEvents(taskId, limit = 20) {
    return tasks.taskEvents(this, taskId, limit);
  },

  /** `delegated` events of this subtree, newest first (the trace). */
  subtreeDelegations(taskIds, limit) {
    return tasks.subtreeDelegations(this, taskIds, limit);
  },

  countSubtreeDelegations(taskIds) {
    return tasks.countSubtreeDelegations(this, taskIds);
  },

  /** The delegation that created `childTaskId` under `parentTaskId` (or null). */
  delegationOf(parentTaskId, childTaskId) {
    return tasks.delegationOf(this, parentTaskId, childTaskId);
  },

  /** The `detached` event that promoted this task to a root (or null). */
  detachmentOf(taskId) {
    return tasks.detachmentOf(this, taskId);
  },

  /** Promote this task's still-active children to roots of their own. */
  detachChildTasks(taskId) {
    return tasks.detachChildTasks(this, taskId);
  },

  taskCalls(taskId) {
    return tasks.taskCalls(this, taskId);
  },

  taskMessages(taskId) {
    return tasks.taskMessages(this, taskId);
  },

  taskSubtree(taskId) {
    return tasks.taskSubtree(this, taskId);
  },

  deleteTaskRows(taskIds) {
    return tasks.deleteTaskRows(this, taskIds);
  },

  detachServiceTasks(sids) {
    return tasks.detachServiceTasks(this, sids);
  },
};
