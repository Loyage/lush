/**
 * The task inbox: the input a task receives from its direct parent / children.
 *
 * A row is one piece of input: `kind='message'` is a message a parent task sent
 * to a child (or the reverse), `kind='child_settled'` is the report that one of
 * the task's children finished. Neither interrupts a running agent invocation:
 * rows sit with `delivered_at IS NULL` until the task layer hands them to the
 * agent between two invocations, at which point they are stamped delivered.
 *
 * Every function operates on the `Repository` passed in; the class in
 * `repository.js` is the only caller.
 */
import { jsonDump, now } from '../core/types.js';

export function decodeInbox(row) {
  if (row === null || row === undefined) return null;
  return { ...row, data: JSON.parse(row.data) };
}

export function createTaskMessage(repository, { toTaskId, fromTaskId, kind, body, data }) {
  const id = repository.db.run(
    `INSERT INTO task_inbox(to_task_id,from_task_id,kind,body,data,created_at,delivered_at)
     VALUES(?,?,?,?,?,?,NULL)`,
    [toTaskId, fromTaskId, kind, body, jsonDump(data), now()],
  ).lastInsertRowid;
  return decodeInbox(repository.db.query('SELECT * FROM task_inbox WHERE id=?').get(id));
}

/** Input handed to a task but not yet passed to its agent, oldest first. */
export function undeliveredTaskMessages(repository, taskId) {
  return repository.db
    .query('SELECT * FROM task_inbox WHERE to_task_id=? AND delivered_at IS NULL ORDER BY id')
    .all(taskId)
    .map(decodeInbox);
}

export function countUndeliveredTaskMessages(repository, taskId) {
  return repository.db
    .query('SELECT COUNT(*) AS n FROM task_inbox WHERE to_task_id=? AND delivered_at IS NULL')
    .get(taskId).n;
}

/** Mark input rows as handed to the agent (idempotent). */
export function deliverTaskMessages(repository, ids) {
  if (ids.length === 0) return 0;
  const stamp = now();
  let changed = 0;
  repository.database.transaction(() => {
    for (const id of ids) {
      changed += repository.db.run('UPDATE task_inbox SET delivered_at=? WHERE id=? AND delivered_at IS NULL',
        [stamp, id]).changes;
    }
  });
  return changed;
}

/** The whole mailbox of one task, oldest first (`delivered` says whether the agent saw it). */
export function listTaskMessages(repository, taskId, { after = 0, limit = 50 } = {}) {
  return repository.db
    .query('SELECT * FROM task_inbox WHERE to_task_id=? AND id>? ORDER BY id LIMIT ?')
    .all(taskId, after, limit)
    .map(decodeInbox);
}

/** Input rows of one task, newest first (`task inspect` shows the recent ones). */
export function recentTaskMessages(repository, taskId, limit = 10) {
  return repository.db
    .query('SELECT * FROM task_inbox WHERE to_task_id=? ORDER BY id DESC LIMIT ?')
    .all(taskId, limit)
    .map(decodeInbox);
}

/** A deleted task's mailbox (both directions) is meaningless without it. */
export function deleteTaskInbox(repository, taskId) {
  return repository.db.run('DELETE FROM task_inbox WHERE to_task_id=? OR from_task_id=?',
    [taskId, taskId]).changes;
}
