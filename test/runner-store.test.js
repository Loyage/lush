import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { Database } from 'bun:sqlite';
import { Store } from '../src/persistence/store.js';
import { SCHEMA } from '../src/persistence/store/schema.js';
import { temp } from './helpers.js';

const NODE = '11111111-1111-4111-8111-111111111111', OTHER = '22222222-2222-4222-8222-222222222222';
const RUNNER = 'installation-one';
const A = 'a'.repeat(40), B = 'b'.repeat(40), C = 'c'.repeat(40), HASH = 'f'.repeat(64);
const baseIdentity = value => Object.fromEntries(['project_id', 'worker_id', 'node_id', 'runner_id', 'workspace_id', 'generation'].map(key => [key, value[key]]));
const receiptIdentity = row => ({ ...baseIdentity(row), ...(row.run_id == null ? { operation_id: row.operation_id } : { run_id: row.run_id }), request_id: row.request_id });
function fixture() {
  const root = temp(), file = path.join(root, 'project.db');
  const f = { root, file, store: new Store(file, root) };
  f.worker = () => f.store.create({ input_id: null, role: 'agent', goal: 'remote', task_kind: 'order' });
  f.policy = () => f.store.saveRunnerProject({ allowed_node_ids: [NODE, OTHER], default_node_id: NODE }, f.store.runnerProject().revision).policy;
  f.bind = (task = f.worker(), node_id = NODE) => {
    const policy = f.store.runnerProject().project_id ? f.store.runnerProject() : f.policy();
    const value = { project_id: policy.project_id, worker_id: task.id, node_id, runner_id: RUNNER, workspace_id: `workspace-${task.id}`, generation: 1, base_commit: A };
    const preparing = f.store.bindRunnerWorkspace(value);
    return f.store.confirmRunnerWorkspace(baseIdentity(preparing), A, preparing.revision);
  };
  f.start = (bound = f.bind()) => {
    const task = f.store.update(bound.worker_id, { status: 'running' });
    const run = f.store.startRun(task, { agent: 'mock' });
    const value = { ...baseIdentity(bound), run_id: run.id };
    return f.store.authorizeRunnerRun(value, f.store.runnerProject().authorization_version);
  };
  f.execution = (run, request_id = `exec-${run.run_id}`, extra = {}) => f.store.createRunnerReceipt({
    ...baseIdentity(run), run_id: run.run_id, request_id, authorization_version: run.authorization_version,
    kind: 'execution', params_hash: HASH, data: {}, ...extra,
  });
  f.control = (bound, kind, data, request_id = `${kind}-${bound.worker_id}`) => f.store.createRunnerReceipt({
    ...baseIdentity(bound), operation_id: `operation-${request_id}`, request_id,
    authorization_version: f.store.runnerProject().authorization_version, kind, data, params_hash: HASH,
  });
  f.update = (row, state, evidence = undefined) => f.store.updateRunnerReceipt(receiptIdentity(row), { state, ...(evidence ? { evidence } : {}) }, row.revision);
  f.reopen = () => { f.store.close(); f.store = new Store(file, root); };
  f.close = () => { f.store.close(); fs.rmSync(root, { recursive: true, force: true }); };
  return f;
}

