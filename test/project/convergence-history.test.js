import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { Store } from '../../src/persistence/store.js';
import { fixture, repo, git, temp } from '../helpers.js';
import policy from '../../src/core/project/convergence-policy.js';
import { convergenceJSON } from '../../src/core/convergence-contract.js';
import { taskDeliveryState } from '../../src/core/project/iteration.js';

const A = 'a'.repeat(40), B = 'b'.repeat(40);
function setup() {
  const root = temp(), store = new Store(path.join(root, 'project.db'), root);
  const parent = store.create({ input_id: null, role: 'agent', goal: 'main', task_kind: 'main' });
  store.update(parent.id, { branch: 'main', status: 'waiting' });
  const sources = Array.from({ length: 2 }, (_, i) => {
    const task = store.create({ parent_id: parent.id, input_id: null, role: 'agent', goal: `source ${i}`, task_kind: 'child' });
    store.update(task.id, { branch: `source-${i}`, target_branch: 'main', status: 'waiting' }); return store.task(task.id);
  });
  const run = store.createDeliveryRun({ parent_id: parent.id, target_branch: 'main', baseline: A, validation: null,
    members: sources.map((task, i) => ({ task_id: task.id, source_branch: task.branch, source_commit: B, base_commit: A, delivery_id: 101 + i, enqueue_seq: 101 + i })) });
  return { root, store, parent, sources, run, close() { store.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

test('withdrawn inactive source can be deleted while the other member prepares, without destroying either snapshot', () => {
  const f = setup(); try {
    f.store.updateDeliveryRun(f.run.id, { generation: 2 }, 1); f.store.releaseDeliveryMembers(f.run.id, f.sources[0].id);
    expect(f.store.deliveryHistoryBlockers([f.sources[0].id])).toEqual([]);
    expect(f.store.deliveryHistoryBlockers([f.sources[1].id])).toHaveLength(1);
    f.store.hardDeleteTasks([f.sources[0].id]);
    expect(f.store.deliveryMembers(f.run.id)).toHaveLength(2);
    expect(f.store.deliveryMembers(f.run.id, true).map(row => row.task_id)).toEqual([f.sources[1].id]);
    expect(f.store.deliveryRun(f.run.id)).toMatchObject({ state: 'preparing', generation: 2 });
    expect(() => f.store.hardDeleteTasks([f.sources[1].id])).toThrow('active convergence');
  } finally { f.close(); }
});

test('unknown publication protects even an inactive historical member at both the preflight and SQLite boundaries', () => {
  const f = setup(); try {
    f.store.releaseDeliveryMembers(f.run.id);
    for (const state of ['landing','blocked']) {
      f.store.updateDeliveryRun(f.run.id, { state, landing_receipt: { commit: B } }, 1);
      expect(f.store.deliveryHistoryBlockers([f.sources[0].id])).toHaveLength(1);
      expect(() => f.store.hardDeleteTasks([f.sources[0].id])).toThrow('active convergence');
    }
    expect(f.store.task(f.sources[0].id).id).toBe(f.sources[0].id);
  } finally { f.close(); }
});

test('only current helper use blocks an idle helper; older-generation identity remains after deletion', () => {
  const f = setup(); try {
    const helper = f.store.create({ parent_id: f.parent.id, input_id: null, role: 'agent', goal: 'helper', task_kind: 'integration' });
    f.store.update(helper.id, { status: 'failed' });
    const node = f.store.createDeliveryNode({ run_id: f.run.id, generation: 1, node_key: 'old-helper', helper_id: helper.id });
    expect(f.store.deliveryHistoryBlockers([helper.id])).toHaveLength(1);
    expect(() => f.store.hardDeleteTasks([helper.id])).toThrow('active convergence');
    f.store.updateDeliveryRun(f.run.id, { generation: 2 }, 1);
    expect(f.store.deliveryHistoryBlockers([helper.id])).toEqual([]);
    expect(f.store.deleteDeliveryHistory([helper.id])).toBe(0);
    f.store.hardDeleteTasks([helper.id]);
    expect(f.store.deliveryNode(node.id).helper_id).toBe(helper.id);
    expect(f.store.deliveryRun(f.run.id).generation).toBe(2);
    expect(f.store.deliveryMembers(f.run.id, true)).toHaveLength(2);
  } finally { f.close(); }
});

test('source/helper snapshots have no live Task FK, while owner lifetime and creation checks remain strict', () => {
  const f = setup(); try {
    expect(f.store.all('PRAGMA foreign_key_list(delivery_members)').filter(row => row.table === 'tasks')).toEqual([]);
    expect(f.store.all('PRAGMA foreign_key_list(delivery_nodes)').filter(row => row.table === 'tasks')).toEqual([]);
    expect(f.store.all('PRAGMA foreign_key_list(delivery_runs)').filter(row => row.table === 'tasks').map(row => row.from)).toEqual(['parent_id']);
    expect(() => f.store.updateDeliveryRun(f.run.id, { integration_worker_id: 99999 }, 1)).toThrow('not found');
    expect(() => f.store.updateDeliveryRun(f.run.id, { integration_worker_number: 'W999' }, 1)).toThrow('fields');
    expect(() => f.store.createDeliveryNode({ run_id: f.run.id, generation: 1, node_key: 'bad-helper', helper_id: f.sources[0].id })).toThrow('binding');
    expect(f.store.deliveryHistoryBlockers([])).toEqual([]); expect(f.store.deleteDeliveryHistory([])).toBe(0);
  } finally { f.close(); }
});

test('nullable snapshot columns are added without backfilling old Worker identities or rewriting delivery rows', () => {
  const f = setup(); let other;
  try {
    f.store.db.exec(`ALTER TABLE delivery_members DROP COLUMN worker_number;
      ALTER TABLE delivery_members DROP COLUMN title;
      ALTER TABLE delivery_nodes DROP COLUMN helper_worker_number;
      ALTER TABLE delivery_runs DROP COLUMN integration_worker_number;`);
    const before = JSON.stringify(f.store.tasks()), members = f.store.deliveryMembers(f.run.id);
    other = new Store(path.join(f.root, 'project.db'), f.root);
    expect(JSON.stringify(other.tasks())).toBe(before);
    expect(other.deliveryMembers(f.run.id)).toEqual(members.map(row => ({ ...row, worker_number: null, title: null })));
    expect(other.deliveryRun(f.run.id).integration_worker_number).toBeNull();
  } finally { other?.close(); f.close(); }
});

test('deleted source and helper remain readable with exact ids, assigned numbers and fixed title, never inferred numbers', async () => {
  const f = fixture(); f.project.kick = () => {}; f.project.scheduleTaskMerge = () => {};
  Object.assign(f.project, policy);
  try {
    await repo(f.root); const parent = await f.project.bootstrapMain(), source = f.store.create({ parent_id: parent.id, input_id: null,
      role: 'agent', goal: 'original source', task_kind: 'child' });
    f.store.update(source.id, { branch: 'source', target_branch: 'main', status: 'completed', retry_profile: '{"token":"PRIVATE_PROFILE"}' });
    f.store.run('UPDATE tasks SET worker_number=?,display_title=? WHERE id=?', 'W98-3', '固定来源标题', source.id);
    const sha = await git(f.root, 'rev-parse', 'HEAD');
    const run = f.store.createDeliveryRun({ parent_id: parent.id, target_branch: 'main', validation: null, baseline: sha,
      members: [{ task_id: source.id, delivery_id: 101, enqueue_seq: 101, source_branch: 'source', source_commit: sha }] });
    const helper = f.store.create({ parent_id: parent.id, input_id: null, role: 'agent', goal: 'helper', task_kind: 'integration' });
    f.store.run('UPDATE tasks SET worker_number=? WHERE id=?', 'W98-4', helper.id); f.store.update(helper.id, { status: 'completed' });
    f.store.updateDeliveryRun(run.id, { state: 'integrated', integration_worker_id: helper.id }); f.store.releaseDeliveryMembers(run.id);
    const before = f.project.convergenceRunView(run.id), revision = before.revision;
    f.store.hardDeleteTasks([source.id, helper.id]);
    const after = (await f.project.branchConvergenceRuns('main')).items[0];
    expect(after.revision).toBe(revision);
    expect(after.members).toEqual([{ id: source.id, worker_number: 'W98-3', title: '固定来源标题', delivery_id: 101, source_commit: sha }]);
    expect(after.integration_worker).toEqual({ id: helper.id, worker_number: 'W98-4', status: 'deleted' });
    expect(JSON.stringify(after)).not.toContain('PRIVATE_PROFILE');
  } finally { await f.close(); }
});

/** Assembled SQL/Git/publication/validation plus actual acceptance/deletion; scheduling alone is controlled. */
test('independent order deletion and real GC retain shared receipts, survivor sync and a second exact publication', async () => {
  const f = fixture(); f.project.kick = () => {}; f.project.scheduleTaskMerge = () => {}; f.project.scheduleConvergence = () => {};
  try {
    await repo(f.root); await f.project.bootstrapMain();
    const entry = f.project.saveShortcutCommand({ name: '组合验证', command: 'test -f first.txt && test -f second.txt' },
      f.project.shortcutCommands().revision).commands.items.at(-1);
    f.project.authorizeShortcutCommand(entry.id, 1, true, f.project.shortcutCommands().revision);
    const view = await f.project.branchConvergence('main');
    await f.project.setBranchConvergence('main', true, { command_id: entry.id, command_version: 1 }, view.revision);
    const sources = [];
    for (const name of ['first', 'second']) {
      const { task } = await f.project.order(`${name} independent order`);
      fs.writeFileSync(path.join(task.workspace, `${name}.txt`), `${name}\n`);
      await git(task.workspace, 'add', '.'); await git(task.workspace, 'commit', '-m', name);
      f.store.update(task.id, { status: 'waiting' }); await f.project.requestTaskMerge(task.id);
      sources.push(f.store.task(task.id));
    }
    const [survivor, removed] = sources, run = await f.project.formConvergenceBatch(survivor.parent_id);
    await f.project.prepareConvergenceRun(run.id, 1, new AbortController().signal);
    const landed = f.store.deliveryRun(run.id), members = f.store.deliveryMembers(run.id), before = f.project.convergenceRunView(run.id);
    expect(landed.state).toBe('integrated');
    const receipt = convergenceJSON(landed.landing_receipt);
    await f.project.acceptTask(removed.id);
    expect(f.store.task(removed.id).status).toBe('completed');
    expect(f.store.task(survivor.id).status).toBe('awaiting_acceptance');
    const preview = await f.project.deleteTaskPreview(removed.id);
    expect(preview.blockers).toEqual([]);
    await f.project.deleteTask(removed.id, { confirm: true, revision: preview.revision });
    expect(f.store.get('SELECT id FROM tasks WHERE id=?', removed.id)).toBeNull();
    expect(f.store.deliveryRun(run.id)).toEqual(landed); expect(f.store.deliveryMembers(run.id)).toEqual(members);
    expect(f.project.convergenceRunView(run.id).members).toEqual(before.members);
    await f.project.workspaces.exclusive(async () => {
      await git(f.root, 'reflog', 'expire', '--expire=now', '--expire-unreachable=now', '--all');
      await git(f.root, 'gc', '--prune=now');
    });
    await expect(git(f.root, 'rev-parse', '--verify', `refs/heads/${removed.branch}`)).rejects.toThrow();
    expect(await git(f.root, 'rev-parse', receipt.evidence.ref)).toBe(receipt.evidence.commit);
    await git(f.root, 'cat-file', '-e', `${removed.head_commit}^{commit}`);
    expect(await taskDeliveryState(f.project, f.store.task(survivor.id))).toBe('merged');
    await f.project.syncTaskParent(survivor.id);
    expect(fs.readFileSync(path.join(survivor.workspace, 'second.txt'), 'utf8')).toBe('second\n');
    fs.writeFileSync(path.join(survivor.workspace, 'first.txt'), 'second iteration\n');
    await git(survivor.workspace, 'add', '.'); await git(survivor.workspace, 'commit', '-m', 'surviving increment');
    await f.project.requestTaskMerge(survivor.id);
    const next = await f.project.formConvergenceBatch(run.parent_id);
    await f.project.prepareConvergenceRun(next.id, 1, new AbortController().signal);
    expect(f.store.deliveryRun(next.id).state).toBe('integrated');
    expect(fs.readFileSync(path.join(f.root, 'first.txt'), 'utf8')).toBe('second iteration\n');
    expect(fs.readFileSync(path.join(f.root, 'second.txt'), 'utf8')).toBe('second\n');
    expect(f.store.deliveryRun(run.id).landing_receipt).toBe(landed.landing_receipt);
    expect(f.store.deliveryMembers(run.id)).toEqual(members);
  } finally { await f.close(); }
});

test('real user-confirmed single-order deletion preserves a sibling order and the complete shared batch', async () => {
  const f = fixture(); f.project.kick = () => {}; f.project.scheduleTaskMerge = () => {};
  Object.assign(f.project, policy);
  try {
    await repo(f.root); const sources = [];
    for (const goal of ['first independent order','second independent order']) {
      const { task } = await f.project.order(goal); sources.push(task);
    }
    const parent = f.store.task(sources[0].parent_id), sha = await git(f.root, 'rev-parse', 'HEAD');
    const run = f.store.createDeliveryRun({ parent_id: parent.id, target_branch: parent.branch, baseline: sha, validation: null,
      members: sources.map((task, i) => ({ task_id: task.id, source_branch: task.branch, source_commit: sha, delivery_id: 101 + i, enqueue_seq: 101 + i })) });
    f.store.updateDeliveryRun(run.id, { state: 'integrated' }); f.store.releaseDeliveryMembers(run.id);
    for (const task of sources) f.store.update(task.id, { status: 'completed', integration: 'merged', head_commit: sha,
      reservation: JSON.stringify({ version: 3, kind: 'merge', status: 'integrated', run_id: run.id, generation: 1, parent_id: parent.id }) });
    const snapshots = f.store.deliveryMembers(run.id), preview = await f.project.deleteTaskPreview(sources[0].id);
    expect(preview.blockers).toEqual([]); expect(preview.can_delete).toBe(true);
    await f.project.deleteTask(sources[0].id, { confirm: true, revision: preview.revision });
    expect(f.store.get('SELECT id FROM tasks WHERE id=?', sources[0].id)).toBeNull();
    expect(f.store.task(sources[1].id).branch).toBe(sources[1].branch);
    expect(f.store.deliveryMembers(run.id)).toEqual(snapshots); expect(f.store.deliveryRun(run.id).state).toBe('integrated');
    expect(f.project.convergenceRunView(run.id).members[0]).toMatchObject({ id: sources[0].id, worker_number: sources[0].worker_number, title: sources[0].goal });
    expect(await git(f.root, 'rev-parse', sources[1].branch)).toBe(sha);
  } finally { await f.close(); }
});
