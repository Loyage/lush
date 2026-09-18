/**
 * The task trace (调用链): one task's collaboration timeline.
 *
 * `task.tree` shows the *shape* of a delegation — who reports to whom. This
 * module shows its *time*: every `task_construct` with either end in the
 * subtree, every `task_message` with either end in the subtree, and every
 * settlement that came back, and every notice the user settled that came back.
 * Reading it answers "while this task was being finished, what did it hand to
 * other tasks (and to the user), and what came back".
 *
 * It is a **derived read model**, not a stored one. There is no trace table:
 * the steps are exactly the rows `task_inbox` and `task_events` already hold, so
 * nothing has to be kept in sync and no write path changes. The one interaction
 * missing from the inbox — a delegation — is merged in from the parent's
 * `delegated` event, which is also why a subtree's root reads the (out-of-tree)
 * delegation that created it: the same "either end" rule as the messages.
 *
 * The subtree filter is "either end", not "receiver": a task's message *to its
 * parent* is part of its own story, and filtering on the receiver alone would
 * drop exactly the outbound edge that leaves the subtree.
 *
 * Two consequences of deriving it:
 *
 * - **Deletion is the boundary.** `task.delete` drops a task's events and its
 *   inbox rows in both directions, so a trace is a view of the rows that still
 *   exist — an observability tool, not an audit log. Read it while the work is
 *   happening (or before cleanup).
 * - **The read is bounded.** At most `limit` rows are taken from each source,
 *   newest-first, then merged; only the newest `limit` steps are returned, so a
 *   long-running task shows its tail and `total` / `truncated` say what was left
 *   out. This keeps the model inside the 1 MiB RPC frame and the 2.5s UI poll.
 */
import { LushError } from '../types.js';
import { requireTask } from './internal.js';

/** The hard cap on one trace read (the CLI help and the UI name the same number). */
const TRACE_LIMIT_MAX = 1000;

/**
 * Ordering is by time, then by a fixed kind rank so two steps written in the
 * same millisecond still read causally: the delegation first, the messages
 * about it next, the settlements last. The sort is stable, so identical keys
 * keep the construction order below.
 */
const KIND_RANK = { delegated: 0, message: 1, child_settled: 2, notice_settled: 3 };

/**
 * `task.trace`: the collaboration timeline of `taskId`'s subtree, oldest step
 * first. `limit` bounds the returned tail; `total` / `truncated` describe the
 * part that did not fit.
 */
export function trace(manager, taskId, limit = 200) {
  const task = requireTask(manager, taskId);
  if (!Number.isInteger(limit) || limit < 1 || limit > TRACE_LIMIT_MAX) {
    throw new LushError(`limit must be an integer in 1..${TRACE_LIMIT_MAX}`, -32602);
  }
  const subtree = manager.repository.taskSubtree(taskId);
  const resolve = resolver(manager);
  // A delegation is written on the *parent*, so the step that created this
  // subtree's root lives outside it; the root is the only task that can have a
  // parent outside (every other task's parent is in the subtree), so one lookup
  // covers the whole inbound side. It is also necessarily the oldest step.
  const inbound = task.parent_task_id === null
    ? null
    : manager.repository.delegationOf(task.parent_task_id, taskId);
  // Both sources come back newest-first (so the SQL `LIMIT` keeps the tail);
  // reversing each gives the ascending order the stable sort below relies on
  // when two steps share a millisecond.
  const entries = [
    ...[...manager.repository.subtreeDelegations(subtree, limit), ...(inbound === null ? [] : [inbound])]
      .reverse().map((row) => delegation(resolve, row)),
    ...manager.repository.subtreeTaskMessages(subtree, limit).reverse().map((row) => message(resolve, row)),
  ];
  entries.sort((left, right) => (left.at === right.at
    ? KIND_RANK[left.kind] - KIND_RANK[right.kind]
    : (left.at < right.at ? -1 : 1)));
  const total = manager.repository.countSubtreeDelegations(subtree)
    + manager.repository.countSubtreeTaskMessages(subtree)
    + (inbound === null ? 0 : 1);
  return {
    task_id: task.id,
    entries: entries.slice(-limit),
    total,
    truncated: total > limit,
  };
}

/**
 * One task id, resolved to its service at most once across the whole trace: the
 * endpoints repeat heavily (a parent appears in every step of its subtree), and
 * the sender of a message can live outside the subtree (the task's parent).
 * Names come from one service list, so a deleted-sid task degrades to null
 * instead of throwing the whole read away.
 */
function resolver(manager) {
  const names = new Map(manager.repository.list().map((row) => [row.sid, row.name]));
  const sids = new Map();
  const sidOf = (taskId) => {
    if (taskId === null || taskId === undefined) return null;
    if (!sids.has(taskId)) sids.set(taskId, manager.repository.findTask(taskId)?.sid ?? null);
    return sids.get(taskId);
  };
  return {
    end(taskId) {
      const sid = sidOf(taskId);
      return {
        task_id: taskId,
        sid,
        service: sid === null ? null : names.get(sid) ?? null,
      };
    },
    name(sid) {
      return sid === null || sid === undefined ? null : names.get(sid) ?? null;
    },
  };
}

/** `delegated`: the parent opened a child task. Never an inbox row. */
function delegation(resolve, row) {
  const from = resolve.end(row.task_id);
  const to = resolve.end(row.data.task_id);
  // The event carries the child's sid itself, so the step still reads right
  // after the child task was deleted (its row is the thing that is gone).
  const toSid = row.data.sid ?? to.sid;
  return {
    at: row.created_at,
    kind: 'delegated',
    from_task_id: from.task_id,
    from_sid: from.sid,
    from_service: from.service,
    to_task_id: to.task_id,
    to_sid: toSid,
    to_service: resolve.name(toSid) ?? to.service,
    delivered_at: null,
    body: null,
    goal: row.data.goal ?? null,
    status: null,
    result: null,
    error: null,
  };
}

/**
 * One inbox row: a `message` in either direction, a child's settlement, or the
 * answer to a notice the task reported (that one comes from Lush, not a task).
 */
function message(resolve, row) {
  const from = resolve.end(row.from_task_id);
  const to = resolve.end(row.to_task_id);
  const settled = row.kind === 'child_settled' ? row.data : null;
  const notice = row.kind === 'notice_settled' ? row.data : null;
  return {
    at: row.created_at,
    kind: row.kind,
    from_task_id: from.task_id,
    from_sid: from.sid,
    from_service: from.service,
    to_task_id: to.task_id,
    to_sid: to.sid,
    to_service: to.service,
    delivered_at: row.delivered_at,
    body: row.kind === 'message' ? row.body : (notice === null ? null : notice.title),
    goal: null,
    notice_id: notice === null ? null : notice.notice_id,
    status: settled === null ? notice?.status ?? null : settled.status,
    result: settled === null ? notice?.answer ?? null : settled.result ?? null,
    error: settled === null ? notice?.note ?? null : settled.error ?? null,
  };
}
