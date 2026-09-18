/**
 * The task layer: one unit of work mounted on a process.
 *
 * A process is passive — identity, permissions, variables, state. Work arrives
 * as a **task**: the user's `call` opens a root task on a process, and that
 * task's agent gets the job done by opening child tasks on the process's own
 * children (`task_spawn`) and collecting them (`task_wait`). Tasks therefore
 * form a tree that grows along the process tree, which is exactly what
 * `lush task tree` shows: how one piece of work was solved by cooperation
 * between processes.
 *
 * Rules this module enforces (they are what keeps a task tree well-formed):
 *
 * - one active task per process: a process runs at most one agent at a time;
 * - child tasks go to a *direct child process* of the parent task's process,
 *   so the task tree is always a tree and `task_wait` can never deadlock;
 * - a terminal task has no active children: completing requires the children to
 *   be finished, while failing / cancelling cascades into the subtree;
 * - `task_wait` only accepts tasks in the waiter's own subtree.
 *
 * Everything operates on the `ProcessManager` passed in; the class in
 * `process_manager.js` is the only caller.
 */
import { LushError, isPlainObject, jsonDump, text, validPid } from './types.js';
import { ACTIVE_TASK_STATUS, validateTaskTransition } from './lifecycle.js';

/** Wire shape of one task: the row plus how far it has come. */
export function summary(task) {
  return {
    id: task.id,
    pid: task.pid,
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

function activeChildren(manager, taskId) {
  return manager.repository.childTasks(taskId)
    .filter((task) => ACTIVE_TASK_STATUS.includes(task.status));
}

function requireTask(manager, taskId) {
  validPid(taskId);
  return manager.repository.getTask(taskId);
}

function isTerminal(task) {
  return !ACTIVE_TASK_STATUS.includes(task.status);
}

// ── Waiting ────────────────────────────────────────────────────────────────
//
// Waiting is in-memory: waiter and waited-on task live in the same daemon, and
// a restarted daemon fails the task instead of resuming it (see
// `Repository.recover`). `taskWaiters` is keyed by task id; `childWaiters` is
// keyed by the *parent* task id and fires when any of its children settles —
// that is what lets an agent that answered early be woken with the results.

function wake(manager, taskId) {
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

/** The process a task's children must be mounted on: a direct child of its own. */
export function delegateTargets(manager, taskId) {
  const task = requireTask(manager, taskId);
  return manager.repository.children(task.pid).map((child) => child.pid);
}

/**
 * Create and start one task. `parentTaskId === null` is the user-facing root
 * task (created by `call`); otherwise the task is delegated to `pid`, which
 * must be a direct child process of the parent task's process.
 */
export function spawn(manager, { parentTaskId = null, pid, goal, start = true }) {
  validPid(pid);
  text(goal, 'goal');
  if (manager.runtime === null) throw new LushError('AgentRuntime is not bound', -32020);
  const target = manager.repository.get(pid);
  if (target.status !== 'active') {
    throw new LushError(`process ${pid} is ${target.status}, expected active`, -32009);
  }
  let parentTask = null;
  if (parentTaskId !== null) {
    parentTask = requireTask(manager, parentTaskId);
    if (isTerminal(parentTask)) {
      throw new LushError(`task ${parentTaskId} is ${parentTask.status}; it cannot spawn more work`, -32009);
    }
    if (parentTask.pid === pid) {
      throw new LushError(`task ${parentTaskId} cannot delegate to its own process ${pid}`, -32010);
    }
    if (!delegateTargets(manager, parentTaskId).includes(pid)) {
      throw new LushError(
        `process ${pid} is not a child of process ${parentTask.pid}; a task may only delegate downstream`,
        -32010,
      );
    }
  }
  const busy = manager.repository.activeTaskOfProcess(pid);
  if (busy !== null) {
    throw new LushError(`process ${pid} is already working on task ${busy.id}`, -32010);
  }
  const task = manager.repository.createTask(pid, parentTaskId, goal, {
    rootTaskId: parentTask === null ? 0 : parentTask.root_task_id,
  });
  if (parentTask !== null) {
    manager.repository.taskEvent(parentTask.id, 'delegated', { task_id: task.id, pid, goal });
  }
  // `start: false` hands the task to a caller that runs its agent itself
  // (`call --interactive` opens the invocation from the terminal).
  if (start) manager.runtime.startTask(task.id);
  return task;
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

/** Resolve once `taskId` has no active child task (immediately when it has none). */
export async function waitForChildren(manager, taskId) {
  while (activeChildren(manager, taskId).length > 0) {
    await new Promise((resolve) => {
      const waiters = manager.childWaiters.get(taskId) ?? new Set();
      waiters.add(resolve);
      manager.childWaiters.set(taskId, waiters);
    });
  }
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

/** Mark an agent that is blocked on its child tasks (and back again). */
export function markWaiting(manager, taskId, waiting = true) {
  const task = requireTask(manager, taskId);
  if (waiting) return task.status === 'running' ? transition(manager, taskId, 'waiting') : task;
  return task.status === 'waiting' ? transition(manager, taskId, 'running') : task;
}

/**
 * Finish a task. Completing requires every child task to be finished first:
 * agents that still have children under way are told to wait or cancel them.
 */
export function complete(manager, taskId, result = undefined) {
  const task = requireTask(manager, taskId);
  const pending = activeChildren(manager, taskId);
  if (pending.length > 0) {
    throw new LushError(
      `task ${taskId} still has active child tasks [${pending.map((child) => child.id).join(', ')}]; `
      + 'wait for them (task_wait) or cancel them (task_cancel) first',
      -32010,
    );
  }
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

/** Common tail of every terminal transition: abort the agent and wake waiters. */
function finish(manager, task, status) {
  if (status !== 'completed') manager.runtime?.cancelTask(task.id);
  manager.repository.taskEvent(task.id, 'settled', { task_id: task.id, status });
  wake(manager, task.id);
}

/** The agent of `taskId` answered and has no active children: that is the result. */
export function settleFromAnswer(manager, taskId, output) {
  const task = requireTask(manager, taskId);
  if (isTerminal(task)) return task;
  return complete(manager, taskId, output === undefined ? undefined : output);
}

// ── Read models ────────────────────────────────────────────────────────────

export function list(manager, { pid = null, status = null, roots = null, limit = 200 } = {}) {
  if (pid !== null) validPid(pid);
  if (status !== null && !TASK_STATUSES.includes(status)) {
    throw new LushError(`unknown task status: ${status} (expected ${TASK_STATUSES.join(', ')})`, -32602);
  }
  if (roots !== null && roots !== 'roots' && roots !== 'children') {
    throw new LushError("roots must be 'roots' or 'children'", -32602);
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new LushError('limit must be 1..1000', -32602);
  }
  return manager.repository.listTasks({ pid, status, root: roots, limit }).map(summary);
}

export const TASK_STATUSES = ['created', 'running', 'waiting', 'completed', 'failed', 'cancelled'];

export function inspect(manager, taskId) {
  const task = requireTask(manager, taskId);
  const pid = task.pid;
  const process = manager.repository.get(pid);
  const parent = task.parent_task_id === null ? null : manager.repository.findTask(task.parent_task_id);
  const calls = manager.repository.callsOfTask(taskId);
  return {
    ...summary(task),
    process: {
      pid: process.pid,
      name: process.name,
      template: process.template,
      status: process.status,
      parent_pid: process.parent_pid,
    },
    parent_task: parent === null ? null : summary(parent),
    child_tasks: manager.repository.childTasks(taskId).map(summary),
    recent_calls: calls.slice(0, 10),
    recent_events: manager.repository.taskEvents(taskId),
    messages: manager.repository.taskMessages(taskId).length,
  };
}

/** `task tree`: the task with its whole subtree of delegated work. */
export function tree(manager, taskId) {
  const task = requireTask(manager, taskId);
  const node = (current) => {
    const row = current.id === taskId ? current : manager.repository.getTask(current.id);
    const process = manager.repository.get(row.pid);
    return {
      ...summary(row),
      // The process name makes the tree readable: a task is always "on" one node.
      process_name: process.name,
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
    pid: task.pid,
    status: task.status,
    finished: isTerminal(task),
    result: task.result,
    error: task.error,
  };
}

/** Shallow-merge the task's own scratch state (the process state is separate). */
export function updateState(manager, taskId, patch) {
  requireTask(manager, taskId);
  if (!isPlainObject(patch)) throw new LushError('patch must be an object', -32602);
  jsonDump(patch);
  return manager.repository.updateTaskState(taskId, patch);
}

/**
 * Remove one finished task's rows (its calls and messages stay, because they
 * belong to the process's history — only the task row and its events go). The
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

/** Root tasks of one process, newest first (`process inspect`). */
export function tasksOfProcess(manager, pid) {
  return manager.repository.tasksOfProcess(pid).map(summary);
}

/** Every active task in the daemon, oldest first (orphan supervision / status). */
export function activeTasks(manager) {
  return manager.repository.activeTasks().map(summary);
}
