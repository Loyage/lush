/** Persistence operations. No Agent, RPC or CLI dependencies. */
import { LushError, jsonDump, now, validPid } from '../core/types.js';

export class Repository {
  constructor(database) {
    this.database = database;
    this.db = database.connection;
  }

  event(pid, kind, data) {
    this.db.run('INSERT INTO process_events(pid,kind,data,created_at) VALUES(?,?,?,?)',
      [pid, kind, jsonDump(data), now()]);
  }

  /**
   * Read model row: metadata plus the process variables. Variable values are
   * the two mutability regions of the persistent state (immutable values in
   * `state.params`, mutable ones in `state.vars`), and the declarations are
   * read from the creation-time template snapshot so that editing a template
   * file later cannot silently re-open a variable the process was created with.
   */
  decode(row) {
    const item = { ...row };
    item.template_snapshot = JSON.parse(item.template_snapshot);
    const state = this.db.query('SELECT state FROM contexts WHERE pid=?').get(item.pid);
    const stored = state === null ? {} : JSON.parse(state.state);
    const declared = item.template_snapshot.variables ?? {};
    item.variables = {
      immutable: stored.params ?? {},
      mutable: stored.vars ?? {},
      declarations: { immutable: declared.immutable ?? {}, mutable: declared.mutable ?? {} },
    };
    item.children = this.db
      .query('SELECT pid FROM processes WHERE parent_pid=? ORDER BY pid')
      .all(item.pid)
      .map((child) => child.pid);
    return item;
  }

  get(pid) {
    validPid(pid);
    const row = this.db.query('SELECT * FROM processes WHERE pid=?').get(pid);
    if (row === null) throw new LushError(`process not found: ${pid}`, -32004);
    return this.decode(row);
  }

  exists(pid) {
    return this.db.query('SELECT 1 FROM processes WHERE pid=?').get(pid) !== null;
  }

  list() {
    return this.db.query('SELECT * FROM processes ORDER BY pid').all().map((row) => this.decode(row));
  }

  children(pid) {
    this.get(pid);
    return this.db.query('SELECT * FROM processes WHERE parent_pid=? ORDER BY pid')
      .all(pid)
      .map((row) => this.decode(row));
  }

  create(parentPid, template, name, goal, { root = false, variables = null } = {}) {
    const stamp = now();
    const columns = 'parent_pid,original_parent_pid,name,type,status,template,template_snapshot,goal,created_at,updated_at';
    const values = [parentPid, parentPid, name, template.type, 'created',
      template.name, jsonDump(template), goal, stamp, stamp];
    let pid = 0;
    this.database.transaction(() => {
      if (root) {
        this.db.run(`INSERT INTO processes(pid,${columns}) VALUES(0,?,?,?,?,?,?,?,?,?,?)`, values);
        pid = 0;
      } else {
        pid = this.db.run(`INSERT INTO processes(${columns}) VALUES(?,?,?,?,?,?,?,?,?,?)`, values).lastInsertRowid;
      }
      // Templates carry no initial Context: state, artifacts and references always
      // start empty. Creation-time variables are stored by mutability region:
      // immutable values in state.params, mutable ones in state.vars.
      const state = {};
      if (variables !== null && Object.keys(variables.immutable).length) state.params = variables.immutable;
      if (variables !== null && Object.keys(variables.mutable).length) state.vars = variables.mutable;
      this.db.run('INSERT INTO contexts VALUES(?,?,?,?,?)', [pid, template.system_prompt, jsonDump(state), '[]', '[]']);
      this.event(pid, 'created', { parent_pid: parentPid, template: template.name });
      this.db.run("UPDATE processes SET status='running' WHERE pid=?", [pid]);
      this.event(pid, 'transition', { from: 'created', to: 'running' });
    });
    return this.get(pid);
  }

