import { test, expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Dispatcher } from '../../src/rpc/dispatcher.js';
import { runnerIdentity } from '../../src/core/runner-service.js';
import { runnerProjectFixture, command } from './runner-delivery-harness.js';
import { remoteProfile } from './fixtures/runner-project.js';

async function setup() {
  const f = await runnerProjectFixture();
  f.project.kick = () => {};
  f.project.scheduleInputEmissions = () => {};
  f.project.scheduleDeliveryHandlerOperation = () => {};
  return { ...f, rpc: new Dispatcher(f.project) };
}
async function drain(f) {
  f.project.stopping = false;
  try { await f.project.drainInputEmissions(); }
  finally { f.project.stopping = true; }
}
const state = (f, input) => f.project.inputEmissionResult(input.draft_id).dispatch;
const emit = (f, options = {}) => f.rpc.dispatch('input.emit', { content: 'after quiet', runner_node_id: 'local', ...options });
async function cancelled(f) {
  const worker = await f.worker();
  f.project.cancel(worker.id);
  await Promise.allSettled([...(f.project.runnerStopJobs ?? [])]);
  expect(f.store.task(worker.id).status).toBe('cancelled');
  return worker;
}
function unknown(f, worker) {
  const binding = f.store.runnerBinding(worker.id);
  return f.store.markRunnerWorkspaceUnknown(runnerIdentity(binding), binding.revision);
}
function revised(f, worker) {
  const binding = unknown(f, worker);
  // Model a completed explicit reconciliation with the same already received HEAD. The
  // revision changed even though the binding is again ready and has no outstanding work.
  f.store.confirmRunnerWorkspace(runnerIdentity(binding), binding.head_commit, binding.revision);
}
async function merged(f) {
  const worker = await f.worker();
  await f.commit(worker);
  await f.project.requestTaskMerge(worker.id);
  f.project.stopping = false;
  try { await f.project.driveTaskMerge(f.main.id); }
  finally { f.project.stopping = true; }
  expect(f.store.task(worker.id).integration).toBe('merged');
  return worker;
}

for (const status of ['cancelled', 'completed']) test(`${status} remote dirty resources stay in subtree/project scope and block actual exclusive and parent_quiet dispatch`, async () => {
  const f = await setup();
  try {
    const worker = await cancelled(f);
    f.store.update(worker.id, { status });
    await command(worker.client, 'printf unaccepted > unaccepted.txt');
    expect(f.project.inputSubtree(f.main.id).some(row => row.id === worker.id)).toBe(true);
    expect(f.project.inputProjectWork().some(row => row.id === worker.id)).toBe(true);
    expect(await f.project.inputWorkspaceClean(f.store.task(worker.id))).toBe(false);
    for (const options of [{ exclusive: true }, { conditions: [{ kind: 'parent_quiet' }] }]) {
      const input = await emit(f, options); await drain(f);
      expect(state(f, input).state).toBe('waiting_conditions');
      expect(state(f, input).worker_id).toBeUndefined();
      expect(state(f, input).reason).toContain('脏现场');
    }
    expect(f.store.all('SELECT * FROM inputs')).toHaveLength(0);
  } finally { await f.close(); }
});

test('cancelled ready-clean remote workspace permits exclusive input without holding Git queue or transaction over observation', async () => {
  const f = await setup();
  try {
    const worker = await cancelled(f), inspect = f.project.workspaces.inspectRemoteWorkspace.bind(f.project.workspaces);
    let observations = 0;
    f.project.workspaces.inspectRemoteWorkspace = async options => {
      expect(f.store.db.inTransaction).toBe(false);
      expect(f.project.workspaces.pending).toBe(0);
      await f.project.workspaces.exclusive(async () => { observations++; });
      return inspect(options);
    };
    const input = await emit(f, { exclusive: true }); await drain(f);
    expect(observations).toBeGreaterThan(0);
    expect(state(f, input).state).toBe('succeeded');
    expect(f.store.task(state(f, input).worker_id).workspace).not.toBeNull();
    expect(f.store.runnerBinding(worker.id).state).toBe('ready');
  } finally { await f.close(); }
});

for (const barrier of ['unknown', 'offline', 'unsettled_sync', 'unconfirmed_run', 'different_head']) {
  test(`cancelled remote ${barrier} cannot become quiet just because its local workspace is null`, async () => {
    const f = await setup();
    try {
      const worker = await cancelled(f);
      if (barrier === 'unknown') unknown(f, worker);
      if (barrier === 'offline') f.service.connect = async () => { throw new Error('fixture offline'); };
      if (barrier === 'unsettled_sync') f.store.event(worker.id, 'task.runner_parent_sync_prepared', { request_id: randomUUID() });
      if (barrier === 'unconfirmed_run') {
        f.store.update(worker.id, { status: 'running' });
        const run = f.store.startRun(f.store.task(worker.id), { agent: 'fixture' });
        f.store.authorizeRunnerRun(runnerIdentity(f.store.runnerBinding(worker.id), { run_id: run.id }), f.policy.authorization_version);
        f.store.revokeRunnerRun(run.id);
        f.store.update(worker.id, { status: 'cancelled' });
        f.store.finishRun(run.id, 'cancelled', 'Provider exit alone is not stop proof');
      }
      if (barrier === 'different_head') await command(worker.client, 'git -c user.name=Fixture -c user.email=fixture@invalid commit --allow-empty -m unreceived');
      expect(await f.project.inputWorkspaceClean(f.store.task(worker.id))).toBe(false);
      const input = await emit(f, { conditions: [{ kind: 'parent_quiet' }] }); await drain(f);
      expect(state(f, input).state).toBe('waiting_conditions');
      expect(state(f, input).worker_id).toBeUndefined();
    } finally { await f.close(); }
  });
}

