import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, repo, git } from '../helpers.js';
import { Workspaces } from '../../src/core/workspaces.js';

async function world() {
  const f = fixture(); f.project.stopping = true; f.project.kick = () => {}; f.project.scheduleTaskMerge = () => {};
  await repo(f.root); const { task } = await f.project.order('original order');
  f.task = task; f.base = task.base_commit; f.main = f.store.task(task.parent_id); return f;
}
async function commit(workspace, name) {
  fs.writeFileSync(path.join(workspace, name + '.txt'), name);
  await git(workspace, 'add', '.'); await git(workspace, 'commit', '-m', name); return git(workspace, 'rev-parse', 'HEAD');
}
async function deliver(f, task = f.task) {
  f.store.update(task.id, { status: 'waiting', result: 'tested' });
  f.store.run('UPDATE messages SET consumed=1 WHERE task_id=?', task.id);
  await f.project.reserveTask(task.id, 'merge'); f.project.stopping = false; await f.project.driveTaskMerge(task.parent_id);
  expect(f.store.task(task.id).integration).toBe('merged');
  return f.store.get("SELECT id,data FROM events WHERE task_id=? AND type='task.merge_integrated' ORDER BY id DESC LIMIT 1", task.id);
}

test('unlanded current Worker snapshot is compact, baseline/ref bound and excludes unrelated synchronized parent commits', async () => {
  const f = await world();
  try {
    const own = await commit(f.task.workspace, 'own'); const unrelated = await commit(f.root, 'parent-work');
    await git(f.task.workspace, 'merge', 'main', '-m', 'parent join'); const join = await git(f.task.workspace, 'rev-parse', 'HEAD');
    f.store.update(f.task.id, { head_commit: unrelated, iteration_base_commit: unrelated });
    const first = await f.project.workerVersionGraph({ id: f.task.id, limit: 1 });
    expect(first).toMatchObject({ scope: 'current', delivery: null, base: f.base, tip: join,
      worker: { id: f.task.id, worker_number: f.task.worker_number }, has_more: true });
    expect(first.commits[0].parents).toEqual([own, unrelated]);
    expect(first.commits[0].tasks[0]).toMatchObject({ id: f.task.id, evidence: 'worker.source', delivery_id: null });
    expect(JSON.stringify(first)).not.toContain('original order'); expect(first.commits[0].tasks[0].goal).toBeUndefined();
    const advanced = await commit(f.task.workspace, 'advance');
    const second = await f.project.workerVersionGraph({ id: f.task.id, cursor: first.cursor });
    expect(second.tip).toBe(join); expect(second.snapshot).toBe(first.snapshot); expect(second.commits.map(c => c.commit)).toEqual([own]);
    expect((await f.project.workerVersionGraph({ id: f.task.id })).tip).toBe(advanced);
    const detail = await f.project.workerVersionCommit({ id: f.task.id, snapshot: first.snapshot, commit: own });
    expect(detail.commit.tasks[0].goal).toBe('original order'); expect(detail.commit.tasks[0].input.content).toBe('original order');
    for (const sha of [unrelated, f.base, advanced]) await expect(f.project.workerVersionCommit({ id: f.task.id, snapshot: first.snapshot, commit: sha })).rejects.toThrow('outside');
    expect(await f.project.workerVersionDeliveries({ id: f.task.id })).toMatchObject({ deliveries: [], has_more: false });
  } finally { await f.close(); }
});

test('production nested Squash delivery uses exact persistent child number/Event with on-demand details and no fabricated Git edge', async () => {
  const f = await world();
  try {
    const own = await commit(f.task.workspace, 'own'); f.store.update(f.task.id, { status: 'waiting' });
    const child = await f.project.spawn(f.task.id, 'child goal'); const source = await commit(child.workspace, 'child');
    const childEvent = await deliver(f, child), childLanding = JSON.parse(childEvent.data).commit;
    const current = await f.project.workerVersionGraph({ id: f.task.id });
    expect(current.commits.map(c => c.commit)).toEqual([childLanding, own]);
    expect(current.commits[0].parents).toEqual([own]);
    expect(current.commits[0].tasks[0]).toMatchObject({ id: child.id, worker_number: child.worker_number, delivery_id: childEvent.id });
    expect(current.commits[0].tasks[0].goal).toBeUndefined();
    const parentEvent = await deliver(f);
    const fixed = await f.project.workerVersionGraph({ id: f.task.id, delivery: parentEvent.id, limit: 1 });
    expect(fixed.commits[0].tasks[0].delivery_id).toBe(childEvent.id);
    const detail = await f.project.workerVersionCommit({ id: f.task.id, snapshot: fixed.snapshot, commit: childLanding });
    expect(detail.commit.tasks[0].goal).toBe('child goal');
    expect((await f.project.workerVersionGraph({ id: child.id, delivery: childEvent.id })).tip).toBe(source);
    await expect(f.project.workerVersionGraph({ id: f.task.id, delivery: childEvent.id })).rejects.toThrow('does not belong');
    await expect(f.project.workerVersionGraph({ id: child.id, cursor: fixed.cursor, delivery: parentEvent.id })).rejects.toThrow('scope');
    await expect(f.project.workerVersionCommit({ id: child.id, snapshot: fixed.snapshot, commit: childLanding })).rejects.toThrow('scope');
    await expect(f.project.workerVersionCommit({ id: f.task.id, snapshot: fixed.snapshot, commit: source })).rejects.toThrow('outside');
    // Events written after sampling must not acquire ownership of a node in an old snapshot.
    f.store.event(child.id, 'merged', { commit: own, parent: f.task.branch });
    const next = await f.project.workerVersionGraph({ id: f.task.id, delivery: parentEvent.id, cursor: fixed.cursor });
    expect(next.commits[0].tasks[0].evidence).toBe('delivery.source');
  } finally { await f.close(); }
});

