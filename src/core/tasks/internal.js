/**
 * The task layer's shared internals: the two guards every rule uses, and the
 * in-memory waiter registry.
 *
 * Nothing here is exported through `core/tasks.js` — the layer's public surface
 * is the rules (`rules.js`) and the read models (`read.js`).
 */
import { validPid } from '../types.js';
import { ACTIVE_TASK_STATUS } from '../lifecycle.js';

/** The task's active child tasks, oldest first. */
export function activeChildren(manager, taskId) {
  return manager.repository.childTasks(taskId)
    .filter((task) => ACTIVE_TASK_STATUS.includes(task.status));
}

/** Decode and validate one task id, or throw the not-found error. */
export function requireTask(manager, taskId) {
  validPid(taskId);
  return manager.repository.getTask(taskId);
}

/** Is this task done (whatever the outcome)? */
export function isTerminal(task) {
  return !ACTIVE_TASK_STATUS.includes(task.status);
}

// ── Waiting ────────────────────────────────────────────────────────────────
//
// Waiting is in-memory: waiter and waited-on task live in the same daemon, and
// a restarted daemon fails the task instead of resuming it (see
// `Repository.recover`). `taskWaiters` is keyed by task id; `childWaiters` is
// keyed by the *parent* task id and fires when any of its children settles —
// that is what lets an agent that answered early be woken with the results.

/** Fire every waiter parked on `taskId` (or on its parent, for `childWaiters`). */
export function wake(manager, taskId) {
  const waiters = manager.taskWaiters.get(taskId);
  if (waiters !== undefined) {
    manager.taskWaiters.delete(taskId);
    for (const resolve of waiters) resolve(taskId);
  }
  const parentId = manager.repository.findTask(taskId)?.parent_task_id;
  if (parentId === null || parentId === undefined) return;
  const parents = manager.childWaiters.get(parentId);
  if (parents !== undefined) {
    manager.childWaiters.delete(parentId);
    for (const resolve of parents) resolve(taskId);
  }
}
