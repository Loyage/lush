import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, repo, git } from '../helpers.js';
import { Workspaces } from '../../src/core/workspaces.js';

async function world() {
  const f = fixture(); await repo(f.root); f.main = await f.project.bootstrapMain();
  f.base = await git(f.root, 'rev-parse', 'HEAD'); return f;
}
function worker(f, branch, parent = f.main, base = f.base) {
  const t = f.store.create({ role: 'agent', goal: `goal ${branch}`, task_kind: parent === f.main ? 'order' : 'child', parent_id: parent.id });
  f.store.update(t.id, { branch, base_commit: base, target_branch: parent.branch });
  return f.store.task(t.id);
}
async function commit(f, message, file = 'file.txt') {
  fs.writeFileSync(path.join(f.root, file), message + '\n');
  await git(f.root, 'add', '.'); await git(f.root, 'commit', '-m', message); return git(f.root, 'rev-parse', 'HEAD');
}
async function squash(f, source, target, message = 'fixed landing') {
  const parent = await git(f.root, 'rev-parse', target), tree = await git(f.root, 'rev-parse', `${source}^{tree}`);
  const landed = await git(f.root, 'commit-tree', tree, '-p', parent, '-m', message);
  await git(f.root, 'checkout', target); await git(f.root, 'reset', '--hard', landed); return { parent, landed };
}
function receipt(f, t, source, landing, extra = {}) {
  const attempt_id = f.store.event(t.id, 'merge.attempt_started', { parent_id: t.parent_id });
  f.store.event(t.id, 'merge.baseline_fixed', { attempt_id, baseline: landing.parent });
  return f.store.event(t.id, 'task.merge_integrated', { source_commit: source, commit: landing.landed,
    parent_id: t.parent_id, squash: true, attempt_id, ...extra });
}
async function all(f, options = {}, limit = 1) {
  let cursor, pages = [], seen = new Set();
  do {
    const page = await f.project.branchVersionGraph({ ...options, limit, ...(cursor ? { cursor } : {}) });
    pages.push(page);
    for (const row of page.commits) { expect(seen.has(row.commit)).toBe(false); seen.add(row.commit); }
    cursor = page.cursor;
  } while (cursor);
  return { commits: pages.flatMap(p => p.commits), pages };
}

test('main graph includes every reachable branch, real topology/parents and root, but not unlanded refs; history stays first-parent', async () => {
  const f = await world();
  try {
    await git(f.root, 'checkout', '-b', 'side'); const side = await commit(f, 'side', 'side.txt');
    await git(f.root, 'checkout', 'main'); const direct = await commit(f, 'main', 'main.txt');
    await git(f.root, 'merge', '--no-ff', 'side', '-m', 'branch join'); const join = await git(f.root, 'rev-parse', 'HEAD');
    await git(f.root, 'checkout', '-b', 'unlanded'); const hidden = await commit(f, 'unlanded', 'hidden.txt'); await git(f.root, 'checkout', 'main');
    const before = await git(f.root, 'status', '--porcelain');
    const graph = await all(f), ids = graph.commits.map(c => c.commit);
    expect(new Set(ids)).toEqual(new Set([join, side, direct, f.base])); expect(ids).not.toContain(hidden);
    expect(graph.commits[0]).toMatchObject({ parents: [direct, side], association: 'unassociated', tasks: [] });
    for (const c of graph.commits) for (const p of c.parents) expect(ids.indexOf(c.commit)).toBeLessThan(ids.indexOf(p));
    expect(graph.pages[0]).toMatchObject({ scope: 'main', branch: 'main', tip: join, base: null, worker: null, delivery: null });
    expect((await f.project.branchHistory()).commits.map(c => c.commit)).toEqual([join, direct, f.base]);
    expect(await git(f.root, 'status', '--porcelain')).toBe(before);
  } finally { await f.close(); }
});

