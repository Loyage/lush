import { test, expect, describe, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { setup, git } from './convergence-harness.js';

async function helperFixture({ obsolete = false, seedIsBaseline = false } = {}) {
  const f = await setup();
  try {
    const p = await f.member('parent', { 'parent.txt': 'parent work\n' }), parent = f.store.task(p.task_id);
    f.store.update(parent.id, { status: 'waiting' });
    const baseline = p.source_commit, members = [];
    for (const name of ['a', 'b']) {
      const task = f.store.create({ role: 'agent', task_kind: 'child', goal: name, name, parent_id: parent.id });
      await f.workspaces.exclusive(() => f.workspaces.forkTaskUnsafe(task, parent.branch, baseline));
      const live = f.store.task(task.id), member = { task_id: live.id, delivery_id: live.id, enqueue_seq: live.id,
        source_branch: live.branch, source_commit: baseline, base_commit: baseline, workspace: live.workspace };
      await f.change(member, { 'file.txt': `${name}\n` });
      f.store.update(task.id, { status: 'awaiting_acceptance', integration: 'pending' }); members.push(member);
    }
    const run = f.store.createDeliveryRun({ parent_id: parent.id, target_branch: parent.branch, baseline,
      validation: null, members: members.map(({ workspace, ...member }) => member), data: {} });
    const seed = await f.combine(members, baseline);
    const helper = f.store.create({ role: 'agent', task_kind: 'integration', goal: 'resolve fixed inputs', name: 'integration', parent_id: parent.id });
    const seedCommit = seedIsBaseline ? baseline : seed.commit;
    await f.workspaces.exclusive(() => f.workspaces.forkTaskUnsafe(helper, parent.branch, seedCommit));
    let live = f.store.task(helper.id);
    const node = f.store.createDeliveryNode({ run_id: run.id, generation: run.generation, node_key: 'fixed-root',
      state: 'conflict', helper_id: helper.id, data: { seed_commit: seedCommit, left: seed.left, right: seed.right },
      result: { commit: seedCommit, tree: await f.workspaces.commitTree(seedCommit), via: 'objects' } });
    f.store.event(helper.id, 'convergence.integration_created', { version: 1, run_id: run.id, node_id: node.id,
      generation: run.generation, seed_commit: seedCommit });
    let output = { commit: seedCommit, tree: await f.workspaces.commitTree(seedCommit) }, receipt = null;
    if (obsolete) {
      f.store.update(helper.id, { status: 'cancelled', head_commit: null });
      f.store.updateDeliveryRun(run.id, { state: 'withdrawn' }); f.store.releaseDeliveryMembers(run.id);
    } else {
      fs.writeFileSync(path.join(live.workspace, 'file.txt'), 'combined resolution\n');
      await git(live.workspace, 'add', '.'); await git(live.workspace, 'commit', '-m', 'fixed integration output');
      output = { commit: await git(live.workspace, 'rev-parse', 'HEAD'), tree: await git(live.workspace, 'rev-parse', 'HEAD^{tree}') };
      f.store.update(helper.id, { status: 'awaiting_acceptance', head_commit: output.commit, integration: 'pending' });
      f.store.updateDeliveryNode(node.id, { state: 'ready', result: { ...output, via: 'integration' } }, run.generation);
      f.store.event(helper.id, 'convergence.integration_ready', { run_id: run.id, node_id: node.id,
        generation: run.generation, commit: output.commit, tree: output.tree });
      const evidenceCommit = await git(f.root, 'commit-tree', output.tree, '-p', output.commit,
        ...members.flatMap(member => ['-p', member.source_commit]), '-m', 'retain fixed root and sources');
      const evidence = { ref: `refs/lush/convergence-evidence/${run.id}/${run.generation}`, commit: evidenceCommit };
      receipt = await f.workspaces.exclusive(() => f.workspaces.prepareConvergencePublishUnsafe({ parent: parent.branch,
        baseline, tree: output.tree, members, message: 'child batch', run_id: run.id, generation: run.generation, evidence }));
      await f.apply(receipt);
      f.store.updateDeliveryRun(run.id, { state: 'integrated', candidate_commit: receipt.commit,
        candidate_tree: receipt.tree, landing_receipt: receipt, data: { root_commit: output.commit } });
      f.store.releaseDeliveryMembers(run.id); f.store.update(parent.id, { head_commit: receipt.commit });
      for (const member of members) {
        f.store.update(member.task_id, { integration: 'merged' });
        f.store.event(member.task_id, 'task.merge_integrated', { convergence: true, run_id: run.id, generation: run.generation,
          parent_id: parent.id, source_commit: member.source_commit, commit: receipt.commit, tree: receipt.tree });
      }
    }
    const running = new Set(), jobs = new Set();
    f.workspaces.convergenceHelperIdle = (taskId, runId) => !running.has(taskId) && !jobs.has(runId);
    return { ...f, parent, baseline, helper: f.store.task(helper.id), node, run, members, output, receipt, running, jobs,
      state(onto = null) { return f.workspaces.convergenceHelperState(f.store.task(helper.id), onto); },
      archive() { return f.workspaces.exclusive(() => f.workspaces.archiveConvergenceHelperUnsafe(f.store.task(helper.id))); } };
  } catch (error) { f.close(); throw error; }
}

test('published quiet infrastructure helper is not a fake member and cannot block its parent delivering upward', async () => {
  const f = await helperFixture();
  try {
    expect(f.receipt.members.some(member => member.task_id === f.helper.id)).toBe(false);
    expect(await f.state()).toBe('merged');
    expect(await f.workspaces.squashedLanded(f.helper.branch, f.receipt.commit)).toBe(true);
    expect(await f.workspaces.squashedLanded(f.helper.branch, f.baseline)).toBe(false);
    const state = await f.workspaces.branchState(f.parent.branch);
    expect(state.blockers).not.toContain(f.helper.branch);
    expect((await f.workspaces.branchState(f.helper.branch)).status).toBe('integrated');
    const parentReceipt = await f.workspaces.exclusive(async () => f.workspaces.prepareTaskSquashUnsafe(
      f.parent.branch, f.receipt.commit, await git(f.root, 'rev-parse', 'HEAD'), 'parent upward delivery'));
    await f.workspaces.exclusive(() => f.workspaces.applyTaskSquashUnsafe(parentReceipt, () => true));
    expect(await git(f.root, 'show', 'HEAD:file.txt')).toBe('combined resolution');
    expect(await git(f.root, 'show', 'HEAD:parent.txt')).toBe('parent work');
  } finally { f.close(); }
});

test('published helper can be archived through its special proof without a member receipt or equivalent source tree', async () => {
  const f = await helperFixture();
  try {
    expect(f.store.get("SELECT id FROM events WHERE task_id=? AND type='task.merge_integrated'", f.helper.id)).toBeNull();
    const result = await f.workspaces.exclusive(() => f.workspaces.archiveSquashedTaskUnsafe(f.helper, f.output.commit, f.receipt.commit));
    expect(result).toMatchObject({ id: f.helper.id, worktree: 'removed', branch: 'removed', reason: null,
      state: 'merged', source_commit: f.output.commit, landed_commit: f.receipt.commit });
    expect(f.store.task(f.helper.id).branch).toBeNull();
    expect(f.store.branch(f.helper.branch).status).toBe('archived'); expect(fs.existsSync(f.helper.workspace)).toBe(false);
    expect(await git(f.root, 'rev-parse', f.receipt.evidence.ref)).toBe(f.receipt.evidence.commit);
    expect(f.store.get("SELECT id FROM events WHERE task_id=? AND type='task.merge_integrated'", f.helper.id)).toBeNull();
  } finally { f.close(); }
});

test('assembled release routes real helper proof and preserves keep-branch without changing receipt identity', async () => {
  const f = await helperFixture();
  try {
    const retained = await f.workspaces.exclusive(() => f.workspaces.release(f.helper, { keepBranch: true }));
    expect(retained).toMatchObject({ id: f.helper.id, worktree: 'kept', branch: 'kept' });
    expect(fs.existsSync(f.helper.workspace)).toBe(true);
    f.running.add(f.helper.id);
    await expect(f.workspaces.exclusive(() => f.workspaces.release(f.store.task(f.helper.id)))).rejects.toThrow('not actually exited');
    expect(fs.existsSync(f.helper.workspace)).toBe(true);
    f.running.delete(f.helper.id);
    const result = await f.workspaces.exclusive(() => f.workspaces.release(f.store.task(f.helper.id)));
    expect(result).toMatchObject({ id: f.helper.id, worktree: 'removed', branch: 'removed', reason: null, state: 'merged' });
    expect(await git(f.root, 'rev-parse', f.receipt.evidence.ref)).toBe(f.receipt.evidence.commit);
    expect(f.store.get("SELECT id FROM events WHERE task_id=? AND type='task.merge_integrated'", f.helper.id)).toBeNull();
    expect(f.store.task(f.helper.id).branch).toBeNull();
  } finally { f.close(); }
});

test('withdrawn never-started seed is a known obsolete derivative, not delivered code, and is safely reclaimable', async () => {
  const f = await helperFixture({ obsolete: true });
  try {
    expect(f.helper.head_commit).toBeNull(); expect(await f.state()).toBe('none');
    expect(await f.workspaces.squashedLanded(f.helper.branch, f.baseline)).toBe(true);
    expect((await f.workspaces.branchState(f.parent.branch)).blockers).not.toContain(f.helper.branch);
    expect(await f.archive()).toMatchObject({ id: f.helper.id, worktree: 'removed', branch: 'removed', reason: null, state: 'none' });
    const event = f.store.get("SELECT data FROM events WHERE task_id=? AND type='task.archived'", f.helper.id);
    expect(JSON.parse(event.data)).toMatchObject({ convergence_helper: true, derivative_state: 'none', landed_commit: null });
  } finally { f.close(); }
});

test('an ancestor-shaped seed still blocks parent while a helper invocation has not truly exited', async () => {
  const f = await helperFixture({ obsolete: true, seedIsBaseline: true });
  try {
    f.running.add(f.helper.id);
    expect(await f.workspaces.isAncestor(f.root, f.helper.base_commit, f.baseline)).toBe(true);
    expect((await f.workspaces.branchState(f.parent.branch)).blockers).toContain(f.helper.branch);
    expect((await f.workspaces.branchState(f.helper.branch)).status).toBe('diverged');
    await expect(f.archive()).rejects.toThrow('not actually exited');
    f.running.delete(f.helper.id);
    expect((await f.workspaces.branchState(f.parent.branch)).blockers).not.toContain(f.helper.branch);
  } finally { f.close(); }
});

async function rejectsHelperProof(f, kind) {
  if (kind === 'missing_guard') delete f.workspaces.convergenceHelperIdle;
  if (kind === 'async_guard') f.workspaces.convergenceHelperIdle = async () => true;
  if (kind === 'running') f.running.add(f.helper.id);
  if (kind === 'job') f.jobs.add(f.run.id);
  if (kind === 'active_member') f.store.run('UPDATE delivery_members SET active=1 WHERE run_id=?', f.run.id);
  if (kind === 'state') f.store.updateDeliveryRun(f.run.id, { state: 'failed' });
  if (kind === 'node') f.store.run('UPDATE delivery_nodes SET helper_id=NULL WHERE id=?', f.node.id);
  if (kind === 'context') f.store.run("UPDATE events SET data=? WHERE task_id=? AND type='convergence.integration_created'",
    JSON.stringify({ run_id: f.run.id, node_id: f.node.id, generation: 2 }), f.helper.id);
  if (kind === 'ready') f.store.run("UPDATE events SET data=? WHERE task_id=? AND type='convergence.integration_ready'",
    JSON.stringify({ run_id: f.run.id, node_id: f.node.id, generation: 2, commit: f.output.commit }), f.helper.id);
  if (kind === 'ready_tree') {
    const tree = await f.workspaces.commitTree(f.baseline);
    f.store.updateDeliveryNode(f.node.id, { result: { commit: f.output.commit, tree } }, f.run.generation);
    f.store.run("UPDATE events SET data=? WHERE task_id=? AND type='convergence.integration_ready'",
      JSON.stringify({ run_id: f.run.id, node_id: f.node.id, generation: f.run.generation, commit: f.output.commit, tree }), f.helper.id);
  }
  if (kind === 'missing_ref') await git(f.root, 'update-ref', '-d', `refs/heads/${f.helper.branch}`, f.output.commit);
  if (kind === 'root') f.store.updateDeliveryRun(f.run.id, { data: { root_commit: f.members[0].source_commit } });
  if (kind === 'keeper') await git(f.root, 'update-ref', '-d', f.receipt.evidence.ref, f.receipt.evidence.commit);
  if (kind === 'dirty') fs.writeFileSync(path.join(f.helper.workspace, 'file.txt'), 'uncommitted valuable data');
  if (kind === 'unknown_head') {
    await git(f.helper.workspace, 'commit', '--allow-empty', '-m', 'unknown extra changes');
    f.store.update(f.helper.id, { head_commit: await git(f.helper.workspace, 'rev-parse', 'HEAD') });
  }
  if (kind === 'git_state') fs.writeFileSync(path.join(await git(f.helper.workspace, 'rev-parse', '--absolute-git-dir'), 'MERGE_HEAD'), f.baseline + '\n');
  if (kind === 'notice') f.store.run("INSERT INTO notices(task_id,kind,title,body) VALUES (?,'question','question','question')", f.helper.id);
  if (kind === 'message') f.store.message(f.helper.id, 'pending input');
  expect(await f.state()).toBe('pending');
  expect((await f.workspaces.branchState(f.parent.branch)).blockers).toContain(f.helper.branch);
  await expect(f.archive()).rejects.toThrow();
  expect(fs.existsSync(f.helper.workspace)).toBe(true);
  if (kind !== 'missing_ref') expect(await git(f.root, 'rev-parse', `refs/heads/${f.helper.branch}`)).toBe(await git(f.helper.workspace, 'rev-parse', 'HEAD'));
}

// These guards change only SQLite rows or Runtime exit evidence. Keep the real published
// Git graph, but roll back each case and prove it is usable again; never share Git mutations.
describe('metadata-only helper rejection cases', () => {
  let f, idleGuard;
  beforeAll(async () => { f = await helperFixture(); idleGuard = f.workspaces.convergenceHelperIdle; });
  beforeEach(() => { f.store.run('SAVEPOINT helper_case'); });
  afterEach(async () => {
    try { f.store.run('ROLLBACK TO helper_case'); f.store.run('RELEASE helper_case'); }
    finally { f.workspaces.convergenceHelperIdle = idleGuard; f.running.clear(); f.jobs.clear(); }
    expect(await f.state()).toBe('merged');
    expect(await git(f.root, 'rev-parse', f.parent.branch)).toBe(f.receipt.commit);
  });
  afterAll(() => { f?.close(); });
  for (const kind of ['missing_guard','async_guard','running','job','active_member','state','node','context','ready','ready_tree','root','notice','message']) {
    test(`helper proof and cleanup fail closed for ${kind}`, () => rejectsHelperProof(f, kind));
  }
});

for (const kind of ['keeper','missing_ref','dirty','unknown_head','git_state']) {
  test(`helper proof and cleanup fail closed for ${kind}`, async () => {
    const f = await helperFixture();
    try { await rejectsHelperProof(f, kind); } finally { f.close(); }
  });
}

test('generation-invalidated known successful output is obsolete without claiming membership in the new run', async () => {
  const f = await helperFixture();
  try {
    f.store.updateDeliveryRun(f.run.id, { generation: 2 });
    expect(await f.state()).toBe('none');
    expect((await f.archive()).state).toBe('none');
  } finally { f.close(); }
});

test('late Runtime start or evidence mutation during asynchronous inspection blocks the first removal', async () => {
  for (const kind of ['start', 'evidence']) {
    const f = await helperFixture();
    try {
      const original = f.workspaces.assertCleanBranches;
      f.workspaces.assertCleanBranches = async function(...args) {
        await original.apply(this, args);
        if (kind === 'start') f.running.add(f.helper.id);
        else f.store.updateDeliveryRun(f.run.id, { data: { root_commit: f.baseline } });
      };
      await expect(f.archive()).rejects.toThrow(); expect(fs.existsSync(f.helper.workspace)).toBe(true);
    } finally { f.close(); }
  }
});

test('partial helper ref cleanup retains a precise removed-worktree fact and can explicitly resume without forcing data', async () => {
  const f = await helperFixture();
  try {
    const original = f.workspaces.git;
    f.workspaces.git = async function(cwd, ...args) {
      if (args[0] === 'update-ref' && args[1] === '-d') throw new Error('injected helper ref failure');
      return original.call(this, cwd, ...args);
    };
    await expect(f.archive()).rejects.toThrow('injected');
    expect(f.store.task(f.helper.id).workspace).toBeNull(); expect(fs.existsSync(f.helper.workspace)).toBe(false);
    expect(await git(f.root, 'rev-parse', `refs/heads/${f.helper.branch}`)).toBe(f.output.commit);
    f.workspaces.git = original;
    expect(await f.archive()).toMatchObject({ id: f.helper.id, worktree: 'absent', branch: 'removed', reason: null, state: 'merged' });
    expect(f.store.task(f.helper.id).branch).toBeNull();
  } finally { f.close(); }
});

test('replacing the registered helper checkout with an identical foreign repository never authorizes deletion', async () => {
  const f = await helperFixture();
  try {
    const retained = path.join(f.config.home, 'retained-original-helper');
    fs.renameSync(f.helper.workspace, retained);
    await git(f.root, 'clone', '--branch', f.helper.branch, f.root, f.helper.workspace);
    expect(await git(f.helper.workspace, 'rev-parse', 'HEAD')).toBe(f.output.commit);
    expect(await f.state()).toBe('pending');
    await expect(f.archive()).rejects.toThrow('repository changed');
    expect(fs.existsSync(path.join(f.helper.workspace, '.git'))).toBe(true);
    expect(fs.existsSync(retained)).toBe(true);
  } finally { f.close(); }
});

test('corrupt orphan ordinary branch metadata still has a safe false landed projection', async () => {
  const f = await setup();
  try {
    const member = await f.member('orphan', { 'ordinary.txt': 'retained work' });
    // Model a damaged historical database, not a supported ordinary deletion route.
    f.store.run('PRAGMA foreign_keys=OFF');
    f.store.run('DELETE FROM tasks WHERE id=?', member.task_id);
    f.store.run('PRAGMA foreign_keys=ON');
    expect(await f.workspaces.squashedLanded(member.source_branch, 'main')).toBe(false);
    expect((await f.workspaces.branchState(member.source_branch)).status).toBe('fast_forward');
  } finally { f.close(); }
});
