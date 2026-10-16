import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DeploymentStore } from '../src/core/runner-deployment-store.js';
import { DeploymentOperations, DeploymentRejection } from '../src/core/runner-deployment-operations.js';
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lush-test-deployment-operations-')), home = path.join(root, 'device');
  const store = new DeploymentStore({ home }), operations = new DeploymentOperations(store);
  const create = (alias = 'fixture') => store.create({ status: 'planned', ssh_alias: alias, name: 'Fixture', project_id: 'project-a', plan: { supported: true }, stages: [], private_data: {} });
  return { root, home, store, operations, create, async close() { await operations.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}
test('observation intent is durable before dispatch and uses the original kernel lease without holding a global receipt lock', async () => {
  const f = fixture(), entered = deferred(), finish = deferred(); let reached = false;
  try {
    const source = f.create();
    const pending = f.operations.observe(source.id, source.revision, async (context, intent) => {
      const actual = new DeploymentStore({ home: f.home }).read(source.id), observation = actual.private_data.reconciliations.at(-1);
      expect(actual.status).toBe('planned'); expect(observation).toMatchObject({ status: 'running', from_revision: source.revision, request_id: intent.request_id, original_operation_id: null });
      expect(intent.request_id).not.toBe(observation.id); expect(f.operations.view(actual).private_data.reconciliations.at(-1).status).toBe('running');
      expect(() => new DeploymentOperations(new DeploymentStore({ home: f.home })).observe(source.id, actual.revision, () => {})).toThrow('already executing');
      context.checkpoint(row => { row.private_data.reconciliations.at(-1).facts = { local: { registration: 'unrecorded' } }; });
      reached = true; entered.resolve(); await finish.promise; return { checked: true };
    });
    await Promise.race([entered.promise, pending.then(() => { if (!reached) throw new Error('Observation intent injection was not reached'); })]); expect(f.operations.pending).toBe(1); const unrelated = f.create('another-fixture'); expect(unrelated.status).toBe('planned');
    finish.resolve(); const result = await pending;
    expect(result.status).toBe('planned'); expect(result.stages).toEqual(source.stages); expect(result.private_data.operation_id).toBeUndefined();
    expect(result.private_data.reconciliations.at(-1)).toMatchObject({ status: 'complete', facts: { checked: true } }); expect(f.store.isActive(source.id)).toBe(false);
    expect(() => f.operations.observe(source.id, source.revision, () => {})).toThrow('revision changed');
  } finally { finish.resolve(); await f.close(); }
});

for (const field of ['original_facts', 'request_id']) test(`observation checkpoints cannot change ${field} or write a resumed operation`, async () => {
  const f = fixture();
  try {
    const source = f.create(), result = await f.operations.observe(source.id, source.revision, async context => {
      context.checkpoint(row => { if (field === 'original_facts') row.plan.supported = false; else row.private_data.reconciliations.at(-1).request_id = row.id; });
    });
    expect(result.status).toBe(source.status); expect(result.plan).toEqual(source.plan); expect(result.stages).toEqual(source.stages);
    expect(result.private_data.reconciliations.at(-1).status).toBe('unknown'); expect(result.private_data.reconciliations.at(-1).request_id).not.toBe(source.id);
  } finally { await f.close(); }
});

test('abandoned original running becomes durable unknown on explicit inspection, never physically stopped or replayable', async () => {
  const f = fixture();
  try {
    const planned = f.create(), source = f.store.change(planned.id, planned.revision, row => {
      row.status = 'running'; row.private_data.operation_id = row.id; row.private_data.active_stage = 'install_runtime';
      row.stages = [{ id: 'install_runtime', status: 'running', message: 'Waiting' }];
      row.private_data.intents = { install_runtime: { id: 'install_runtime', operation_id: row.id, request_id: row.id, status: 'running' } };
    });
    const result = await f.operations.observe(source.id, source.revision, async context => {
      const record = context.read(); expect(record.status).toBe('unknown'); expect(record.private_data.intents.install_runtime).toMatchObject({ request_id: source.id, status: 'unknown' }); return {};
    });
    expect(result.status).toBe('unknown'); expect(result.stages[0].status).toBe('unknown'); expect(result.private_data.operation_id).toBe(source.id);
    expect(result.private_data.reconciliations[0].original_operation_id).toBe(source.id);
    expect(() => f.operations.run(result.id, result.revision, { stages: ['install_runtime'] }, () => {})).toThrow('cannot be replayed');
  } finally { await f.close(); }
});

test('abandoned observation derives unknown without writes, remains in history, and a fresh explicit observation never reuses its IDs', async () => {
  const f = fixture();
  try {
    const source = f.create(), abandoned = f.store.change(source.id, source.revision, row => {
      row.private_data.reconciliations = [{ id: row.id, request_id: row.id, status: 'running', from_revision: row.revision, original_operation_id: null, created_at: row.created_at }];
    });
    const bytes = fs.readFileSync(path.join(f.home, 'runner-deployments.json'));
    expect(f.operations.view(abandoned).private_data.reconciliations[0].status).toBe('unknown');
    expect(fs.readFileSync(path.join(f.home, 'runner-deployments.json'))).toEqual(bytes);
    const observed = await f.operations.observe(source.id, abandoned.revision, async () => ({ checked: true }));
    expect(observed.private_data.reconciliations[0]).toMatchObject({ id: source.id, request_id: source.id, status: 'unknown' });
    expect(observed.private_data.reconciliations[1].id).not.toBe(source.id); expect(observed.private_data.reconciliations[1].request_id).not.toBe(source.id);
    const limited = f.store.change(observed.id, observed.revision, row => { row.private_data.reconciliations = Array.from({ length: 16 }, () => structuredClone(row.private_data.reconciliations[0])); });
    expect(() => f.operations.observe(limited.id, limited.revision, () => {})).toThrow('history limit'); expect(f.store.isActive(source.id)).toBe(false);
  } finally { await f.close(); }
});

test('a new explicitly approved normal operation cannot make an abandoned old observation look active again', async () => {
  const f = fixture();
  try {
    const source = f.create(), abandoned = f.store.change(source.id, source.revision, row => {
      row.private_data.reconciliations = [{ id: row.id, request_id: row.id, status: 'running', from_revision: row.revision, original_operation_id: null, created_at: row.created_at }];
    });
    const result = await f.operations.run(source.id, abandoned.revision, { stages: ['check'] }, async context => {
      expect(context.read().private_data.reconciliations[0].status).toBe('unknown');
      expect(f.operations.view(context.read()).private_data.reconciliations[0].status).toBe('unknown');
      await context.stage('check', async () => ({}));
    });
    expect(result.status).toBe('ready'); expect(result.private_data.reconciliations[0]).toMatchObject({ request_id: source.id, status: 'unknown' });
  } finally { await f.close(); }
});

test('failed observation intent publication sends nothing and releases its lease without replacing the original operation', async () => {
  const f = fixture();
  try {
    const source = f.create(); let sends = 0;
    f.store.before_publish = () => { throw new Error('PRIVATE-INTENT-ERROR'); };
    await expect(f.operations.observe(source.id, source.revision, async () => { sends++; })).rejects.toThrow('no action sent');
    expect(sends).toBe(0); expect(f.store.read(source.id)).toEqual(source); expect(f.store.isActive(source.id)).toBe(false); expect(f.operations.pending).toBe(0);
  } finally { f.store.before_publish = null; await f.close(); }
});

test('lost final observation publication leaves unknown with original installation facts, never reports completion or replays a read automatically', async () => {
  const f = fixture(); let sends = 0;
  try {
    const source = f.create(), result = await f.operations.observe(source.id, source.revision, async () => {
      sends++; f.store.before_publish = () => { f.store.before_publish = null; throw new Error('PRIVATE-PUBLICATION-ERROR'); }; return { checked: true };
    });
    expect(result.status).toBe(source.status); expect(result.stages).toEqual(source.stages); expect(result.private_data.reconciliations.at(-1).status).toBe('unknown');
    expect(result.private_data.reconciliations.at(-1).facts).toBeUndefined(); expect(sends).toBe(1); expect(f.store.isActive(source.id)).toBe(false);
  } finally { f.store.before_publish = null; await f.close(); }
});

test('confirmation purpose cannot authorize arbitrary stages, an unsealed ready receipt or a repeated installation run', async () => {
  const f = fixture();
  try {
    const row = f.create();
    expect(() => f.operations.run(row.id, row.revision, { purpose: 'confirm', stages: ['install_runtime'], finish: 'confirmed' }, async () => {})).toThrow('purpose');
    expect(f.store.read(row.id)).toEqual(row);
    const ready = f.store.change(row.id, row.revision, value => { value.status = 'ready'; });
    let dispatched = 0;
    await expect(f.operations.run(ready.id, ready.revision, { purpose: 'confirm', stages: ['confirm_remote', 'confirm_binding'], finish: 'confirmed' }, async () => { dispatched++; })).rejects.toThrow('cannot be replayed');
    expect(dispatched).toBe(0);
    expect(f.store.read(row.id)).toEqual(ready); // Invalid admission cannot overwrite its source facts.
    expect(f.store.isActive(row.id)).toBe(false);
  } finally { await f.close(); }
});

test('stage CAS intent precedes each dispatch, persists independent request IDs, and releases global locks before awaiting', async () => {
  const f = fixture();
  try {
    const row = f.create(); let cleanup = 0; const sends = [];
    const result = await f.operations.run(row.id, row.revision, { stages: ['prepare_installation', 'install_runtime'] }, async context => {
      context.onClose(() => { cleanup++; });
      for (const id of ['prepare_installation', 'install_runtime']) await context.stage(id, async request => {
        const durable = f.store.read(row.id), intent = durable.private_data.intents[id];
        expect(durable.status).toBe('running'); expect(intent.status).toBe('running'); expect(intent.request_id).toBe(request.request_id);
        expect(durable.private_data.active_stage).toBe(id); expect(f.store.isActive(row.id)).toBe(true);
        // This would fail if a receipt/global settings lock were held across network waits.
        const separate = f.create('independent-' + id); expect(separate.status).toBe('planned');
        sends.push(request.request_id); fs.appendFileSync(path.join(f.root, 'effects'), id + '\n');
        return { fixed_proof: id, raw_stderr: 'PRIVATE-TEST-STDERR' };
      }, (receipt, proof) => { receipt.private_data.proofs ??= {}; receipt.private_data.proofs[id] = proof.fixed_proof; });
    });
    expect(result.status).toBe('ready'); expect(result.stages.map(stage => stage.status)).toEqual(['complete', 'complete']);
    expect(new Set(sends).size).toBe(2); expect(JSON.stringify(result)).not.toContain('PRIVATE-TEST-STDERR');
    expect(Object.values(result.private_data.intents).map(intent => intent.request_id)).toEqual(sends);
    expect(result.private_data.active_stage).toBe(null); expect(cleanup).toBe(1); expect(f.operations.pending).toBe(0);
    expect(f.store.isActive(row.id)).toBe(false);
    expect(() => f.operations.run(row.id, result.revision, { stages: ['install_runtime'] }, async () => {})).toThrow('replayed');
    expect(fs.readFileSync(path.join(f.root, 'effects'), 'utf8').trim().split('\n')).toHaveLength(2);
  } finally { await f.close(); }
});

test('planned probe and approved apply retain distinct durable stage evidence without changing a frozen plan', async () => {
  const f = fixture();
  try {
    const row = f.create();
    const planned = await f.operations.run(row.id, 1, { stages: ['probe_target'], finish: 'planned', publish(receipt) {
      receipt.private_data.plan_sha256 = 'a'.repeat(64); receipt.private_data.plan_proof = { target: 'fixed' };
    } }, async context => { await context.stage('probe_target', async () => ({ os: 'linux' })); });
    expect(planned.status).toBe('planned');
    const applied = await f.operations.run(row.id, planned.revision, { stages: ['validate_target', 'install_runtime'] }, async context => {
      await context.stage('validate_target', async () => true);
      await context.stage('install_runtime', async () => true);
    });
    expect(applied.status).toBe('ready'); expect(applied.stages.map(stage => stage.id)).toEqual(['probe_target', 'validate_target', 'install_runtime']);
    expect(Object.keys(applied.private_data.intents)).toEqual(['probe_target', 'validate_target', 'install_runtime']);
    expect(applied.private_data.intents.probe_target.operation_id).not.toBe(applied.private_data.intents.install_runtime.operation_id);
    expect(applied.plan).toEqual(planned.plan); expect(applied.private_data.plan_proof).toEqual(planned.private_data.plan_proof);
  } finally { await f.close(); }
});

test('transport failure and missing required stages cannot report ready or replay; acknowledged rejection preserves completed partial effects', async () => {
  const f = fixture();
  try {
    const row = f.create(), failure = await f.operations.run(row.id, 1, { stages: ['install_runtime'] }, async context => {
      await context.stage('install_runtime', async () => { throw new Error('PRIVATE-TEST-AUTH-AND-STDERR'); });
    });
    expect(failure.status).toBe('unknown'); expect(failure.stages[0].status).toBe('unknown');
    expect(JSON.stringify(failure)).not.toContain('PRIVATE-TEST-AUTH-AND-STDERR');
    expect(() => f.create()).toThrow('unresolved');
    expect(() => f.operations.run(row.id, failure.revision, { stages: ['install_runtime'] }, async () => {})).toThrow('replayed');
    const partial = f.create('partial'), rejected = await f.operations.run(partial.id, 1, { stages: ['install_runtime', 'configure_runner'] }, async context => {
      await context.stage('install_runtime', async () => { fs.writeFileSync(path.join(f.root, 'installed'), 'retained'); });
      await context.stage('configure_runner', async () => { throw new DeploymentRejection(); });
    });
    expect(rejected.status).toBe('failed'); expect(rejected.stages.map(stage => stage.status)).toEqual(['complete', 'failed']);
    expect(fs.readFileSync(path.join(f.root, 'installed'), 'utf8')).toBe('retained');
    const incomplete = f.create('incomplete'), missing = await f.operations.run(incomplete.id, 1, { stages: ['verify_runner'] }, async () => {});
    expect(missing.status).toBe('unknown'); expect(missing.stages).toEqual([]);
  } finally { await f.close(); }
});

test('close publishes unknown before cancelling tracked children, waits for cleanup and rejects late ACK success', async () => {
  const f = fixture(), started = deferred(), release = deferred(); let calls = 0, closes = 0;
  try {
    const row = f.create(), pending = f.operations.run(row.id, 1, { stages: ['install_runtime'] }, async context => {
      context.onClose(() => { closes++; expect(f.store.read(row.id).status).toBe('unknown'); release.resolve({ acknowledged_after_disconnect: true }); });
      await context.stage('install_runtime', async () => { calls++; started.resolve(); return release.promise; });
    });
    await started.promise; expect(f.operations.pending).toBe(1);
    expect(() => new DeploymentOperations(f.store).run(row.id, 1, { stages: ['install_runtime'] }, async () => {})).toThrow('executing');
    const closing = f.operations.close(); expect(f.store.read(row.id).status).toBe('unknown'); await closing;
    const result = await pending; expect(result.status).toBe('unknown'); expect(result.stages[0].status).toBe('unknown');
    expect(calls).toBe(1); expect(closes).toBe(1); expect(f.operations.pending).toBe(0); expect(f.store.isActive(row.id)).toBe(false);
    await f.operations.close(); expect(closes).toBe(1);
    expect(() => f.operations.run(row.id, result.revision, { stages: ['install_runtime'] }, async () => {})).toThrow('closed');
  } finally { release.resolve(); await f.close(); }
});

test('lost lease prevents ACK publication; abandoned running receipt derives unknown on inert reads without sending again', async () => {
  const f = fixture();
  try {
    const row = f.create(), lock = path.join(f.home, `.runner-deployment-${row.id}.lock`); let sends = 0;
    const result = await f.operations.run(row.id, 1, { stages: ['install_runtime'] }, async context => {
      await context.stage('install_runtime', async () => {
        sends++; fs.renameSync(lock, `${lock}.original`); fs.writeFileSync(lock, '', { mode: 0o600 }); return { acknowledged: true };
      });
    });
    expect(result.status).toBe('unknown'); expect(result.stages[0].status).toBe('unknown');
    const durable = f.store.read(row.id); expect(durable.status).toBe('running'); expect(durable.stages[0].status).toBe('running');
    const file = path.join(f.home, 'runner-deployments.json'), original = fs.readFileSync(file), mtime = fs.statSync(file).mtimeMs;
    expect(f.operations.view(durable).status).toBe('unknown'); expect(f.operations.view(durable).stages[0].status).toBe('unknown');
    expect(fs.readFileSync(file)).toEqual(original); expect(fs.statSync(file).mtimeMs).toBe(mtime); expect(sends).toBe(1);
  } finally { await f.close(); }
});
