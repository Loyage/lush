/**
 * The task record: one unit of work mounted on a service.
 *
 * A `tasks` row is the durable identity of a piece of work — its goal, its
 * status, its result and its place in the task tree. The conversation that
 * produced it lives in `agent_calls` / `messages` next to it (both carry the
 * `task_id`), and the agent that is *currently* working on it is runtime data
 * (see `agent/agent_space.js`). Every function operates on the `Repository`
 * passed in; the class in `repository.js` is the only caller.
 */
import { LushError, jsonDump, now, validSid } from '../core/types.js';

/** Task statuses that mean "the work is not finished yet". */
export const ACTIVE_TASK_STATUS = ['created', 'running', 'waiting'];

/**
 * Raw row → wire shape (no joins). `state` and `result` are stored as JSON, so
 * both are decoded here; `result` may legitimately be a string, an object or
 * null, which is why it is a JSON column rather than TEXT.
 */
export function decodeTask(row) {
  if (row === null || row === undefined) return null;
  const task = { ...row };
  task.state = JSON.parse(task.state);
  task.result = task.result === null || task.result === undefined ? null : JSON.parse(task.result);
  return task;
}

/** Open one task. `rootTaskId` is filled in by the caller for root tasks. */
export function createTask(repository, sid, parentTaskId, goal, { rootTaskId = 0 } = {}) {
  validSid(sid);
  let taskId = 0;
  repository.database.transaction(() => {
    const stamp = now();
    taskId = repository.db.run(
      `INSERT INTO tasks(sid,parent_task_id,root_task_id,goal,status,result,error,state,
                         created_at,started_at,finished_at,updated_at)
       VALUES(?,?,?,?,'created',NULL,NULL,'{}',?,NULL,NULL,?)`,
      [sid, parentTaskId, rootTaskId, goal, stamp, stamp],
    ).lastInsertRowid;
    // A root task is its own root; a child inherits its parent's.
    repository.db.run('UPDATE tasks SET root_task_id=? WHERE id=?',
      [parentTaskId === null ? taskId : rootTaskId, taskId]);
    repository.event(sid, 'task_created', { task_id: taskId, parent_task_id: parentTaskId, goal });
    taskEvent(repository, taskId, 'created', { sid, parent_task_id: parentTaskId });
  });
  return getTask(repository, taskId);
}

export function getTask(repository, taskId) {
  const row = repository.db.query('SELECT * FROM tasks WHERE id=?').get(taskId);
  if (row === null || row === undefined) throw new LushError(`task not found: ${taskId}`, -32004);
  return decodeTask(row);
}

/** Raw row without the JSON decode (internal decisions). */
export function rawTask(repository, taskId) {
  return repository.db.query('SELECT * FROM tasks WHERE id=?').get(taskId) ?? null;
}

export function findTask(repository, taskId) {
  return decodeTask(repository.db.query('SELECT * FROM tasks WHERE id=?').get(taskId));
}

export function listTasks(repository, { sid = null, status = null, root = null, limit = 200 } = {}) {
  const where = [];
  const args = [];
  if (sid !== null) { where.push('sid=?'); args.push(sid); }
  if (status !== null) { where.push('status=?'); args.push(status); }
  if (root === 'roots') where.push('parent_task_id IS NULL');
  if (root === 'children') where.push('parent_task_id IS NOT NULL');
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return repository.db.query(`SELECT * FROM tasks ${clause} ORDER BY id DESC LIMIT ?`)
    .all(...args, limit)
    .map(decodeTask);
}

/** Every task mounted on one service, oldest first (tree rendering). */
export function tasksOfService(repository, sid) {
  return repository.db.query('SELECT * FROM tasks WHERE sid=? ORDER BY id').all(sid).map(decodeTask);
}

export function childTasks(repository, taskId) {
  return repository.db.query('SELECT * FROM tasks WHERE parent_task_id=? ORDER BY id').all(taskId).map(decodeTask);
}

