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
 * that is blocked on its child tasks, `running ⇄ awaiting` an agent parked on a
 * `notice` the user has not settled yet, and `completed / failed / cancelled`
 * are terminal. A terminal task never has an active child task: finishing,
 * failing or cancelling a task cascades into its subtree, which is what keeps
 * an observed task tree settled.
 *
 * An **intension** is one piece of user input on its way in (see
 * `core/intensions.js`): the user speaks once, the top-level parsing node turns
 * it into work. Its statuses do not form a state machine — they are the queue's
 * bookkeeping.
 */
export const ACTIVE_SERVICE_STATUS = ['created', 'active'];
export const ACTIVE_TASK_STATUS = ['created', 'running', 'waiting', 'awaiting'];

/** Service statuses: a node is either coming up, taking work, or stopped. */
export const SERVICE_TRANSITIONS = {
  created: new Set(['active', 'stopped']),
  active: new Set(['stopped']),
  stopped: new Set(['active']),
};

/** Task statuses: `waiting` waits on children, `awaiting` waits on the user. */
export const TASK_TRANSITIONS = {
  created: new Set(['running', 'completed', 'failed', 'cancelled']),
  running: new Set(['waiting', 'awaiting', 'completed', 'failed', 'cancelled']),
  waiting: new Set(['running', 'completed', 'failed', 'cancelled']),
  awaiting: new Set(['running', 'completed', 'failed', 'cancelled']),
  completed: new Set(),
  failed: new Set(),
  cancelled: new Set(),
};

/**
 * Intension statuses: raw user input that is still somewhere in the queue.
 * `queued` waits for the parsing node, `parsing` is the one being parsed right
 * now, `awaiting` is parked on a conflict notice the user has to settle, and
 * `settled` / `rejected` are the two endings (arranged, or refused/withdrawn).
 *
 * There is no transition table here: unlike services and tasks, an intension
 * moves by decision of the parser (`core/intensions.js`), not by a state
 * machine — the only structural rule is one row per parse, and the queue
 * itself is `INTENSION_OPEN_STATUS`.
 */
export const INTENSION_STATUSES = ['queued', 'parsing', 'awaiting', 'settled', 'rejected'];

/** The intensions that still occupy the queue (in order: waiting, busy, parked). */
export const INTENSION_OPEN_STATUS = ['queued', 'parsing', 'awaiting'];

/**
 * The intensions a parse task currently holds: the one it is parsing, and the
 * one it parked on a conflict notice. This is what "the parse task still owes
 * this row" means, and why such a task may not settle itself yet.
 */
export const INTENSION_HELD_STATUS = ['parsing', 'awaiting'];

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
