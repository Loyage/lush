/**
 * The one place in Lush that removes rows: hard deletion of processes and
 * everything they own.
 *
 * `delete` and `purge` both land here, children before parents, inside one
 * transaction. Every function operates on the `Repository` passed in; the class
 * in `repository.js` is the only caller.
 */
import { now } from '../core/types.js';
import { event } from './repository_state.js';

/**
 * Delete every row one pid owns, inside the caller's transaction. Order
 * matters: `messages` references `agent_calls`, and every other table
 * references `processes`, so a surviving row would fail the last DELETE.
 */
export function deleteRows(repository, pid) {
  return {
    messages: repository.db.run('DELETE FROM messages WHERE pid=?', [pid]).changes,
    agent_calls: repository.db.run('DELETE FROM agent_calls WHERE pid=?', [pid]).changes,
    process_events: repository.db.run('DELETE FROM process_events WHERE pid=?', [pid]).changes,
    contexts: repository.db.run('DELETE FROM contexts WHERE pid=?', [pid]).changes,
    processes: repository.db.run('DELETE FROM processes WHERE pid=?', [pid]).changes,
  };
}

/**
 * Hard-delete processes, children before parents, in one transaction; returns
 * the total row counts. This is the only place in Lush that removes rows.
 *
 * A Process that a deleted pid created and that was later adopted by PID 0
 * still names it in `original_parent_pid`, and a row may not outlive the pid
 * it points at (the column is NOT NULL, so it cannot be cleared either). Such
 * survivors are therefore re-pointed at PID 0 — the same value their
 * `parent_pid` already holds — and each gets a `parent_deleted` event naming
 * the pid that is gone, so the lineage stays readable.
 *
 * `audit` writes one extra event (`{ pid, kind, data }`) for the pid that
 * keeps a record of what disappeared, typically the deleted process's parent.
 */
export function remove(repository, pids, audit = null) {
  const doomed = new Set(pids);
  return repository.database.transaction(() => {
    const rows = { processes: 0, contexts: 0, agent_calls: 0, messages: 0, process_events: 0 };
    for (const pid of pids) {
      const removed = repository.get(pid);
      for (const survivor of repository.db.query('SELECT pid FROM processes WHERE original_parent_pid=?').all(pid)) {
        if (doomed.has(survivor.pid)) continue;
        repository.db.run('UPDATE processes SET original_parent_pid=0,updated_at=? WHERE pid=?', [now(), survivor.pid]);
        event(repository, survivor.pid, 'parent_deleted', {
          pid, name: removed.name, template: removed.template, status: removed.status,
        });
      }
      for (const [table, count] of Object.entries(deleteRows(repository, pid))) rows[table] += count;
    }
    if (audit !== null) event(repository, audit.pid, audit.kind, audit.data);
    return rows;
  });
}
