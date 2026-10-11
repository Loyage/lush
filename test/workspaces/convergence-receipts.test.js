import { test, expect } from 'bun:test';
import { setup, git } from './convergence-harness.js';

async function ready() {
  const f = await setup();
  try {
    await f.member('a', { 'a.txt': 'a\n' }); await f.member('b', { 'b.txt': 'b\n' });
    const root = await f.combine(), receipt = await f.prepare(root.tree);
    return { ...f, receipt };
  } catch (error) { f.close(); throw error; }
}

test('recovery refuses misattributed source identity and source advance but never rolls back the landed target', async () => {
  const f = await ready();
  try {
    await f.apply(f.receipt);
    const forged = { ...f.receipt, members: f.receipt.members.map((member, index) => ({ ...member, task_id: f.receipt.members[1 - index].task_id })) };
    expect(await f.workspaces.verifyConvergencePublishUnsafe(forged)).toBe(false);
    await git(f.members[0].workspace, 'commit', '--allow-empty', '-m', 'outside source after publication');
    expect(await f.workspaces.verifyConvergencePublishUnsafe(f.receipt)).toBe(false);
    expect(await git(f.root, 'rev-parse', 'HEAD')).toBe(f.receipt.commit);
  } finally { f.close(); }
});

test('an unregistered source checkout identity cannot publish even when refs are unchanged', async () => {
  const f = await ready();
  try {
    f.store.update(f.members[0].task_id, { workspace: f.root });
    await expect(f.apply(f.receipt)).rejects.toThrow('identity');
    expect(await git(f.root, 'rev-parse', 'HEAD')).toBe(f.baseline);
    expect(await git(f.root, 'status', '--porcelain')).toBe('');
  } finally { f.close(); }
});

test('single-member convergence cannot bypass missing provenance merely because its source and landing trees coincide', async () => {
  const f = await setup();
  try {
    const a = await f.member('a', { 'a.txt': 'a\n' }), root = await f.combine(), receipt = await f.prepare(root.tree);
    await f.apply(receipt);
    f.store.update(a.task_id, { integration: 'merged', reservation: JSON.stringify({ version: 3, kind: 'merge', status: 'integrated',
      commit: a.source_commit, landed_commit: receipt.commit, parent_id: f.parent.id }) });
    expect(await git(f.root, 'rev-parse', `${a.source_commit}^{tree}`)).toBe(receipt.tree);
    await expect(f.workspaces.exclusive(() => f.workspaces.archiveSquashedTaskUnsafe(f.store.task(a.task_id), a.source_commit, receipt.commit))).rejects.toThrow('exact member receipt');
    await expect(f.workspaces.taskSyncBase(f.store.task(a.task_id), a.source_commit, receipt.commit)).rejects.toThrow('missing');
    expect(await f.workspaces.squashedLanded(a.source_branch, receipt.commit)).toBe(false);
    expect(await git(a.workspace, 'rev-parse', 'HEAD')).toBe(a.source_commit);
  } finally { f.close(); }
});

test('old generation or nonintegrated shared run cannot authorize a landed projection, sync, or archive', async () => {
  const f = await ready();
  try {
    await f.apply(f.receipt); f.settle(f.receipt);
    const a = f.members[0], task = f.store.task(a.task_id);
    for (const patch of ['generation=2', "state='landing'"]) {
      f.store.run(`UPDATE delivery_runs SET generation=1,state='integrated' WHERE id=1`);
      f.store.run(`UPDATE delivery_runs SET ${patch} WHERE id=1`);
      expect(await f.workspaces.squashedLanded(a.source_branch, f.receipt.commit)).toBe(false);
      await expect(f.workspaces.taskSyncBase(task, a.source_commit, f.receipt.commit)).rejects.toThrow('not settled');
      await expect(f.workspaces.exclusive(() => f.workspaces.archiveSquashedTaskUnsafe(task, a.source_commit, f.receipt.commit))).rejects.toThrow('not settled');
    }
    expect(await git(a.workspace, 'rev-parse', 'HEAD')).toBe(a.source_commit);
  } finally { f.close(); }
});

test('malformed receipt or reservation never falls back to tree coincidence during archival', async () => {
  const f = await setup();
  try {
    const a = await f.member('a', { 'a.txt': 'a\n' }), root = await f.combine(), receipt = await f.prepare(root.tree);
    await f.apply(receipt); f.settle(receipt);
    f.store.update(a.task_id, { reservation: '{broken' });
    await expect(f.workspaces.exclusive(() => f.workspaces.archiveSquashedTaskUnsafe(f.store.task(a.task_id), a.source_commit, receipt.commit))).rejects.toThrow('malformed delivery reservation');
    f.store.update(a.task_id, { reservation: null });
    f.store.run("UPDATE events SET data=? WHERE task_id=? AND type='task.merge_integrated'", '{broken', a.task_id);
    await expect(f.workspaces.exclusive(() => f.workspaces.archiveSquashedTaskUnsafe(f.store.task(a.task_id), a.source_commit, receipt.commit))).rejects.toThrow('malformed delivery receipt');
    expect(await git(a.workspace, 'rev-parse', 'HEAD')).toBe(a.source_commit);
  } finally { f.close(); }
});
