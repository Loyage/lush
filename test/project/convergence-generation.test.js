import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, repo, git } from '../helpers.js';
import queue from '../../src/core/project/convergence-queue.js';
import prepare from '../../src/core/project/convergence-prepare.js';
import policy from '../../src/core/project/convergence-policy.js';
import { convergenceJSON } from '../../src/core/convergence-contract.js';
import { convergenceTopology } from '../../src/core/convergence-plan.js';

/** Real SQL/object provenance, controlled factory: these tests do not claim provider/validation execution. */
async function fixedOutput() {
  const f = fixture(); f.project.kick = () => {}; f.project.scheduleTaskMerge = () => {};
  Object.assign(f.project, queue, prepare, policy); f.project.scheduleConvergence = () => {};
  await repo(f.root);
  const { task } = await f.project.order('source increment');
  fs.writeFileSync(path.join(task.workspace, 'source.txt'), 'source\n');
  await git(task.workspace, 'add', '.'); await git(task.workspace, 'commit', '-m', 'source');
  await f.project.workspaces.finish(f.store.task(task.id));
  const source = f.store.task(task.id), baseline = await git(f.root, 'rev-parse', 'main');
  const definition = f.project.saveShortcutCommand({ name: 'test', command: 'true' }, f.project.shortcutCommands().revision).commands.items.at(-1);
  const validation = { command_id: definition.id, command_version: 1 };
  const member = { task_id: source.id, delivery_id: 101, enqueue_seq: 101, source_branch: source.branch,
    source_commit: source.head_commit, base_commit: baseline };
  const run = f.store.createDeliveryRun({ parent_id: source.parent_id, target_branch: 'main', baseline, validation,
    members: [member], data: { plan: convergenceTopology([member]), repair_attempts: 1 } });
  f.store.update(source.id, { status: 'waiting', reservation: JSON.stringify({ version: 3, kind: 'merge', status: 'requested',
    run_id: run.id, generation: 1, parent_id: source.parent_id, commit: source.head_commit, delivery_id: 101, enqueue_seq: 101 }) });
  const tree = await f.project.workspaces.commitTree(source.head_commit);
  const seed = await git(f.root, 'commit-tree', tree, '-p', baseline, '-p', source.head_commit, '-m', 'fixed two-input seed');
  const helper = f.store.create({ role: 'agent', task_kind: 'integration', parent_id: run.parent_id, name: 'controlled-old', goal: 'controlled output' });
  await f.project.workspaces.exclusive(() => f.project.workspaces.forkTaskUnsafe(helper, 'main', seed));
  const workspace = f.store.task(helper.id).workspace;
  fs.writeFileSync(path.join(workspace, 'repair.txt'), 'repair\n');
  await git(workspace, 'add', '.'); await git(workspace, 'commit', '-m', 'controlled repair');
  await f.project.workspaces.finish(f.store.task(helper.id));
  const output = f.store.task(helper.id).head_commit, outputTree = await f.project.workspaces.commitTree(output);
  f.store.update(helper.id, { status: 'awaiting_acceptance' });
  const node = f.store.createDeliveryNode({ run_id: run.id, generation: 1, node_key: 'leaf:101', state: 'ready', helper_id: helper.id,
    data: { kind: 'leaf', base: baseline, left: baseline, right: source.head_commit, seed_commit: seed, member_ids: [source.id],
      inputs: [], reason: 'content_conflict', repair_attempts: 1 }, result: { commit: output, tree: outputTree, via: 'integration' } });
  f.store.updateDeliveryRun(run.id, { integration_worker_id: helper.id,
    validation_result: { state: 'failed', tested_tree: outputTree, error: 'validation_failed' } }, 1);
  const calls = [];
  f.project.createConvergenceIntegration = async (runId, nodeId) => {
    const current = f.store.deliveryRun(runId), target = f.store.deliveryNode(nodeId);
    calls.push({ runId, nodeId, generation: current.generation, data: convergenceJSON(target.data) });
    const next = f.store.create({ role: 'agent', task_kind: 'integration', parent_id: current.parent_id, goal: 'controlled new fixed attempt' });
    f.store.updateDeliveryNode(nodeId, { helper_id: next.id, state: 'resolving' }, current.generation);
    f.store.updateDeliveryRun(runId, { state: 'resolving', integration_worker_id: next.id }, current.generation);
    return next;
  };
  return { ...f, source, baseline, run, node, helper, seed, output, calls };
}

