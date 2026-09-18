/**
 * Hard removal of services: `delete` and `purge`, and the subtree walk they
 * share.
 *
 * Both subtract a service from the record for good — metadata, Context, the
 * tasks mounted on it (with their calls, messages and events) and its own
 * events — inside one transaction. `delete` only accepts a service that is
 * stopped and has no active task left, `purge` cancels the work first. Every
 * function operates on the `ServiceManager` passed in (its repository,
 * `_transition` and the task layer); the class in `service_manager.js` is the
 * only caller.
 */
import { LushError, validSid } from './types.js';
import { ACTIVE_SERVICE_STATUS } from './lifecycle.js';

/**
 * The subtree rooted at `sid`, children before parents, so a row disappears
 * only after the rows that reference it. Iterative on purpose: logical trees
 * may be deeper than the call stack is tall.
 */
export function subtree(manager, sid) {
  const order = [];
  const stack = [sid];
  while (stack.length) {
    const current = stack.pop();
    order.push(current);
    for (const child of manager.repository.children(current)) stack.push(child.sid);
  }
  return order.reverse();
}

/**
 * Shared body of `delete` and `purge`. Decisions, in order: SID 0 is never
 * removable (the daemon owns it), children need `recursive`, and unfinished
 * work (an active service, or an active task on one of them) is refused unless
 * the caller asked to terminate it.
 */
export function remove(manager, sid, recursive, terminate) {
  validSid(sid);
  if (typeof recursive !== 'boolean') throw new LushError('recursive must be a boolean', -32602);
  if (sid === 0) throw new LushError('SID 0 is managed by the daemon; it cannot be deleted', -32010);
  const root = manager.repository.get(sid);
  const children = manager.repository.children(sid).map((child) => child.sid);
  if (children.length && !recursive) {
    throw new LushError(
      `service ${sid} has children [${children.join(', ')}]; delete them first, or repeat with recursive deletion`,
      -32010,
    );
  }
  const doomed = subtree(manager, sid).map((item) => manager.repository.get(item));
  const active = doomed.filter((item) => ACTIVE_SERVICE_STATUS.includes(item.status));
  const busy = doomed.flatMap((item) => manager.repository.activeTasks({ sid: item.sid }));
  if ((active.length || busy.length) && !terminate) {
    const detail = [
      ...active.map((item) => `service ${item.sid} is ${item.status}`),
      ...busy.map((task) => `task ${task.id} on service ${task.sid} is ${task.status}`),
    ].join(', ');
    throw new LushError(
      `${detail}; stop it first (cancel its task with 'lush task cancel TASK_ID'), or use 'lush service purge'`,
      -32010,
    );
  }
  // Terminate the work first: cancelling a task aborts its agent, and only then
  // can the node be stopped without leaving an agent running behind it.
  for (const task of busy) manager.cancelTask(task.id);
  const terminated = [];
  for (const item of [...doomed].reverse()) {
    if (!ACTIVE_SERVICE_STATUS.includes(item.status)) continue;
    manager._transition(item.sid, 'stopped', { adopt: false });
    terminated.push(item.sid);
  }
  // The parent outlives the child by construction (a subtree holds no
  // ancestor), so it is the one that keeps the record of what disappeared.
  const sids = doomed.map((item) => item.sid);
  const deleted = [...sids].sort((left, right) => left - right);
  const audit = root.parent_sid === null ? null : {
    sid: root.parent_sid,
    kind: 'child_deleted',
    data: { sid, name: root.name, template: root.template, status: root.status, deleted },
  };
  return {
    sid,
    deleted,
    status: root.status,
    cancelled: busy.map((task) => task.id).sort((left, right) => left - right),
    terminated: terminated.sort((left, right) => left - right),
    rows: manager.repository.remove(sids, audit),
  };
}