test('Project settlement remains a durable barrier after ACK/ready and only its exact candidate can be confirmed', () => {
  const f = fixture();
  try {
    const bound = f.bind(), workerId = bound.worker_id, request_id = 'explicit-sync';
    const event_id = f.store.event(workerId, 'task.runner_parent_sync_prepared', { request_id, outcome: { head_commit: B } });
    let receipt = f.control(bound, 'parent_sync', { old_commit: A, new_commit: B, attempt_id: event_id }, request_id);
    receipt = f.update(receipt, 'landed', { head_commit: B, verified: true });
    receipt = f.update(receipt, 'applying');
    receipt = f.update(receipt, 'acknowledged', { head_commit: B, stopped: true, clean: true });
    f.reopen();
    expect(f.store.runnerBarriers(workerId).bindings[0].state).toBe('ready');
    expect(f.store.runnerBarriers(workerId).receipts[0].terminal).toBe(1);
    expect(() => f.store.advanceRunnerGeneration(baseIdentity(bound), f.store.runnerBinding(workerId).revision)).toThrow('fixed receipt');
    expect(() => f.start(f.store.runnerBinding(workerId))).toThrow('fixed receipt');
    expect(f.store.runnerBarriers(workerId).runs).toHaveLength(0);
    const unknown = f.store.markRunnerWorkspaceUnknown(baseIdentity(bound), f.store.runnerBinding(workerId).revision);
    expect(() => f.store.confirmRunnerWorkspace(baseIdentity(bound), B, unknown.revision)).toThrow('fixed receipt');
    expect(() => f.store.confirmRunnerWorkspace(baseIdentity(bound), B, unknown.revision, { sync_request_id: 'another' })).toThrow('exact acknowledged');
    f.store.confirmRunnerWorkspace(baseIdentity(bound), B, unknown.revision, { sync_request_id: request_id });
    expect(f.store.runnerBarriers(workerId).bindings).toHaveLength(1);
    expect(() => f.control(f.store.runnerBinding(workerId), 'cleanup', { head_commit: B })).toThrow('fixed receipt');
    // A newer settled event cannot hide an older unclosed operation.
    f.store.event(workerId, 'task.runner_parent_sync_prepared', { request_id: 'newer', outcome: { head_commit: B } });
    f.store.event(workerId, 'task.runner_parent_sync_settled', { request_id: 'newer' });
    expect(f.store.pendingRunnerTaskSyncs(workerId).map(row => row.request_id)).toEqual([request_id]);
    f.store.event(workerId, 'task.runner_parent_sync_settled', { request_id });
    expect(f.store.runnerBarriers(workerId)).toEqual({ bindings: [], runs: [], receipts: [] });
    expect(f.start(f.store.runnerBinding(workerId)).state).toBe('active');
  } finally { f.close(); }
});