  /**
   * Active (created/running) children of `parentPid` that were created from
   * `template`. Singleton templates refuse creation while this is non-zero;
   * stopped, completed, failed, cancelled and reclaimed instances do not count.
   */
  activeCount(parentPid, template) {
    return this.db
      .query("SELECT COUNT(*) AS n FROM processes WHERE parent_pid=? AND template=? AND status IN ('created','running')")
      .get(parentPid, template).n;
  }

  /**
   * Move one process to `target` and, in the same transaction, apply the
   * parent's policy to its active direct children: `adopt` reparents them to
   * PID 0, `terminate` freezes them (Service → stopped, Task → cancelled).
   * PID 0 is exempt from both, so daemon shutdown stays a change to PID 0
   * alone.
   *
   * `cause` is the supervision reason (`orphan_ttl`, `orphan_limit`) and is
   * only recorded in the transition event when given. `effects` is an optional
   * out-parameter: every child action is pushed as
   * `{ pid, from, to, kind: 'adopted' | 'terminated' }` so the ProcessManager
   * can cancel the running calls of terminated children *after* this
   * transaction, where cancelling is a runtime side effect and cannot be
   * rolled back. The crash window between state change and cancellation is
   * covered by `recover()` on the next daemon start.
   */
  transition(pid, target, {
    adopt = false, terminate = false, result, cause, effects = null,
  } = {}) {
    this.database.transaction(() => {
      const old = this.get(pid);
      this.db.run('UPDATE processes SET status=?,updated_at=? WHERE pid=?', [target, now(), pid]);
      // `cause` records *why* a supervised process was frozen (orphan_ttl,
      // orphan_limit, parent_terminated); every other transition keeps the
      // two-field payload older readers expect.
      this.event(pid, 'transition',
        cause === undefined ? { from: old.status, to: target } : { from: old.status, to: target, cause });
      if (result !== undefined && result !== null) {
        const state = this.context(pid).state;
        state.result = result;
        // jsonDump runs inside the transaction so an invalid result rolls everything back.
        this.db.run('UPDATE contexts SET state=? WHERE pid=?', [jsonDump(state), pid]);
      }
      // PID 0 never adopts and never terminates children: daemon shutdown does
      // `transition(0, 'stopped')` and must stay a change to PID 0 alone.
      if ((adopt || terminate) && pid !== 0) {
        const children = this.db
          .query("SELECT pid,type,status FROM processes WHERE parent_pid=? AND status IN ('created','running')")
          .all(pid);
        for (const child of children) {
          if (adopt) {
            this.db.run('UPDATE processes SET parent_pid=0,updated_at=? WHERE pid=?', [now(), child.pid]);
            this.event(child.pid, 'reparented', { from: pid, to: 0, reason: target });
            if (effects !== null) effects.push({ pid: child.pid, from: child.status, to: child.status, kind: 'adopted' });
            continue;
          }
          // The child is frozen, not deleted, and only this one level is
          // written here: each frozen child goes through the same policy again
          // in ProcessManager, which is what walks an active chain down.
          const childTarget = child.type === 'service' ? 'stopped' : 'cancelled';
          this.db.run('UPDATE processes SET status=?,updated_at=? WHERE pid=?', [childTarget, now(), child.pid]);
          this.event(child.pid, 'transition', { from: child.status, to: childTarget, cause: 'parent_terminated' });
          if (effects !== null) effects.push({ pid: child.pid, from: child.status, to: childTarget, kind: 'terminated' });
        }
      }
    });
    return this.get(pid);
  }

  /**
   * Every process PID 0 adopted, terminal ones included (the supervision read
   * model shows what it froze as well as what it still holds). Raw rows: no
   * JSON decoding, no variables, just the columns the policy needs plus the two
   * activity stamps used to compute `last_activity_at`.
   */
  orphans() {
    return this.db.query(`
      SELECT p.pid, p.name, p.type, p.status, p.template, p.parent_pid, p.original_parent_pid,
             p.created_at, p.updated_at, p.goal,
             (SELECT MAX(m.created_at) FROM messages m WHERE m.pid = p.pid) AS last_message_at,
             (SELECT MAX(COALESCE(c.finished_at, c.started_at)) FROM agent_calls c WHERE c.pid = p.pid) AS last_call_at
      FROM processes p
      WHERE p.parent_pid = 0 AND p.pid > 0
        AND p.original_parent_pid IS NOT NULL AND p.original_parent_pid != 0
      ORDER BY p.pid
    `).all();
  }

