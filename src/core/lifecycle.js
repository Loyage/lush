import { LushError } from './types.js';

/**
 * Two state machines, one per kind of row.
 *
 * A **service** is a passive node: it holds identity, permissions, variables
 * and state, and never runs an agent itself. Its short life is `created →
 * active ⇄ stopped` — stopped just means "this node takes no new work".
 *
 * A **task** is one unit of work mounted on a service, and it is where agents
 * run. `created → running` starts the agent, `running ⇄ waiting` marks an agent
 * that is blocked on its child tasks, and `completed / failed / cancelled` are
 * terminal. A terminal task never has an active child task: finishing,
 * failing or cancelling a task cascades into its subtree, which is what keeps
 * an observed task tree settled.
 */
export const ACTIVE_SERVICE_STATUS = ['created', 'active'];
export const ACTIVE_TASK_STATUS = ['created', 'running', 'waiting'];

/** Service statuses: a node is either coming up, taking work, or stopped. */
export const SERVICE_TRANSITIONS = {
  created: new Set(['active', 'stopped']),
  active: new Set(['stopped']),
  stopped: new Set(['active']),
};

/** Task statuses: `waiting` is a running agent blocked on its child tasks. */
export const TASK_TRANSITIONS = {
  created: new Set(['running', 'completed', 'failed', 'cancelled']),
  running: new Set(['waiting', 'completed', 'failed', 'cancelled']),
  waiting: new Set(['running', 'completed', 'failed', 'cancelled']),
  completed: new Set(),
  failed: new Set(),
  cancelled: new Set(),
};

export function validateServiceTransition(service, target) {
  const allowed = SERVICE_TRANSITIONS[service.status] ?? new Set();
  if (!allowed.has(target)) {
    throw new LushError(`cannot transition service ${service.sid} from ${service.status} to ${target}`);
  }
}

export function validateTaskTransition(task, target) {
  const allowed = TASK_TRANSITIONS[task.status] ?? new Set();
  if (!allowed.has(target)) {
    throw new LushError(`cannot transition task ${task.id} from ${task.status} to ${target}`);
  }
}
