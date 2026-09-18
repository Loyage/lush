/**
 * The write side of the task layer: which work may be opened, how a task moves
 * between statuses, and what that does to its agent and its waiters.
 *
 * The rules (they are what keeps a task tree well-formed):
 *
 * - one active task per service: a service runs at most one agent at a time;
 * - a root task is created by the intension dispatcher alone, on the parsing
 *   node (see `core/intensions.js`) — every other task is a child task of one;
 * - child tasks go to a *direct child service* of the parent task's service,
 *   so the task tree is always a tree;
 * - a terminal task has no active children: completing requires the children to
 *   be finished, while failing / cancelling cascades into the subtree;
 * - a settling child reports to its parent through the parent's inbox, and a
 *   task may only message its direct parent / children (see `messages.js`).
 *
 * Everything operates on the `ServiceManager` passed in.
 */
import { LushError, text, validSid } from '../types.js';
import { validateTaskTransition } from '../lifecycle.js';
import { INTENSION_NODE_SID } from '../intensions.js';
import { activeChildren, isTerminal, requireTask, wake } from './internal.js';
import { notifyChildSettled } from './messages.js';

/** The service a task's children must be mounted on: a direct child of its own. */
export function delegateTargets(manager, taskId) {
  const task = requireTask(manager, taskId);
  return manager.repository.children(task.sid).map((child) => child.sid);
}

/**
 * Create and start one task. `parentTaskId === null` is a root task, which only
 * the intension dispatcher may create (`intensionId` is the row it is parsing);
 * otherwise the task is delegated to `sid`, which must be a direct child
 * service of the parent task's service.
 */
export function construct(manager, { parentTaskId = null, sid, goal, start = true, intensionId = null }) {
  validSid(sid);
  text(goal, 'goal');
  if (manager.runtime === null) throw new LushError('AgentRuntime is not bound', -32020);
  if (parentTaskId === null) {
    // Root tasks are user input, and user input arrives as an intension: the
    // only root task in Lush is the parse task the queue dispatches, always on
    // the parsing node (`core/intensions.js`). Everything else delegates down.
    if (intensionId === null) {
      throw new LushError('root tasks are created only by the intension dispatcher (intent.submit)', -32010);
    }
    if (sid !== INTENSION_NODE_SID) {
      throw new LushError(`root tasks live on the parsing node (SID ${INTENSION_NODE_SID}), not on service ${sid}`, -32010);
    }
  }
  requireActiveTarget(manager, sid);
  let parentTask = null;
  if (parentTaskId !== null) {
    parentTask = requireTask(manager, parentTaskId);
    if (isTerminal(parentTask)) {
      throw new LushError(`task ${parentTaskId} is ${parentTask.status}; it cannot construct more work`, -32009);
    }
    if (parentTask.sid === sid) {
      throw new LushError(`task ${parentTaskId} cannot delegate to its own service ${sid}`, -32010);
    }
    if (!delegateTargets(manager, parentTaskId).includes(sid)) {
      throw new LushError(
        `service ${sid} is not a child of service ${parentTask.sid}; a task may only delegate downstream`,
        -32010,
      );
    }
  }
  requireIdleTarget(manager, sid);
  const task = manager.repository.createTask(sid, parentTaskId, goal, {
    rootTaskId: parentTask === null ? 0 : parentTask.root_task_id,
  });
  if (parentTask !== null) {
    manager.repository.taskEvent(parentTask.id, 'delegated', { task_id: task.id, sid, goal });
  }
  // `start: false` hands the task to a caller that runs its agent itself
  // (`call --interactive` opens the invocation from the terminal).
  if (start) manager.runtime.startTask(task.id);
  return task;
}

/**
 * A root task on an arbitrary service, bypassing the rule above. **Internal**:
 * only the tests and an embedding caller use it, and neither the RPC surface,
 * the CLI nor the agent tools can reach it. Everything a *user* says goes
 * through `intent.submit` → `core/intensions.js` → `drain`.
 */
export function constructRoot(manager, { sid, goal, start = true }) {
  validSid(sid);
  text(goal, 'goal');
  if (manager.runtime === null) throw new LushError('AgentRuntime is not bound', -32020);
  requireActiveTarget(manager, sid);
  requireIdleTarget(manager, sid);
  const task = manager.repository.createTask(sid, null, goal, { rootTaskId: 0 });
  if (start) manager.runtime.startTask(task.id);
  return task;
}

/** The target node takes work at all (`created` is only the instant of creation). */
function requireActiveTarget(manager, sid) {
  const target = manager.repository.get(sid);
  if (target.status !== 'active') {
    throw new LushError(`service ${sid} is ${target.status}, expected active`, -32009);
  }
  return target;
}

/**
 * Nobody else is working on it: one task per service, the rule the whole
 * intension queue leans on ("serial for free").
 */
function requireIdleTarget(manager, sid) {
  const busy = manager.repository.activeTaskOfService(sid);
  if (busy !== null) {
    throw new LushError(`service ${sid} is already working on task ${busy.id}`, -32010);
  }
}

/**
 * Wait until `taskId` is terminal. Only tasks inside `fromTaskId`'s own subtree
 * may be awaited, so waiting can never form a cycle.
 */