test('multiple successful rounds stay immutable; current means development since latest source; reclaimed branch falls back only to latest fixed success', async () => {
  const f = await world();
  try {
    const first = await commit(f.task.workspace, 'first'), round1 = await deliver(f);
    await git(f.task.workspace, 'merge', 'main', '-m', 'synchronize first landing');
    const sync = await git(f.task.workspace, 'rev-parse', 'HEAD');
    const second = await commit(f.task.workspace, 'second'), round2 = await deliver(f);
    const list = await f.project.workerVersionDeliveries({ id: f.task.id, limit: 1 });
    expect(list).toMatchObject({ before: round2.id, has_more: true }); expect(list.deliveries[0].delivery_id).toBe(round2.id);
    expect((await f.project.workerVersionDeliveries({ id: f.task.id, before: list.before, limit: 1 })).deliveries[0].delivery_id).toBe(round1.id);
    const fixed1 = await f.project.workerVersionGraph({ id: f.task.id, delivery: round1.id });
    expect(fixed1.commits.map(c => c.commit)).toEqual([first]);
    expect((await f.project.workerVersionGraph({ id: f.task.id, delivery: round2.id })).commits.map(c => c.commit)).toEqual([second, sync]);
    expect((await f.project.workerVersionGraph({ id: f.task.id })).commits).toEqual([]);
    await f.project.acceptTask(f.task.id);
    expect(f.store.task(f.task.id).status).toBe('completed');
    expect(f.store.task(f.task.id).workspace).toBeNull();
    await expect(git(f.root, 'rev-parse', '--verify', `refs/heads/${f.task.branch}`)).rejects.toThrow();
    f.store.update(f.task.id, { head_commit: f.base, iteration_base_commit: f.base });
    const archived = await f.project.workerVersionGraph({ id: f.task.id, limit: 1 });
    expect(archived).toMatchObject({ scope: 'delivery', delivery: round2.id, tip: second, base: first });
    expect((await f.project.workerVersionGraph({ id: f.task.id, cursor: archived.cursor })).commits[0].commit).toBe(sync);
    await expect(f.project.workerVersionGraph({ id: f.task.id, delivery: round2.id, cursor: archived.cursor })).rejects.toThrow('scope');
    expect((await f.project.workerVersionGraph({ id: f.task.id, delivery: round1.id })).tip).toBe(first);
    expect((await f.project.workerVersionCommit({ id: f.task.id, snapshot: fixed1.snapshot, commit: first })).commit.commit).toBe(first);
    f.store.event(f.task.id, 'task.merge_integrated', { commit: second, squash: true, parent_id: f.main.id });
    await expect(f.project.workerVersionGraph({ id: f.task.id })).rejects.toThrow('not traceable');
  } finally { await f.close(); }
});

