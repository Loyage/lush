/**
 * The read side of the task layer: the wire shape of one task, the list / tree
 * / inspect models, and the two operations that only touch a finished task's
 * own rows (state patch, delete).
 *
 * Read models are deliberately cheap: a task row plus the service it is
 * mounted on, never the whole task tree unless `tree` was asked.
 */
import { LushError, isPlainObject, jsonDump, validSid } from '../types.js';
import { isTerminal, requireTask } from './internal.js';

/** Wire shape of one task: the row plus how far it has come. */
export function summary(task) {
  return {
    id: task.id,
    sid: task.sid,
    parent_task_id: task.parent_task_id,
    root_task_id: task.root_task_id,
    status: task.status,
    goal: task.goal,
    result: task.result,
    error: task.error,
    state: task.state,
    created_at: task.created_at,
    started_at: task.started_at,
    finished_at: task.finished_at,
    updated_at: task.updated_at,
  };
}

export const TASK_STATUSES = ['created', 'running', 'waiting', 'awaiting', 'completed', 'failed', 'cancelled'];

/** `task list`: filtered rows, newest first, `limit`-bounded. */
export function list(manager, { sid = null, status = null, roots = null, limit = 200 } = {}) {
  if (sid !== null) validSid(sid);
  if (status !== null && !TASK_STATUSES.includes(status)) {
    throw new LushError(`unknown task status: ${status} (expected ${TASK_STATUSES.join(', ')})`, -32602);
  }
  if (roots !== null && roots !== 'roots' && roots !== 'children') {
    throw new LushError("roots must be 'roots' or 'children'", -32602);
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new LushError('limit must be 1..1000', -32602);
  }
  return manager.repository.listTasks({ sid, status, root: roots, limit }).map(summary);
}

/** `task inspect`: the task, the service it sits on, its children, calls and events. */
export function inspect(manager, taskId) {
  const task = requireTask(manager, taskId);
  const sid = task.sid;
  const service = manager.repository.get(sid);
  const parent = task.parent_task_id === null ? null : manager.repository.findTask(task.parent_task_id);
  const calls = manager.repository.callsOfTask(taskId);
  return {
    ...summary(task),
    service: {
      sid: service.sid,
      name: service.name,
      template: service.template,
      status: service.status,
      parent_sid: service.parent_sid,
    },
    parent_task: parent === null ? null : summary(parent),
    child_tasks: manager.repository.childTasks(taskId).map(summary),
    recent_calls: calls.slice(0, 10),
    recent_events: manager.repository.taskEvents(taskId),
    recent_inbox: manager.repository.recentTaskMessages(taskId, 10),
    messages: manager.repository.taskMessages(taskId).length,
  };
}

/** `task tree`: the task with its whole subtree of delegated work. */
export function tree(manager, taskId) {
  const task = requireTask(manager, taskId);
  const node = (current) => {
    const row = current.id === taskId ? current : manager.repository.getTask(current.id);
    const service = manager.repository.get(row.sid);
    return {
      ...summary(row),
      // The service name makes the tree readable: a task is always "on" one node.
      service_name: service.name,
      children: manager.repository.childTasks(row.id)
        .map((child) => node(child)),
    };
  };
  return node(task);
}

/** `task result`: the settled outcome, or a refusal while the task is still active. */
export function result(manager, taskId) {
  const task = requireTask(manager, taskId);
  return {
    id: task.id,
    sid: task.sid,
    status: task.status,
    finished: isTerminal(task),
    result: task.result,
    error: task.error,
  };
}

/** Shallow-merge the task's own scratch state (the service state is separate). */
export function updateState(manager, taskId, patch) {
  requireTask(manager, taskId);
  if (!isPlainObject(patch)) throw new LushError('patch must be an object', -32602);
  jsonDump(patch);
  return manager.repository.updateTaskState(taskId, patch);
}

/**
 * Remove one finished task's rows (its calls and messages stay, because they
 * belong to the service's history — only the task row and its events go). The
 * subtree is removed children-first, and a task that still has active work is
 * refused; `recursive` is required when child tasks exist.
 */
export function remove(manager, taskId, recursive = false) {
  const task = requireTask(manager, taskId);
  const subtreeIds = manager.repository.taskSubtree(taskId);
  const active = manager.repository.activeTasks().filter((row) => subtreeIds.includes(row.id));
  if (active.length > 0) {
    throw new LushError(
      `task ${active[0].id} is ${active[0].status}; cancel it first ('lush task cancel ${active[0].id}')`,
      -32010,
    );
  }
  const children = manager.repository.childTasks(taskId);
  if (children.length > 0 && !recursive) {
    throw new LushError(
      `task ${taskId} has child tasks [${children.map((child) => child.id).join(', ')}]; `
      + 'delete them first, or repeat with recursive deletion',
      -32010,
    );
  }
  const rows = manager.repository.deleteTaskRows([...subtreeIds].reverse());
  return { task_id: taskId, status: task.status, deleted: subtreeIds.sort((left, right) => left - right), rows };
}

/** Root tasks of one service, newest first (`service inspect`). */
export function tasksOfService(manager, sid) {
  return manager.repository.tasksOfService(sid).map(summary);
}

/** Every active task in the daemon, oldest first (orphan supervision / status). */
export function activeTasks(manager) {
  return manager.repository.activeTasks().map(summary);
}
