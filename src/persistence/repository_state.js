/**
 * Context, state, events and history: everything attached to one service
 * besides its own row.
 *
 * The persistent Context owns the system prompt, `state`, artifacts and
 * references; its two variable regions (`state.params` / `state.vars`) are
 * written only by the variable system through `updateVars`. Events are the
 * append-only audit trail. Every function operates on the `Repository` passed
 * in; the class in `repository.js` is the only caller.
 */
import { jsonDump, now } from '../core/types.js';

/** Append one service event. The only writer of `service_events`. */
export function event(repository, sid, kind, data) {
  repository.db.run('INSERT INTO service_events(sid,kind,data,created_at) VALUES(?,?,?,?)',
    [sid, kind, jsonDump(data), now()]);
}

/** The most recent events of a service, newest first. */
export function events(repository, sid, limit = 20) {
  return repository.db.query('SELECT * FROM service_events WHERE sid=? ORDER BY id DESC LIMIT ?').all(sid, limit)
    .map((row) => ({ ...row, data: JSON.parse(row.data) }));
}

export function context(repository, sid) {
  repository.get(sid);
  const row = repository.db.query('SELECT * FROM contexts WHERE sid=?').get(sid);
  const count = repository.db.query('SELECT COUNT(*) AS n FROM messages WHERE sid=?').get(sid).n;
  return {
    system_prompt: row.system_prompt,
    state: JSON.parse(row.state),
    artifacts: JSON.parse(row.artifacts),
    references: JSON.parse(row.refs),
    message_count: count,
  };
}

/**
 * Replace one service's Context system prompt. The call prompt comes from the
 * Context, not from the template snapshot (`buildInvocation` reads
 * `context.context.systemPrompt`), so a service whose prompt must follow a
 * template edit needs this in addition to `replaceSnapshot`. Used for SID 0
 * alone, by `ServiceManager.refreshRootTemplate`; every other service keeps the
 * prompt it was created with. Returns whether the prompt actually changed.
 */
export function replaceContextPrompt(repository, sid, systemPrompt) {
  let changed = false;
  repository.database.transaction(() => {
    const row = repository.db.query('SELECT system_prompt FROM contexts WHERE sid=?').get(sid);
    if (row === null || row.system_prompt === systemPrompt) return;
    repository.db.run('UPDATE contexts SET system_prompt=? WHERE sid=?', [systemPrompt, sid]);
    changed = true;
  });
  return changed;
}

/**
 * The agent profile a service selected at construct time (`state.agent`), or null.
 * Reading one column keeps `service tree` cheap: it resolves a provider name per
 * row without walking sessions or counting messages.
 */
export function stateAgent(repository, sid) {
  const row = repository.db.query('SELECT state FROM contexts WHERE sid=?').get(sid);
  if (row === null) return null;
  const state = JSON.parse(row.state);
  const name = state === null || typeof state !== 'object' ? undefined : state.agent;
  return typeof name === 'string' && name !== '' ? name : null;
}

export function updateState(repository, sid, patch) {
  let state;
  repository.database.transaction(() => {
    state = context(repository, sid).state;
    Object.assign(state, patch);
    repository.db.run('UPDATE contexts SET state=? WHERE sid=?', [jsonDump(state), sid]);
    repository.db.run('UPDATE services SET updated_at=? WHERE sid=?', [now(), sid]);
    event(repository, sid, 'state_updated', { keys: Object.keys(patch) });
  });
  return state;
}

/**
 * Merge values into the mutable variable region (`state.vars`). Which names
 * may be changed is decided by ServiceManager against the template snapshot;
 * this layer only stores the merge.
 */
export function updateVars(repository, sid, patch) {
  let vars;
  repository.database.transaction(() => {
    const state = context(repository, sid).state;
    vars = { ...(state.vars ?? {}), ...patch };
    state.vars = vars;
    repository.db.run('UPDATE contexts SET state=? WHERE sid=?', [jsonDump(state), sid]);
    repository.db.run('UPDATE services SET updated_at=? WHERE sid=?', [now(), sid]);
    event(repository, sid, 'vars_updated', { keys: Object.keys(patch) });
  });
  return vars;
}

/** One page of one task's persisted messages, plus the cursor that continues it. */
export function history(repository, taskId, after = 0, limit = 100) {
  repository.getTask(taskId);
  const messages = repository.db
    .query('SELECT * FROM messages WHERE task_id=? AND id>? ORDER BY id LIMIT ?')
    .all(taskId, after, limit)
    .map((row) => ({ ...row, body: JSON.parse(row.body) }));
  return { messages, next_after: messages.length ? messages[messages.length - 1].id : after };
}

/**
 * Add fields that were introduced after this row was written, leaving every
 * other snapshot key untouched. Returns the fields actually added.
 */
export function backfillSnapshot(repository, sid, fields) {
  const added = [];
  repository.database.transaction(() => {
    const row = repository.db.query('SELECT template_snapshot FROM services WHERE sid=?').get(sid);
    if (row === null) return;
    const snapshot = JSON.parse(row.template_snapshot);
    for (const [key, value] of Object.entries(fields)) {
      if (Object.hasOwn(snapshot, key)) continue;
      snapshot[key] = value;
      added.push(key);
    }
    if (added.length === 0) return;
    repository.db.run('UPDATE services SET template_snapshot=? WHERE sid=?', [jsonDump(snapshot), sid]);
    event(repository, sid, 'template_backfilled', { fields: added });
  });
  return added;
}
