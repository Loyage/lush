import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, repo, git } from '../helpers.js';
import { Workspaces } from '../../src/core/workspaces.js';

async function world() {
  const f = fixture(); f.project.stopping = true; f.project.kick = () => {}; f.project.scheduleTaskMerge = () => {};
  await repo(f.root); f.task = (await f.project.order('original order')).task;
  f.base = f.task.base_commit; f.main = f.store.task(f.task.parent_id); return f;
}
async function commit(workspace, name, empty = false) {
  if (!empty) { fs.writeFileSync(path.join(workspace, name + '.txt'), name); await git(workspace, 'add', '.'); }
  await git(workspace, 'commit', '--allow-empty', '-m', name + '\n\nbody'); return git(workspace, 'rev-parse', 'HEAD');
}
async function deliver(f, task = f.task) {
  f.store.update(task.id, { status: 'waiting', result: 'tested' });
  f.store.run('UPDATE messages SET consumed=1 WHERE task_id=?', task.id);
  await f.project.reserveTask(task.id, 'merge'); f.project.stopping = false; await f.project.driveTaskMerge(task.parent_id);
  expect(f.store.task(task.id).integration).toBe('merged');
  const row = f.store.get("SELECT id,data FROM events WHERE task_id=? AND type='task.merge_integrated' ORDER BY id DESC LIMIT 1", task.id);
  return { id: row.id, ...JSON.parse(row.data) };
}
async function pages(f, first, limit = 1) {
  const commits = [...first.commits], deliveries = [...first.deliveries]; let page = first;
  while (page.has_more) {
    page = await f.project.workerVersionLineage({ id: f.task.id, cursor: page.cursor, limit });
    expect(page.snapshot).toBe(first.snapshot); expect(page.tip).toBe(first.tip); expect(page.origin.commit).toBe(f.base);
    commits.push(...page.commits); deliveries.push(...page.deliveries);
  }
  return { commits, deliveries };
}

test('lifetime lineage starts at creation, keeps prior rounds, current development and real sync parents, never enumerates external parent history', async () => {
  const f = await world();
  try {
    const one = await commit(f.task.workspace, 'one'), round1 = await deliver(f);
    await f.project.syncTaskParent(f.task.id); const sync1 = await git(f.task.workspace, 'rev-parse', 'HEAD');
    const two = await commit(f.task.workspace, 'two'), round2 = await deliver(f);
    await f.project.syncTaskParent(f.task.id); const sync2 = await git(f.task.workspace, 'rev-parse', 'HEAD');
    const current = await commit(f.task.workspace, 'current');
    const external = await commit(f.root, 'external');
    await git(f.task.workspace, 'merge', 'main', '-m', 'join parent'); const join = await git(f.task.workspace, 'rev-parse', 'HEAD');
    f.store.update(f.task.id, { head_commit: external, iteration_base_commit: external });
    const first = await f.project.workerVersionLineage({ id: f.task.id, limit: 1 });
    expect(first).toMatchObject({ scope: 'lineage', range: 'first-parent', tip: join, tip_evidence: 'branch.ref', tip_delivery_id: null,
      origin: { commit: f.base }, parent: { id: f.main.id, worker_number: f.main.worker_number, branch: 'main' }, has_more: true });
    expect(first.commits[0].parents).toEqual([current, external]);
    expect(first.commits[0].tasks[0]).toMatchObject({ id: f.task.id, worker_number: f.task.worker_number, evidence: 'worker.source' });
    expect(JSON.stringify(first)).not.toContain('original order');
    const advanced = await commit(f.task.workspace, 'advanced');
    const futureEvent = f.store.event(f.task.id, 'merged', { commit: one, parent: 'main' });
    const all = await pages(f, first);
    expect(all.commits.map(c => c.commit)).toEqual([join, current, sync2, two, sync1, one]);
    expect(all.deliveries.map(d => d.delivery_id).sort((a, b) => a - b)).toEqual([round1.id, round2.id]);
    expect(all.deliveries).not.toContainEqual(expect.objectContaining({ delivery_id: futureEvent }));
    expect((await f.project.workerVersionLineage({ id: f.task.id })).tip).toBe(advanced);
    const detail = await f.project.workerVersionLineageCommit({ id: f.task.id, snapshot: first.snapshot, commit: one });
    expect(detail.commit).toMatchObject({ message: 'one\n\nbody', parents: [f.base] });
    expect(detail.commit.tasks[0].input.content).toBe('original order');
    expect(detail.deliveries).toHaveLength(1); expect(detail.deliveries[0]).toMatchObject({ delivery_id: round1.id, source_commit: one, commit: round1.commit, delivery_available: true });
    expect((await f.project.workerVersionLineageCommit({ id: f.task.id, snapshot: first.snapshot, commit: f.base })).commit.tasks).toEqual([]);
    for (const sha of [external, round1.commit, advanced])
      await expect(f.project.workerVersionLineageCommit({ id: f.task.id, snapshot: first.snapshot, commit: sha })).rejects.toThrow('outside');
  } finally { await f.close(); }
});

