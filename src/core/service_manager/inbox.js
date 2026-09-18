/**
 * The inbox verbs as RPC / CLI / runtime callers see them.
 *
 * `send` / `inbox` / `trace` are the user- and agent-facing surface
 * (`task.message` / `task.inbox` / `task.trace`); `takeTaskInput`,
 * `waitForTaskInput` and `resumeTask` are what the runtime uses to hand queued
 * input to one task's agent and to park a task between invocations. The rules
 * live in `core/tasks/messages.js`; the trace's read model in
 * `core/tasks/trace.js`.
 *
 * Exported as a method group: `index.js` merges it into `ServiceManager`.
 */
import { inbox, pending, send, take, trace } from '../tasks.js';

export const inboxLayer = {
  /** `task.message`: a direct parent ↔ child message. Queued, never interrupting. */
  taskMessage(fromTaskId, toTaskId, body) {
    return send(this, fromTaskId, toTaskId, body);
  },

  /** `task.inbox`: the mailbox of one task, oldest first. */
  taskInbox(taskId, after = 0, limit = 50) {
    return inbox(this, taskId, { after, limit });
  },

  /**
   * `task.trace`: the subtree's collaboration timeline, oldest step first —
   * delegations, messages in either direction, and settlements. Derived from
   * `task_inbox` + `task_events`, so there is nothing to keep in sync.
   */
  taskTrace(taskId, limit = 200) {
    return trace(this, taskId, limit);
  },

  /** Undelivered input, marked delivered: it becomes the next invocation's prompt. */
  takeTaskInput(taskId) {
    return take(this, taskId);
  },

  pendingTaskInput(taskId) {
    return pending(this, taskId);
  },

  /**
   * Park until anything lands in this task's inbox. Registering before the
   * re-check makes it race-free: a delivery that happened first resolves the
   * promise immediately instead of being missed.
   */
  waitForTaskInput(taskId) {
    return new Promise((resolve) => {
      const waiters = this.resumeWaiters.get(taskId) ?? new Set();
      waiters.add(resolve);
      this.resumeWaiters.set(taskId, waiters);
      if (this.repository.countUndeliveredTaskMessages(taskId) > 0) this.resumeTask(taskId);
    });
  },

  /** Wake a task parked in `waiting` because new input arrived (or it settled). */
  resumeTask(taskId) {
    const waiters = this.resumeWaiters.get(taskId);
    if (waiters === undefined) return;
    this.resumeWaiters.delete(taskId);
    for (const resolve of waiters) resolve(taskId);
  },
};