test('snapshot/cursor kind, instance, Worker and delivery scopes cannot mix; strict limits and arbitrary objects are rejected', async () => {
  const f = await world();
  try {
    const one = await commit(f.task.workspace, 'one'); await commit(f.task.workspace, 'two');
    const current = await f.project.workerVersionGraph({ id: f.task.id, limit: 1 });
    for (const cursor of [current.snapshot, '', current.cursor + 'x']) await expect(f.project.workerVersionGraph({ id: f.task.id, cursor })).rejects.toThrow();
    const main = await f.project.branchVersionGraph({ limit: 1 });
    await expect(f.project.workerVersionGraph({ id: f.task.id, cursor: main.cursor })).rejects.toThrow();
    await expect(f.project.branchVersionGraph({ cursor: current.cursor })).rejects.toThrow('cursor');
    await expect(f.project.workerVersionCommit({ id: f.task.id, snapshot: current.cursor, commit: one })).rejects.toThrow('scope');
    for (const sha of ['HEAD', one.slice(0, 12), '-n1', 'a'.repeat(40), await git(f.task.workspace, 'rev-parse', `${one}:one.txt`)])
      await expect(f.project.workerVersionCommit({ id: f.task.id, snapshot: current.snapshot, commit: sha })).rejects.toThrow();
    for (const limit of [0, 101, '1', null, 1.5]) {
      await expect(f.project.workerVersionGraph({ id: f.task.id, limit })).rejects.toThrow('limit');
      expect(() => f.project.workerVersionDeliveries({ id: f.task.id, limit })).toThrow('limit');
    }
    const original = f.project.workspaces; f.project.workspaces = new Workspaces(f.config, f.store);
    await expect(f.project.workerVersionGraph({ id: f.task.id, cursor: current.cursor })).rejects.toThrow('expired');
    await expect(f.project.workerVersionCommit({ id: f.task.id, snapshot: current.snapshot, commit: one })).rejects.toThrow('expired');
    f.project.workspaces = original;
    f.store.run('UPDATE branches SET task_id=? WHERE branch=?', f.main.id, f.task.branch);
    await expect(f.project.workerVersionGraph({ id: f.task.id })).rejects.toThrow('ownership');
  } finally { await f.close(); }
});

test('real multi-source convergence keeps exact member receipts despite shared landing tree and supports lazy fixed member graph', async () => {
  const f = fixture(); f.project.kick = () => {}; f.project.scheduleTaskMerge = () => {}; f.project.scheduleConvergence = () => {};
  try {
    await repo(f.root); await f.project.bootstrapMain();
    const command = f.project.saveShortcutCommand({ name: 'combined validation', command: 'test -f first.txt && test -f second.txt' },
      f.project.shortcutCommands().revision).commands.items.at(-1);
    const config = await f.project.branchConvergence('main');
    await f.project.setBranchConvergence('main', true, { command_id: command.id, command_version: 1 }, config.revision);
    const sources = [];
    for (const name of ['first', 'second']) {
      const { task } = await f.project.order(name); const tip = await commit(task.workspace, name);
      f.store.update(task.id, { status: 'waiting' }); await f.project.requestTaskMerge(task.id); sources.push({ task, tip });
    }
    const run = await f.project.formConvergenceBatch(sources[0].task.parent_id);
    await f.project.prepareConvergenceRun(run.id, 1, new AbortController().signal);
    expect(f.store.deliveryRun(run.id).state).toBe('integrated');
    const main = await f.project.workerVersionGraph({ id: sources[0].task.parent_id });
    expect(main.commits[0].tasks.map(t => t.id).sort()).toEqual(sources.map(s => s.task.id).sort());
    for (const { task, tip } of sources) {
      const deliveries = f.project.workerVersionDeliveries({ id: task.id });
      expect(deliveries.deliveries[0].delivery_available).toBe(true);
      const fixed = await f.project.workerVersionGraph({ id: task.id, delivery: deliveries.deliveries[0].delivery_id });
      expect(fixed.commits.map(c => c.commit)).toEqual([tip]);
      expect((await f.project.workerVersionCommit({ id: task.id, snapshot: fixed.snapshot, commit: tip })).commit.tasks[0].worker_number).toBe(task.worker_number);
      const lineage = await f.project.workerVersionLineage({ id: task.id });
      expect(lineage.origin.commit).toBe(task.base_commit); expect(lineage.commits.map(row => row.commit)).toEqual([tip]);
      expect(lineage.deliveries[0]).toMatchObject({ delivery_id: deliveries.deliveries[0].delivery_id, source_commit: tip,
        commit: main.tip, delivery_available: true });
      expect(lineage.commits[0].parents).toEqual([task.base_commit]);
      expect((await f.project.workerVersionLineageCommit({ id: task.id, snapshot: lineage.snapshot, commit: tip })).deliveries[0].delivery_available).toBe(true);
    }
  } finally { await f.close(); }
});

test('missing undeployed branch has explicit error rather than current HEAD; main graph retains root and uses compact lazy details', async () => {
  const f = await world();
  try {
    const main = await f.project.workerVersionGraph({ id: f.main.id });
    expect(main).toMatchObject({ scope: 'main', delivery: null, tip: f.base, base: null });
    expect(main.commits[0].tasks).toEqual([]);
    expect((await f.project.workerVersionCommit({ id: f.main.id, snapshot: main.snapshot, commit: f.base })).commit.commit).toBe(f.base);
    await git(f.root, 'worktree', 'remove', f.task.workspace); await git(f.root, 'branch', '-D', f.task.branch);
    await expect(f.project.workerVersionGraph({ id: f.task.id })).rejects.toThrow('no successful fixed delivery');
  } finally { await f.close(); }
});