test('reclaimed branch recovers the entire fixed source lifetime, ignores mutable task hints and refuses the latest broken success', async () => {
  const f = await world();
  try {
    const one = await commit(f.task.workspace, 'one'); await deliver(f);
    await f.project.syncTaskParent(f.task.id); const sync = await git(f.task.workspace, 'rev-parse', 'HEAD');
    const two = await commit(f.task.workspace, 'two'), round2 = await deliver(f);
    await f.project.acceptTask(f.task.id); expect(f.store.task(f.task.id).workspace).toBeNull();
    f.store.update(f.task.id, { head_commit: f.base, iteration_base_commit: f.base });
    const first = await f.project.workerVersionLineage({ id: f.task.id, limit: 1 });
    expect(first).toMatchObject({ tip: two, tip_evidence: 'delivery.source', tip_delivery_id: round2.id, origin: { commit: f.base } });
    expect((await pages(f, first)).commits.map(row => row.commit)).toEqual([two, sync, one]);
    expect((await f.project.workerVersionLineageCommit({ id: f.task.id, snapshot: first.snapshot, commit: f.base })).commit.commit).toBe(f.base);
    f.store.event(f.task.id, 'task.merge_integrated', { commit: two, parent_id: f.main.id, squash: true });
    await expect(f.project.workerVersionLineage({ id: f.task.id })).rejects.toThrow('latest successful');
    // Existing signed pages and details do not sample newly appended bad evidence.
    expect((await pages(f, first)).commits.map(row => row.commit)).toEqual([two, sync, one]);
  } finally { await f.close(); }
});

test('all same-SHA Event mappings and a no-new-landing delivery survive, malformed successes are explicit records', async () => {
  const f = await world();
  try {
    const one = await commit(f.task.workspace, 'one'), first = await deliver(f);
    const repeat = f.store.event(f.task.id, 'task.merge_integrated', { source_commit: one, commit: first.commit, parent_id: f.main.id, squash: true });
    await f.project.syncTaskParent(f.task.id);
    const empty = await commit(f.task.workspace, 'no tree change', true);
    const attempt = 992;
    f.store.event(f.task.id, 'merge.baseline_fixed', { attempt_id: attempt, baseline: first.commit });
    const noNew = { id: f.store.event(f.task.id, 'task.merge_integrated', { source_commit: empty, commit: first.commit,
      parent_id: f.main.id, squash: true, attempt_id: attempt }) };
    const resultOnly = f.store.event(f.task.id, 'task.delivered', { no_changes: true, commit: empty, result: 'answer only' });
    const missingSource = f.store.event(f.task.id, 'task.merge_integrated', { commit: first.commit, parent_id: f.main.id, squash: true });
    const missingLanding = f.store.event(f.task.id, 'task.merge_integrated', { source_commit: one, parent_id: f.main.id, squash: true });
    const legacy = f.store.event(f.task.id, 'merged', { commit: first.commit, parent: 'main' });
    const graph = await f.project.workerVersionLineage({ id: f.task.id, limit: 1 });
    expect(graph.deliveries[0]).toMatchObject({ delivery_id: noNew.id, source_commit: empty, commit: first.commit, delivery_available: true });
    expect(graph.untraceable_deliveries.map(d => d.delivery_id).sort((a, b) => a - b)).toEqual([resultOnly, missingSource, missingLanding, legacy]);
    expect(graph.untraceable_deliveries.every(d => d.delivery_unavailable_reason && !d.delivery_available)).toBe(true);
    expect(graph.untraceable_deliveries.find(d => d.delivery_id === resultOnly)).toMatchObject({ source_commit: empty, commit: null });
    const all = await pages(f, graph);
    expect(all.deliveries.filter(d => d.source_commit === one).map(d => d.delivery_id).sort((a, b) => a - b)).toEqual([first.id, repeat]);
    expect(all.commits.find(row => row.commit === empty).parents).not.toContain(first.commit); // delivery is NOT a fabricated parent
  } finally { await f.close(); }
});

