/**
 * The `services` entity and the transaction rules that span entities
 * (`create`, `transition`, `recover`, `replaceSnapshot`).
 *
 * This is the layer that owns rows: it decodes them, and it is the only place
 * that writes service status. Everything about Context / state / events sits in
 * `state.js`, about calls in `calls.js`, about tasks in `tasks.js`, and about
 * hard deletion in `removal.js`; those groups are merged into the class by
 * `index.js`.
 */
import { LushError, jsonDump, now, validSid } from '../../core/types.js';
import * as tasks from '../repository_tasks.js';

export const rows = {
  /**
   * Read model row: metadata plus the service variables. Variable values are
   * the two mutability regions of the persistent state (immutable values in
   * `state.params`, mutable ones in `state.vars`), and the declarations are
   * read from the creation-time template snapshot so that editing a template
   * file later cannot silently re-open a variable the service was created with.
   */
  decode(row) {
    const item = { ...row };
    item.template_snapshot = JSON.parse(item.template_snapshot);
    const state = this.db.query('SELECT state FROM contexts WHERE sid=?').get(item.sid);
    const stored = state === null ? {} : JSON.parse(state.state);
    const declared = item.template_snapshot.variables ?? {};
    // The agent profile this service selected at spawn time (null = the
    // daemon's fallback tier). It lives in the Context state next to the
    // variables, so reading it costs nothing extra here.
    item.agent_profile = typeof stored.agent === 'string' && stored.agent !== '' ? stored.agent : null;
    item.variables = {
      immutable: stored.params ?? {},
      mutable: stored.vars ?? {},
      declarations: { immutable: declared.immutable ?? {}, mutable: declared.mutable ?? {} },
    };
    item.children = this.db
      .query('SELECT sid FROM services WHERE parent_sid=? ORDER BY sid')
      .all(item.sid)
      .map((child) => child.sid);
    return item;
  },

  get(sid) {
    validSid(sid);
    const row = this.db.query('SELECT * FROM services WHERE sid=?').get(sid);
    if (row === null) throw new LushError(`service not found: ${sid}`, -32004);
    return this.decode(row);
  },

  exists(sid) {
    return this.db.query('SELECT 1 FROM services WHERE sid=?').get(sid) !== null;
  },

  list() {
    return this.db.query('SELECT * FROM services ORDER BY sid').all().map((row) => this.decode(row));
  },

  children(sid) {
    this.get(sid);
    return this.db.query('SELECT * FROM services WHERE parent_sid=? ORDER BY sid')
      .all(sid)
      .map((row) => this.decode(row));
  },

  /**
   * Insert one service row plus its Context, both in one transaction; the row
   * starts as `created` and is moved to `active` before returning.
   */
  create(parentSid, template, name, goal, { root = false, variables = null, agent = null } = {}) {
    const stamp = now();
    const columns = 'parent_sid,original_parent_sid,name,status,template,template_snapshot,goal,created_at,updated_at';
    const values = [parentSid, parentSid, name, 'created',
      template.name, jsonDump(template), goal, stamp, stamp];
    let sid = 0;
    this.database.transaction(() => {
      if (root) {
        this.db.run(`INSERT INTO services(sid,${columns}) VALUES(0,?,?,?,?,?,?,?,?,?)`, values);
        sid = 0;
      } else {
        sid = this.db.run(`INSERT INTO services(${columns}) VALUES(?,?,?,?,?,?,?,?,?)`, values).lastInsertRowid;
      }
      // Templates carry no initial Context: state, artifacts and references always
      // start empty. Creation-time variables are stored by mutability region:
      // immutable values in state.params, mutable ones in state.vars. The
      // selected agent profile is recorded in the same state so every later read
      // (`inspect`, `tree`, a call) knows which backend this SID asked for.
      const state = {};
      if (variables !== null && Object.keys(variables.immutable).length) state.params = variables.immutable;
      if (variables !== null && Object.keys(variables.mutable).length) state.vars = variables.mutable;
      if (agent !== null && agent !== undefined) state.agent = agent;
      this.db.run('INSERT INTO contexts VALUES(?,?,?,?,?)', [sid, template.system_prompt, jsonDump(state), '[]', '[]']);
      this.event(sid, 'created', { parent_sid: parentSid, template: template.name });
      this.db.run("UPDATE services SET status='active' WHERE sid=?", [sid]);
      this.event(sid, 'transition', { from: 'created', to: 'active' });
    });
    return this.get(sid);
  },

  /**
   * Active (created/active) children of `parentSid` that were created from
   * `template`. Singleton templates refuse creation while this is non-zero;
   * stopped instances do not count.
   */
  activeCount(parentSid, template) {
    return this.db
      .query("SELECT COUNT(*) AS n FROM services WHERE parent_sid=? AND template=? AND status IN ('created','active')")
      .get(parentSid, template).n;
  },

  /**
   * Move one service to `target` and, in the same transaction, apply the
   * parent's policy to its active direct children: `adopt` reparents them to
   * SID 0, `terminate` freezes them (always → stopped). SID 0 is exempt from
   * both, so daemon shutdown stays a change to SID 0 alone.
   *
   * `cause` is the supervision reason (`orphan_ttl`, `orphan_limit`) and is
   * only recorded in the transition event when given. `effects` is an optional
   * out-parameter: every child action is pushed as
   * `{ sid, from, to, kind: 'adopted' | 'terminated' }` so the ServiceManager
   * can cancel the running calls of terminated children *after* this
   * transaction, where cancelling is a runtime side effect and cannot be
   * rolled back. The crash window between state change and cancellation is
   * covered by `recover()` on the next daemon start.
   */
  transition(sid, target, {
    adopt = false, terminate = false, result, cause, effects = null,
  } = {}) {
    this.database.transaction(() => {
      const old = this.get(sid);
      this.db.run('UPDATE services SET status=?,updated_at=? WHERE sid=?', [target, now(), sid]);
      // `cause` records *why* a supervised service was frozen (orphan_ttl,
      // orphan_limit, parent_terminated); every other transition keeps the
      // two-field payload older readers expect.
      this.event(sid, 'transition',
        cause === undefined ? { from: old.status, to: target } : { from: old.status, to: target, cause });
      if (result !== undefined && result !== null) {
        const state = this.context(sid).state;
        state.result = result;
        // jsonDump runs inside the transaction so an invalid result rolls everything back.
        this.db.run('UPDATE contexts SET state=? WHERE sid=?', [jsonDump(state), sid]);
      }
      // SID 0 never adopts and never terminates children: daemon shutdown does
      // `transition(0, 'stopped')` and must stay a change to SID 0 alone.
      if ((adopt || terminate) && sid !== 0) {
        const children = this.db
          .query("SELECT sid,status FROM services WHERE parent_sid=? AND status IN ('created','active')")
          .all(sid);
        for (const child of children) {
          if (adopt) {
            this.db.run('UPDATE services SET parent_sid=0,updated_at=? WHERE sid=?', [now(), child.sid]);
            this.event(child.sid, 'reparented', { from: sid, to: 0, reason: target });
            if (effects !== null) effects.push({ sid: child.sid, from: child.status, to: child.status, kind: 'adopted' });
            continue;
          }
          // The child is frozen, not deleted, and only this one level is
          // written here: each frozen child goes through the same policy again
          // in ServiceManager, which is what walks an active chain down.
          const childTarget = 'stopped';
          this.db.run('UPDATE services SET status=?,updated_at=? WHERE sid=?', [childTarget, now(), child.sid]);
          this.event(child.sid, 'transition', { from: child.status, to: childTarget, cause: 'parent_terminated' });
          if (effects !== null) effects.push({ sid: child.sid, from: child.status, to: childTarget, kind: 'terminated' });
        }
      }
    });
    return this.get(sid);
  },

  /**
   * Every service SID 0 adopted, terminal ones included (the supervision read
   * model shows what it froze as well as what it still holds). Raw rows: no
   * JSON decoding, no variables, just the columns the policy needs plus the two
   * activity stamps used to compute `last_activity_at`.
   */
  orphans() {
    return this.db.query(`
      SELECT p.sid, p.name, p.status, p.template, p.parent_sid, p.original_parent_sid,
             p.created_at, p.updated_at, p.goal,
             (SELECT MAX(m.created_at) FROM messages m WHERE m.sid = p.sid) AS last_message_at,
             (SELECT MAX(COALESCE(c.finished_at, c.started_at)) FROM agent_calls c WHERE c.sid = p.sid) AS last_call_at
      FROM services p
      WHERE p.parent_sid = 0 AND p.sid > 0
        AND p.original_parent_sid IS NOT NULL AND p.original_parent_sid != 0
      ORDER BY p.sid
    `).all();
  },

  /**
   * A restarted daemon must not inherit work it cannot vouch for: dangling
   * calls become interrupted, tasks that were running or waiting become
   * `failed` (their agents are gone), and SID 0 goes back to active.
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
        this.db.run("UPDATE services SET status='active',updated_at=? WHERE sid=0", [now()]);
        this.event(0, 'daemon_started', {});
      }
    });
  },

  /**
   * Replace one service's whole template snapshot with `snapshot` and record
   * which fields changed. The sibling of `backfillSnapshot`: that one only
   * adds missing keys (older rows), this one overwrites the lot. It exists for
   * SID 0 alone, whose snapshot follows the currently loaded `lush-root`
   * template and is refreshed once per daemon start (see
   * `ServiceManager.refreshRootTemplate`); every other service keeps its
   * creation-time snapshot.
   *
   * Fields are compared per key with `jsonDump`, so a value that differs, a key
   * only the old snapshot had, and a key only the new one has all count. The
   * returned list is ordered stably: new-snapshot key order first, then keys
   * the replacement drops in their old order. A missing service or an
   * identical snapshot writes nothing and returns `[]`.
   */
  replaceSnapshot(sid, snapshot) {
    const fields = [];
    this.database.transaction(() => {
      const row = this.db.query('SELECT template_snapshot FROM services WHERE sid=?').get(sid);
      if (row === null) return;
      const current = JSON.parse(row.template_snapshot);
      const changed = Object.keys(snapshot)
        .filter((key) => !Object.hasOwn(current, key) || jsonDump(current[key]) !== jsonDump(snapshot[key]));
      const removed = Object.keys(current).filter((key) => !Object.hasOwn(snapshot, key));
      fields.push(...changed, ...removed);
      if (fields.length === 0) return;
      this.db.run('UPDATE services SET template_snapshot=?, updated_at=? WHERE sid=?',
        [jsonDump(snapshot), now(), sid]);
      this.event(sid, 'template_refreshed', { template: snapshot.name, fields: [...fields] });
    });
    return fields;
  },
};
