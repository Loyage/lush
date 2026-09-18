/**
 * The notice channel: a task's agent reporting to the user.
 *
 * A `notices` row is the durable record of one report — who reported (`sid`,
 * `task_id`), what they need (`kind`, `title`, `body`), the answer form they
 * declared (`fields`), whether the reporter is parked on the answer (`wait`),
 * and how the user settled it (`status` / `answer` / `note`). Nothing about the
 * wait is live state: a `wait` notice is delivered back to its reporter as
 * inbox input when it is settled (see `core/tasks/messages.js`).
 *
 * Every function operates on the `Repository` passed in; the classes in
 * `repository.js` and `service_manager.js` are the only callers.
 */
import { LushError, jsonDump, now } from '../core/types.js';

/** Raw row → wire shape: `fields` and `answer` are stored as JSON. */
export function decodeNotice(row) {
  if (row === null || row === undefined) return null;
  const notice = { ...row };
  notice.fields = JSON.parse(notice.fields);
  notice.answer = notice.answer === null || notice.answer === undefined ? null : JSON.parse(notice.answer);
  notice.wait = notice.wait === 1;
  return notice;
}

const SELECT = `
SELECT n.*, s.name AS service_name, s.template AS service_template,
       t.goal AS task_goal, t.status AS task_status
  FROM notices n
  LEFT JOIN services s ON s.sid = n.sid
  LEFT JOIN tasks t ON t.id = n.task_id`;

/** Open one notice. `fields` is the already-validated declaration array. */
export function createNotice(repository, { sid, taskId, kind, title, body, fields, wait }) {
  let noticeId = 0;
  repository.database.transaction(() => {
    const stamp = now();
    noticeId = repository.db.run(
      `INSERT INTO notices(sid,task_id,kind,title,body,fields,wait,status,answer,note,
                           created_at,answered_at,updated_at)
       VALUES(?,?,?,?,?,?,?,'open',NULL,NULL,?,NULL,?)`,
      [sid, taskId, kind, title, body, jsonDump(fields), wait ? 1 : 0, stamp, stamp],
    ).lastInsertRowid;
  });
  return getNotice(repository, noticeId);
}

export function getNotice(repository, noticeId) {
  const row = repository.db.query(`${SELECT} WHERE n.id=?`).get(noticeId);
  if (row === null || row === undefined) {
    throw new LushError(`notice not found: ${noticeId}`, -32004);
  }
  return decodeNotice(row);
}

/** Same read without the not-found error, for callers that decide on absence. */
export function findNotice(repository, noticeId) {
  return decodeNotice(repository.db.query(`${SELECT} WHERE n.id=?`).get(noticeId));
}

/**
 * `notice.list`: newest first. `status` narrows to open / answered /
 * dismissed, `taskId` / `sid` to the reporter. Range checks stay in Core.
 */
export function listNotices(repository, { status = null, taskId = null, sid = null, limit = 200 } = {}) {
  const where = [];
  const args = [];
  if (status !== null) { where.push('n.status=?'); args.push(status); }
  if (taskId !== null) { where.push('n.task_id=?'); args.push(taskId); }
  if (sid !== null) { where.push('n.sid=?'); args.push(sid); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return repository.db.query(`${SELECT} ${clause} ORDER BY n.id DESC LIMIT ?`)
    .all(...args, limit)
    .map(decodeNotice);
}

/** Open notices a task's agent is still waiting on (used when the task dies). */
export function openNoticesOfTask(repository, taskId) {
  return repository.db.query(`${SELECT} WHERE n.task_id=? AND n.status='open' ORDER BY n.id`).all(taskId)
    .map(decodeNotice);
}

/**
 * How many notices a task reported that are still waiting for the user — the
 * `wait` ones. This is what says a task is `awaiting` rather than running:
 * opening a notice attaches the answer to the reporter, so the reporter cannot
 * settle until it comes back (or the user dismisses it).
 */
export function countAwaitingNotices(repository, taskId) {
  return repository.db
    .query("SELECT COUNT(*) AS n FROM notices WHERE task_id=? AND status='open' AND wait=1")
    .get(taskId).n;
}

/** How many notices still need a user (`system.status`). */
export function openNoticeCount(repository) {
  return repository.db.query("SELECT COUNT(*) AS n FROM notices WHERE status='open'").get().n;
}

/** Settle one notice: `answered` stores the fill-in, `dismissed` a reason. */
export function settleNotice(repository, noticeId, status, { answer, note } = {}) {
  repository.database.transaction(() => {
    const stamp = now();
    repository.db.run(
      'UPDATE notices SET status=?,answer=?,note=?,answered_at=?,updated_at=? WHERE id=?',
      [status, answer === undefined || answer === null ? null : jsonDump(answer),
        note === undefined || note === null ? null : String(note), stamp, stamp, noticeId],
    );
  });
  return getNotice(repository, noticeId);
}

/** A deleted task's notices keep existing, but lose the task they point at. */
export function detachTaskNotices(repository, taskId) {
  return repository.db.run('UPDATE notices SET task_id=NULL,updated_at=? WHERE task_id=?',
    [now(), taskId]).changes;
}

export function deleteNoticesOfService(repository, sid) {
  return repository.db.run('DELETE FROM notices WHERE sid=?', [sid]).changes;
}

/**
 * Dismiss the open notices of a set of tasks in one statement, with one shared
 * reason. `Repository.recover` uses it for the tasks a restarted daemon failed:
 * their reporters are gone, so nobody can answer those notices any more.
 */
export function dismissOpenNoticesOfTasks(repository, taskIds, note) {
  if (taskIds.length === 0) return 0;
  const marks = taskIds.map(() => '?').join(',');
  const stamp = now();
  return repository.db.run(
    `UPDATE notices SET status='dismissed',note=?,answered_at=?,updated_at=?
      WHERE status='open' AND task_id IN (${marks})`,
    [note, stamp, stamp, ...taskIds],
  ).changes;
}