  /**
   * Delete every row one pid owns, inside the caller's transaction. Order
   * matters: `messages` references `agent_calls`, and every other table
   * references `processes`, so a surviving row would fail the last DELETE.
   */
  _deleteRows(pid) {
    return {
      messages: this.db.run('DELETE FROM messages WHERE pid=?', [pid]).changes,
      agent_calls: this.db.run('DELETE FROM agent_calls WHERE pid=?', [pid]).changes,
      process_events: this.db.run('DELETE FROM process_events WHERE pid=?', [pid]).changes,
      contexts: this.db.run('DELETE FROM contexts WHERE pid=?', [pid]).changes,
      processes: this.db.run('DELETE FROM processes WHERE pid=?', [pid]).changes,
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
  remove(pids, audit = null) {
    const doomed = new Set(pids);
    return this.database.transaction(() => {
      const rows = { processes: 0, contexts: 0, agent_calls: 0, messages: 0, process_events: 0 };
      for (const pid of pids) {
        const removed = this.get(pid);
        for (const survivor of this.db.query('SELECT pid FROM processes WHERE original_parent_pid=?').all(pid)) {
          if (doomed.has(survivor.pid)) continue;
          this.db.run('UPDATE processes SET original_parent_pid=0,updated_at=? WHERE pid=?', [now(), survivor.pid]);
          this.event(survivor.pid, 'parent_deleted', {
            pid, name: removed.name, template: removed.template, status: removed.status,
          });
        }
        for (const [table, count] of Object.entries(this._deleteRows(pid))) rows[table] += count;
      }
      if (audit !== null) this.event(audit.pid, audit.kind, audit.data);
      return rows;
    });
  }

  /**
   * Add fields that were introduced after this row was written, leaving every
   * other snapshot key untouched. Returns the fields actually added.
   */
  backfillSnapshot(pid, fields) {
    const added = [];
    this.database.transaction(() => {
      const row = this.db.query('SELECT template_snapshot FROM processes WHERE pid=?').get(pid);
      if (row === null) return;
      const snapshot = JSON.parse(row.template_snapshot);
      for (const [key, value] of Object.entries(fields)) {
        if (Object.hasOwn(snapshot, key)) continue;
        snapshot[key] = value;
        added.push(key);
      }
      if (added.length === 0) return;
      this.db.run('UPDATE processes SET template_snapshot=? WHERE pid=?', [jsonDump(snapshot), pid]);
      this.event(pid, 'template_backfilled', { fields: added });
    });
    return added;
  }

  context(pid) {
    this.get(pid);
    const row = this.db.query('SELECT * FROM contexts WHERE pid=?').get(pid);
    const count = this.db.query('SELECT COUNT(*) AS n FROM messages WHERE pid=?').get(pid).n;
    return {
      system_prompt: row.system_prompt,
      state: JSON.parse(row.state),
      artifacts: JSON.parse(row.artifacts),
      references: JSON.parse(row.refs),
      message_count: count,
    };
  }

  updateState(pid, patch) {
    let state;
    this.database.transaction(() => {
      state = this.context(pid).state;
      Object.assign(state, patch);
      this.db.run('UPDATE contexts SET state=? WHERE pid=?', [jsonDump(state), pid]);
      this.db.run('UPDATE processes SET updated_at=? WHERE pid=?', [now(), pid]);
      this.event(pid, 'state_updated', { keys: Object.keys(patch) });
    });
    return state;
  }

  /**
   * Merge values into the mutable variable region (`state.vars`). Which names
   * may be changed is decided by ProcessManager against the template snapshot;
   * this layer only stores the merge.
   */
  updateVars(pid, patch) {
    let vars;
    this.database.transaction(() => {
      const state = this.context(pid).state;
      vars = { ...(state.vars ?? {}), ...patch };
      state.vars = vars;
      this.db.run('UPDATE contexts SET state=? WHERE pid=?', [jsonDump(state), pid]);
      this.db.run('UPDATE processes SET updated_at=? WHERE pid=?', [now(), pid]);
      this.event(pid, 'vars_updated', { keys: Object.keys(patch) });
    });
    return vars;
  }

  beginCall(pid, prompt) {
    let callId = 0;
    this.database.transaction(() => {
      callId = this.db.run(
        "INSERT INTO agent_calls(pid,prompt,status,started_at) VALUES(?,?,'running',?)",
        [pid, prompt, now()],
      ).lastInsertRowid;
      this.addMessage(pid, callId, { role: 'user', content: prompt });
    });
    return callId;
  }

  addMessage(pid, callId, body) {
    this.db.run('INSERT INTO messages(pid,call_id,body,created_at) VALUES(?,?,?,?)',
      [pid, callId, jsonDump(body), now()]);
  }

  finishCall(callId, status, { output, error } = {}) {
    this.db.run("UPDATE agent_calls SET status=?,output=?,error=?,finished_at=? WHERE id=? AND status='running'",
      [status, output ?? null, error ?? null, now(), callId]);
  }

  calls(pid, limit = 20) {
    return this.db.query('SELECT * FROM agent_calls WHERE pid=? ORDER BY id DESC LIMIT ?').all(pid, limit);
  }

  /** One call row by id, whenever it happened (agent history is not paginated away). */
  callById(callId) {
    return this.db.query('SELECT * FROM agent_calls WHERE id=?').get(callId) ?? null;
  }

  events(pid, limit = 20) {
    return this.db.query('SELECT * FROM process_events WHERE pid=? ORDER BY id DESC LIMIT ?').all(pid, limit)
      .map((row) => ({ ...row, data: JSON.parse(row.data) }));
  }

  history(pid, after = 0, limit = 100) {
    this.get(pid);
    const messages = this.db
      .query('SELECT * FROM messages WHERE pid=? AND id>? ORDER BY id LIMIT ?')
      .all(pid, after, limit)
      .map((row) => ({ ...row, body: JSON.parse(row.body) }));
    return { messages, next_after: messages.length ? messages[messages.length - 1].id : after };
  }

  /**
   * Replay complete calls verbatim; failed calls as plain audit dialogue.
   * Dangling assistant.tool_calls must never be sent back to a provider.
   */
  conversation(pid, currentCall) {
    const calls = this.db.query('SELECT * FROM agent_calls WHERE pid=? ORDER BY id').all(pid);
    const result = [];
    for (const call of calls) {
      if (call.status === 'succeeded' || call.id === currentCall) {
        const rows = this.db.query('SELECT body FROM messages WHERE call_id=? ORDER BY id').all(call.id);
        result.push(...rows.map((row) => JSON.parse(row.body)));
      } else {
        result.push(
          { role: 'user', content: call.prompt },
          {
            role: 'assistant',
            content: `[Lush audit: invocation ${call.id} ${call.status}; `
              + 'tool effects may have committed. Inspect process state/events before retrying.]',
          },
        );
      }
    }
    return result;
  }

  recover() {
    this.database.transaction(() => {
      this.db.run("UPDATE agent_calls SET status='interrupted',error='daemon restarted',finished_at=? WHERE status='running'",
        [now()]);
      if (this.exists(0)) {
        this.db.run("UPDATE processes SET status='running',updated_at=? WHERE pid=0", [now()]);
        this.event(0, 'daemon_started', {});
      }
    });
  }
}
