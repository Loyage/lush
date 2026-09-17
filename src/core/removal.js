/**
 * Hard removal of processes: `delete` and `purge`, and the subtree walk they
 * share.
 *
 * Both subtract a process from the record for good — metadata, Context,
 * messages, calls and its own events — inside one transaction. `delete` only
 * accepts an already finished process, `purge` stops/cancels first. Every
 * function operates on the `ProcessManager` passed in (its repository and
 * `_transition`); the class in `process_manager.js` is the only caller.
 */
import { LushError, validPid } from './types.js';
import { ACTIVE } from './lifecycle.js';

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
 * work is refused unless the caller asked to terminate it.
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
  const active = doomed.filter((item) => ACTIVE.has(item.status));
  if (active.length && !terminate) {
    const detail = active.map((item) => `${item.pid} is ${item.status}`).join(', ');
    throw new LushError(`process ${detail}; stop or kill it first, or use 'lush process purge'`, -32010);
  }
  const terminated = [];
  for (const item of [...doomed].reverse()) {
    if (!ACTIVE.has(item.status)) continue;
    manager._transition(item.pid, item.type === 'service' ? 'stopped' : 'cancelled', { adopt: false });
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
    terminated: terminated.sort((left, right) => left - right),
    rows: manager.repository.remove(pids, audit),
  };
}