export function waitForTask(manager, taskId, { fromTaskId = null } = {}) {
  const task = requireTask(manager, taskId);
  // The waiter's own tree is checked first: an invalid target is refused whether
  // or not it happens to be finished already.
  if (fromTaskId !== null) {
    if (taskId === fromTaskId) {
      throw new LushError(`task ${taskId} cannot wait on itself`, -32010);
    }
    if (!manager.repository.taskSubtree(fromTaskId).includes(taskId)) {
      throw new LushError(
        `task ${taskId} is not part of task ${fromTaskId}'s own tree; a task may only wait on its own downstream work`,
        -32010,
      );
    }
  }
  if (isTerminal(task)) return Promise.resolve(task);
  return new Promise((resolve) => {
    const waiters = manager.taskWaiters.get(taskId) ?? new Set();
    waiters.add(() => resolve(manager.repository.getTask(taskId)));
    manager.taskWaiters.set(taskId, waiters);
  });
}

// ── Transitions ────────────────────────────────────────────────────────────

function transition(manager, taskId, target, { result, error } = {}) {
  const task = requireTask(manager, taskId);
  if (task.status === target) return task;
  validateTaskTransition(task, target);
  return manager.repository.transitionTask(taskId, target, { result, error });
}

/** `created → running`: the agent is about to take over. */
export function start(manager, taskId) {
  return transition(manager, taskId, 'running');
}

/**
 * Park a running task that has nothing left to do this turn, and say what it is
 * parked on: `children` (child tasks still working, status `waiting`) or
 * `notice` (a notice the user has not settled, status `awaiting`). Both are the
 * same shape of wait — the task layer wakes the task when input arrives — the
 * status just tells the user whether they are the ones being waited on.
 */
export function park(manager, taskId, reason = 'children') {
  const task = requireTask(manager, taskId);
  if (task.status !== 'running') return task;
  return transition(manager, taskId, reason === 'notice' ? 'awaiting' : 'waiting');
}

/**
 * Finish a task. Completing requires every child task to be finished first:
 * agents that still have children under way are told to end their turn and be
 * woken with the results (the `task_complete` tool adds the same check for
 * unread inbox input and for a notice the user still owes an answer to; the
 * runtime parks the task on either before it would settle it, and a human
 * completing a task by hand is not blocked by a report nobody needs to read).
 */
export function complete(manager, taskId, result = undefined) {
  const task = requireTask(manager, taskId);
  const pending = activeChildren(manager, taskId);
  if (pending.length > 0) {
    throw new LushError(
      `task ${taskId} still has active child tasks [${pending.map((child) => child.id).join(', ')}]; `
      + 'end this turn and you will be woken with their results, or cancel them (task_cancel) first',
      -32010,
    );
  }
  // An unsettled notice is work the user owes this task: the answer is on its
  // way through the inbox. The run-time parks the task on an open notice before
  // it would settle it and `AgentTools.complete` refuses a mid-turn call, but
  // the rule itself stays permissive so a human can finish a task by hand.
  const updated = transition(manager, taskId, 'completed', { result, error: null });
  finish(manager, updated, 'completed');
  return updated;
}

/** Fail a task (agent error, timeout, daemon restart, cancellation of a parent). */
export function fail(manager, taskId, error) {
  const task = requireTask(manager, taskId);
  if (isTerminal(task)) return task;
  cascade(manager, taskId, 'failed', String(error ?? 'failed'));
  const updated = transition(manager, taskId, 'failed', { error: String(error ?? 'failed') });
  finish(manager, updated, 'failed');
  return updated;
}

/** Cancel a task and its whole subtree; running agents are aborted. */
export function cancel(manager, taskId) {
  const task = requireTask(manager, taskId);
  if (isTerminal(task)) return task;
  cascade(manager, taskId, 'cancelled', 'cancelled');
  const updated = transition(manager, taskId, 'cancelled');
  finish(manager, updated, 'cancelled');
  return updated;
}

/** Cancel (or fail) every active descendant, deepest first, then the task itself. */
function cascade(manager, taskId, status, reason) {
  for (const childId of manager.repository.taskSubtree(taskId)) {
    if (childId === taskId) continue;
    const child = manager.repository.findTask(childId);
    if (child === null || isTerminal(child)) continue;
    manager.runtime?.cancelTask(childId);
    const updated = transition(manager, childId, status, { error: reason });
    finish(manager, updated, status);
  }
}

/** Common tail of every terminal transition: abort the agent, report, wake waiters. */
function finish(manager, task, status) {
  if (status !== 'completed') manager.runtime?.cancelTask(task.id);
  // A reporter that dies with work still open (a `notice` the user never
  // answered, or a report nobody read) leaves notices nobody can act on:
  // dismiss them. A completed task keeps its open notices — they are results
  // and findings the user may still want to read — but a `wait` notice can no
  // longer survive it (`complete` refuses while one is open).
  if (status !== 'completed') manager.terminateNotices(task.id, `task ${task.id} ${status}`);
  // A task parked in `waiting` / `awaiting` (its agent yielded) must be
  // released: the loop wakes, sees the terminal status and returns instead of
  // leaking a promise.
  manager.resumeTask(task.id);
  // The parent learns through the same inbox a message arrives in.
  notifyChildSettled(manager, task);
  manager.repository.taskEvent(task.id, 'settled', { task_id: task.id, status });
  // The intension queue moves here, for two reasons at once: a parse task just
  // decided the outcome of its row (completed → settled, otherwise → requeued),
  // and the parsing node just became free (or a row was waiting behind this very
  // task). See `core/intensions.js`.
  manager.intensionAfterTaskSettled(task, status);
  wake(manager, task.id);
}

/** The agent of `taskId` answered and has no active children: that is the result. */
export function settleFromAnswer(manager, taskId, output) {
  const task = requireTask(manager, taskId);
  if (isTerminal(task)) return task;
  return complete(manager, taskId, output === undefined ? undefined : output);
}