test('main Squash drills into a fixed Event and exact child Squash recursively; source commits cannot recursively open themselves', async () => {
  const f = await world();
  try {
    const t = worker(f, 'feature'); await git(f.root, 'checkout', '-b', t.branch);
    const own = await commit(f, 'own work', 'own.txt');
    const child = worker(f, 'child', t, own); await git(f.root, 'checkout', '-b', child.branch);
    const c1 = await commit(f, 'child first', 'c1.txt'), c2 = await commit(f, 'child second', 'c2.txt');
    const childLanding = await squash(f, c2, t.branch, 'misleading #999 not attribution');
    const childEvent = receipt(f, child, c2, childLanding);
    // Wrong parent and post-delivery records must not acquire child ownership.
    const other = worker(f, 'other'); f.store.event(other.id, 'task.merge_integrated', {
      commit: childLanding.landed, source_commit: c2, parent_id: f.main.id, squash: true });
    const tip = await commit(f, 'final feature', 'final.txt');
    const mainLanding = await squash(f, tip, 'main'); const delivery = receipt(f, t, tip, mainLanding);
    f.store.event(other.id, 'task.merge_integrated', { commit: own, source_commit: c1, parent_id: t.id, squash: true });
    // Current Worker state is deliberately unrelated to the fixed receipt.
    f.store.update(t.id, { head_commit: f.base, iteration_base_commit: f.base });
    await git(f.root, 'branch', '-f', t.branch, f.base); await git(f.root, 'branch', '-D', t.branch);
    await git(f.root, 'branch', '-D', child.branch);
    const graph = await f.project.branchVersionGraph();
    expect(graph.commits[0].tasks[0]).toMatchObject({ id: t.id, delivery_id: delivery, delivery_available: true });
    const source = await all(f, { delivery });
    expect(source.commits.map(c => c.commit)).toEqual([tip, childLanding.landed, own]);
    expect(source.pages[0]).toMatchObject({ scope: 'delivery', branch: t.branch, tip, base: f.base, delivery,
      worker: { id: t.id, worker_number: t.worker_number, goal: t.goal } });
    expect(source.commits[1].tasks.map(t => t.delivery_id)).toEqual([childEvent]);
    for (const row of [source.commits[0], source.commits[2]]) expect(row.tasks[0]).toMatchObject({ id: t.id, delivery_id: null, delivery_available: false, evidence: 'delivery.source' });
    const nested = await all(f, { delivery: childEvent });
    expect(nested.commits.map(c => c.commit)).toEqual([c2, c1]); expect(nested.pages[0].base).toBe(own);
  } finally { await f.close(); }
});

test('later rounds use previous fixed source, exclude synchronized parent work and preserve original receipt', async () => {
  const f = await world();
  try {
    const t = worker(f, 'feature'); await git(f.root, 'checkout', '-b', t.branch);
    const first = await commit(f, 'first', 'first.txt'); const landing1 = await squash(f, first, 'main');
    const round1 = receipt(f, t, first, landing1);
    const sibling = await commit(f, 'other parent feature', 'sibling.txt');
    await git(f.root, 'checkout', t.branch); await git(f.root, 'merge', 'main', '-m', 'parent sync'); const sync = await git(f.root, 'rev-parse', 'HEAD');
    f.store.event(t.id, 'task.parent_synced', { source_commit: first, parent_commit: sibling, head_commit: sync, parent_id: f.main.id });
    const second = await commit(f, 'second', 'second.txt'); const landing2 = await squash(f, second, 'main'); const round2 = receipt(f, t, second, landing2);
    f.store.update(t.id, { head_commit: sibling, iteration_base_commit: sibling });
    expect((await all(f, { delivery: round1 })).commits.map(c => c.commit)).toEqual([first]);
    const next = await all(f, { delivery: round2 });
    expect(next.pages[0].base).toBe(first); expect(next.commits.map(c => c.commit)).toEqual([second, sync]);
    expect(next.commits.some(c => [sibling, landing1.landed, first].includes(c.commit))).toBe(false);
    expect(next.commits[1].parents).toEqual([first, sibling]);
    const main = await f.project.branchVersionGraph();
    expect(main.commits.find(c => c.commit === landing1.landed).tasks[0].delivery_id).toBe(round1);
    expect(main.commits.find(c => c.commit === landing2.landed).tasks[0].delivery_id).toBe(round2);
  } finally { await f.close(); }
});