test('old projects gain only empty auxiliary tables, preserve local Worker facts and do not allocate identity on read', () => {
  const root = temp(), file = path.join(root, 'legacy.db'); let store;
  try {
    const old = new Database(file); old.exec(SCHEMA);
    old.query('INSERT INTO meta(key,value) VALUES (?,?)').run('project', root);
    old.query(`INSERT INTO tasks(id,role,goal,task_kind,workspace,branch,worker_number,reservation) VALUES (1,'agent','legacy','order',?,'old','W7',?)`)
      .run('/legacy/worktree', '{"version":2,"status":"pending"}');
    const before = old.query('SELECT * FROM tasks WHERE id=1').get(); old.close();
    store = new Store(file, root);
    expect(store.task(1)).toEqual(before);
    expect(store.runnerProject()).toMatchObject({ project_id: null, default_node_id: 'local', revision: 0 });
    expect(store.runnerBinding(1)).toBeNull();
    expect(store.runnerBarriers()).toEqual({ bindings: [], runs: [], receipts: [] });
    expect(store.get("SELECT value FROM meta WHERE key='runner_project_v1'")).toBeNull();
    const policy = store.saveRunnerProject({ allowed_node_ids: [NODE], default_node_id: NODE }, 0).policy;
    expect(() => store.bindRunnerWorkspace({ project_id: policy.project_id, worker_id: 1, node_id: NODE,
      runner_id: RUNNER, workspace_id: 'old', generation: 1, base_commit: A })).toThrow('cannot be migrated');
    expect(store.task(1)).toEqual(before);
  } finally { store?.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('pre-pin remote auxiliary records gain nullable installation identity without guesses or clearing barriers', () => {
  const f = fixture(); try {
    const bound = f.bind(), run = f.start(bound), receipt = f.execution(run), task = f.store.task(bound.worker_id);
    // Reconstruct the previously shipped auxiliary schema in this isolated fixture only.
    for (const table of ['runner_bindings', 'runner_runs', 'runner_receipts']) f.store.db.exec(`ALTER TABLE ${table} DROP COLUMN runner_id`);
    const before = f.store.runnerBinding(bound.worker_id);
    f.reopen();
    expect(f.store.runnerBinding(bound.worker_id)).toEqual({ ...before, runner_id: null });
    expect(f.store.runnerRun(run.run_id).runner_id).toBeNull();
    expect(f.store.runnerReceipt(receipt.request_id).runner_id).toBeNull();
    expect(f.store.task(bound.worker_id)).toEqual(task);
    expect(f.store.runnerBarriers(bound.worker_id).bindings).toHaveLength(1);
    expect(() => f.store.assertRunnerAuthorization({ ...baseIdentity(run), run_id: run.run_id }, run.authorization_version)).toThrow('identity');
    expect(() => f.store.updateRunnerReceipt(receiptIdentity(receipt), { state: 'stopped', evidence: { stopped: true } }, receipt.revision)).toThrow('identity');
  } finally { f.close(); }
});

test('project policy is opaque, CAS guarded, durable and revocation never silently changes selection', () => {
  const f = fixture(); try {
    const first = f.policy(); expect(first.project_id).toMatch(/^[a-f0-9-]{36}$/); expect(first.project_id).not.toContain(f.root);
    expect(() => f.store.saveRunnerProject({ allowed_node_ids: [], default_node_id: 'local' }, 0)).toThrow('revision');
    const bound = f.bind(), run = f.start(bound), execution = f.execution(run);
    const revoked = f.store.revokeRunnerNode(NODE, first.revision);
    expect(revoked.policy.authorization_version).toBe(first.authorization_version + 1);
    expect(revoked.policy.default_node_id).toBe(NODE);
    expect(revoked.stop_bindings.map(row => row.worker_id)).toEqual([bound.worker_id]);
    expect(f.store.runnerRun(run.run_id).state).toBe('revoked');
    expect(f.store.runnerReceipt(execution.request_id).state).toBe('prepared'); // Revocation is not proof of stop.
    expect(() => f.store.assertRunnerAuthorization({ ...baseIdentity(run), run_id: run.run_id }, run.authorization_version)).toThrow();
    const again = f.store.revokeRunnerNode(NODE, revoked.policy.revision);
    expect(again.stop_bindings).toHaveLength(1); // Still report stop work after an earlier ACK was lost.
    const restored = f.policy();
    expect(restored.project_id).toBe(first.project_id);
    expect(() => f.store.assertRunnerAuthorization({ ...baseIdentity(run), run_id: run.run_id }, run.authorization_version)).toThrow('revoked');
    f.reopen(); expect(f.store.runnerProject()).toEqual(restored);
    expect(f.store.runnerBarriers().runs[0].state).toBe('revoked');
  } finally { f.close(); }
});

test('binding creation is idempotent, fixes ownership and CAS generation cannot bypass unknown activity', () => {
  const f = fixture(); try {
    const policy = f.policy(), task = f.worker(), value = { project_id: policy.project_id, worker_id: task.id,
      node_id: NODE, runner_id: RUNNER, workspace_id: 'workspace-one', generation: 1, base_commit: A };
    const row = f.store.bindRunnerWorkspace(value);
    expect(f.store.bindRunnerWorkspace(value)).toEqual(row);
    expect(f.store.runnerBarriers(task.id).bindings).toHaveLength(1);
    expect(() => f.store.bindRunnerWorkspace({ ...value, node_id: OTHER })).toThrow('already');
    expect(() => f.store.bindRunnerWorkspace({ ...value, runner_id: 'another-installation' })).toThrow('already');
    expect(() => f.store.confirmRunnerWorkspace({ ...baseIdentity(row), runner_id: 'another-installation' }, A, row.revision)).toThrow('identity');
    expect(() => f.store.bindRunnerWorkspace({ ...value, runner_id: null })).toThrow('installation');
    expect(() => f.store.bindRunnerWorkspace({ ...value, project_id: OTHER })).toThrow('project');
    expect(() => f.store.confirmRunnerWorkspace(baseIdentity(row), B, row.revision)).toThrow('unknown HEAD');
    const ready = f.store.confirmRunnerWorkspace(baseIdentity(row), A, row.revision);
    expect(() => f.store.confirmRunnerWorkspace(baseIdentity(row), A, row.revision)).toThrow('revision');
    const next = f.store.advanceRunnerGeneration(baseIdentity(ready), ready.revision);
    expect(next).toMatchObject({ generation: 2, node_id: NODE, workspace_id: row.workspace_id, state: 'preparing' });
    expect(() => f.store.advanceRunnerGeneration(baseIdentity(ready), next.revision)).toThrow('generation');
    const confirmed = f.store.confirmRunnerWorkspace(baseIdentity(next), A, next.revision), run = f.start(confirmed);
    const unknown = f.update(f.execution(run), 'unknown');
    expect(() => f.store.advanceRunnerGeneration(baseIdentity(confirmed), confirmed.revision)).toThrow('active or unknown');
    expect(() => f.store.releaseRunnerRun({ ...baseIdentity(run), run_id: run.run_id }, run.revision, { stopped: true })).toThrow('active or unknown');
    f.reopen(); expect(f.store.runnerReceipt(unknown.request_id)).toEqual(unknown);
    expect(f.store.runnerBinding(task.id).generation).toBe(2);
    expect(f.store.task(task.id).workspace).toBeNull(); // No remote path stored as a local fs path.
  } finally { f.close(); }
});

test('Run admission rejects wrong ownership, stale generation/version and overlapping writers', () => {
  const f = fixture(); try {
    const first = f.bind(), other = f.bind(), run = f.start(first);
    const context = { ...baseIdentity(run), run_id: run.run_id };
    expect(f.store.authorizeRunnerRun(context, run.authorization_version)).toEqual(run);
    for (const changed of [{ worker_id: other.worker_id }, { generation: 2 }, { node_id: OTHER }, { runner_id: 'another-installation' }, { project_id: OTHER }, { workspace_id: other.workspace_id }])
      expect(() => f.store.assertRunnerAuthorization({ ...context, ...changed }, run.authorization_version)).toThrow();
    expect(() => f.store.assertRunnerAuthorization(context, run.authorization_version + 1)).toThrow();
    const secondRun = f.store.startRun(f.store.task(first.worker_id), { agent: 'mock' });
    expect(() => f.store.authorizeRunnerRun({ ...context, run_id: secondRun.id }, run.authorization_version)).toThrow('active or unknown');
    expect(() => f.store.assertRunnerAuthorization(context, run.authorization_version)).toThrow('no longer owns');
    const foreignRun = f.store.startRun(f.store.update(other.worker_id, { status: 'running' }), { agent: 'mock' });
    expect(() => f.store.authorizeRunnerRun({ ...baseIdentity(other), run_id: secondRun.id }, run.authorization_version)).toThrow('own');
    f.store.finishRun(run.run_id, 'completed');
    expect(() => f.store.assertRunnerAuthorization(context, run.authorization_version)).toThrow('no longer owns');
    expect(() => f.store.releaseRunnerRun(context, run.revision)).toThrow();
    expect(f.store.releaseRunnerRun(context, run.revision, { stopped: true }).state).toBe('released');
    expect(f.store.authorizeRunnerRun({ ...baseIdentity(other), run_id: foreignRun.id }, run.authorization_version).run_id).toBe(foreignRun.id);
    expect(() => f.store.authorizeRunnerRun(context, run.authorization_version)).toThrow();
  } finally { f.close(); }
});

test('receipts bind exactly one Run/operation, reject reused request parameters and never reset completed effects', () => {
  const f = fixture(); try {
    const run = f.start(), receipt = f.execution(run);
    const duplicate = f.execution(run); expect(duplicate).toEqual(receipt);
    for (const extra of [{ operation_id: 'also-operation' }, { params_hash: 'e'.repeat(64) }, { data: { command: 'secret' } },
      { node_id: OTHER }, { runner_id: 'another-installation' }, { authorization_version: 999 }, { kind: 'unknown' }]) expect(() => f.execution(run, receipt.request_id, extra)).toThrow();
    expect(() => f.update(receipt, 'completed')).toThrow('confirmed stop');
    const running = f.update(receipt, 'running');
    expect(() => f.update(receipt, 'running')).toThrow('revision');
    const done = f.update(running, 'completed', { stopped: true, output_complete: true, output_cursor: 7 });
    expect(done.terminal).toBe(1);
    expect(f.execution(run)).toEqual(done);
    expect(() => f.update(done, 'running')).toThrow('terminal');
    expect(() => f.store.updateRunnerReceipt({ ...receiptIdentity(done), worker_id: 999 }, { state: 'unknown' }, done.revision)).toThrow();
    expect(f.store.runnerBarriers(run.worker_id).receipts).toEqual([]);
  } finally { f.close(); }
});

test('revoked unknown execution stays blocked across reopen until exact stop proof, never auto-replays', () => {
  const f = fixture(); try {
    const run = f.start(), running = f.update(f.execution(run), 'running');
    const unknown = f.store.updateRunnerReceipt(receiptIdentity(running), { state: 'unknown', error_code: 'connection_lost' }, running.revision);
    f.store.revokeRunnerNode(run.node_id, f.store.runnerProject().revision); f.reopen();
    expect(f.store.runnerBarriers(run.worker_id).receipts).toEqual([unknown]);
    expect(() => f.update(unknown, 'prepared')).toThrow('transition');
    expect(() => f.update(unknown, 'running')).toThrow();
    const stopped = f.update(unknown, 'stopped', { stopped: true, output_complete: false });
    expect(stopped.state).toBe('stopped');
    const currentRun = f.store.runnerRun(run.run_id);
    expect(() => f.store.releaseRunnerRun({ ...baseIdentity(run), run_id: run.run_id }, run.revision, { stopped: true })).toThrow('revision');
    f.store.releaseRunnerRun({ ...baseIdentity(run), run_id: run.run_id }, currentRun.revision, { stopped: true });
    expect(f.store.runnerBarriers(run.worker_id)).toEqual({ bindings: [], runs: [], receipts: [] });
  } finally { f.close(); }
});

test('object receipts require full fixed integrity and CAS baseline, preventing out-of-order HEAD rollback', () => {
  const f = fixture(); try {
    const run = f.start();
    const objects = (request, commit = B) => f.execution(run, request, { kind: 'objects', data: { old_commit: A, commit, digest: HASH, size_bytes: 123 } });
    const one = objects('objects-one'), two = objects('objects-two', C);
    expect(() => f.update(one, 'received', { head_commit: B, digest: HASH, size_bytes: 122 })).toThrow('mismatched');
    const received = f.update(one, 'received', { head_commit: B, digest: HASH, size_bytes: 123 });
    expect(() => f.update(received, 'accepted', { head_commit: B, digest: HASH, size_bytes: 123 })).toThrow('incomplete');
    f.update(received, 'accepted', { head_commit: B, digest: HASH, size_bytes: 123, verified: true });
    expect(f.store.runnerBinding(run.worker_id).head_commit).toBe(B);
    const late = f.update(two, 'received', { head_commit: C, digest: HASH, size_bytes: 123 });
    expect(() => f.update(late, 'accepted', { head_commit: C, digest: HASH, size_bytes: 123, verified: true })).toThrow('baseline');
    expect(f.store.runnerReceipt(late.request_id).state).toBe('received');
    f.update(late, 'rejected');
    expect(f.store.runnerBinding(run.worker_id).head_commit).toBe(B);
    expect(f.store.task(run.worker_id).head_commit).toBeNull(); // Store facts never publish a Git/Worker delivery.
  } finally { f.close(); }
});

test('parent sync fixes attempt/tips, survives lost ACK and cannot re-squash or admit competing work', () => {
  const f = fixture(); try {
    const bound = f.bind(), fixed = { old_commit: A, new_commit: B, attempt_id: 41 };
    let sync = f.control(bound, 'parent_sync', fixed);
    expect(() => f.control(bound, 'parent_sync', { ...fixed, new_commit: C })).toThrow('different');
    expect(() => f.control(bound, 'parent_sync', fixed, 'another-request')).toThrow('active or unknown');
    expect(() => f.update(sync, 'acknowledged', { head_commit: B, clean: true, stopped: true })).toThrow('transition');
    expect(() => f.update(sync, 'landed')).toThrow('central landing');
    sync = f.update(sync, 'landed', { head_commit: B, verified: true });
    sync = f.update(sync, 'applying'); sync = f.update(sync, 'unknown'); f.reopen();
    expect(f.store.runnerReceipt(sync.request_id)).toMatchObject({ state: 'unknown', last_known_state: 'applying', data: fixed });
    expect(() => f.update(sync, 'prepared')).toThrow('transition');
    expect(() => f.start(bound)).toThrow('active or unknown');
    expect(() => f.store.advanceRunnerGeneration(baseIdentity(bound), bound.revision)).toThrow('active or unknown');
    expect(() => f.update(sync, 'acknowledged', { head_commit: C, clean: true, stopped: true })).toThrow('fixed tip');
    expect(() => f.update(sync, 'acknowledged', { head_commit: B, clean: false, stopped: true })).toThrow('fixed tip');
    const ack = f.update(sync, 'acknowledged', { head_commit: B, clean: true, stopped: true });
    expect(ack.terminal).toBe(1); expect(f.store.runnerBinding(bound.worker_id).head_commit).toBe(B);
    expect(f.store.runnerBarriers(bound.worker_id).receipts).toEqual([]);
    expect(() => f.update(sync, 'acknowledged', { head_commit: B, clean: true, stopped: true })).toThrow('revision');
    expect(() => f.control(f.store.runnerBinding(bound.worker_id), 'parent_sync', { old_commit: B, new_commit: C, attempt_id: 41 }, 'reuse-attempt')).toThrow();
  } finally { f.close(); }
});

test('prepared parent sync can be explicitly rejected only with exact unwritten and stopped evidence', () => {
  const f = fixture(); try {
    const bound = f.bind(), fixed = { old_commit: A, new_commit: B, attempt_id: 42 };
    const sync = f.control(bound, 'parent_sync', fixed);
    const proof = { head_commit: A, verified: true, clean: true, stopped: true };
    expect(() => f.update(sync, 'rejected')).toThrow('unwritten');
    for (const key of Object.keys(proof)) {
      const incomplete = { ...proof }; delete incomplete[key];
      expect(() => f.update(sync, 'rejected', incomplete)).toThrow('unwritten');
    }
    expect(() => f.update(sync, 'rejected', { ...proof, head_commit: B })).toThrow('unwritten');
    for (const key of ['verified', 'clean', 'stopped'])
      expect(() => f.update(sync, 'rejected', { ...proof, [key]: false })).toThrow('unwritten');
    expect(f.store.runnerBarriers(bound.worker_id).receipts).toHaveLength(1);
    const rejected = f.update(sync, 'rejected', proof);
    expect(rejected.state).toBe('rejected'); expect(rejected.terminal).toBe(1);
    expect(f.store.runnerBinding(bound.worker_id)).toEqual(bound); // no HEAD/revision adoption
    expect(f.store.runnerBarriers(bound.worker_id).receipts).toHaveLength(0);
    f.reopen();
    expect(f.store.runnerReceipt(sync.request_id).state).toBe('rejected');
    expect(f.store.runnerBinding(bound.worker_id).head_commit).toBe(A);
    expect(() => f.update(rejected, 'landed', { head_commit: B, verified: true })).toThrow('terminal');
    expect(() => f.control(bound, 'parent_sync', fixed, 'reused-rejected-attempt')).toThrow();
    expect(f.start(bound).state).toBe('active');
  } finally { f.close(); }
});

test('landed, applying and unknown parent sync cannot use the unwritten rejection exit', () => {
  const f = fixture(); try {
    for (const state of ['landed', 'applying', 'unknown']) {
      const bound = f.bind();
      let sync = f.control(bound, 'parent_sync', { old_commit: A, new_commit: B, attempt_id: 43 });
      if (state !== 'unknown') sync = f.update(sync, 'landed', { head_commit: B, verified: true });
      if (state === 'applying') sync = f.update(sync, 'applying');
      if (state === 'unknown') sync = f.update(sync, 'unknown'); // last_known_state=prepared still cannot reject
      expect(() => f.update(sync, 'rejected', { head_commit: A, verified: true, clean: true, stopped: true })).toThrow();
      expect(f.store.runnerReceipt(sync.request_id).state).toBe(state);
      expect(f.store.runnerBarriers(bound.worker_id).receipts).toHaveLength(1);
      expect(f.store.runnerBinding(bound.worker_id)).toEqual(bound);
    }
  } finally { f.close(); }
});

test('sync already started can record fixed landing/ACK after revoke but new forward application is refused', () => {
  const f = fixture(); try {
    const bound = f.bind(); let sync = f.control(bound, 'parent_sync', { old_commit: A, new_commit: B, attempt_id: 10 });
    f.store.revokeRunnerNode(bound.node_id, f.store.runnerProject().revision);
    sync = f.update(sync, 'landed', { head_commit: B, verified: true });
    expect(() => f.update(sync, 'applying')).toThrow('not authorized');
    // An exact node confirmation may prove an already-completed authorized synchronization.
    sync = f.update(sync, 'acknowledged', { head_commit: B, stopped: true, clean: true });
    expect(sync.terminal).toBe(1);
  } finally { f.close(); }
});

test('cleanup after revoke preserves partial/unknown barriers and only exact resource proof marks removal', () => {
  const f = fixture(); try {
    const bound = f.bind(); f.store.revokeRunnerNode(bound.node_id, f.store.runnerProject().revision);
    let cleanup = f.control(bound, 'cleanup', { head_commit: A });
    expect(() => f.update(cleanup, 'removed', { head_commit: A, stopped: true, clean: true })).toThrow('transition');
    cleanup = f.update(cleanup, 'removing'); cleanup = f.update(cleanup, 'unknown'); f.reopen();
    expect(f.store.runnerBinding(bound.worker_id).state).toBe('ready');
    expect(f.store.runnerBarriers(bound.worker_id).receipts[0].state).toBe('unknown');
    expect(() => f.update(cleanup, 'removed', { head_commit: B, stopped: true, clean: true })).toThrow('exact resource');
    expect(() => f.update(cleanup, 'removed', { head_commit: A, stopped: true, clean: true })).toThrow('exact resource');
    f.update(cleanup, 'removed', { head_commit: A, stopped: true, clean: true, removed: true });
    expect(f.store.runnerBinding(bound.worker_id).state).toBe('removed');
    expect(() => f.store.confirmRunnerWorkspace(baseIdentity(bound), A, f.store.runnerBinding(bound.worker_id).revision)).toThrow();
    expect(f.store.task(bound.worker_id).status).toBe('queued'); // Not acceptance, deletion, or scheduling.
  } finally { f.close(); }
});

test('independent project identities, unrelated revocation and control operations cannot borrow a Run writer', () => {
  const f = fixture(), g = fixture(); try {
    const bound = f.bind(), run = f.start(bound), foreign = g.bind();
    const context = { ...baseIdentity(run), run_id: run.run_id };
    expect(foreign.project_id).not.toBe(bound.project_id);
    expect(() => g.store.bindRunnerWorkspace({ ...baseIdentity(bound), base_commit: A })).toThrow('project');
    const revoked = f.store.revokeRunnerNode(OTHER, f.store.runnerProject().revision);
    expect(revoked.stop_bindings).toEqual([]);
    expect(f.store.assertRunnerAuthorization(context, run.authorization_version)).toEqual(run);
    expect(() => f.control(bound, 'execution', {}, 'control-exec')).toThrow('active or unknown');
    expect(() => f.control(bound, 'cleanup', { head_commit: A })).toThrow('active or unknown');
    const running = f.store.updateRunnerReceipt(receiptIdentity(f.execution(run)), { state: 'running', evidence: { output_cursor: 10 } }, 1);
    const unknown = f.update(running, 'unknown');
    expect(unknown.evidence.output_cursor).toBe(10);
    expect(() => f.update(unknown, 'stopped', { stopped: true, output_cursor: 9 })).toThrow('cursor');
    expect(f.update(unknown, 'stopped', { stopped: true, output_cursor: 10 }).state).toBe('stopped');
  } finally { f.close(); g.close(); }
});

test('a control operation cannot be reused across Worker, generation or receipt kind', () => {
  const f = fixture(); try {
    const first = f.bind(), other = f.bind();
    const receipt = f.control(first, 'execution', {}, 'controlled');
    const make = (bound, kind = 'execution', data = {}) => ({ ...baseIdentity(bound), operation_id: receipt.operation_id,
      request_id: 'another-control-request', authorization_version: receipt.authorization_version, kind, params_hash: HASH, data });
    expect(() => f.store.createRunnerReceipt(make(other))).toThrow('scope');
    f.update(receipt, 'stopped', { stopped: true });
    expect(() => f.store.createRunnerReceipt(make(first, 'cleanup', { head_commit: A }))).toThrow('scope');
    const next = f.store.advanceRunnerGeneration(baseIdentity(first), first.revision);
    const ready = f.store.confirmRunnerWorkspace(baseIdentity(next), A, next.revision);
    expect(() => f.store.createRunnerReceipt(make(ready))).toThrow('scope');
  } finally { f.close(); }
});

test('workspace unknown, cross-connection CAS and transaction rollback never clear or partially publish facts', () => {
  const f = fixture(); let other;
  try {
    const bound = f.bind(), unknown = f.store.markRunnerWorkspaceUnknown(baseIdentity(bound), bound.revision);
    expect(() => f.start(unknown)).toThrow('not ready');
    other = new Store(f.file, f.root);
    expect(other.runnerBarriers(bound.worker_id).bindings[0]).toEqual(unknown);
    expect(() => other.confirmRunnerWorkspace(baseIdentity(bound), A, bound.revision)).toThrow('revision');
    const ready = f.store.confirmRunnerWorkspace(baseIdentity(unknown), A, unknown.revision);
    expect(() => other.markRunnerWorkspaceUnknown(baseIdentity(unknown), unknown.revision)).toThrow('revision');
    const policy = f.store.runnerProject();
    expect(() => f.store.transaction(() => {
      f.store.revokeRunnerNode(bound.node_id, policy.revision); throw new Error('abort');
    })).toThrow('abort');
    expect(other.runnerProject()).toEqual(policy); expect(other.runnerBinding(bound.worker_id)).toEqual(ready);
    const run = f.start(ready), receipt = f.execution(run);
    expect(() => f.store.transaction(() => { f.update(receipt, 'unknown'); throw new Error('abort'); })).toThrow('abort');
    expect(other.runnerReceipt(receipt.request_id)).toEqual(receipt);
    const running = f.update(receipt, 'running');
    expect(() => other.updateRunnerReceipt(receiptIdentity(receipt), { state: 'unknown' }, receipt.revision)).toThrow('revision');
    expect(other.runnerReceipt(receipt.request_id)).toEqual(running);
  } finally { other?.close(); f.close(); }
});
