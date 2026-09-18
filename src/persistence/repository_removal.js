/**
 * The one place in Lush that removes rows: hard deletion of services and
 * everything they own.
 *
 * `delete` and `purge` both land here, children before parents, inside one
 * transaction. Every function operates on the `Repository` passed in; the class
 * in `repository.js` is the only caller.
 */
import { now } from '../core/types.js';
import { event } from './repository_state.js';

/**
 * Delete every row one sid owns, inside the caller's transaction. Order
 * matters: `messages` references `agent_calls`, and every other table
 * references `services`, so a surviving row would fail the last DELETE.
 */
export function deleteRows(repository, sid) {
  const rows = {
    messages: repository.db.run('DELETE FROM messages WHERE sid=?', [sid]).changes,
    agent_calls: repository.db.run('DELETE FROM agent_calls WHERE sid=?', [sid]).changes,
    service_events: repository.db.run('DELETE FROM service_events WHERE sid=?', [sid]).changes,
    contexts: repository.db.run('DELETE FROM contexts WHERE sid=?', [sid]).changes,
  };
  // Tasks are mounted on the service, so they go with it; child tasks that live
  // on surviving services are re-pointed at themselves (they become roots).
  const detached = repository.detachServiceTasks([sid]);
  rows.tasks = detached.tasks;
  rows.task_events = detached.task_events;
  rows.services = repository.db.run('DELETE FROM services WHERE sid=?', [sid]).changes;
  return rows;
}

/**
 * Hard-delete services, children before parents, in one transaction; returns
 * the total row counts. This is the only place in Lush that removes rows.
 *
 * A Service that a deleted sid created and that was later adopted by SID 0
 * still names it in `original_parent_sid`, and a row may not outlive the sid
 * it points at (the column is NOT NULL, so it cannot be cleared either). Such
 * survivors are therefore re-pointed at SID 0 — the same value their
 * `parent_sid` already holds — and each gets a `parent_deleted` event naming
 * the sid that is gone, so the lineage stays readable.
 *
 * `audit` writes one extra event (`{ sid, kind, data }`) for the sid that
 * keeps a record of what disappeared, typically the deleted service's parent.
 */
export function remove(repository, sids, audit = null) {
  const doomed = new Set(sids);
  return repository.database.transaction(() => {
    const rows = { services: 0, contexts: 0, agent_calls: 0, messages: 0, service_events: 0, tasks: 0, task_events: 0 };
    for (const sid of sids) {
      const removed = repository.get(sid);
      for (const survivor of repository.db.query('SELECT sid FROM services WHERE original_parent_sid=?').all(sid)) {
        if (doomed.has(survivor.sid)) continue;
        repository.db.run('UPDATE services SET original_parent_sid=0,updated_at=? WHERE sid=?', [now(), survivor.sid]);
        event(repository, survivor.sid, 'parent_deleted', {
          sid, name: removed.name, template: removed.template, status: removed.status,
        });
      }
      for (const [table, count] of Object.entries(deleteRows(repository, sid))) rows[table] += count;
    }
    if (audit !== null) event(repository, audit.sid, audit.kind, audit.data);
    return rows;
  });
}
