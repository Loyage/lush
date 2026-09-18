/**
 * Context, state, events and history: everything attached to one process
 * besides its own row.
 *
 * The persistent Context owns the system prompt, `state`, artifacts and
 * references; its two variable regions (`state.params` / `state.vars`) are
 * written only by the variable system through `updateVars`. Events are the
 * append-only audit trail. Every function operates on the `Repository` passed
 * in; the class in `repository.js` is the only caller.
 */
import { jsonDump, now } from '../core/types.js';

/** Append one process event. The only writer of `process_events`. */
export function event(repository, pid, kind, data) {
  repository.db.run('INSERT INTO process_events(pid,kind,data,created_at) VALUES(?,?,?,?)',
    [pid, kind, jsonDump(data), now()]);
}

/** The most recent events of a process, newest first. */
export function events(repository, pid, limit = 20) {
  return repository.db.query('SELECT * FROM process_events WHERE pid=? ORDER BY id DESC LIMIT ?').all(pid, limit)
    .map((row) => ({ ...row, data: JSON.parse(row.data) }));
}

export function context(repository, pid) {
  repository.get(pid);
  const row = repository.db.query('SELECT * FROM contexts WHERE pid=?').get(pid);
  const count = repository.db.query('SELECT COUNT(*) AS n FROM messages WHERE pid=?').get(pid).n;
  return {
    system_prompt: row.system_prompt,
    state: JSON.parse(row.state),
    artifacts: JSON.parse(row.artifacts),
    references: JSON.parse(row.refs),
    message_count: count,
  };
}

/**
 * The agent profile a process selected at spawn time (`state.agent`), or null.
 * Reading one column keeps `process tree` cheap: it resolves a provider name per
 * row without walking sessions or counting messages.
 */
export function stateAgent(repository, pid) {
  const row = repository.db.query('SELECT state FROM contexts WHERE pid=?').get(pid);
  if (row === null) return null;
  const state = JSON.parse(row.state);
  const name = state === null || typeof state !== 'object' ? undefined : state.agent;
  return typeof name === 'string' && name !== '' ? name : null;
}

export function updateState(repository, pid, patch) {
  let state;
  repository.database.transaction(() => {
    state = context(repository, pid).state;
    Object.assign(state, patch);
    repository.db.run('UPDATE contexts SET state=? WHERE pid=?', [jsonDump(state), pid]);
    repository.db.run('UPDATE processes SET updated_at=? WHERE pid=?', [now(), pid]);
    event(repository, pid, 'state_updated', { keys: Object.keys(patch) });
  });
  return state;
}

/**
 * Merge values into the mutable variable region (`state.vars`). Which names
 * may be changed is decided by ProcessManager against the template snapshot;
 * this layer only stores the merge.
 */
export function updateVars(repository, pid, patch) {
  let vars;
  repository.database.transaction(() => {
    const state = context(repository, pid).state;
    vars = { ...(state.vars ?? {}), ...patch };
    state.vars = vars;
    repository.db.run('UPDATE contexts SET state=? WHERE pid=?', [jsonDump(state), pid]);
    repository.db.run('UPDATE processes SET updated_at=? WHERE pid=?', [now(), pid]);
    event(repository, pid, 'vars_updated', { keys: Object.keys(patch) });
  });
  return vars;
}

/** One page of persisted messages, plus the cursor that continues it. */
export function history(repository, pid, after = 0, limit = 100) {
  repository.get(pid);
  const messages = repository.db
    .query('SELECT * FROM messages WHERE pid=? AND id>? ORDER BY id LIMIT ?')
    .all(pid, after, limit)
    .map((row) => ({ ...row, body: JSON.parse(row.body) }));
  return { messages, next_after: messages.length ? messages[messages.length - 1].id : after };
}

/**
 * Add fields that were introduced after this row was written, leaving every
 * other snapshot key untouched. Returns the fields actually added.
 */
export function backfillSnapshot(repository, pid, fields) {
  const added = [];
  repository.database.transaction(() => {
    const row = repository.db.query('SELECT template_snapshot FROM processes WHERE pid=?').get(pid);
    if (row === null) return;
    const snapshot = JSON.parse(row.template_snapshot);
    for (const [key, value] of Object.entries(fields)) {
      if (Object.hasOwn(snapshot, key)) continue;
      snapshot[key] = value;
      added.push(key);
    }
    if (added.length === 0) return;
    repository.db.run('UPDATE processes SET template_snapshot=? WHERE pid=?', [jsonDump(snapshot), pid]);
    event(repository, pid, 'template_backfilled', { fields: added });
  });
  return added;
}