test('equal-tree success uses its precise attempt baseline, returns empty range, and never falls back when audit is absent', async () => {
  const f = await world();
  try {
    const t = worker(f, 'feature'); await git(f.root, 'checkout', '-b', t.branch); const source = await commit(f, 'same tree', 'same.txt');
    const landing = await squash(f, source, 'main');
    const good = receipt(f, t, source, { parent: landing.landed, landed: landing.landed });
    expect((await f.project.branchVersionGraph({ delivery: good })).commits.map(c => c.commit)).toEqual([source]);
    const duplicate = receipt(f, t, source, { parent: landing.landed, landed: landing.landed });
    expect((await f.project.branchVersionGraph({ delivery: duplicate })).commits).toEqual([]);
    const unknown = f.store.event(t.id, 'task.merge_integrated', { commit: source, source_commit: source, parent_id: f.main.id, squash: true });
    await expect(f.project.branchVersionGraph({ delivery: unknown })).rejects.toThrow('not traceable');
  } finally { await f.close(); }
});

test('missing/legacy/malformed evidence is explicit; unrelated success, false parents and Worker IDs cannot authorize drills', async () => {
  const f = await world();
  try {
    const t = worker(f, 'feature'); const sha = await commit(f, `Merge worker #${t.id} title is not evidence`);
    const legacy = f.store.event(t.id, 'merged', { commit: sha, parent: 'main' });
    const missing = f.store.event(t.id, 'task.merge_integrated', { commit: sha, parent_id: f.main.id, squash: true });
    for (const parent_id of [String(f.main.id), true, null]) f.store.event(t.id, 'task.merge_integrated', { commit: sha, source_commit: sha, parent_id, squash: true });
    f.store.run('INSERT INTO events(task_id,type,data) VALUES (?,?,?)', t.id, 'task.merge_integrated', '{invalid');
    const graph = await f.project.branchVersionGraph();
    expect(graph.commits[0].tasks.map(t => t.delivery_id)).toEqual([missing, legacy]);
    for (const task of graph.commits[0].tasks) expect(task.delivery_available).toBe(false);
    for (const delivery of [legacy, missing, 999999, t.id]) await expect(f.project.branchVersionGraph({ delivery })).rejects.toThrow('not traceable');
    const fake = await commit(f, 'title only');
    expect((await f.project.branchVersionGraph()).commits.find(c => c.commit === fake).tasks).toEqual([]);
  } finally { await f.close(); }
});

test('missing objects, non-ancestor baseline and contradictory exact parent/source evidence fail instead of current ref fallback', async () => {
  const f = await world();
  try {
    const t = worker(f, 'feature'); await git(f.root, 'checkout', '-b', t.branch); const source = await commit(f, 'source');
    const landing = await squash(f, source, 'main'); const good = receipt(f, t, source, landing);
    const missing = receipt(f, t, 'a'.repeat(40), landing);
    const main = await f.project.branchVersionGraph(); expect(main.commits[0].tasks.find(t => t.delivery_id === missing).delivery_available).toBe(true);
    await expect(f.project.branchVersionGraph({ delivery: missing })).rejects.toThrow('Git');
    await expect(f.project.branchVersionGraph({ delivery: good })).resolves.toMatchObject({ tip: source });
    const bad = worker(f, 'bad', f.main, landing.landed); const nonAncestor = receipt(f, bad, source, landing);
    await expect(f.project.branchVersionGraph({ delivery: nonAncestor })).rejects.toThrow('baseline');
    const badParent = worker(f, 'bad-parent'); const parentMismatch = receipt(f, badParent, source, { ...landing, parent: source });
    await expect(f.project.branchVersionGraph({ delivery: parentMismatch })).rejects.toThrow('disagree');
    const badTree = worker(f, 'bad-tree'); const mismatch = receipt(f, badTree, f.base, landing);
    await expect(f.project.branchVersionGraph({ delivery: mismatch })).rejects.toThrow('trees disagree');
  } finally { await f.close(); }
});