test('nested source chain includes actual child Squash node with exact associations, not child source history', async () => {
  const f = await world();
  try {
    const one = await commit(f.task.workspace, 'one'); f.store.update(f.task.id, { status: 'waiting' });
    const child = await f.project.spawn(f.task.id, 'child goal'), source = await commit(child.workspace, 'child');
    const childEvent = await deliver(f, child);
    const graph = await f.project.workerVersionLineage({ id: f.task.id });
    expect(graph.commits.map(row => row.commit)).toEqual([childEvent.commit, one]);
    expect(graph.commits[0].parents).toEqual([one]); expect(graph.commits[0].tasks[0].delivery_id).toBe(childEvent.id);
    const detail = await f.project.workerVersionLineageCommit({ id: f.task.id, snapshot: graph.snapshot, commit: childEvent.commit });
    expect(detail.commit.tasks[0].goal).toBe('child goal');
    await expect(f.project.workerVersionLineageCommit({ id: f.task.id, snapshot: graph.snapshot, commit: source })).rejects.toThrow('outside');
    const childGraph = await f.project.workerVersionLineage({ id: child.id });
    expect(childGraph.parent).toMatchObject({ id: f.task.id, worker_number: f.task.worker_number, branch: f.task.branch });
    expect(childGraph.origin.commit).toBe(one); expect(childGraph.deliveries[0].commit).toBe(childEvent.commit);
  } finally { await f.close(); }
});

test('origin no-change Event, missing landing objects, off-chain sources and parent mismatches never silently disappear', async () => {
  const f = await world();
  try {
    const attempt = 991;
    f.store.event(f.task.id, 'merge.baseline_fixed', { attempt_id: attempt, baseline: f.base });
    const originEvent = f.store.event(f.task.id, 'task.merge_integrated', { source_commit: f.base, commit: f.base, parent_id: f.main.id, squash: true, attempt_id: attempt });
    const initial = await f.project.workerVersionLineage({ id: f.task.id });
    expect(initial.commits).toEqual([]); expect(initial.deliveries[0]).toMatchObject({ delivery_id: originEvent, delivery_available: true });
    const own = await commit(f.task.workspace, 'own'), round = await deliver(f);
    const external = await commit(f.root, 'external'); await git(f.task.workspace, 'merge', 'main', '-m', 'sync');
    const offchain = f.store.event(f.task.id, 'task.merge_integrated', { source_commit: external, commit: external, parent_id: f.main.id, squash: true, attempt_id: attempt });
    const wrongParent = f.store.event(f.task.id, 'task.merge_integrated', { source_commit: own, commit: round.commit, parent_id: f.task.id, squash: true });
    const fakeLanding = 'a'.repeat(40), missingObject = f.store.event(f.task.id, 'task.merge_integrated', { source_commit: own, commit: fakeLanding, parent_id: f.main.id, squash: true });
    const graph = await f.project.workerVersionLineage({ id: f.task.id });
    expect(graph.untraceable_deliveries.map(d => d.delivery_id).sort((a, b) => a - b)).toEqual([offchain, wrongParent]);
    expect(graph.deliveries.find(d => d.delivery_id === missingObject)).toMatchObject({ delivery_available: false, commit: fakeLanding });
    expect(graph.deliveries.find(d => d.delivery_id === round.id).delivery_available).toBe(true);
  } finally { await f.close(); }
});