export function activeTasks(repository, { sid = null } = {}) {
  const marks = ACTIVE_TASK_STATUS.map(() => '?').join(',');
  const rows = sid === null
    ? repository.db.query(`SELECT * FROM tasks WHERE status IN (${marks}) ORDER BY id`).all(...ACTIVE_TASK_STATUS)
    : repository.db.query(`SELECT * FROM tasks WHERE sid=? AND status IN (${marks}) ORDER BY id`)
      .all(sid, ...ACTIVE_TASK_STATUS);
  return rows.map(decodeTask);
}

/** The task currently occupying one service, if any (one active task per service). */
export function activeTaskOfService(repository, sid) {
  const marks = ACTIVE_TASK_STATUS.map(() => '?').join(',');
  return decodeTask(repository.db
    .query(`SELECT * FROM tasks WHERE sid=? AND status IN (${marks}) ORDER BY id LIMIT 1`)
    .get(sid, ...ACTIVE_TASK_STATUS));
}

/**
 * Move one task to `target`. Only the columns that belong to the status
 * change are written, and `result` / `error` are JSON-encoded here so an
 * invalid value rolls the whole transition back.
 */
export function transitionTask(repository, taskId, target, { result, error } = {}) {
  repository.database.transaction(() => {
    const old = rawTask(repository, taskId);
    if (old === null) throw new LushError(`task not found: ${taskId}`, -32004);
    const fields = ['status=?', 'updated_at=?'];
    const args = [target, now()];
    if (old.started_at === null && (target === 'running' || target === 'waiting')) {
      fields.push('started_at=?');
      args.push(now());
    }
    if (target === 'completed' || target === 'failed' || target === 'cancelled') {
      fields.push('finished_at=?');
      args.push(now());
    }
    if (result !== undefined) {
      fields.push('result=?');
      args.push(result === null ? null : jsonDump(result));
    }
    if (error !== undefined) {
      fields.push('error=?');
      args.push(error === null ? null : String(error));
    }
    args.push(taskId);
    repository.db.run(`UPDATE tasks SET ${fields.join(',')} WHERE id=?`, args);
    if (old.status !== target) taskEvent(repository, taskId, 'transition', { from: old.status, to: target });
  });
  return getTask(repository, taskId);
}

/** Task-scoped state: shallow merge, same rules as a service's state. */
export function updateTaskState(repository, taskId, patch) {
  let state = null;
  repository.database.transaction(() => {
    const row = rawTask(repository, taskId);
    if (row === null) throw new LushError(`task not found: ${taskId}`, -32004);
    const merged = { ...JSON.parse(row.state), ...patch };
    repository.db.run('UPDATE tasks SET state=?,updated_at=? WHERE id=?', [jsonDump(merged), now(), taskId]);
    state = merged;
  });
  return state;
}

export function taskEvent(repository, taskId, kind, data) {
  repository.db.run('INSERT INTO task_events(task_id,kind,data,created_at) VALUES(?,?,?,?)',
    [taskId, kind, jsonDump(data), now()]);
}

export function taskEvents(repository, taskId, limit = 20) {
  return repository.db
    .query('SELECT * FROM task_events WHERE task_id=? ORDER BY id DESC LIMIT ?')
    .all(taskId, limit)
    .map((row) => ({ ...row, data: JSON.parse(row.data) }));
}

/**
 * The `delegated` events of a set of tasks, newest first. A delegation is the
 * one interaction that never enters an inbox — it is written on the parent when
 * `task_construct` opens the child — so the chain read model merges it in from
 * here.
 */
export function subtreeDelegations(repository, taskIds, limit) {
  if (taskIds.length === 0) return [];
  const marks = taskIds.map(() => '?').join(',');
  return repository.db
    .query(`SELECT * FROM task_events WHERE kind='delegated' AND task_id IN (${marks})
            ORDER BY id DESC LIMIT ?`)
    .all(...taskIds, limit)
    .map((row) => ({ ...row, data: JSON.parse(row.data) }));
}