test('signed graph pagination binds main/delivery/ranges and event snapshot; refresh reads new main while old pages remain stable', async () => {
  const f = await world();
  try {
    const t = worker(f, 'feature'); await git(f.root, 'checkout', '-b', t.branch); const a = await commit(f, 'one', 'a.txt'); const b = await commit(f, 'two', 'b.txt');
    const landing = await squash(f, b, 'main'); const delivery = receipt(f, t, b, landing);
    const first = await f.project.branchVersionGraph({ limit: 1 }), fixed = await f.project.branchVersionGraph({ delivery, limit: 1 });
    const newer = await commit(f, 'advance', 'advance.txt');
    f.store.event(t.id, 'merged', { commit: f.base, parent: 'main' });
    const next = await f.project.branchVersionGraph({ cursor: first.cursor, limit: 1 });
    expect(next.tip).toBe(landing.landed); expect(next.commits[0].commit).toBe(f.base); expect(next.commits[0].tasks).toEqual([]);
    expect((await f.project.branchVersionGraph()).tip).toBe(newer);
    expect((await f.project.branchVersionGraph({ delivery, cursor: fixed.cursor, limit: 2 })).commits.map(c => c.commit)).toEqual([a]);
    const tampered = first.cursor.slice(0, -1) + (first.cursor.endsWith('0') ? '1' : '0');
    for (const options of [{ cursor: fixed.cursor }, { delivery, cursor: first.cursor }, { cursor: fixed.cursor + 'x' }, { cursor: tampered }, { cursor: '' }])
      await expect(f.project.branchVersionGraph(options)).rejects.toThrow('cursor');
    const restarted = new Workspaces(f.config, f.store);
    await expect(restarted.versionGraphPage({ cursor: first.cursor })).rejects.toThrow('cursor');
    await expect(restarted.mainHistory({ cursor: first.cursor })).rejects.toThrow('cursor');
    for (const delivery of [0, -1, '1', null, 1.5, Number.MAX_SAFE_INTEGER + 1]) await expect(f.project.branchVersionGraph({ delivery })).rejects.toThrow('Event ID');
    for (const limit of [0, 101, '1', null, 1.5]) await expect(f.project.branchVersionGraph({ limit })).rejects.toThrow('limit');
  } finally { await f.close(); }
});

test('missing prior-round evidence or contradictory attempt audit remains unavailable, not a creation/current baseline fallback', async () => {
  const f = await world();
  try {
    const t = worker(f, 'feature'); await git(f.root, 'checkout', '-b', t.branch); const source = await commit(f, 'fixed source'); const landing = await squash(f, source, 'main');
    f.store.event(t.id, 'merged', { commit: f.base, parent: 'main' });
    const incomplete = receipt(f, t, source, landing);
    expect((await f.project.branchVersionGraph()).commits[0].tasks[0]).toMatchObject({ delivery_id: incomplete, delivery_available: false });
    await expect(f.project.branchVersionGraph({ delivery: incomplete })).rejects.toThrow('此前成功交付');
    const conflict = worker(f, 'conflict'); const attempt_id = f.store.event(conflict.id, 'merge.attempt_started', {});
    for (const baseline of [f.base, source]) f.store.event(conflict.id, 'merge.baseline_fixed', { attempt_id, baseline });
    const ambiguous = f.store.event(conflict.id, 'task.merge_integrated', { source_commit: source, commit: landing.landed, parent_id: f.main.id, squash: true, attempt_id });
    expect((await f.project.branchVersionGraph()).commits[0].tasks[0]).toMatchObject({ delivery_id: ambiguous, delivery_available: false });
    await expect(f.project.branchVersionGraph({ delivery: ambiguous })).rejects.toThrow('相互矛盾');
  } finally { await f.close(); }
});

