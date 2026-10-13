import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, repo, git } from '../helpers.js';
import queue from '../../src/core/project/convergence-queue.js';
import prepare from '../../src/core/project/convergence-prepare.js';
import policy from '../../src/core/project/convergence-policy.js';
import { convergenceJSON } from '../../src/core/convergence-contract.js';

/** Real SQLite/refs/objects, controlled object algorithm and validation seams; not a publication/command proof. */
async function setup(count = 2, conflict = false) {
  const f = fixture(); f.project.kick = () => {}; f.project.scheduleTaskMerge = () => {};
  await repo(f.root);
  Object.assign(f.project, queue, prepare, policy);
  f.project.scheduleConvergence = () => {};
  const item = f.project.saveShortcutCommand({ name: '固定验证名称', command: 'true' }, f.project.shortcutCommands().revision).commands.items.at(-1);
  const validation = { command_id: item.id, command_version: 1 }, sources = [];
  for (let i = 0; i < count; i++) {
    const { task } = await f.project.order(`source ${i}`);
    fs.writeFileSync(path.join(task.workspace, `source-${i}.txt`), `source ${i}\n`);
    await git(task.workspace, 'add', '.'); await git(task.workspace, 'commit', '-m', `source ${i}`);
    await f.project.workspaces.finish(f.store.task(task.id));
    f.store.update(task.id, { status: 'waiting', reservation: JSON.stringify({ version: 3, kind: 'merge', status: 'requested', validation,
      parent_id: task.parent_id, delivery_id: 100 + i, enqueue_seq: 100 + i, commit: f.store.task(task.id).head_commit,
      base_commit: i === 0 && count > 1 ? task.base_commit : null }) });
    sources.push(f.store.task(task.id));
  }
  const baseline = await git(f.root, 'rev-parse', 'main'), calls = [];
  f.project.workspaces.mergeConvergenceObjects = async value => {
    calls.push(value);
    const tree = await git(f.root, 'rev-parse', `${value.right}^{tree}`);
    const commit = await git(f.root, 'commit-tree', tree, '-p', value.left, '-p', value.right, '-m', 'controlled object output');
    return { ...value, base: value.base ?? baseline, tree, commit, conflict };
  };
  f.project.workspaces.prepareConvergencePublishUnsafe = async value => ({ ...value,
    commit: await git(f.root, 'commit-tree', value.tree, '-p', value.baseline, '-m', 'controlled single-parent candidate'), workspace: f.root });
  f.project.workspaces.createConvergenceValidationUnsafe = async value => ({ ...value, path: path.join(f.config.home, 'controlled-validation'), ref: 'controlled-ref' });
  let validationCalls = 0, removed = false, published = false;
  f.project.workspaces.runConvergenceValidation = async (checkout, command, guard) => {
    expect(checkout.path).not.toBe(f.root); expect(command).toBe('true'); expect(guard()).toBe(true);
    validationCalls++; return { status: 'succeeded', exit_code: 0 };
  };
  f.project.workspaces.removeConvergenceValidationUnsafe = async () => { removed = true; };
  f.project.publishConvergence = async () => { published = true; return false; };
  f.project.createConvergenceIntegration = async (runId, nodeId) => {
    const run = f.store.deliveryRun(runId);
    const helper = f.store.create({ parent_id: run.parent_id, role: 'agent', task_kind: 'integration', goal: 'controlled repair' });
    f.store.updateDeliveryNode(nodeId, { state: 'resolving', helper_id: helper.id }, run.generation);
    f.store.updateDeliveryRun(runId, { state: 'resolving', integration_worker_id: helper.id }, run.generation);
    return helper;
  };
  const run = await f.project.formConvergenceBatch(sources[0].parent_id);
  return { ...f, sources, baseline, run, calls, flags: () => ({ validationCalls, removed, published }) };
}

test('parent formation/preparation uses actual Store claims and binds planned pair inputs before fixed validation', async () => {
  const f = await setup(); try {
    await f.project.prepareConvergenceRun(f.run.id, 1, new AbortController().signal);
    const run = f.store.deliveryRun(f.run.id), nodes = f.store.deliveryNodes(run.id, 1);
    expect(nodes.map(node => node.state)).toEqual(['ready','ready','ready']);
    const [leafA, leafB, pair] = nodes.map(node => ({ ...node, data: convergenceJSON(node.data), result: convergenceJSON(node.result) }));
    expect(leafA.data.base).toBe(f.baseline); expect(leafB.data.base).toBeNull(); expect(leafB.data.resolved_base).toBe(f.baseline);
    expect(pair.data.left).toBe(leafA.result.commit); expect(pair.data.right).toBe(leafB.result.commit);
    expect(pair.data.inputs).toEqual(['leaf:100','leaf:101']);
    expect(run.state).toBe('ready'); expect(convergenceJSON(run.validation_result).state).toBe('passed');
    expect(f.flags()).toEqual({ validationCalls: 1, removed: true, published: true });
    expect(f.calls).toHaveLength(3);
    expect((await git(f.root, 'rev-list', '--parents', '-n', '1', run.candidate_commit)).split(' ')).toEqual([run.candidate_commit, f.baseline]);
    expect(await git(f.root, 'rev-parse', 'main')).toBe(f.baseline);
    for (const source of f.sources) expect(await git(source.workspace, 'rev-parse', 'HEAD')).toBe(source.head_commit);
    expect(f.project.convergenceRunView(run.id).validation.command_name).toBe('固定验证名称');
  } finally { await f.close(); }
});

test('implicit source merge-base survives preparation as immutable null, with computed base recorded separately', async () => {
  const f = await setup(1); try {
    await f.project.prepareConvergenceRun(f.run.id, 1, new AbortController().signal);
    expect(f.calls[0].base).toBeNull();
    const node = f.store.deliveryNodes(f.run.id, 1)[0], data = convergenceJSON(node.data);
    expect(data.base).toBeNull(); expect(data.resolved_base).toBe(f.baseline);
    expect(() => f.store.updateDeliveryNode(node.id, { data: { ...data, base: f.baseline } }, 1)).toThrow('inputs');
    expect(f.store.deliveryRun(f.run.id).state).toBe('ready');
  } finally { await f.close(); }
});

test('parent conflict transition persists before requesting a fixed integration helper and never starts validation', async () => {
  const f = await setup(1, true); try {
    await f.project.prepareConvergenceRun(f.run.id, 1, new AbortController().signal);
    const run = f.store.deliveryRun(f.run.id), node = f.store.deliveryNodes(run.id, 1)[0];
    expect(run.state).toBe('resolving'); expect(node.state).toBe('resolving'); expect(node.helper_id).toBe(run.integration_worker_id);
    expect(convergenceJSON(node.data)).toMatchObject({ base: null, reason: 'content_conflict', repair_attempts: 1 });
    expect(f.flags()).toEqual({ validationCalls: 0, removed: false, published: false });
    expect(await git(f.root, 'rev-parse', 'main')).toBe(f.baseline);
  } finally { await f.close(); }
});
