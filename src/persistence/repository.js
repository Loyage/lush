/**
 * Persistence operations. No Agent, RPC or CLI dependencies.
 *
 * This class is the only way the rest of Lush reaches the database, and it
 * keeps the `processes` entity plus the transaction rules that span entities
 * (`transition`, `remove`, `recover`). Two concerns live in sibling modules and
 * are delegated to from here so the call sites keep their signatures: the
 * Context / state / events / history side (`repository_state.js`) and the calls
 * and messages side (`repository_calls.js`).
 */
import { LushError, jsonDump, now, validPid } from '../core/types.js';
import {
  backfillSnapshot, context, event, events, history, replaceContextPrompt, stateAgent, updateState, updateVars,
} from './repository_state.js';
import { addMessage, beginCall, callById, calls, callsOfTask, conversation, finishCall } from './repository_calls.js';
import { deleteRows, remove } from './repository_removal.js';
import * as tasks from './repository_tasks.js';

export class Repository {
  constructor(database) {
    this.database = database;
    this.db = database.connection;
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
    // The agent profile this process selected at spawn time (null = the
    // daemon's fallback tier). It lives in the Context state next to the
    // variables, so reading it costs nothing extra here.
    item.agent_profile = typeof stored.agent === 'string' && stored.agent !== '' ? stored.agent : null;
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

  /**
   * Insert one process row plus its Context, both in one transaction; the row
   * starts as `created` and is moved to `active` before returning.
   */
  create(parentPid, template, name, goal, { root = false, variables = null, agent = null } = {}) {
    const stamp = now();
    const columns = 'parent_pid,original_parent_pid,name,status,template,template_snapshot,goal,created_at,updated_at';
    const values = [parentPid, parentPid, name, 'created',
      template.name, jsonDump(template), goal, stamp, stamp];
    let pid = 0;
    this.database.transaction(() => {
      if (root) {
        this.db.run(`INSERT INTO processes(pid,${columns}) VALUES(0,?,?,?,?,?,?,?,?,?)`, values);
        pid = 0;
      } else {
        pid = this.db.run(`INSERT INTO processes(${columns}) VALUES(?,?,?,?,?,?,?,?,?)`, values).lastInsertRowid;
      }
      // Templates carry no initial Context: state, artifacts and references always
      // start empty. Creation-time variables are stored by mutability region:
      // immutable values in state.params, mutable ones in state.vars. The
      // selected agent profile is recorded in the same state so every later read
      // (`inspect`, `tree`, a call) knows which backend this PID asked for.
      const state = {};
      if (variables !== null && Object.keys(variables.immutable).length) state.params = variables.immutable;
      if (variables !== null && Object.keys(variables.mutable).length) state.vars = variables.mutable;
      if (agent !== null && agent !== undefined) state.agent = agent;
      this.db.run('INSERT INTO contexts VALUES(?,?,?,?,?)', [pid, template.system_prompt, jsonDump(state), '[]', '[]']);
      this.event(pid, 'created', { parent_pid: parentPid, template: template.name });
      this.db.run("UPDATE processes SET status='active' WHERE pid=?", [pid]);
      this.event(pid, 'transition', { from: 'created', to: 'active' });
    });
    return this.get(pid);
  }

  /**
   * Active (created/active) children of `parentPid` that were created from
   * `template`. Singleton templates refuse creation while this is non-zero;
   * stopped instances do not count.
   */
  activeCount(parentPid, template) {
    return this.db
      .query("SELECT COUNT(*) AS n FROM processes WHERE parent_pid=? AND template=? AND status IN ('created','active')")
      .get(parentPid, template).n;
  }

  /**
   * Move one process to `target` and, in the same transaction, apply the
   * parent's policy to its active direct children: `adopt` reparents them to
   * PID 0, `terminate` freezes them (always → stopped). PID 0 is exempt from
   * both, so daemon shutdown stays a change to PID 0 alone.
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
          .query("SELECT pid,status FROM processes WHERE parent_pid=? AND status IN ('created','active')")
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
          const childTarget = 'stopped';
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
      SELECT p.pid, p.name, p.status, p.template, p.parent_pid, p.original_parent_pid,
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
   * A restarted daemon must not inherit work it cannot vouch for: dangling
   * calls become interrupted, tasks that were running or waiting become
   * `failed` (their agents are gone), and PID 0 goes back to active.
   */
  recover() {
    this.database.transaction(() => {
      this.db.run("UPDATE agent_calls SET status='interrupted',error='daemon restarted',finished_at=? WHERE status='running'",
        [now()]);
      const abandoned = this.db.query("SELECT id FROM tasks WHERE status IN ('created','running','waiting')").all();
      for (const row of abandoned) {
        this.db.run("UPDATE tasks SET status='failed',error='daemon restarted',finished_at=?,updated_at=? WHERE id=?",
          [now(), now(), row.id]);
        tasks.taskEvent(this, row.id, 'transition', { from: 'running', to: 'failed', cause: 'daemon_restarted' });
      }
      if (this.exists(0)) {
        this.db.run("UPDATE processes SET status='active',updated_at=? WHERE pid=0", [now()]);
        this.event(0, 'daemon_started', {});
      }
    });
  }

  // ── Hard removal (see repository_removal.js) ──────────────────────────────

  /** Delete every row one pid owns; only called inside `remove`'s transaction. */
  _deleteRows(pid) {
    return deleteRows(this, pid);
  }

  remove(pids, audit = null) {
    return remove(this, pids, audit);
  }

  // ── Context, state, events and history (see repository_state.js) ───────────

  /** The agent profile this process selected at spawn time (null when unset). */
  stateAgent(pid) {
    return stateAgent(this, pid);
  }

  event(pid, kind, data) {
    return event(this, pid, kind, data);
  }

  events(pid, limit = 20) {
    return events(this, pid, limit);
  }

  context(pid) {
    return context(this, pid);
  }

  /** Replace a Context system prompt (see `repository_state.replaceContextPrompt`). */
  replaceContextPrompt(pid, systemPrompt) {
    return replaceContextPrompt(this, pid, systemPrompt);
  }

  updateState(pid, patch) {
    return updateState(this, pid, patch);
  }

  updateVars(pid, patch) {
    return updateVars(this, pid, patch);
  }

  history(pid, after = 0, limit = 100) {
    return history(this, pid, after, limit);
  }

  backfillSnapshot(pid, fields) {
    return backfillSnapshot(this, pid, fields);
  }

  /**
   * Replace one process's whole template snapshot with `snapshot` and record
   * which fields changed. The sibling of `backfillSnapshot`: that one only
   * adds missing keys (older rows), this one overwrites the lot. It exists for
   * PID 0 alone, whose snapshot follows the currently loaded `lush-root`
   * template and is refreshed once per daemon start (see
   * `ProcessManager.refreshRootTemplate`); every other process keeps its
   * creation-time snapshot.
   *
   * Fields are compared per key with `jsonDump`, so a value that differs, a key
   * only the old snapshot had, and a key only the new one has all count. The
   * returned list is ordered stably: new-snapshot key order first, then keys
   * the replacement drops in their old order. A missing process or an
   * identical snapshot writes nothing and returns `[]`.
   */
  replaceSnapshot(pid, snapshot) {
    const fields = [];
    this.database.transaction(() => {
      const row = this.db.query('SELECT template_snapshot FROM processes WHERE pid=?').get(pid);
      if (row === null) return;
      const current = JSON.parse(row.template_snapshot);
      const changed = Object.keys(snapshot)
        .filter((key) => !Object.hasOwn(current, key) || jsonDump(current[key]) !== jsonDump(snapshot[key]));
      const removed = Object.keys(current).filter((key) => !Object.hasOwn(snapshot, key));
      fields.push(...changed, ...removed);
      if (fields.length === 0) return;
      this.db.run('UPDATE processes SET template_snapshot=?, updated_at=? WHERE pid=?',
        [jsonDump(snapshot), now(), pid]);
      this.event(pid, 'template_refreshed', { template: snapshot.name, fields: [...fields] });
    });
    return fields;
  }

  // ── Agent calls and messages (see repository_calls.js) ────────────────────

  beginCall(pid, taskId, prompt) {
    return beginCall(this, pid, taskId, prompt);
  }

  addMessage(pid, taskId, callId, body) {
    return addMessage(this, pid, taskId, callId, body);
  }

  finishCall(callId, status, detail = {}) {
    return finishCall(this, callId, status, detail);
  }

  calls(pid, limit = 20) {
    return calls(this, pid, limit);
  }

  callsOfTask(taskId, limit = 20) {
    return callsOfTask(this, taskId, limit);
  }

  callById(callId) {
    return callById(this, callId);
  }

  conversation(taskId, currentCall) {
    return conversation(this, taskId, currentCall);
  }

  // ── Tasks (see repository_tasks.js) ────────────────────────────────────────

  /** `createTask` opens a unit of work on one process; the root task is its own root. */
  createTask(pid, parentTaskId, goal, options) {
    return tasks.createTask(this, pid, parentTaskId, goal, options);
  }

  getTask(taskId) {
    return tasks.getTask(this, taskId);
  }

  findTask(taskId) {
    return tasks.findTask(this, taskId);
  }

  listTasks(options) {
    return tasks.listTasks(this, options);
  }

  tasksOfProcess(pid) {
    return tasks.tasksOfProcess(this, pid);
  }

  childTasks(taskId) {
    return tasks.childTasks(this, taskId);
  }

  activeTasks(options) {
    return tasks.activeTasks(this, options);
  }

  activeTaskOfProcess(pid) {
    return tasks.activeTaskOfProcess(this, pid);
  }

  transitionTask(taskId, target, options) {
    return tasks.transitionTask(this, taskId, target, options);
  }

  updateTaskState(taskId, patch) {
    return tasks.updateTaskState(this, taskId, patch);
  }

  taskEvent(taskId, kind, data) {
    return tasks.taskEvent(this, taskId, kind, data);
  }

  taskEvents(taskId, limit = 20) {
    return tasks.taskEvents(this, taskId, limit);
  }

  taskCalls(taskId) {
    return tasks.taskCalls(this, taskId);
  }

  taskMessages(taskId) {
    return tasks.taskMessages(this, taskId);
  }

  taskSubtree(taskId) {
    return tasks.taskSubtree(this, taskId);
  }

  deleteTaskRows(taskIds) {
    return tasks.deleteTaskRows(this, taskIds);
  }

  detachProcessTasks(pids) {
    return tasks.detachProcessTasks(this, pids);
  }
}
