/**
 * The intension queue: raw user input, before it is any work.
 *
 * An `intensions` row is one thing the user said — their own words
 * (`content`), the service they named (`sid`, NULL when they named none) — plus
 * the queue's bookkeeping: where it is (`status`), how many times the parser
 * tried (`attempts`), which root task is parsing it (`parse_task_id`), what a
 * user decision parked it behind (`blocked_by_task_id`), and what came of it
 * (`resolution` / `response`).
 *
 * Nothing here decides anything: which row is next, what a settle may say, and
 * who may move a row are `core/intensions.js`. These are the statements, the
 * row decoding, and the foreign-key bookkeeping that keeps a deleted service or
 * task from leaving a dangling pointer behind.
 *
 * Every function operates on the `Repository` passed in; the class in
 * `repository.js` is the only caller.
 */
import { LushError, jsonDump, now } from '../core/types.js';
import { ACTIVE_TASK_STATUS, INTENSION_HELD_STATUS, INTENSION_OPEN_STATUS } from '../core/lifecycle.js';

/** Raw row → wire shape: `resolution` is stored as JSON, like every other column of its kind. */
export function decodeIntension(row) {
  if (row === null || row === undefined) return null;
  const intension = { ...row };
  intension.resolution = intension.resolution === null || intension.resolution === undefined
    ? null
    : JSON.parse(intension.resolution);
  return intension;
}

/**
 * Rows carry the facts a reader would otherwise join for: the named service
 * (name / template / status — the same shape notices report), how the parse
 * task is doing (`parse_task_status`: `parsing` covers running / waiting /
 * awaiting of that task), and whether the task a user decision parked it behind
 * is still alive.
 */
const SELECT = `
SELECT i.*, s.name AS service_name, s.template AS service_template, s.status AS service_status,
       t.status AS parse_task_status, b.status AS blocker_status
  FROM intensions i
  LEFT JOIN services s ON s.sid = i.sid
  LEFT JOIN tasks t ON t.id = i.parse_task_id
  LEFT JOIN tasks b ON b.id = i.blocked_by_task_id`;

/** Record one piece of user input. `content` is stored verbatim; nothing rewrites it. */
export function createIntension(repository, { sid, content, source }) {
  let intensionId = 0;
  repository.database.transaction(() => {
    const stamp = now();
    intensionId = repository.db.run(
      `INSERT INTO intensions(sid,content,source,status,parse_task_id,blocked_by_task_id,attempts,
                              resolution,response,created_at,updated_at,settled_at)
       VALUES(?,?,?,'queued',NULL,NULL,0,NULL,NULL,?,?,NULL)`,
      [sid, content, source, stamp, stamp],
    ).lastInsertRowid;
  });
  return getIntension(repository, intensionId);
}

export function getIntension(repository, intensionId) {
  const row = repository.db.query(`${SELECT} WHERE i.id=?`).get(intensionId);
  if (row === null || row === undefined) {
    throw new LushError(`intension not found: ${intensionId}`, -32004);
  }
  return decodeIntension(row);
}

/** Same read without the not-found error, for callers that decide on absence. */
export function findIntension(repository, intensionId) {
  return decodeIntension(repository.db.query(`${SELECT} WHERE i.id=?`).get(intensionId));
}

/**
 * `intent.list`: the queue and its history, newest first. `status` narrows to
 * one status, `open` to the whole queue. `sid` narrows to the service the user
 * named, and the two "absent" values are different questions: `undefined` means
 * *any* target, `null` means *the user named none*.
 */
