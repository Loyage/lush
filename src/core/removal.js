/**
 * Hard removal of processes: `delete` and `purge`, and the subtree walk they
 * share.
 *
 * Both subtract a process from the record for good — metadata, Context, the
 * tasks mounted on it (with their calls, messages and events) and its own
 * events — inside one transaction. `delete` only accepts a process that is
 * stopped and has no active task left, `purge` cancels the work first. Every
 * function operates on the `ProcessManager` passed in (its repository,
 * `_transition` and the task layer); the class in `process_manager.js` is the
 * only caller.
 */
import { LushError, validPid } from './types.js';
import { ACTIVE_PROCESS_STATUS } from './lifecycle.js';

/**
 * The subtree rooted at `pid`, children before parents, so a row disappears
 * only after the rows that reference it. Iterative on purpose: logical trees
 * may be deeper than the call stack is tall.
 */
export function subtree(manager, pid) {
  const order = [];
  const stack = [pid];
  while (stack.length) {
    const current = stack.pop();
    order.push(current);
    for (const child of manager.repository.children(current)) stack.push(child.pid);
  }
  return order.reverse();
}

/**
 * Shared body of `delete` and `purge`. Decisions, in order: PID 0 is never
 * removable (the daemon owns it), children need `recursive`, and unfinished
 * work (an active process, or an active task on one of them) is refused unless
 * the caller asked to terminate it.
 */
export function remove(manager, pid, recursive, terminate) {
  validPid(pid);
  if (typeof recursive !== 'boolean') throw new LushError('recursive must be a boolean', -32602);
  if (pid === 0) throw new LushError('PID 0 is managed by the daemon; it cannot be deleted', -32010);
  const root = manager.repository.get(pid);
  const children = manager.repository.children(pid).map((child) => child.pid);
  if (children.length && !recursive) {
    throw new LushError(
      `process ${pid} has children [${children.join(', ')}]; delete them first, or repeat with recursive deletion`,
      -32010,
    );
  }
  const doomed = subtree(manager, pid).map((item) => manager.repository.get(item));
  const active = doomed.filter((item) => ACTIVE_PROCESS_STATUS.includes(item.status));
  const busy = doomed.flatMap((item) => manager.repository.activeTasks({ pid: item.pid }));
  if ((active.length || busy.length) && !terminate) {
    const detail = [
      ...active.map((item) => `process ${item.pid} is ${item.status}`),
      ...busy.map((task) => `task ${task.id} on process ${task.pid} is ${task.status}`),
    ].join(', ');
    throw new LushError(
      `${detail}; stop it first (cancel its task with 'lush task cancel TASK_ID'), or use 'lush process purge'`,
      -32010,
    );
  }
  // Terminate the work first: cancelling a task aborts its agent, and only then
  // can the node be stopped without leaving an agent running behind it.
  for (const task of busy) manager.cancelTask(task.id);
  const terminated = [];
  for (const item of [...doomed].reverse()) {
    if (!ACTIVE_PROCESS_STATUS.includes(item.status)) continue;
    manager._transition(item.pid, 'stopped', { adopt: false });
    terminated.push(item.pid);
  }
  // The parent outlives the child by construction (a subtree holds no
  // ancestor), so it is the one that keeps the record of what disappeared.
  const pids = doomed.map((item) => item.pid);
  const deleted = [...pids].sort((left, right) => left - right);
  const audit = root.parent_pid === null ? null : {
    pid: root.parent_pid,
    kind: 'child_deleted',
    data: { pid, name: root.name, template: root.template, status: root.status, deleted },
  };
  return {
    pid,
    deleted,
    status: root.status,
    cancelled: busy.map((task) => task.id).sort((left, right) => left - right),
    terminated: terminated.sort((left, right) => left - right),
    rows: manager.repository.remove(pids, audit),
  };
}
