import { randomUUID } from 'node:crypto';
import { check, isPlainObject } from '../../core/types.js';
import { OPERATIONS } from '../../runner/protocol.js';

const KEY = 'runner_project_v1';
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const ID_KEYS = ['project_id', 'worker_id', 'node_id', 'runner_id', 'workspace_id', 'generation'];
const CONTEXT_KEYS = [...ID_KEYS, 'run_id', 'operation_id'];
const TERMINAL = { tool: ['completed', 'stopped', 'rejected'], execution: ['completed', 'stopped'], objects: ['accepted', 'rejected'], parent_sync: ['acknowledged', 'rejected'], cleanup: ['removed'] };
const TRANSITIONS = {
  tool: { prepared: ['acknowledged', 'completed', 'stopped', 'rejected'], acknowledged: ['completed', 'stopped'] },
  execution: { prepared: ['accepted', 'running', 'stopping', 'stopped', 'completed'], accepted: ['running', 'stopping', 'stopped', 'completed'],
    running: ['stopping', 'stopped', 'completed'], stopping: ['stopped', 'completed'] },
  objects: { prepared: ['receiving', 'received', 'rejected'], receiving: ['received', 'rejected'], received: ['accepted', 'rejected'] },
  parent_sync: { prepared: ['landed', 'rejected'], landed: ['applying', 'acknowledged'], applying: ['acknowledged'] },
  cleanup: { prepared: ['removing'], removing: ['removed'] },
};
function object(value, keys, label) {
  check(isPlainObject(value) && Object.keys(value).every(key => keys.includes(key)), `invalid Runner ${label} fields`);
}
function positive(value, label) { check(Number.isSafeInteger(value) && value > 0, `invalid Runner ${label}`); return value; }
function revision(value) { check(Number.isSafeInteger(value) && value >= 0, 'Runner expected revision is required'); return value; }
function opaque(value, label) {
  check(typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value), `invalid Runner ${label}`); return value;
}
function uuid(value, label) { check(typeof value === 'string' && UUID.test(value), `invalid Runner ${label}`); return value; }
function oid(value) { check(typeof value === 'string' && OID.test(value), 'invalid Runner fixed commit'); return value; }
function digest(value) { check(typeof value === 'string' && /^[0-9a-f]{64}$/.test(value), 'invalid Runner digest'); return value; }
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (isPlainObject(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
const json = value => JSON.stringify(canonical(value));
const same = (a, b) => json(a) === json(b);
const pick = (value, keys) => Object.fromEntries(keys.map(key => [key, value[key]]));
function identity(value, context = false) {
  uuid(value.project_id, 'project identity'); positive(value.worker_id, 'Worker id'); uuid(value.node_id, 'node identity');
  opaque(value.runner_id, 'installation identity');
  opaque(value.workspace_id, 'workspace identity'); positive(value.generation, 'workspace generation');
  if (context) {
    check((value.run_id != null) !== (value.operation_id != null), 'Runner requires exactly one Run or control operation');
    if (value.run_id != null) positive(value.run_id, 'Run id');
    else opaque(value.operation_id, 'control operation');
  }
}
function binding(store, value) {
  identity(value);
  check(store.runnerProject().project_id === value.project_id, 'Runner project identity changed');
  const row = store.runnerBinding(value.worker_id);
  check(row && ID_KEYS.every(key => row[key] === value[key]), 'Runner workspace identity or generation changed');
  return row;
}
function permitted(store, node_id) {
  check(store.runnerProject().allowed_node_ids.includes(node_id), 'Runner node is not authorized for this project');
}
function activeRun(store, value) {
  const run = store.get('SELECT task_id,status FROM agent_runs WHERE id=?', value.run_id);
  const latest = store.get('SELECT id FROM agent_runs WHERE task_id=? ORDER BY id DESC LIMIT 1', value.worker_id);
  check(run?.task_id === value.worker_id && run.status === 'running' && latest?.id === value.run_id
    && store.task(value.worker_id).status === 'running', 'Runner Run no longer owns this active Worker');
}
function stateData(kind, value) {
  if (kind === 'tool') {
    object(value, ['method', 'path_hash', 'expected_sha256', 'execution_id'], 'tool metadata');
    check(OPERATIONS[value.method]?.tool_effect === true, 'invalid Runner tool method');
    if (value.method.startsWith('file.')) {
      digest(value.path_hash);
      if (value.expected_sha256 !== null) digest(value.expected_sha256);
    } else if (value.method === 'command.cancel') opaque(value.execution_id, 'execution identity');
    return value;
  }
  if (kind === 'execution') {
    object(value, [], 'execution data'); return {};
  }
  if (kind === 'objects') {
    object(value, ['old_commit', 'commit', 'digest', 'size_bytes'], 'object receipt');
    oid(value.old_commit); oid(value.commit); digest(value.digest); positive(value.size_bytes, 'object size');
  } else if (kind === 'parent_sync') {
    object(value, ['old_commit', 'new_commit', 'attempt_id'], 'parent sync');
    oid(value.old_commit); oid(value.new_commit); positive(value.attempt_id, 'delivery attempt');
  } else {
    object(value, ['head_commit'], 'cleanup'); oid(value.head_commit);
  }
  return value;
}
const decoded = row => row ? { ...row, data: JSON.parse(row.data), evidence: row.evidence === null ? null : JSON.parse(row.evidence) } : null;
function activeReceipts(store, worker_id, run_id = null) {
  return store.all(`SELECT * FROM runner_receipts WHERE worker_id=? AND terminal=0${run_id === null ? '' : ' AND run_id=?'} ORDER BY rowid`,
    worker_id, ...(run_id === null ? [] : [run_id])).map(decoded);
}
function noActivity(store, worker_id, sync_request_id = null) {
  check(!store.pendingRunnerTaskSyncs(worker_id).some(sync => sync.request_id !== sync_request_id),
    'Runner synchronization must settle its fixed receipt first');
  check(!store.get("SELECT run_id FROM runner_runs WHERE worker_id=? AND state!='released'", worker_id)
    && !activeReceipts(store, worker_id).length, 'Runner workspace still has active or unknown operations');
}
function contextEqual(a, b) { return CONTEXT_KEYS.every(key => (a[key] ?? null) === (b[key] ?? null)); }
function liveContext(store, value, authorization_version, kind) {
  const row = binding(store, value);
  check(row.state === 'ready', 'Runner workspace is not ready');
  if (value.run_id != null) store.assertRunnerAuthorization(pick(value, CONTEXT_KEYS), authorization_version);
  else {
    // A revoked node remains eligible for explicitly authorized stop/reconciliation/reclamation,
    // not new code execution. Updating an existing receipt below is a separate recovery path.
    if (kind !== 'cleanup') permitted(store, value.node_id);
    check(store.runnerProject().authorization_version === authorization_version, 'Runner authorization version changed');
  }
  return row;
}

/** Additive auxiliary facts only. Existing tasks/paths/reservations are never rewritten. */
export function ensureRunnerSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS runner_bindings (
    worker_id INTEGER PRIMARY KEY REFERENCES tasks(id), project_id TEXT NOT NULL, node_id TEXT NOT NULL, runner_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL UNIQUE, generation INTEGER NOT NULL CHECK(generation>0),
    base_commit TEXT NOT NULL, head_commit TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'preparing',
    revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0));
    CREATE TABLE IF NOT EXISTS runner_runs (
      run_id INTEGER PRIMARY KEY REFERENCES agent_runs(id), worker_id INTEGER NOT NULL REFERENCES runner_bindings(worker_id),
      project_id TEXT NOT NULL, node_id TEXT NOT NULL, runner_id TEXT NOT NULL, workspace_id TEXT NOT NULL, generation INTEGER NOT NULL,
      authorization_version INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'active', revision INTEGER NOT NULL DEFAULT 1,
      stop_confirmed INTEGER NOT NULL DEFAULT 0 CHECK(stop_confirmed IN (0,1)));
    CREATE UNIQUE INDEX IF NOT EXISTS runner_run_writer ON runner_runs(worker_id) WHERE state!='released';
    CREATE TABLE IF NOT EXISTS runner_receipts (
      request_id TEXT PRIMARY KEY, worker_id INTEGER NOT NULL REFERENCES runner_bindings(worker_id),
      project_id TEXT NOT NULL, node_id TEXT NOT NULL, runner_id TEXT NOT NULL, workspace_id TEXT NOT NULL, generation INTEGER NOT NULL,
      run_id INTEGER REFERENCES runner_runs(run_id), operation_id TEXT,
      authorization_version INTEGER NOT NULL, kind TEXT NOT NULL, params_hash TEXT NOT NULL, data TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'prepared', last_known_state TEXT NOT NULL DEFAULT 'prepared',
      terminal INTEGER NOT NULL DEFAULT 0 CHECK(terminal IN (0,1)), revision INTEGER NOT NULL DEFAULT 1,
      evidence TEXT, error_code TEXT,
      CHECK((run_id IS NULL) != (operation_id IS NULL)));
    CREATE INDEX IF NOT EXISTS runner_receipts_pending ON runner_receipts(worker_id) WHERE terminal=0;
    CREATE INDEX IF NOT EXISTS runner_receipts_operation ON runner_receipts(operation_id) WHERE operation_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS runner_sync_attempt ON runner_receipts(worker_id,json_extract(data,'$.attempt_id')) WHERE kind='parent_sync';`);
  const runColumns = new Set(db.query('PRAGMA table_info(runner_runs)').all().map(column => column.name));
  if (!runColumns.has('tool_journal')) db.query('ALTER TABLE runner_runs ADD COLUMN tool_journal TEXT').run();
  if (!runColumns.has('tool_count')) db.query('ALTER TABLE runner_runs ADD COLUMN tool_count INTEGER').run();
  // Earlier auxiliary records without a pin remain unknown, never infer installation identity from an alias.
  for (const table of ['runner_bindings', 'runner_runs', 'runner_receipts']) {
    const columns = new Set(db.query(`PRAGMA table_info(${table})`).all().map(column => column.name));
    if (!columns.has('runner_id')) db.query(`ALTER TABLE ${table} ADD COLUMN runner_id TEXT`).run();
  }
}

export const runner = {
  /** No write on read; an old project/Worker without records still uses its original local path. */
  runnerProject() {
    const row = this.get('SELECT value FROM meta WHERE key=?', KEY);
    return row ? JSON.parse(row.value) : { version: 1, project_id: null, revision: 0, authorization_version: 0,
      allowed_node_ids: [], default_node_id: 'local' };
  },

  saveRunnerProject(value, expected_revision) {
    object(value, ['allowed_node_ids', 'default_node_id'], 'project policy'); revision(expected_revision);
    check(Array.isArray(value.allowed_node_ids) && value.allowed_node_ids.length <= 64, 'invalid Runner node authorization list');
    value.allowed_node_ids.forEach(node => uuid(node, 'node identity'));
    check(new Set(value.allowed_node_ids).size === value.allowed_node_ids.length, 'duplicate Runner node authorization');
    if (value.default_node_id !== 'local') uuid(value.default_node_id, 'default node identity');
    return this.transaction(() => {
      const before = this.runnerProject(); check(before.revision === expected_revision, 'Runner policy revision changed');
      const next = { version: 1, project_id: before.project_id ?? randomUUID(), revision: before.revision + 1,
        authorization_version: before.authorization_version + 1,
        allowed_node_ids: [...value.allowed_node_ids].sort(), default_node_id: value.default_node_id };
      // A selected-but-revoked default stays selected and unavailable. Never silently move work to local.
      const removed = before.allowed_node_ids.filter(node => !next.allowed_node_ids.includes(node));
      this.run('INSERT INTO meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', KEY, json(next));
      const stop_bindings = [];
      for (const node of removed) {
        this.run("UPDATE runner_runs SET state='revoked',revision=revision+1 WHERE node_id=? AND state='active'", node);
        stop_bindings.push(...this.all("SELECT * FROM runner_bindings WHERE node_id=? AND state!='removed' ORDER BY worker_id", node));
      }
      return { policy: next, stop_bindings };
    });
  },

  /** Call on project revocation or observed device disable. Re-enable never resurrects an old Run. */
  revokeRunnerNode(node_id, expected_revision) {
    uuid(node_id, 'node identity');
    return this.transaction(() => {
      const policy = this.runnerProject();
      const result = this.saveRunnerProject({ allowed_node_ids: policy.allowed_node_ids.filter(node => node !== node_id),
        default_node_id: policy.default_node_id }, expected_revision);
      this.run("UPDATE runner_runs SET state='revoked',revision=revision+1 WHERE node_id=? AND state='active'", node_id);
      // A lost prior response must not hide resources still requiring explicit stop/reconciliation.
      return { ...result, stop_bindings: this.all("SELECT * FROM runner_bindings WHERE node_id=? AND state!='removed' ORDER BY worker_id", node_id) };
    });
  },

  runnerBinding(worker_id) { positive(worker_id, 'Worker id'); return this.get('SELECT * FROM runner_bindings WHERE worker_id=?', worker_id) ?? null; },

  /** Register before remote creation. No node/workspace rebinding or implicit local-to-remote migration. */
  bindRunnerWorkspace(value, expected_generation = 0) {
    object(value, [...ID_KEYS, 'base_commit'], 'binding'); identity(value); oid(value.base_commit); revision(expected_generation);
    return this.transaction(() => {
      const policy = this.runnerProject(); check(policy.project_id === value.project_id, 'Runner project identity changed');
      permitted(this, value.node_id);
      const task = this.task(value.worker_id);
      check(['order', 'child'].includes(task.task_kind), 'Runner binding requires an order/child Worker');
      const old = this.runnerBinding(value.worker_id);
      if (old) {
        check(expected_generation === 0 && ID_KEYS.every(key => old[key] === value[key]) && old.base_commit === value.base_commit,
          'Runner binding already exists or changed');
        return old;
      }
      check(expected_generation === 0 && value.generation === 1, 'new Runner binding requires initial generation');
      check(!task.workspace && task.calls === 0 && !this.get('SELECT id FROM agent_runs WHERE task_id=? LIMIT 1', task.id),
        'existing local Worker cannot be migrated by binding');
      check(!task.base_commit || task.base_commit === value.base_commit, 'Runner binding base differs from Worker base');
      this.run(`INSERT INTO runner_bindings(worker_id,project_id,node_id,runner_id,workspace_id,generation,base_commit,head_commit)
        VALUES (?,?,?,?,?,?,?,?)`, value.worker_id, value.project_id, value.node_id, value.runner_id, value.workspace_id, value.generation, value.base_commit, value.base_commit);
      return this.runnerBinding(value.worker_id);
    });
  },

  confirmRunnerWorkspace(value, head_commit, expected_revision, { sync_request_id = null } = {}) {
    object(value, ID_KEYS, 'workspace identity'); oid(head_commit); revision(expected_revision);
    return this.transaction(() => {
      const row = binding(this, value); check(row.revision === expected_revision, 'Runner binding revision changed');
      check(['preparing', 'unknown'].includes(row.state), 'Runner workspace is not awaiting confirmation');
      if (sync_request_id !== null) {
        const pending = this.pendingRunnerTaskSyncs(row.worker_id);
        const receipt = this.runnerReceipt(sync_request_id);
        check(pending.length === 1 && pending[0].request_id === sync_request_id
          && receipt?.worker_id === row.worker_id && receipt.kind === 'parent_sync' && receipt.state === 'acknowledged'
          && receipt.data.attempt_id === pending[0].event_id && receipt.data.new_commit === head_commit
          && pending[0].outcome.head_commit === head_commit, 'Runner synchronization confirmation requires its exact acknowledged candidate');
      }
      noActivity(this, row.worker_id, sync_request_id);
      check(head_commit === row.head_commit, 'Runner confirmation cannot adopt an unknown HEAD');
      this.run("UPDATE runner_bindings SET state='ready',revision=revision+1 WHERE worker_id=? AND revision=?", row.worker_id, expected_revision);
      return this.runnerBinding(row.worker_id);
    });
  },

  markRunnerWorkspaceUnknown(value, expected_revision) {
    object(value, ID_KEYS, 'workspace identity'); revision(expected_revision);
    return this.transaction(() => {
      const row = binding(this, value);
      check(row.revision === expected_revision && row.state !== 'removed', 'Runner binding revision or state changed');
      this.run("UPDATE runner_bindings SET state='unknown',revision=revision+1 WHERE worker_id=? AND revision=?", row.worker_id, expected_revision);
      return this.runnerBinding(row.worker_id);
    });
  },

  advanceRunnerGeneration(value, expected_revision) {
    object(value, ID_KEYS, 'workspace identity'); revision(expected_revision);
    return this.transaction(() => {
      const row = binding(this, value); check(row.revision === expected_revision && row.state === 'ready', 'Runner binding revision or state changed');
      noActivity(this, row.worker_id); permitted(this, row.node_id);
      this.run("UPDATE runner_bindings SET generation=generation+1,revision=revision+1,state='preparing' WHERE worker_id=? AND revision=?", row.worker_id, expected_revision);
      return this.runnerBinding(row.worker_id);
    });
  },

  runnerRun(run_id) { positive(run_id, 'Run id'); return this.get('SELECT * FROM runner_runs WHERE run_id=?', run_id) ?? null; },

  startRunnerToolJournal(value, journal) {
    object(journal, ['version', 'head_commit', 'baseline'], 'tool journal');
    check(journal.version === 1, 'Unsupported Runner tool journal'); oid(journal.head_commit);
    check(journal.baseline === null || isPlainObject(journal.baseline) && Object.keys(journal.baseline).length <= 256
      && Object.entries(journal.baseline).every(([key, digest]) => /^[a-f0-9]{64}$/.test(key) && /^[a-f0-9]{64}$/.test(digest)), 'Invalid Runner baseline metadata');
    return this.transaction(() => {
      const run = this.runnerRun(value.run_id);
      this.assertRunnerAuthorization(value, run?.authorization_version);
      check(run.tool_journal === null && this.runnerBinding(value.worker_id).head_commit === journal.head_commit, 'Runner journal was already fixed or HEAD changed');
      this.run('UPDATE runner_runs SET tool_journal=?,tool_count=0,revision=revision+1 WHERE run_id=? AND revision=?', json(journal), value.run_id, run.revision);
      return this.runnerRun(value.run_id);
    });
  },

  authorizeRunnerRun(value, expected_authorization_version) {
    object(value, [...ID_KEYS, 'run_id'], 'Run authorization'); identity(value, true); positive(expected_authorization_version, 'authorization version');
    return this.transaction(() => {
      const row = binding(this, value), policy = this.runnerProject();
      permitted(this, row.node_id); check(row.state === 'ready', 'Runner workspace is not ready');
      const old = this.runnerRun(value.run_id);
      if (old) { this.assertRunnerAuthorization(value, expected_authorization_version); return old; }
      check(policy.authorization_version === expected_authorization_version, 'Runner authorization version changed');
      noActivity(this, row.worker_id);
      activeRun(this, value);
      this.run(`INSERT INTO runner_runs(run_id,worker_id,project_id,node_id,runner_id,workspace_id,generation,authorization_version) VALUES (?,?,?,?,?,?,?,?)`,
        value.run_id, value.worker_id, value.project_id, value.node_id, value.runner_id, value.workspace_id, value.generation, expected_authorization_version);
      return this.runnerRun(value.run_id);
    });
  },

  assertRunnerAuthorization(value, expected_authorization_version) {
    object(value, CONTEXT_KEYS, 'Run identity'); identity(value, true);
    check(value.run_id != null, 'Runner Run identity is required'); positive(expected_authorization_version, 'authorization version');
    const workspace = binding(this, value), row = this.runnerRun(value.run_id);
    permitted(this, value.node_id);
    check(workspace.state === 'ready' && row && ID_KEYS.every(key => row[key] === value[key]) && row.state === 'active'
      && row.authorization_version === expected_authorization_version, 'Runner Run authorization changed or was revoked');
    check(!this.pendingRunnerTaskSyncs(value.worker_id).length, 'Runner synchronization must settle its fixed receipt first');
    activeRun(this, value);
    return row;
  },

  /** Revocation closes new admission immediately; only releaseRunnerRun records actual exit. */
  revokeRunnerRun(run_id) {
    const row = this.runnerRun(run_id);
    check(row, 'Runner Run was not registered');
    if (row.state === 'active') this.run("UPDATE runner_runs SET state='revoked',revision=revision+1 WHERE run_id=? AND state='active'", run_id);
    return this.runnerRun(run_id);
  },

  releaseRunnerRun(value, expected_revision, evidence) {
    object(value, [...ID_KEYS, 'run_id'], 'Run identity'); identity(value, true); revision(expected_revision);
    object(evidence, ['stopped'], 'Run stop evidence');
    check(evidence.stopped === true, 'Runner Run release requires confirmed remote stop');
    return this.transaction(() => {
      binding(this, value);
      const row = this.runnerRun(value.run_id);
      check(row && ID_KEYS.every(key => row[key] === value[key]) && row.revision === expected_revision, 'Runner Run identity or revision changed');
      check(row.state !== 'released', 'Runner Run already released');
      check(!activeReceipts(this, value.worker_id, value.run_id).length, 'Runner Run still has active or unknown operations');
      this.run("UPDATE runner_runs SET state='released',stop_confirmed=1,revision=revision+1 WHERE run_id=? AND revision=?", value.run_id, expected_revision);
      return this.runnerRun(value.run_id);
    });
  },

  runnerReceipt(request_id) { opaque(request_id, 'request identity'); return decoded(this.get('SELECT * FROM runner_receipts WHERE request_id=?', request_id)); },

  /** request_id is project-wide; exact retries return the original receipt, never restart an effect. */
  createRunnerReceipt(value) {
    object(value, [...CONTEXT_KEYS, 'request_id', 'authorization_version', 'kind', 'params_hash', 'data'], 'receipt');
    identity(value, true); opaque(value.request_id, 'request identity'); positive(value.authorization_version, 'authorization version');
    check(Object.hasOwn(TERMINAL, value.kind), 'invalid Runner receipt kind'); digest(value.params_hash);
    const data = stateData(value.kind, value.data);
    check(['parent_sync', 'cleanup'].includes(value.kind) ? value.operation_id != null : true, 'Runner control operation identity is required');
    return this.transaction(() => {
      binding(this, value);
      const old = this.runnerReceipt(value.request_id);
      if (old) {
        check(contextEqual(old, value) && old.kind === value.kind && old.params_hash === value.params_hash
          && old.authorization_version === value.authorization_version && same(old.data, data), 'Runner request id has different parameters');
        return old; // Inspection of a fixed receipt remains possible after revocation; it grants no new execution.
      }
      if (value.operation_id != null) {
        const prior = this.get('SELECT * FROM runner_receipts WHERE operation_id=? LIMIT 1', value.operation_id);
        check(!prior || ID_KEYS.every(key => prior[key] === value[key]) && prior.authorization_version === value.authorization_version
          && prior.kind === value.kind, 'Runner control operation scope changed');
      }
      const fixedStop = value.kind === 'tool' && data.method === 'command.cancel';
      const row = fixedStop ? binding(this, value) : liveContext(this, value, value.authorization_version, value.kind);
      if (value.kind === 'tool') {
        const run = this.runnerRun(value.run_id);
        check(run && run.tool_journal && Number.isSafeInteger(run.tool_count) && run.tool_count >= 0 && ID_KEYS.every(key => run[key] === value[key])
          && run.authorization_version === value.authorization_version && run.state !== 'released', 'Runner tool requires its fixed journaled Run');
        if (!fixedStop) check(!activeReceipts(this, value.worker_id).some(receipt => receipt.state === 'unknown'), 'Unknown Runner tool blocks new writes');
      }
      const pending = activeReceipts(this, value.worker_id);
      if (value.operation_id != null) noActivity(this, value.worker_id, value.kind === 'parent_sync' ? value.request_id : null);
      if (['parent_sync', 'cleanup'].includes(value.kind)) {
        check((value.kind === 'parent_sync' ? data.old_commit : data.head_commit) === row.head_commit, 'Runner operation fixed HEAD differs from binding');
      } else check(!pending.some(receipt => ['parent_sync', 'cleanup'].includes(receipt.kind)), 'Runner workspace has a synchronization or cleanup barrier');
      if (value.kind === 'objects') check(data.old_commit === row.head_commit, 'Runner object receipt baseline changed');
      this.run(`INSERT INTO runner_receipts(request_id,worker_id,project_id,node_id,runner_id,workspace_id,generation,run_id,operation_id,
        authorization_version,kind,params_hash,data) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, value.request_id, value.worker_id,
      value.project_id, value.node_id, value.runner_id, value.workspace_id, value.generation, value.run_id ?? null, value.operation_id ?? null,
      value.authorization_version, value.kind, value.params_hash, json(data));
      if (value.kind === 'tool') this.run('UPDATE runner_runs SET tool_count=tool_count+1,revision=revision+1 WHERE run_id=?', value.run_id);
      return this.runnerReceipt(value.request_id);
    });
  },

  /** Trusted central observations only, not a public capability or a substitute for Git/cgroup proof. */
  updateRunnerReceipt(value, patch, expected_revision) {
    object(value, [...CONTEXT_KEYS, 'request_id'], 'receipt identity'); identity(value, true); opaque(value.request_id, 'request identity');
    object(patch, ['state', 'evidence', 'error_code'], 'receipt update'); revision(expected_revision);
    return this.transaction(() => {
      const workspace = binding(this, value), row = this.runnerReceipt(value.request_id);
      check(row && contextEqual(row, value) && row.revision === expected_revision, 'Runner receipt identity or revision changed');
      check(!row.terminal, 'Runner receipt is already terminal');
      const previous = row.state === 'unknown' ? row.last_known_state : row.state;
      check(patch.state === 'unknown' || TRANSITIONS[row.kind][previous]?.includes(patch.state)
        || row.state === 'unknown' && patch.state === previous, 'invalid Runner receipt transition');
      const terminal = TERMINAL[row.kind].includes(patch.state);
      const evidence = patch.evidence === undefined ? row.evidence : patch.evidence;
      if (evidence !== null) {
        object(evidence, ['stopped', 'output_complete', 'clean', 'removed', 'head_commit', 'verified', 'digest', 'size_bytes', 'output_cursor', 'execution_id'], 'evidence');
        for (const key of ['stopped', 'output_complete', 'clean', 'removed', 'verified']) if (key in evidence) check(typeof evidence[key] === 'boolean', 'invalid Runner evidence flag');
        if ('head_commit' in evidence) oid(evidence.head_commit);
        if ('digest' in evidence) digest(evidence.digest);
        if ('execution_id' in evidence) opaque(evidence.execution_id, 'execution identity');
        if ('size_bytes' in evidence) positive(evidence.size_bytes, 'evidence size');
        if ('output_cursor' in evidence) revision(evidence.output_cursor);
      }
      if (row.evidence?.output_cursor !== undefined) check(evidence?.output_cursor >= row.evidence.output_cursor,
        'Runner output cursor cannot move backwards or disappear');
      const error_code = patch.error_code ?? null;
      check(error_code === null || typeof error_code === 'string' && /^[a-z][a-z0-9_]{0,79}$/.test(error_code), 'Runner error must be a bounded diagnostic code');
      // Reconciliation can prove exit/receipt after revoke. New forward execution cannot.
      if (row.kind === 'execution' && ['accepted', 'running'].includes(patch.state)
        || row.kind === 'objects' && patch.state === 'accepted'
        || row.kind === 'parent_sync' && patch.state === 'applying') {
        liveContext(this, row, row.authorization_version, row.kind);
      }
      if (row.kind === 'tool' && terminal) {
        check(evidence?.verified === true, 'Runner tool outcome requires verified request evidence');
        if (patch.state === 'completed') check(row.data.method.startsWith('file.') && evidence.digest, 'File mutation requires its exact result digest');
        if (patch.state === 'stopped') check(row.data.method.startsWith('command.') && evidence.stopped === true && evidence.execution_id,
          'Command admission ACK is not a stop receipt');
      }
      if (row.kind === 'execution' && terminal) check(evidence?.stopped === true
        && (patch.state !== 'completed' || evidence.output_complete === true), 'Runner execution requires confirmed stop and complete result');
      if (row.kind === 'objects' && ['received', 'accepted'].includes(patch.state)) {
        check(evidence?.head_commit === row.data.commit && evidence.digest === row.data.digest
          && evidence.size_bytes === row.data.size_bytes && (patch.state !== 'accepted' || evidence.verified === true), 'Runner object receipt is incomplete or mismatched');
        if (patch.state === 'accepted') {
          check(workspace.head_commit === row.data.old_commit, 'Runner object receipt baseline changed');
          this.run('UPDATE runner_bindings SET head_commit=?,revision=revision+1 WHERE worker_id=?', row.data.commit, row.worker_id);
        }
      }
      if (row.kind === 'parent_sync' && patch.state === 'landed') check(evidence?.head_commit === row.data.new_commit
        && evidence.verified === true, 'Runner sync requires exact central landing proof');
      // Explicit caller-proven unwritten cancellation only. Unknown cannot inherit this exit
      // through last_known_state; an empty remote process group alone is not landing evidence.
      if (row.kind === 'parent_sync' && patch.state === 'rejected') check(row.state === 'prepared'
        && evidence?.head_commit === row.data.old_commit && evidence.verified === true
        && evidence.clean === true && evidence.stopped === true && workspace.head_commit === row.data.old_commit,
      'Runner parent sync rejection requires a prepared, verified unwritten fixed tip');
      if (row.kind === 'parent_sync' && patch.state === 'acknowledged') {
        check(evidence?.head_commit === row.data.new_commit && evidence.clean === true && evidence.stopped === true
          && workspace.head_commit === row.data.old_commit, 'Runner parent sync acknowledgement does not prove the fixed tip');
        this.run('UPDATE runner_bindings SET head_commit=?,revision=revision+1 WHERE worker_id=?', row.data.new_commit, row.worker_id);
      }
      if (row.kind === 'cleanup' && terminal) {
        check(evidence?.head_commit === row.data.head_commit && evidence.clean === true && evidence.stopped === true && evidence.removed === true,
          'Runner cleanup requires exact resource and stop confirmation');
        this.run("UPDATE runner_bindings SET state='removed',revision=revision+1 WHERE worker_id=?", row.worker_id);
      }
      this.run(`UPDATE runner_receipts SET state=?,last_known_state=?,terminal=?,revision=revision+1,evidence=?,error_code=?
        WHERE request_id=? AND revision=?`, patch.state, patch.state === 'unknown' ? previous : patch.state,
      Number(terminal), evidence === null ? null : json(evidence), error_code, row.request_id, expected_revision);
      return this.runnerReceipt(row.request_id);
    });
  },

  /** Project settlement is distinct from the Runner ACK. Keep one unbounded durable query
   * for all admission/recovery readers; older unsettled events cannot hide behind a newer one. */
  pendingRunnerTaskSyncs(worker_id = null) {
    if (worker_id !== null) positive(worker_id, 'Worker id');
    return this.all(`SELECT e.id,e.task_id,e.data FROM events e
      JOIN runner_bindings b ON b.worker_id=e.task_id
      WHERE e.type='task.runner_parent_sync_prepared' ${worker_id === null ? '' : 'AND e.task_id=?'}
      AND NOT EXISTS (SELECT 1 FROM events s WHERE s.task_id=e.task_id AND s.id>e.id
        AND s.type='task.runner_parent_sync_settled'
        AND json_extract(s.data,'$.request_id')=json_extract(e.data,'$.request_id'))
      ORDER BY e.id`, ...(worker_id === null ? [] : [worker_id]))
      .map(row => ({ ...JSON.parse(row.data), worker_id: row.task_id, event_id: row.id }));
  },

  /** Durable barriers survive daemon restart; an absent Runner binding is not a remote unknown. */
  runnerBarriers(worker_id = null) {
    if (worker_id !== null) positive(worker_id, 'Worker id');
    const where = worker_id === null ? '' : ' AND worker_id=?', args = worker_id === null ? [] : [worker_id];
    const pending = this.pendingRunnerTaskSyncs(worker_id);
    const bindings = this.all(`SELECT * FROM runner_bindings WHERE (state IN ('preparing','unknown') OR runner_id IS NULL)${where} ORDER BY worker_id`, ...args);
    const receipts = this.all(`SELECT * FROM runner_receipts WHERE terminal=0${where} ORDER BY rowid`, ...args).map(decoded);
    for (const sync of pending) {
      // Preserve the existing three-array contract: even legacy callers see the settlement
      // barrier when the binding is ready or the node receipt is already terminal.
      if (!bindings.some(row => row.worker_id === sync.worker_id)) bindings.push(this.runnerBinding(sync.worker_id));
      const receipt = this.runnerReceipt(sync.request_id);
      if (receipt && !receipts.some(row => row.request_id === receipt.request_id)) receipts.push(receipt);
    }
    return { bindings, runs: this.all(`SELECT * FROM runner_runs WHERE state!='released'${where} ORDER BY run_id`, ...args), receipts };
  },
};