/** How many delegations the set made (the trace's `total`). */
export function countSubtreeDelegations(repository, taskIds) {
  if (taskIds.length === 0) return 0;
  const marks = taskIds.map(() => '?').join(',');
  return repository.db
    .query(`SELECT COUNT(*) AS n FROM task_events WHERE kind='delegated' AND task_id IN (${marks})`)
    .get(...taskIds).n;
}

/**
 * The one `delegated` event that created `childTaskId` under `parentTaskId`, if
 * it is still there. A delegation is written on the parent, so this is how a
 * subtree reads the edge that *entered* it: only the subtree's root can have
 * its creator outside, so one lookup is all a trace needs. The `task_id`
 * predicate is indexed; `json_extract` then filters that one parent's rows.
 */
export function delegationOf(repository, parentTaskId, childTaskId) {
  const row = repository.db
    .query("SELECT * FROM task_events WHERE kind='delegated' AND task_id=? AND json_extract(data,'$.task_id')=?")
    .get(parentTaskId, childTaskId);
  return row === null || row === undefined ? null : { ...row, data: JSON.parse(row.data) };
}

/** The calls of one task, oldest first. */
export function taskCalls(repository, taskId) {
  return repository.db.query('SELECT * FROM agent_calls WHERE task_id=? ORDER BY id').all(taskId);
}

/** Messages of one task's conversation, oldest first. */
export function taskMessages(repository, taskId) {
  return repository.db
    .query('SELECT * FROM messages WHERE task_id=? ORDER BY id')
    .all(taskId)
    .map((row) => ({ ...row, body: JSON.parse(row.body) }));
}

/** Ids of every task in one task's subtree, the task itself first. */
export function taskSubtree(repository, taskId) {
  const seen = [];
  const stack = [taskId];
  while (stack.length) {
    const current = stack.pop();
    seen.push(current);
    for (const child of repository.db.query('SELECT id FROM tasks WHERE parent_task_id=?').all(current)) {
      stack.push(child.id);
    }
  }
  return seen;
}

/** Delete task rows (and their events) in the caller's transaction. */
export function deleteTaskRows(repository, taskIds) {
  const rows = { tasks: 0, task_events: 0 };
  for (const taskId of taskIds) {
    rows.task_events += repository.db.run('DELETE FROM task_events WHERE task_id=?', [taskId]).changes;
    // Child tasks that survive a deleted parent become roots of their own.
    repository.db.run('UPDATE tasks SET parent_task_id=NULL,root_task_id=id,updated_at=? WHERE parent_task_id=?',
      [now(), taskId]);
    // The calls and messages stay: they are the service's conversation history.
    // They only lose the task they belonged to (like calls written before tasks
    // existed), because the row they point at is going away. Notices keep their
    // own record for the same reason.
    repository.db.run('UPDATE agent_calls SET task_id=NULL WHERE task_id=?', [taskId]);
    repository.db.run('UPDATE messages SET task_id=NULL WHERE task_id=?', [taskId]);
    repository.detachTaskNotices(taskId);
    // Inbox rows name the task in both directions, so they go with it.
    repository.deleteTaskInbox(taskId);
    rows.tasks += repository.db.run('DELETE FROM tasks WHERE id=?', [taskId]).changes;
  }
  return rows;
}

/**
 * Tasks mounted on services that are about to disappear. Their child tasks may
 * live on services that survive, so those are re-pointed at themselves (roots)
 * by `deleteTaskRows` instead of being deleted with their parent.
 */
export function tasksOnServices(repository, sids) {
  const ids = [];
  for (const sid of sids) {
    for (const row of repository.db.query('SELECT id FROM tasks WHERE sid=? ORDER BY id DESC').all(sid)) {
      ids.push(row.id);
    }
  }
  return ids;
}

export function detachServiceTasks(repository, sids) {
  return deleteTaskRows(repository, tasksOnServices(repository, sids));
}