test('production parent-owned delivery queue emits traceable nested successful Events without synthetic receipts', async () => {
  const f = fixture(); f.project.stopping = true;
  f.project.kick = () => {}; f.project.scheduleTaskMerge = () => {};
  try {
    await repo(f.root);
    const { task: parent } = await f.project.order('real parent');
    fs.writeFileSync(path.join(parent.workspace, 'own.txt'), 'own'); await git(parent.workspace, 'add', '.'); await git(parent.workspace, 'commit', '-m', 'own development');
    const own = await git(parent.workspace, 'rev-parse', 'HEAD'); f.store.update(parent.id, { status: 'waiting' });
    const child = await f.project.spawn(parent.id, 'real child');
    fs.writeFileSync(path.join(child.workspace, 'child.txt'), 'child'); await git(child.workspace, 'add', '.'); await git(child.workspace, 'commit', '-m', 'child first');
    const first = await git(child.workspace, 'rev-parse', 'HEAD'); await git(child.workspace, 'commit', '--allow-empty', '-m', 'child second');
    const childTip = await git(child.workspace, 'rev-parse', 'HEAD'); f.store.update(child.id, { status: 'waiting', result: 'tested child' });
    await f.project.reserveTask(child.id, 'merge'); f.project.stopping = false; await f.project.driveTaskMerge(parent.id);
    expect(f.store.task(child.id).integration).toBe('merged');
    const childEvent = f.store.get("SELECT id,data FROM events WHERE task_id=? AND type='task.merge_integrated' ORDER BY id DESC LIMIT 1", child.id);
    const childLanding = JSON.parse(childEvent.data).commit;
    f.store.run('UPDATE messages SET consumed=1 WHERE task_id=?', parent.id); f.store.update(parent.id, { status: 'waiting', result: 'tested parent' });
    await f.project.reserveTask(parent.id, 'merge'); await f.project.driveTaskMerge(parent.parent_id);
    expect(f.store.task(parent.id).integration).toBe('merged');
    const parentEvent = f.store.get("SELECT id,data FROM events WHERE task_id=? AND type='task.merge_integrated' ORDER BY id DESC LIMIT 1", parent.id);
    const main = await f.project.branchVersionGraph(); expect(main.commits[0].tasks[0].delivery_id).toBe(parentEvent.id);
    const source = await f.project.branchVersionGraph({ delivery: parentEvent.id });
    expect(source.commits.map(c => c.commit)).toEqual([childLanding, own]); expect(source.commits[0].tasks[0].delivery_id).toBe(childEvent.id);
    const childSource = await f.project.branchVersionGraph({ delivery: childEvent.id });
    expect(childSource.tip).toBe(childTip); expect(childSource.base).toBe(own); expect(childSource.commits.map(c => c.commit)).toEqual([childTip, first]);
  } finally { await f.close(); }
});

test('association audit overflow and large Worker/evidence text fail explicitly instead of silent truncation', async () => {
  const f = await world();
  try {
    const t = worker(f, 'feature'), sha = await commit(f, 'association limits');
    f.store.transaction(() => { for (let i = 0; i < 1001; i++) f.store.event(t.id, 'merged', { commit: sha, parent: 'main' }); });
    await expect(f.project.branchVersionGraph()).rejects.toThrow('associations exceed');
    f.store.run('DELETE FROM events WHERE task_id=?', t.id); f.store.event(t.id, 'merged', { commit: sha, parent: 'main' });
    f.store.run('UPDATE tasks SET goal=? WHERE id=?', 'g'.repeat(16385), t.id); await expect(f.project.branchVersionGraph()).rejects.toThrow('safe size');
    f.store.run('UPDATE tasks SET goal=? WHERE id=?', 'normal', t.id); f.store.event(t.id, 'merged', { commit: sha, parent: 'main', excess: 'x'.repeat(8192) });
    await expect(f.project.branchVersionGraph()).rejects.toThrow('evidence exceeds');
  } finally { await f.close(); }
});

test('missing main is an explicit empty graph; Git failure is not empty; oversized text/pages fail without cropping', async () => {
  const f = await world();
  try {
    const t = worker(f, 'feature'); const sha = await commit(f, 'landing'); f.store.event(t.id, 'merged', { commit: sha, parent: 'main' });
    f.store.run('INSERT INTO inputs(id,content,task_id) VALUES (?,?,?)', 1, 'x'.repeat(131073), t.id); f.store.run('UPDATE tasks SET input_id=1 WHERE id=?', t.id);
    await expect(f.project.branchVersionGraph()).rejects.toThrow('safe size');
    f.store.run('UPDATE inputs SET content=? WHERE id=1', 'x'.repeat(120000));
    for (let i = 0; i < 4; i++) { const sha = await commit(f, `delivery ${i}`); f.store.event(t.id, 'merged', { commit: sha, parent: 'main' }); }
    await expect(f.project.branchVersionGraph()).rejects.toThrow('response exceeds');
    expect((await f.project.branchVersionGraph({ limit: 1 })).commits[0].tasks[0].input.content).toHaveLength(120000);
    await git(f.root, 'checkout', '-b', 'elsewhere'); await git(f.root, 'branch', '-D', 'main'); await git(f.root, 'branch', 'main/topic');
    expect(await f.project.branchVersionGraph()).toEqual({ scope: 'main', branch: 'main', tip: null, base: null, worker: null, delivery: null, commits: [], cursor: null, has_more: false });
    fs.renameSync(path.join(f.root, '.git'), path.join(f.root, '.git.saved'));
    await expect(f.project.branchVersionGraph()).rejects.toThrow('Git'); fs.renameSync(path.join(f.root, '.git.saved'), path.join(f.root, '.git'));
  } finally { await f.close(); }
});