test('checked remote removal needs no online node, but a remaining Project settlement barrier still prevents exclusion', async () => {
  const f = await setup();
  try {
    const worker = await cancelled(f);
    await f.project.workspaces.cleanup(worker.id);
    expect(f.store.runnerBinding(worker.id).state).toBe('removed');
    f.service.connect = async () => { throw new Error('removed node must not be contacted'); };
    expect(await f.project.inputWorkspaceClean(f.store.task(worker.id))).toBe(true);
    expect(f.project.inputSubtree(f.main.id).some(row => row.id === worker.id)).toBe(false);
    expect(f.project.inputProjectWork().some(row => row.id === worker.id)).toBe(false);
    const request_id = randomUUID();
    f.store.event(worker.id, 'task.runner_parent_sync_prepared', { request_id });
    expect(f.project.inputSubtree(f.main.id).some(row => row.id === worker.id)).toBe(true);
    expect(f.project.inputProjectWork().some(row => row.id === worker.id)).toBe(true);
    expect(await f.project.inputWorkspaceClean(f.store.task(worker.id))).toBe(false);
    expect(f.project.inputQuietStateReason(f.main.id)).not.toBeNull();
    f.store.event(worker.id, 'task.runner_parent_sync_settled', { request_id });
    const input = await emit(f, { exclusive: true }); await drain(f);
    expect(state(f, input).state).toBe('succeeded');
  } finally { await f.close(); }
});

for (const change of ['unknown', 'revision']) {
  test(`creation guard rejects remote ${change} change after clean observation and before actual Input/ref creation`, async () => {
    const f = await setup();
    try {
      const worker = await cancelled(f), send = f.project.sendOrder.bind(f.project);
      f.project.sendOrder = async (...args) => {
        if (change === 'unknown') unknown(f, worker); else revised(f, worker);
        return send(...args);
      };
      const input = await emit(f, { exclusive: true }); await drain(f);
      expect(state(f, input).state).toBe('queued');
      expect(state(f, input).worker_id).toBeUndefined();
      expect(f.store.all('SELECT * FROM inputs')).toHaveLength(0);
      expect(f.store.tasks().filter(row => row.task_kind === 'order')).toHaveLength(1);
    } finally { await f.close(); }
  });
}

test('remote no-code exclusive result keeps its reservation when clean evidence changes, then releases after fresh proof', async () => {
  const f = await setup();
  let connection;
  try {
    f.project.provider.resolve = () => remoteProfile;
    const input = await emit(f, { exclusive: true, runner_node_id: f.nodes[0].id }); await drain(f);
    expect(state(f, input)).toMatchObject({ state: 'succeeded', exclusive_active: true });
    const task = f.store.task(state(f, input).worker_id);
    const identity = runnerIdentity(f.store.runnerBinding(task.id), { operation_id: randomUUID() });
    connection = await f.service.connect(identity);
    await f.project.workspaces.prepareRemoteWorkspace({ client: connection.client, identity, request_id: randomUUID(),
      authorization_version: f.policy.authorization_version, guard() { f.service.assertBinding(identity); } });
    // A controlled no-code invocation boundary; actual node preparation/inspection and input
    // creation/release remain real. This test does not claim a model invocation occurred.
    f.store.update(task.id, { status: 'waiting', head_commit: task.base_commit });
    f.store.event(task.id, 'task.idle', { head_commit: task.base_commit });
    const clean = f.project.inputWorkspaceClean.bind(f.project);
    f.project.inputWorkspaceClean = async (...args) => { const result = await clean(...args); revised(f, task); return result; };
    await drain(f);
    expect(state(f, input).exclusive_active).toBe(true);
    f.project.inputWorkspaceClean = clean;
    await drain(f);
    expect(state(f, input)).toMatchObject({ exclusive_active: false });
  } finally { await connection?.close(); await f.close(); }
});

test('worker_settled cannot latch a remote clean observation after its binding revision changes', async () => {
  const f = await setup();
  try {
    const worker = await merged(f), clean = f.project.inputWorkspaceClean.bind(f.project);
    f.project.inputWorkspaceClean = async (...args) => { const result = await clean(...args); revised(f, worker); return result; };
    const input = await emit(f, { conditions: [{ kind: 'worker_settled', worker_id: worker.id }] });
    await drain(f);
    expect(state(f, input).state).toBe('waiting_conditions');
    expect(state(f, input).conditions[0].satisfied).toBe(false);
    f.project.inputWorkspaceClean = clean;
    await drain(f);
    expect(state(f, input).state).toBe('succeeded');
  } finally { await f.close(); }
});

test('worker_merged requires real remote cleanliness; a changed binding cannot latch an old async merge proof', async () => {
  const f = await setup();
  try {
    const worker = await merged(f);
    await command(worker.client, 'printf dirty > unaccepted.txt');
    const input = await emit(f, { conditions: [{ kind: 'worker_merged', worker_id: worker.id }] });
    await drain(f);
    expect(state(f, input).state).toBe('waiting_conditions');
    expect(state(f, input).conditions[0].satisfied).toBe(false);
    await command(worker.client, 'rm unaccepted.txt');
    const ancestor = f.project.workspaces.isAncestor.bind(f.project.workspaces);
    f.project.workspaces.isAncestor = async (...args) => { const result = await ancestor(...args); revised(f, worker); return result; };
    await drain(f);
    expect(state(f, input).state).toBe('waiting_conditions');
    expect(state(f, input).conditions[0].satisfied).toBe(false);
    f.project.workspaces.isAncestor = ancestor;
    await drain(f);
    expect(state(f, input).state).toBe('succeeded');
    expect(state(f, input).conditions[0].satisfied).toBe(true);
  } finally { await f.close(); }
});
