/**
 * The task layer's shared internals: the two guards every rule uses, and the
 * in-memory waiter registry.
 *
 * Nothing here is exported through `core/tasks.js` — the layer's public surface
 * is the rules (`rules.js`) and the read models (`read.js`).
 */
import { validSid } from '../types.js';
import { ACTIVE_TASK_STATUS } from '../lifecycle.js';

/** The task's active child tasks, oldest first. */
export function activeChildren(manager, taskId) {
  return manager.repository.childTasks(taskId)
    .filter((task) => ACTIVE_TASK_STATUS.includes(task.status));
}

/** Decode and validate one task id, or throw the not-found error. */
export function requireTask(manager, taskId) {
  validSid(taskId);
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
// `Repository.recover`). `taskWaiters` is keyed by task id and exists for the
// *user-facing* `task.wait` (a CLI / RPC caller blocking until a task reaches a
// terminal status). An agent no longer blocks inside a call: it parks its task
// in `waiting` and is resumed through its inbox (see `messages.js`).

/** Fire every user-side waiter parked on `taskId` (it reached a terminal status). */
export function wake(manager, taskId) {
  const waiters = manager.taskWaiters.get(taskId);
  if (waiters === undefined) return;
  manager.taskWaiters.delete(taskId);
  for (const resolve of waiters) resolve(taskId);
}
