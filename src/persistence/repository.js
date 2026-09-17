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

  decode(row) {
    const item = { ...row };
    item.template_snapshot = JSON.parse(item.template_snapshot);
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

  create(parentPid, template, name, goal, { root = false } = {}) {
    const stamp = now();
    const columns = 'parent_pid,original_parent_pid,name,type,status,template,template_snapshot,goal,created_at,updated_at';
    const values = [parentPid, parentPid, name, template.process_type, 'created',
      template.name, jsonDump(template), goal, stamp, stamp];
    let pid = 0;
    this.database.transaction(() => {
      if (root) {
        this.db.run(`INSERT INTO processes(pid,${columns}) VALUES(0,?,?,?,?,?,?,?,?,?,?)`, values);
        pid = 0;
      } else {
        pid = this.db.run(`INSERT INTO processes(${columns}) VALUES(?,?,?,?,?,?,?,?,?,?)`, values).lastInsertRowid;
      }
      const initial = template.initial_context;
      this.db.run('INSERT INTO contexts VALUES(?,?,?,?,?)', [
        pid, template.system_prompt,
        jsonDump(initial.state ?? {}), jsonDump(initial.artifacts ?? []), jsonDump(initial.references ?? []),
      ]);
      this.event(pid, 'created', { parent_pid: parentPid, template: template.name });
      this.db.run("UPDATE processes SET status='running' WHERE pid=?", [pid]);
      this.event(pid, 'transition', { from: 'created', to: 'running' });
    });
    return this.get(pid);
  }

  transition(pid, target, { adopt = false, result } = {}) {
    this.database.transaction(() => {
      const old = this.get(pid);
      this.db.run('UPDATE processes SET status=?,updated_at=? WHERE pid=?', [target, now(), pid]);
      this.event(pid, 'transition', { from: old.status, to: target });
      if (result !== undefined && result !== null) {
        const state = this.context(pid).state;
        state.result = result;
        // jsonDump runs inside the transaction so an invalid result rolls everything back.
        this.db.run('UPDATE contexts SET state=? WHERE pid=?', [jsonDump(state), pid]);
      }
      if (adopt && pid !== 0) {
        const children = this.db
          .query("SELECT pid FROM processes WHERE parent_pid=? AND status IN ('created','running')")
          .all(pid);
        for (const child of children) {
          this.db.run('UPDATE processes SET parent_pid=0,updated_at=? WHERE pid=?', [now(), child.pid]);
          this.event(child.pid, 'reparented', { from: pid, to: 0, reason: target });
        }
      }
    });
    return this.get(pid);
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