test('signatures isolate lineage from old graph, other Workers, cursor kinds and instances; arbitrary objects/limits and creation rewrites fail closed', async () => {
  const f = await world();
  try {
    const one = await commit(f.task.workspace, 'one'); await commit(f.task.workspace, 'two');
    const graph = await f.project.workerVersionLineage({ id: f.task.id, limit: 1 });
    const old = await f.project.workerVersionGraph({ id: f.task.id, limit: 1 });
    for (const cursor of [old.cursor, graph.snapshot, '', graph.cursor + 'x'])
      await expect(f.project.workerVersionLineage({ id: f.task.id, cursor })).rejects.toThrow();
    for (const snapshot of [old.snapshot, graph.cursor])
      await expect(f.project.workerVersionLineageCommit({ id: f.task.id, snapshot, commit: one })).rejects.toThrow('scope');
    await expect(f.project.workerVersionGraph({ id: f.task.id, cursor: graph.cursor })).rejects.toThrow('scope');
    await expect(f.project.workerVersionCommit({ id: f.task.id, snapshot: graph.snapshot, commit: one })).rejects.toThrow('scope');
    await expect(f.project.workerVersionLineageCommit({ id: f.main.id, snapshot: graph.snapshot, commit: one })).rejects.toThrow('scope');
    for (const limit of [0, 101, '1', null, 1.5]) await expect(f.project.workerVersionLineage({ id: f.task.id, limit })).rejects.toThrow('limit');
    for (const sha of [undefined, 'HEAD', one.slice(0, 12), '-n1', 'a'.repeat(40), await git(f.task.workspace, 'rev-parse', `${one}:one.txt`)])
      await expect(f.project.workerVersionLineageCommit({ id: f.task.id, snapshot: graph.snapshot, commit: sha })).rejects.toThrow();
    const original = f.project.workspaces; f.project.workspaces = new Workspaces(f.config, f.store);
    await expect(f.project.workerVersionLineage({ id: f.task.id, cursor: graph.cursor })).rejects.toThrow('expired'); f.project.workspaces = original;
    f.store.run('UPDATE branches SET created_from_commit=? WHERE branch=?', one, f.task.branch);
    await expect(f.project.workerVersionLineage({ id: f.task.id })).rejects.toThrow('creation baseline');
    f.store.run('UPDATE branches SET created_from_commit=? WHERE branch=?', f.base, f.task.branch);
    await git(f.task.workspace, 'reset', '--hard', f.base);
    expect((await f.project.workerVersionLineage({ id: f.task.id, cursor: graph.cursor })).commits[0].commit).toBe(one);
    await expect(f.project.workerVersionLineage({ id: f.main.id })).rejects.toThrow('no readable');
  } finally { await f.close(); }
});

test('a full 1000-Event same-source page retains every mapping within reader/response budgets; the 1001st Event fails explicitly', async () => {
  const f = await world();
  try {
    const source = await commit(f.task.workspace, 'source'), round = await deliver(f);
    f.store.transaction(() => {
      for (let i = 0; i < 999; i++) f.store.event(f.task.id, 'task.merge_integrated', {
        source_commit: source, commit: round.commit, parent_id: f.main.id, squash: true });
    });
    const graph = await f.project.workerVersionLineage({ id: f.task.id, limit: 1 });
    expect(graph.deliveries).toHaveLength(1000);
    expect(new Set(graph.deliveries.map(row => row.delivery_id)).size).toBe(1000);
    expect(graph.deliveries.every(row => row.source_commit === source && row.commit === round.commit && row.delivery_available)).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(graph))).toBeLessThan(512 * 1024);
    f.store.event(f.task.id, 'task.merge_integrated', { source_commit: source, commit: round.commit, parent_id: f.main.id, squash: true });
    await expect(f.project.workerVersionLineage({ id: f.task.id, limit: 1 })).rejects.toThrow('1000 Events');
  } finally { await f.close(); }
});

test('global evidence and text/response limits are explicit, not silent truncation; missing undeployed refs never fall back to HEAD', async () => {
  const f = await world();
  try {
    const one = await commit(f.task.workspace, 'one');
    f.store.run('UPDATE tasks SET goal=? WHERE id=?', 'x'.repeat(16385), f.task.id);
    const graph = await f.project.workerVersionLineage({ id: f.task.id }); expect(graph.commits).toHaveLength(1);
    await expect(f.project.workerVersionLineageCommit({ id: f.task.id, snapshot: graph.snapshot, commit: one })).rejects.toThrow('safe size');
    f.store.run('UPDATE tasks SET goal=? WHERE id=?', 'original order', f.task.id);
    f.store.event(f.task.id, 'merged', { oversized: 'e'.repeat(8193) });
    await expect(f.project.workerVersionLineage({ id: f.task.id })).rejects.toThrow('evidence exceeds');
    f.store.run("DELETE FROM events WHERE task_id=? AND type='merged'", f.task.id);
    f.store.transaction(() => { for (let i = 0; i < 1001; i++) f.store.event(f.task.id, 'merged', {}); });
    await expect(f.project.workerVersionLineage({ id: f.task.id })).rejects.toThrow('1000 Events');
    f.store.run("DELETE FROM events WHERE task_id=? AND type='merged'", f.task.id);
    const file = path.join(f.config.home, 'large-message'); fs.writeFileSync(file, 's'.repeat(520 * 1024));
    await git(f.task.workspace, 'commit', '--allow-empty', '-F', file);
    await expect(f.project.workerVersionLineage({ id: f.task.id, limit: 1 })).rejects.toThrow('response exceeds');
    await git(f.root, 'worktree', 'remove', f.task.workspace); await git(f.root, 'branch', '-D', f.task.branch);
    await expect(f.project.workerVersionLineage({ id: f.task.id })).rejects.toThrow('latest successful');
  } finally { await f.close(); }
});