export function listIntensions(repository, { status = null, sid = undefined, open = false, limit = 200 } = {}) {
  const where = [];
  const args = [];
  if (open) {
    where.push(`i.status IN (${INTENSION_OPEN_STATUS.map(() => '?').join(',')})`);
    args.push(...INTENSION_OPEN_STATUS);
  }
  if (status !== null) { where.push('i.status=?'); args.push(status); }
  if (sid !== undefined) {
    if (sid === null) where.push('i.sid IS NULL');
    else { where.push('i.sid=?'); args.push(sid); }
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return repository.db.query(`${SELECT} ${clause} ORDER BY i.id DESC LIMIT ?`)
    .all(...args, limit)
    .map(decodeIntension);
}

/** Every row still occupying the queue, oldest first (the parser's backlog). */
export function openIntensions(repository) {
  const marks = INTENSION_OPEN_STATUS.map(() => '?').join(',');
  return repository.db.query(`${SELECT} WHERE i.status IN (${marks}) ORDER BY i.id`)
    .all(...INTENSION_OPEN_STATUS)
    .map(decodeIntension);
}

/**
 * The next row that may be parsed: oldest first, and only once nothing is left
 * to wait for. A `blocked_by_task_id` that is still active (or that a `defer`
 * set) keeps the row out of the way; a NULL one — including a deleted task —
 * is free, which is what makes the drain retry it after that task settles.
 */
export function nextQueuedIntension(repository) {
  const marks = ACTIVE_TASK_STATUS.map(() => '?').join(',');
  const row = repository.db.query(`${SELECT}
    WHERE i.status='queued'
      AND (i.blocked_by_task_id IS NULL OR b.id IS NULL OR b.status NOT IN (${marks}))
    ORDER BY i.id LIMIT 1`).get(...ACTIVE_TASK_STATUS);
  return decodeIntension(row);
}

/** How many intensions are still in the queue (`system.status`). */
export function openIntensionCount(repository) {
  const marks = INTENSION_OPEN_STATUS.map(() => '?').join(',');
  return repository.db.query(`SELECT COUNT(*) AS n FROM intensions WHERE status IN (${marks})`)
    .get(...INTENSION_OPEN_STATUS).n;
}

/**
 * Hand the row to the parse task that will work on it: `parsing`, one more
 * attempt. `blocked_by_task_id` and `resolution` are kept on purpose — the
 * parser sees why this row waited and why it is back.
 */
export function beginParsing(repository, intensionId, taskId) {
  repository.database.transaction(() => {
    repository.db.run(
      "UPDATE intensions SET status='parsing',parse_task_id=?,attempts=attempts+1,updated_at=? WHERE id=?",
      [taskId, now(), intensionId],
    );
  });
  return getIntension(repository, intensionId);
}

/** The parser was answering a conflict notice and is running again. */
export function resumeParsing(repository, intensionId) {
  repository.database.transaction(() => {
    repository.db.run(
      "UPDATE intensions SET status='parsing',updated_at=? WHERE id=? AND status='awaiting'",
      [now(), intensionId],
    );
  });
  return getIntension(repository, intensionId);
}

/** The parser posted a conflict notice and parked on the user's answer. */
export function parkAwaiting(repository, intensionId) {
  repository.database.transaction(() => {
    repository.db.run(
      "UPDATE intensions SET status='awaiting',updated_at=? WHERE id=? AND status='parsing'",
      [now(), intensionId],
    );
  });
  return getIntension(repository, intensionId);
}

/** The end of the road: arranged (`settled`) or refused / withdrawn (`rejected`). */
export function settleIntension(repository, intensionId, { status, resolution, response = null }) {
  repository.database.transaction(() => {
    const stamp = now();
    repository.db.run(
      'UPDATE intensions SET status=?,resolution=?,response=?,settled_at=?,updated_at=? WHERE id=?',
      [status, jsonDump(resolution ?? null), response, stamp, stamp, intensionId],
    );
  });
  return getIntension(repository, intensionId);
}

/**
 * The user chose "let that task finish first": back into the queue, but behind
 * `blockedByTaskId` (`nextQueuedIntension` skips it until that task settles).
 * The parse task is released — it has nothing left to do with this row.
 */
export function deferIntension(repository, intensionId, { blockedByTaskId, resolution }) {
  repository.database.transaction(() => {
    repository.db.run(
      "UPDATE intensions SET status='queued',blocked_by_task_id=?,parse_task_id=NULL,resolution=?,updated_at=? WHERE id=?",
      [blockedByTaskId, jsonDump(resolution ?? null), now(), intensionId],
    );
  });
  return getIntension(repository, intensionId);
}

/**
 * The parse never happened (its task died, or arranged nothing): back into the
 * queue to be tried again, with no blocker — a retry is not a wait. `attempts`
 * is left alone; it is what bounds the retry (`core/intensions.js`).
 */
export function requeueIntension(repository, intensionId, { resolution }) {
  repository.database.transaction(() => {
    repository.db.run(
      "UPDATE intensions SET status='queued',blocked_by_task_id=NULL,parse_task_id=NULL,resolution=?,updated_at=? WHERE id=?",
      [jsonDump(resolution ?? null), now(), intensionId],
    );
  });
  return getIntension(repository, intensionId);
}

/** The row a parse task is still responsible for (parsing or parked on the user). */
export function openIntensionOfTask(repository, taskId) {
  const marks = INTENSION_HELD_STATUS.map(() => '?').join(',');
  return decodeIntension(repository.db.query(`${SELECT} WHERE i.parse_task_id=? AND i.status IN (${marks}) ORDER BY i.id LIMIT 1`)
    .get(taskId, ...INTENSION_HELD_STATUS));
}

/**
 * A row this task already settled, but without saying anything: the parser has
 * a second chance to answer (see `recordIntensionResponse`).
 */
export function silentIntensionOfTask(repository, taskId) {
  return decodeIntension(repository.db.query(
    "SELECT * FROM intensions WHERE parse_task_id=? AND status='settled' AND (response IS NULL OR response='') ORDER BY id LIMIT 1",
  ).get(taskId));
}

/**
 * Fill in the answer of a row the parser settled before it had one to give.
 * Only ever called with a non-empty response, and only for a row that has none —
 * what a row says is never *changed* after the fact, only recorded.
 */
export function recordIntensionResponse(repository, intensionId, response) {
  return repository.db.run('UPDATE intensions SET response=?,updated_at=? WHERE id=?',
    [response, now(), intensionId]).changes;
}

/**
 * A restarted daemon just failed every task it could not vouch for, including
 * the parse tasks: the rows they were parsing go back to the queue instead of
 * waiting forever behind a dead task. Called inside `Repository.recover`'s
 * transaction, right after the tasks were failed.
 */
export function requeueParsingIntensions(repository, note) {
  const marks = INTENSION_HELD_STATUS.map(() => '?').join(',');
  return repository.db.run(
    `UPDATE intensions SET status='queued',parse_task_id=NULL,resolution=?,updated_at=?
      WHERE status IN (${marks})`,
    [jsonDump({ kind: 'requeue', reason: note }), now(), ...INTENSION_HELD_STATUS],
  ).changes;
}

/**
 * A task row is being deleted: drop both pointers that name it. Clearing the
 * blocker is not cosmetic — a freed row becomes eligible for the drain again,
 * which is exactly right when the thing it was waiting for is gone.
 */
export function detachTaskIntensions(repository, taskId) {
  const stamp = now();
  return {
    blockers: repository.db.run('UPDATE intensions SET blocked_by_task_id=NULL,updated_at=? WHERE blocked_by_task_id=?',
      [stamp, taskId]).changes,
    parsers: repository.db.run('UPDATE intensions SET parse_task_id=NULL,updated_at=? WHERE parse_task_id=?',
      [stamp, taskId]).changes,
  };
}

/**
 * A service row is being deleted: rows naming it lose their target. A row the
 * parser is still holding goes back to the queue — its target is gone, so the
 * decision has to be made again against the service tree that is left.
 */
export function detachServiceIntensions(repository, sid) {
  const stamp = now();
  const marks = INTENSION_HELD_STATUS.map(() => '?').join(',');
  const requeued = repository.db.run(
    `UPDATE intensions SET sid=NULL,status='queued',parse_task_id=NULL,updated_at=?
      WHERE sid=? AND status IN (${marks})`,
    [stamp, sid, ...INTENSION_HELD_STATUS],
  ).changes;
  const detached = repository.db.run('UPDATE intensions SET sid=NULL,updated_at=? WHERE sid=?',
    [stamp, sid]).changes;
  return { detached, requeued };
}
