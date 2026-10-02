import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, repo, git } from '../helpers.js';
import { Workspaces } from '../../src/core/workspaces.js';

async function commit(f, text) {
  fs.writeFileSync(path.join(f.root, 'file.txt'), text + '\n');
  await git(f.root, 'add', '.'); await git(f.root, 'commit', '-m', text);
  return git(f.root, 'rev-parse', 'HEAD');
}
async function world() { const f = fixture(); await repo(f.root); f.main = await f.project.bootstrapMain(); return f; }
function task(f, goal = 'current Task goal', target = 'main') {
  const row = f.store.create({ role: 'agent', goal, parent_id: f.main.id, task_kind: 'say' });
  f.store.update(row.id, { target_branch: target }); return row;
}
function legacyTask(f, goal, target = 'main') {
  const row = f.store.create({ role: 'worker', goal });
  f.store.update(row.id, { target_branch: target }); return row;
}

test('history follows first-parent, not side development, and preserves a paginated snapshot as main advances', async () => {
  const f = await world();
  try {
    const root = await git(f.root, 'rev-parse', 'HEAD');
    await git(f.root, 'checkout', '-b', 'side'); const side = await commit(f, 'side development');
    await git(f.root, 'checkout', 'main'); await git(f.root, 'merge', '--no-ff', 'side', '-m', 'feature landing');
    const merge = await git(f.root, 'rev-parse', 'HEAD'); const newest = await commit(f, 'direct commit');
    const first = await f.project.branchHistory({ limit: 1 });
    expect(first.tip).toBe(newest); expect(first.commits.map(c => c.commit)).toEqual([newest]); expect(first.has_more).toBe(true);
    await commit(f, 'new main advancement');
    const second = await f.project.branchHistory({ limit: 1, cursor: first.cursor });
    expect(second.tip).toBe(newest); expect(second.commits[0].commit).toBe(merge); expect(second.commits[0].parents).toHaveLength(2);
    const last = await f.project.branchHistory({ limit: 1, cursor: second.cursor });
    expect(last.commits.map(c => c.commit)).toEqual([root]); expect(last.has_more).toBe(false); expect(last.cursor).toBeNull();
    const old = legacyTask(f, 'legacy side source');
    f.store.event(old.id, 'merged', { commit: side, legacy: true });
    const history = await f.project.branchHistory();
    expect(history.commits.some(c => c.commit === side)).toBe(false);
    expect(history.commits.find(c => c.commit === merge).tasks).toEqual([]);
    expect(first.commits[0]).toMatchObject({ subject: 'direct commit', author: { name: 'Lush Test' }, association: 'unassociated', tasks: [] });
  } finally { await f.close(); }
});

test('exact main landing evidence binds each delivery, original input and historical merged records, never titles or non-main events', async () => {
  const f = await world();
  try {
    const parent = f.main, t = task(f), child = task(f, 'child', 'feature');
    f.store.run('INSERT INTO inputs(id,content,task_id) VALUES (?,?,?)', 91, 'original say differs from goal', t.id);
    f.store.run('UPDATE tasks SET input_id=? WHERE id=?', 91, t.id);
    const a = await commit(f, 'first delivery'), b = await commit(f, 'second delivery');
    const fake = await commit(f, `Merge task #${t.id}: pretend`), side = await commit(f, 'non-main delivery');
    f.store.event(t.id, 'task.merge_integrated', { commit: a, parent_id: parent.id, squash: true });
    f.store.event(t.id, 'task.merge_integrated', { commit: b, parent_id: parent.id, squash: true });
    // Duplicate compatibility audits collapse only within this commit, not across deliveries.
    f.store.event(t.id, 'task.merge_integrated', { commit: b, parent_id: parent.id });
    const owner = f.store.create({ role: 'agent', goal: 'owner', task_kind: 'owner' });
    f.store.update(owner.id, { branch: 'feature' });
    f.store.event(child.id, 'task.merge_integrated', { commit: side, parent_id: owner.id });
    f.store.event(child.id, 'merged', { commit: side, parent: 'feature' });
    const old = task(f, 'legacy'); f.store.event(old.id, 'merged', { commit: a, parent: 'main' });
    f.store.run('INSERT INTO events(task_id,type,data) VALUES (?,?,?)', t.id, 'task.merge_integrated', '{invalid');
    const result = await f.project.branchHistory(), by = new Map(result.commits.map(c => [c.commit, c]));
    expect(by.get(a).tasks.map(t => t.id).sort()).toEqual([t.id, old.id].sort());
    expect(by.get(b).tasks).toHaveLength(1); expect(by.get(b).tasks[0]).toMatchObject({ id: t.id, input: { id: 91, content: 'original say differs from goal' }, evidence: 'task.merge_integrated' });
    expect(by.get(a).tasks.find(t => t.id === old.id).evidence).toBe('merged');
    expect(by.get(fake).association).toBe('unassociated'); expect(by.get(side).association).toBe('unassociated');
    // Missing parent evidence must not fall back to misleading current target_branch.
    f.store.event(t.id, 'task.merge_integrated', { commit: fake, parent_id: 999999 });
    expect((await f.project.branchHistory()).commits.find(c => c.commit === fake).tasks).toEqual([]);
  } finally { await f.close(); }
});