test('repeated validation repair gets a new immutable node/generation and preserves the previous seed/helper/result', async () => {
  const f = await fixedOutput(); try {
    const old = f.store.deliveryNode(f.node.id), parentTip = await git(f.root, 'rev-parse', 'main');
    f.project.convergenceJobs = new Map([[f.run.id, { generation: 1 }]]);
    expect(await f.project.requestConvergenceRepair(f.run.id, 1, f.node.id, 'validation_failed')).toBe(true);
    const current = f.store.deliveryRun(f.run.id), next = f.store.deliveryNodes(f.run.id, 2)[0];
    expect(current).toMatchObject({ generation: 2, state: 'resolving', candidate_commit: null, validation_result: null });
    expect(f.store.deliveryNode(f.node.id)).toEqual(old);
    expect(next.id).not.toBe(old.id); expect(next.helper_id).not.toBe(old.helper_id);
    expect(convergenceJSON(next.data)).toMatchObject({ seed_commit: f.output, left: f.baseline, right: f.source.head_commit,
      repair_attempts: 2, reused_from: { node_id: old.id, generation: 1 } });
    expect(await f.project.workspaces.isAncestor(f.root, f.baseline, f.output)).toBe(true);
    expect(await f.project.workspaces.isAncestor(f.root, f.source.head_commit, f.output)).toBe(true);
    expect(convergenceJSON(f.store.task(f.source.id).reservation).generation).toBe(2);
    expect(f.project.convergenceJobs.get(f.run.id).generation).toBe(2);
    expect(await git(f.root, 'rev-parse', 'main')).toBe(parentTip);
    await expect(f.project.requestConvergenceRepair(f.run.id, 1, old.id, 'validation_failed')).rejects.toThrow('attempt changed');
    expect(f.calls).toHaveLength(1);
  } finally { f.project.convergenceJobs?.clear(); await f.close(); }
});

test('allocation failure retains the fixed conflict and spends no unstarted-model budget', async () => {
  const f = await fixedOutput(); try {
    let races = 0;
    const factory = f.project.createConvergenceIntegration;
    f.project.createConvergenceIntegration = async () => {
      races++; throw new Error('PRIVATE must not be persisted');
    };
    await expect(f.project.requestConvergenceRepair(f.run.id, 1, f.node.id, 'validation_failed')).rejects.toThrow('PRIVATE');
    const waiting = f.store.deliveryRun(f.run.id), next = f.store.deliveryNodes(f.run.id, 2)[0];
    expect(waiting.state).toBe('preparing'); expect(convergenceJSON(waiting.data)).toMatchObject({ repair_attempts: 1, wait_reason: null });
    expect(next).toMatchObject({ state: 'conflict', helper_id: null });
    expect(convergenceJSON(next.data).repair_attempts).toBe(1);
    expect(waiting.error).toBeNull(); expect(races).toBe(1);
    f.project.setConvergenceState(f.run.id, 2, 'preparing');
    f.project.createConvergenceIntegration = factory;
    expect(await f.project.requestConvergenceRepair(f.run.id, 2, next.id, 'validation_failed')).toBe(true);
    expect(f.store.deliveryRun(f.run.id).generation).toBe(2);
    expect(convergenceJSON(f.store.deliveryNode(next.id).data).repair_attempts).toBe(2);
    expect(f.calls).toHaveLength(1);
  } finally { await f.close(); }
});

test('a preparation job owns its internally advanced generation but reports factory failure without replay', async () => {
  const f = await fixedOutput(); try {
    let calls = 0;
    f.project.createConvergenceIntegration = async () => { calls++; throw new Error('PRIVATE profile detail'); };
    f.project.prepareConvergenceRun = async (id, generation) => f.project.requestConvergenceRepair(id, generation, f.node.id, 'validation_failed');
    expect(f.project.startConvergenceJob(f.run.id)).toBe(true);
    await f.project.convergenceJobs.get(f.run.id).promise;
    const run = f.store.deliveryRun(f.run.id);
    expect(run).toMatchObject({ generation: 2, state: 'failed' });
    expect(run.error).not.toContain('PRIVATE'); expect(calls).toBe(1);
    expect(convergenceJSON(f.store.deliveryNodes(run.id, 2)[0].data).repair_attempts).toBe(1);
    expect(f.project.convergenceJobs.size).toBe(0);
  } finally { await f.close(); }
});

test('repair bound blocks further paid attempts without changing generation or a frozen helper', async () => {
  const f = await fixedOutput(); try {
    const old = f.store.deliveryNode(f.node.id);
    f.store.updateDeliveryNode(old.id, { data: { ...convergenceJSON(old.data), repair_attempts: 2 } }, 1);
    expect(await f.project.requestConvergenceRepair(f.run.id, 1, old.id, 'validation_failed')).toBe(false);
    expect(f.store.deliveryRun(f.run.id)).toMatchObject({ generation: 1, state: 'failed' });
    expect(f.store.deliveryNode(old.id).helper_id).toBe(old.helper_id); expect(f.calls).toHaveLength(0);
  } finally { await f.close(); }
});
