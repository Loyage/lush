/**
 * The task rows as the class exposes them. Every method forwards to
 * `repository_tasks.js`, which holds the statements and the row decoding.
 *
 * Exported as a method group: `index.js` merges it into `Repository`.
 */
import * as tasks from '../repository_tasks.js';

export const taskMethods = {
  /** `createTask` opens a unit of work on one process; the root task is its own root. */
  createTask(pid, parentTaskId, goal, options) {
    return tasks.createTask(this, pid, parentTaskId, goal, options);
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

  tasksOfProcess(pid) {
    return tasks.tasksOfProcess(this, pid);
  },

  childTasks(taskId) {
    return tasks.childTasks(this, taskId);
  },

  activeTasks(options) {
    return tasks.activeTasks(this, options);
  },

  activeTaskOfProcess(pid) {
    return tasks.activeTaskOfProcess(this, pid);
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

  detachProcessTasks(pids) {
    return tasks.detachProcessTasks(this, pids);
  },
};