test('merge_integrated requires an explicit integer main parent ID, never current target fallback or coerced IDs', async () => {
  const f = await world();
  try {
    const t = task(f), sha = await commit(f, 'ambiguous landing target');
    f.store.event(t.id, 'task.merge_integrated', { commit: sha });
    for (const parent_id of [null, String(f.main.id), true, false, {}, []]) {
      f.store.event(t.id, 'task.merge_integrated', { commit: sha, parent_id });
    }
    // Preserve a real-valued JSON number which SQLite could coerce to the main ID.
    f.store.run('INSERT INTO events(task_id,type,data) VALUES (?,?,?)', t.id, 'task.merge_integrated',
      `{"commit":"${sha}","parent_id":${f.main.id}.0}`);
    expect((await f.project.branchHistory()).commits[0].tasks).toEqual([]);
    f.store.event(t.id, 'task.merge_integrated', { commit: sha, parent_id: f.main.id });
    expect((await f.project.branchHistory()).commits[0].tasks.map(t => t.id)).toEqual([t.id]);
  } finally { await f.close(); }
});

test('legacy target fallback is restricted to old Tasks and explicit non-main evidence always wins', async () => {
  const f = await world();
  try {
    const sha = await commit(f, 'legacy landing');
    const old = legacyTask(f, 'old protocol');
    const elsewhere = legacyTask(f, 'non-main old protocol', 'feature');
    const explicit = legacyTask(f, 'explicit non-main old protocol');
    f.store.event(old.id, 'merged', { commit: sha, legacy: true });
    f.store.event(elsewhere.id, 'merged', { commit: sha, legacy: true });
    f.store.event(explicit.id, 'merged', { commit: sha, legacy: true, parent: 'feature' });
    const fresh = task(f), freshChild = f.store.create({ role: 'agent', goal: 'new child', task_kind: 'child', target_branch: 'main' });
    f.store.update(freshChild.id, { target_branch: 'main' });
    f.store.event(fresh.id, 'merged', { commit: sha, legacy: true });
    f.store.event(freshChild.id, 'merged', { commit: sha, legacy: true });
    f.store.event(elsewhere.id, 'task.merge_integrated', { commit: sha });
    expect((await f.project.branchHistory()).commits[0].tasks.map(t => t.id)).toEqual([old.id]);
  } finally { await f.close(); }
});

test('parameters, forged/foreign/restarted cursors, absent main and broken repository are distinguished', async () => {
  const f = await world();
  try {
    await commit(f, 'one'); const first = await f.project.branchHistory({ limit: 1 });
    for (const limit of [0, 101, 1.5, null, '1']) await expect(f.project.branchHistory({ limit })).rejects.toThrow('limit');
    for (const cursor of ['', '--all', first.cursor + 'x', first.cursor.replace(/.$/, first.cursor.endsWith('0') ? '1' : '0')])
      await expect(f.project.branchHistory({ cursor })).rejects.toThrow('cursor');
    const restarted = new Workspaces(f.config, f.store);
    await expect(restarted.mainHistory({ cursor: first.cursor })).rejects.toThrow('cursor');
    await git(f.root, 'checkout', '-b', 'other'); await git(f.root, 'branch', '-D', 'main');
    await git(f.root, 'branch', 'main/topic'); // Prefix matches must not masquerade as main.
    expect(await f.project.branchHistory()).toEqual({ branch: 'main', tip: null, commits: [], cursor: null, has_more: false });
    const dir = path.join(f.root, '.git'); fs.renameSync(dir, dir + '.saved');
    await expect(f.project.branchHistory()).rejects.toThrow();
    fs.renameSync(dir + '.saved', dir);
  } finally { await f.close(); }
});

test('oversized whole pages fail explicitly while smaller pages remain readable', async () => {
  const f = await world();
  try {
    const t = task(f);
    f.store.run('INSERT INTO inputs(id,content,task_id) VALUES (?,?,?)', 1, 'x'.repeat(120000), t.id);
    f.store.run('UPDATE tasks SET input_id=? WHERE id=?', 1, t.id);
    for (let n = 0; n < 5; n++) {
      const sha = await commit(f, `delivery ${n}`);
      f.store.event(t.id, 'task.merge_integrated', { commit: sha, parent_id: f.main.id });
    }
    await expect(f.project.branchHistory()).rejects.toThrow('response exceeds safe size');
    expect((await f.project.branchHistory({ limit: 1 })).commits[0].tasks[0].input.content).toHaveLength(120000);
  } finally { await f.close(); }
});

test('large original says fail explicitly instead of silent truncation', async () => {
  const f = await world();
  try {
    const t = task(f), sha = await commit(f, 'huge say');
    f.store.run('INSERT INTO inputs(id,content,task_id) VALUES (?,?,?)', 1, 'x'.repeat(131073), t.id);
    f.store.run('UPDATE tasks SET input_id=? WHERE id=?', 1, t.id);
    f.store.event(t.id, 'task.merge_integrated', { commit: sha, parent_id: f.main.id });
    await expect(f.project.branchHistory()).rejects.toThrow('safe size');
  } finally { await f.close(); }
});
