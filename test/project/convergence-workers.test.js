import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, repo, git, env, until, gate } from '../helpers.js';
import { AgentPreempted } from '../../src/agent/provider.js';

/** Native Delivery Store: exercise fixed-input/generation guards, not a permissive duplicate schema. */
function deliveryFixture(store, base, seed, members) {
  const run = store.createDeliveryRun({ parent_id: base.parentId, target_branch: 'main', baseline: base.commit,
    validation: { command_id: '00000000-0000-4000-8000-000000000001', command_version: 1 },
    members: members.map(member => ({ ...member, enqueue_seq: member.delivery_id, base_commit: base.commit })) });
  expect(run.id).toBe(1);
  const node = store.createDeliveryNode({ run_id: run.id, generation: run.generation, node_key: 'pair:1:0', state: 'conflict',
    data: { base: base.commit, left: members[0].source_commit, right: members[1].source_commit, seed_commit: seed,
      member_ids: members.map(member => member.task_id), reason: 'content_conflict' } });
  expect(node.id).toBe(1);
}

async function setup(provider) {
  const f = fixture(provider, { LUSH_CONCURRENCY: '1' });
  await repo(f.root);
  const originalKick = f.project.kick.bind(f.project);
  f.project.kick = () => {};
  const parent = f.store.create({ input_id: null, role: 'agent', task_kind: 'main', goal: 'target owner' });
  const base = await git(f.root, 'rev-parse', 'HEAD');
  f.store.update(parent.id, { branch: 'main', workspace: f.root, head_commit: base, status: 'waiting' });
  f.store.recordBranch({ branch: 'main', task_id: parent.id, worktree: f.root, created_from_commit: base });
  const members = [];
  for (const side of ['left', 'right']) {
    const source = f.store.create({ parent_id: parent.id, input_id: null, role: 'agent', task_kind: 'order', goal: `${side} goal` });
    await f.project.workspaces.exclusive(() => f.project.workspaces.forkTaskUnsafe(source, 'main', base));
    const live = f.store.task(source.id);
    fs.writeFileSync(path.join(live.workspace, 'file.txt'), `${side}\n`);
    await git(live.workspace, 'add', '.'); await git(live.workspace, 'commit', '-m', side);
    const commit = await git(live.workspace, 'rev-parse', 'HEAD');
    f.store.update(source.id, { head_commit: commit, status: 'awaiting_acceptance', result: `${side} source report`,
      retry_profile: JSON.stringify({ env: { SOURCE_SECRET: 'never copy this source credential' } }) });
    members.push({ task_id: source.id, delivery_id: source.id + 100, source_branch: live.branch, source_commit: commit });
  }
  const merge = Bun.spawn(['git', '-C', f.root, 'merge-tree', '--write-tree', members[0].source_commit, members[1].source_commit],
    { env: env(), stdout: 'pipe', stderr: 'pipe' });
  const [output, , exit] = await Promise.all([new Response(merge.stdout).text(), new Response(merge.stderr).text(), merge.exited]);
  expect(exit).toBe(1);
  const tree = output.split('\n')[0];
  const seed = await git(f.root, 'commit-tree', tree, '-p', members[0].source_commit, '-p', members[1].source_commit, '-m', 'fixed conflict seed');
  deliveryFixture(f.store, { parentId: parent.id, commit: base }, seed, members);
  const publications = [];
  f.project.scheduleConvergence = parentId => publications.push({ parentId, active: f.project.running.size,
    token: f.store.task(f.store.deliveryNode(1).helper_id).agent_token_hash });
  return { ...f, parent, base, seed, members, publications, start() { f.project.kick = originalKick; originalKick(); } };
}

test('native coordinator creates a new immutable repair helper after a settled output fails validation', async () => {
  let calls = 0;
  const f = await setup({ run: async ({ cwd, context }) => {
    calls++;
    expect(context.integration.generation).toBe(calls);
    if (calls === 1) await repair(cwd);
    else {
      fs.writeFileSync(path.join(cwd, 'validation-repair.txt'), 'second fixed repair\n');
      await git(cwd, 'add', '.'); await git(cwd, 'commit', '-m', 'repair combined validation');
    }
    return 'fixed attempt repaired';
  } });
  try {
    for (const member of f.members) f.store.update(member.task_id, { status: 'waiting', reservation: JSON.stringify({ version: 3,
      kind: 'merge', status: 'requested', run_id: 1, generation: 1, parent_id: f.parent.id,
      commit: member.source_commit, delivery_id: member.delivery_id, enqueue_seq: member.delivery_id }) });
    const first = await f.project.createConvergenceIntegration(1, 1); f.start();
    await until(() => f.store.deliveryNode(1).state === 'ready' && !f.project.running.has(first.id));
    const oldNode = f.store.deliveryNode(1), oldContext = f.store.get(
      "SELECT data FROM events WHERE task_id=? AND type='convergence.integration_created'", first.id).data;
    const firstOutput = JSON.parse(oldNode.result);
    f.store.updateDeliveryRun(1, { validation_result: { state: 'failed', tested_tree: firstOutput.tree } }, 1);
    expect(await f.project.requestConvergenceRepair(1, 1, 1, 'validation_failed')).toBe(true);
    const secondNode = f.store.deliveryNodes(1, 2)[0], second = f.store.task(secondNode.helper_id);
    expect(second.id).not.toBe(first.id);
    expect(f.store.deliveryNode(1)).toEqual(oldNode);
    expect(f.store.get("SELECT data FROM events WHERE task_id=? AND type='convergence.integration_created'", first.id).data).toBe(oldContext);
    expect(JSON.parse(secondNode.data)).toMatchObject({ seed_commit: firstOutput.commit, reason: 'validation_failed' });
    await until(() => f.store.deliveryNode(secondNode.id).state === 'ready' && !f.project.running.has(second.id));
    const output = JSON.parse(f.store.deliveryNode(secondNode.id).result);
    expect(calls).toBe(2);
    expect(await f.project.workspaces.isAncestor(second.workspace, firstOutput.commit, output.commit)).toBe(true);
    for (const member of f.members) expect(await f.project.workspaces.isAncestor(second.workspace, member.source_commit, output.commit)).toBe(true);
    expect(f.store.deliveryRun(1)).toMatchObject({ generation: 2, state: 'preparing' });
    expect(f.store.task(first.id).status).toBe('awaiting_acceptance');
    await assertSources(f);
  } finally { await f.close(); }
});

test('baseline refresh conflict admits an opaque refresh node, retains prior repairs and carries its repair budget', async () => {
  let calls = 0, expected;
  const f = await setup({ run: async ({ cwd, context }) => {
    calls++;
    if (calls === 2) {
      expect(context.integration).toMatchObject(expected);
      expect(context.integration.members.map(member => member.task_id)).toEqual(f.members.map(member => member.task_id));
      expect(fs.readFileSync(path.join(cwd, 'paid-repair.txt'), 'utf8')).toBe('preserved prior repair\n');
      expect(fs.readFileSync(path.join(cwd, 'file.txt'), 'utf8')).toContain('<<<<<<<');
    }
    await repair(cwd);
    if (calls === 1) {
      fs.writeFileSync(path.join(cwd, 'paid-repair.txt'), 'preserved prior repair\n');
      await git(cwd, 'add', '.'); await git(cwd, 'commit', '-m', 'prior semantic repair');
    }
    return 'fixed refresh inputs repaired';
  } });
  try {
    for (const member of f.members) f.store.update(member.task_id, { status: 'waiting', reservation: JSON.stringify({ version: 3,
      kind: 'merge', status: 'requested', run_id: 1, generation: 1, parent_id: f.parent.id,
      commit: member.source_commit, delivery_id: member.delivery_id, enqueue_seq: member.delivery_id }) });
    const first = await f.project.createConvergenceIntegration(1, 1); f.start();
    await until(() => f.store.deliveryNode(1).state === 'ready' && !f.project.running.has(first.id));
    const oldBaseline = f.base, oldOutput = JSON.parse(f.store.deliveryNode(1).result);
    f.store.updateDeliveryNode(1, { data: { ...JSON.parse(f.store.deliveryNode(1).data), repair_attempts: 1 } }, 1);
    f.store.updateDeliveryRun(1, { data: { plan: { version: 1, root: 'pair:1:0' }, repair_attempts: 1 } }, 1);
    await f.project.workspaces.exclusive(async () => {
      fs.writeFileSync(path.join(f.root, 'file.txt'), 'new parent intent\n');
      await git(f.root, 'add', '.'); await git(f.root, 'commit', '-m', 'parent baseline advances');
    });
    f.base = await git(f.root, 'rev-parse', 'main');
    const refreshed = await f.project.refreshConvergenceBaseline(1, 1);
    const plan = JSON.parse(refreshed.data).plan, item = plan.nodes[0];
    expect(plan.variant).toBe('baseline_refresh');
    expect(item).toMatchObject({ kind: 'refresh', base: oldBaseline, left: f.base, right: oldOutput.commit, repair_attempts: 1 });
    const merged = await f.project.workspaces.mergeConvergenceObjects({ base: item.base, left: item.left, right: item.right,
      message: 'controlled fixed refresh conflict' });
    expect(merged.conflict).toBe(true);
    const node = f.store.createDeliveryNode({ run_id: 1, generation: 2, node_key: item.key, state: 'conflict',
      data: { ...item, seed_commit: merged.commit, reason: 'content_conflict' },
      result: { commit: merged.commit, tree: merged.tree, via: 'objects' } });
    expected = { generation: 2, base: oldBaseline, baseline: f.base, left: f.base, right: oldOutput.commit, seed_commit: merged.commit };
    expect(await f.project.requestConvergenceRepair(1, 2, node.id, 'content_conflict')).toBe(true);
    const second = f.store.task(f.store.deliveryNode(node.id).helper_id);
    expect(second.id).not.toBe(first.id);
    await until(() => f.store.deliveryNode(node.id).state === 'ready' && !f.project.running.has(second.id));
    const output = JSON.parse(f.store.deliveryNode(node.id).result);
    for (const input of [f.base, oldOutput.commit, merged.commit])
      expect(await f.project.workspaces.isAncestor(second.workspace, input, output.commit)).toBe(true);
    expect(JSON.parse(f.store.deliveryNode(node.id).data)).toMatchObject({ kind: 'refresh', repair_attempts: 2 });
    expect(JSON.parse(f.store.deliveryRun(1).data).repair_attempts).toBe(2);
    expect(calls).toBe(2);
    expect(await f.project.requestConvergenceRepair(1, 2, node.id, 'validation_failed')).toBe(false);
    expect(f.store.deliveryRun(1).state).toBe('failed');
    expect(f.store.tasks().filter(task => task.task_kind === 'integration')).toHaveLength(2);
    expect(JSON.parse(f.store.deliveryNode(1).result)).toEqual(oldOutput);
    await assertSources(f);
  } finally { await f.close(); }
});

async function repair(cwd) {
  fs.writeFileSync(path.join(cwd, 'file.txt'), 'left + right\n');
  await git(cwd, 'add', '.'); await git(cwd, 'commit', '-m', 'preserve both fixed intents');
}

async function assertSources(f) {
  expect(await git(f.root, 'rev-parse', 'main')).toBe(f.base);
  for (const member of f.members) {
    expect(await git(f.root, 'rev-parse', member.source_branch)).toBe(member.source_commit);
    expect(f.store.task(member.task_id).parent_id).toBe(f.parent.id);
  }
}

test('factory is idempotent, freezes actual parent configuration and never borrows source context', async () => {
  const f = await setup({ run: async () => 'unused' });
  try {
    f.store.update(f.parent.id, { retry_profile: JSON.stringify({ agent: 'codex', model: 'gpt-5.4', env: { PARENT_ONLY: 'private' } }) });
    const helper = await f.project.createConvergenceIntegration(1, 1);
    expect((await f.project.createConvergenceIntegration(1, 1)).id).toBe(helper.id);
    expect(helper).toMatchObject({ task_kind: 'integration', role: 'agent', input_id: null, worker_number: null,
      parent_id: f.parent.id, target_branch: 'main', base_commit: f.seed, reservation: null, auto_merge: null, status: 'queued' });
    expect(JSON.parse(helper.retry_profile)).toMatchObject({ agent: 'codex', model: 'gpt-5.4', env: { PARENT_ONLY: 'private' } });
    expect(helper.workspace).not.toBe(f.root);
    const context = await f.project.invocationContext(helper, { recordId: 42 });
    expect(context.integration).toMatchObject({ worker_id: helper.id, run_id: 1, node_id: 1, generation: 1, left: f.members[0].source_commit });
    expect(context.integration.members.map(member => member.report)).toEqual(['left source report', 'right source report']);
    expect(JSON.stringify(context)).not.toContain('SOURCE_SECRET'); expect(JSON.stringify(context)).not.toContain('PARENT_ONLY');
    expect(JSON.stringify(f.store.history(helper.id))).not.toContain('PARENT_ONLY');
    expect(f.store.history(helper.id).filter(row => row.type === 'convergence.integration_created')).toHaveLength(1);
    await assertSources(f);
  } finally { await f.close(); }
});

test('real conflict repair preserves inputs; candidate only promotes after actual exit and token revocation', async () => {
  const closing = gate(), release = gate(); let token, helper;
  const f = await setup({ run: async ({ task, cwd, context, api, token: issued, forkPointer }) => {
    token = issued; expect(api.actor(token)).toBe(task.id); expect(forkPointer).toBeNull();
    expect(context.integration.generation).toBe(1);
    expect(fs.readFileSync(path.join(cwd, 'file.txt'), 'utf8')).toContain('<<<<<<<');
    await repair(cwd); return 'fixed inputs and completed affected checks';
  } });
  const closeOwned = f.project.workspaces.closeOwnedBranch.bind(f.project.workspaces);
  let closed = 0;
  f.project.workspaces.closeOwnedBranch = async observation => {
    if (++closed === 2) { closing.resolve(); await release.promise; }
    return closeOwned(observation);
  };
  try {
    helper = await f.project.createConvergenceIntegration(1, 1); f.start();
    await closing.promise;
    expect(f.store.task(helper.id).status).toBe('awaiting_acceptance');
    expect(f.project.running.has(helper.id)).toBe(true);
    expect(f.store.deliveryNode(1).state).toBe('resolving'); expect(f.publications).toEqual([]);
    expect(() => f.project.actor(token)).toThrow();
    f.project.onConvergenceIntegrationExit(helper.id); expect(f.store.deliveryNode(1).state).toBe('resolving');
    release.resolve();
    await until(() => !f.project.running.has(helper.id));
    expect(f.store.deliveryNode(1).state).toBe('ready'); expect(f.store.deliveryRun(1).state).toBe('preparing');
    const result = JSON.parse(f.store.deliveryNode(1).result);
    for (const member of f.members) expect(await f.project.workspaces.isAncestor(helper.workspace, member.source_commit, result.commit)).toBe(true);
    expect(result).toMatchObject({ via: 'integration', commit: f.store.task(helper.id).head_commit });
    expect(f.store.task(helper.id).integration).not.toBe('merged');
    expect(f.publications).toEqual([{ parentId: f.parent.id, active: 0, token: null }]);
    f.project.onConvergenceIntegrationExit(helper.id); expect(f.publications).toHaveLength(1);
    expect(() => f.project.actor(token)).toThrow(); await assertSources(f);
  } finally { release.resolve(); await f.close(); }
});

test('questionnaire parks only the helper and a real answer wakes the same fixed attempt', async () => {
  let calls = 0, oldToken;
  const f = await setup({ run: async ({ task, cwd, api, token }) => {
    calls++;
    if (calls === 1) {
      oldToken = token;
      api.notice(task.id, '固定组合语义决定', '', 'question', [{ header: '语义', question: '保留哪些行为？', options: [
        { label: '两侧', description: '保留双方' }, { label: '暂停', description: '先检查需求' }] }]);
      return 'awaiting decision';
    }
    expect(token).not.toBe(oldToken); await repair(cwd); return 'repaired after explicit answer';
  } });
  try {
    const helper = await f.project.createConvergenceIntegration(1, 1); f.start();
    await until(() => f.store.task(helper.id).status === 'awaiting' && !f.project.running.has(helper.id));
    expect(f.store.deliveryRun(1).state).toBe('awaiting'); expect(f.store.deliveryNode(1).state).toBe('awaiting');
    expect(() => f.project.actor(oldToken)).toThrow(); await assertSources(f);
    const notice = f.store.get("SELECT id FROM notices WHERE task_id=? AND status='open'", helper.id);
    f.project.answer(notice.id, { answers: [{ selected: [0] }] });
    await until(() => f.store.deliveryNode(1).state === 'ready' && !f.project.running.has(helper.id));
    expect(calls).toBe(2); expect(f.store.deliveryNode(1).helper_id).toBe(helper.id); await assertSources(f);
  } finally { await f.close(); }
});

test('stale generation cannot use its token, complete, promote, or silently spawn a replacement', async () => {
  const entered = gate(), leave = gate(); let token;
  const f = await setup({ run: async ({ cwd, token: issued }) => { token = issued; entered.resolve(); await leave.promise; await repair(cwd); return 'obsolete'; } });
  try {
    const helper = await f.project.createConvergenceIntegration(1, 1); f.start(); await entered.promise;
    f.store.updateDeliveryRun(1, { generation: 2, state: 'preparing' }, 1);
    expect(() => f.project.actor(token)).toThrow('fixed attempt');
    leave.resolve(); await until(() => !f.project.running.has(helper.id));
    expect(f.store.deliveryRun(1)).toMatchObject({ generation: 2, state: 'preparing' });
    expect(f.store.deliveryNode(1).result).toBeNull();
    // Actual obsolete exit wakes capacity waiters, never promotes this old node.
    expect(f.publications).toEqual([{ parentId: f.parent.id, active: 0, token: null }]);
    expect(f.project.convergenceIntegrationReady(f.store.task(helper.id))).toBe(false);
    await expect(f.project.createConvergenceIntegration(1, 1)).rejects.toThrow('stale'); await assertSources(f);
  } finally { leave.resolve(); await f.close(); }
});

for (const scenario of ['failure', 'cancel', 'lost ancestor', 'source drift']) test(`${scenario} retains helper scene without advancing source or parent`, async () => {
  const entered = gate(), leave = gate();
  const f = await setup({ run: async ({ cwd }) => {
    entered.resolve(); await leave.promise;
    if (scenario === 'failure') throw new Error('controlled provider failure');
    if (scenario === 'lost ancestor') { await git(cwd, 'reset', '--hard', f.base); return 'discarded fixed inputs'; }
    if (scenario === 'source drift') await git(f.root, 'update-ref', `refs/heads/${f.members[0].source_branch}`, f.base);
    else await repair(cwd);
    return 'not eligible';
  } });
  try {
    const helper = await f.project.createConvergenceIntegration(1, 1); f.start(); await entered.promise;
    if (scenario === 'cancel') f.project.cancel(helper.id, 'explicit helper cancellation');
    leave.resolve(); await until(() => !f.project.running.has(helper.id));
    expect(f.store.deliveryRun(1).state).toBe('failed'); expect(f.store.deliveryNode(1).result).toBeNull();
    expect(fs.existsSync(helper.workspace)).toBe(true);
    expect(await git(f.root, 'rev-parse', 'main')).toBe(f.base);
    if (scenario !== 'source drift') await assertSources(f);
    expect(f.store.task(helper.id).integration).not.toBe('merged');
    expect(f.store.history(helper.id).filter(row => row.type === 'convergence.integration_ready')).toHaveLength(0);
    expect((await f.project.createConvergenceIntegration(1, 1)).id).toBe(helper.id);
    expect(f.project.convergenceIntegrationReady(f.store.task(helper.id))).toBe(false);
  } finally { leave.resolve(); await f.close(); }
});

for (const drift of ['missing', 'canonical', 'registration', 'branch']) test(`ensure rejects ${drift} helper worktree identity without fallback or recreation`, async () => {
  const f = await setup({ run: async () => 'unused' });
  try {
    const helper = await f.project.createConvergenceIntegration(1, 1);
    if (drift === 'missing') await git(f.root, 'worktree', 'remove', helper.workspace);
    if (drift === 'canonical') f.store.update(helper.id, { workspace: f.root });
    if (drift === 'registration') f.store.run('UPDATE branches SET task_id=? WHERE branch=?', f.parent.id, helper.branch);
    if (drift === 'branch') await git(helper.workspace, 'checkout', '--detach');
    await expect(f.project.workspaces.ensure(f.store.task(helper.id))).rejects.toThrow();
    if (drift === 'missing') expect(fs.existsSync(helper.workspace)).toBe(false);
    await assertSources(f);
  } finally { await f.close(); }
});

for (const race of ['parent ended', 'member withdrawn']) test(`factory refuses ${race} during Git preparation without allocating a helper`, async () => {
  const f = await setup({ run: async () => 'unused' }), entered = gate(), resume = gate();
  const ancestor = f.project.workspaces.isAncestor.bind(f.project.workspaces);
  let first = true;
  f.project.workspaces.isAncestor = async (...args) => {
    if (first) { first = false; entered.resolve(); await resume.promise; }
    return ancestor(...args);
  };
  try {
    const creation = f.project.createConvergenceIntegration(1, 1);
    const observed = creation.then(value => ({ value }), error => ({ error }));
    await entered.promise;
    if (race === 'parent ended') f.store.update(f.parent.id, { status: 'cancelled' });
    else f.store.releaseDeliveryMembers(1, f.members[0].task_id);
    resume.resolve(); expect((await observed).error.message).toContain('changed before creation');
    expect(f.store.tasks().filter(task => task.task_kind === 'integration')).toEqual([]);
    expect(f.store.deliveryNode(1).helper_id).toBeNull(); await assertSources(f);
  } finally { resume.resolve(); await f.close(); }
});

test('a frozen real parent subtree does not occupy the isolated integration preparation slot', async () => {
  const f = await setup({ run: async ({ cwd }) => { await repair(cwd); return 'isolated combination ready'; } });
  try {
    const helper = await f.project.createConvergenceIntegration(1, 1);
    const frozen = { branch: helper.branch, kind: 'resolution', task_id: f.members[0].task_id,
      target: 'main', reason: 'another fixed ancestor resolution' };
    f.project.branchFreeze = branch => branch ? (branch === helper.branch ? frozen : null) : [frozen];
    f.start();
    await until(() => f.store.deliveryNode(1).state === 'ready' && !f.project.running.has(helper.id));
    expect(f.store.task(helper.id).status).toBe('awaiting_acceptance');
    await assertSources(f);
  } finally { await f.close(); }
});

test('helper factory never follows a preexisting checkout symlink or blindly recreates its partial resources', async () => {
  const f = await setup({ run: async () => 'unused' });
  const foreign = path.join(f.root, 'outside-private-home'); fs.mkdirSync(foreign);
  const available = [];
  f.project.wakeConvergenceAfterIntegration = parentId => available.push({ parentId, active: f.project.running.size });
  const fork = f.project.workspaces.forkTaskUnsafe.bind(f.project.workspaces);
  f.project.workspaces.forkTaskUnsafe = async (task, branch, commit) => {
    fs.symlinkSync(foreign, path.join(f.config.home, 'worktrees', `${task.id}-${task.name}`));
    return fork(task, branch, commit);
  };
  try {
    await expect(f.project.createConvergenceIntegration(1, 1)).rejects.toThrow('creation incomplete');
    const helper = f.store.tasks().find(task => task.task_kind === 'integration');
    expect(helper.status).toBe('failed'); expect(f.store.deliveryRun(1).state).toBe('failed');
    expect(available).toEqual([{ parentId: f.parent.id, active: 0 }]);
    expect(fs.readdirSync(foreign)).toEqual([]);
    expect(await git(f.root, 'branch', '--list', helper.branch)).toBe('');
    expect((await f.project.createConvergenceIntegration(1, 1)).id).toBe(helper.id);
    expect(f.project.convergenceIntegrationReady(helper)).toBe(false);
    await assertSources(f);
  } finally { await f.close(); }
});

test('bulk maintenance pauses and resumes a fixed integration; completion waits for real exit and preparation ownership', async () => {
  const entered = gate(), pause = gate(); let calls = 0;
  const f = await setup({ run: async ({ cwd }) => {
    calls++;
    if (calls === 1) { entered.resolve(); await pause.promise; throw new AgentPreempted({ reason: 'controlled maintenance boundary' }); }
    await repair(cwd); return 'resumed fixed output';
  } });
  try {
    const helper = await f.project.createConvergenceIntegration(1, 1); f.start(); await entered.promise;
    const preparation = { controller: new AbortController(), promise: Promise.resolve() };
    (f.project.convergenceJobs ??= new Map()).set(999, preparation);
    const pending = f.project.interruptAll();
    expect(pending).toMatchObject({ completion_state: 'pending', ready_to_restart: false, affected_count: 1 });
    const batch = JSON.parse(f.store.get("SELECT value FROM meta WHERE key='project_maintenance'").value);
    expect(batch.participants.map(row => row.id)).toEqual([helper.id]);
    expect(f.store.get("SELECT count(*) AS n FROM events WHERE type='worker.interrupted'").n).toBe(0);
    pause.resolve(); await until(() => !f.project.running.has(helper.id)); await f.project.hookQueue;
    expect(f.store.task(helper.id).status).toBe('paused');
    expect(f.store.deliveryNode(1).state).toBe('awaiting');
    expect(f.store.get("SELECT count(*) AS n FROM events WHERE type='worker.interrupted'").n).toBe(1);
    expect(f.project.maintenanceView()).toMatchObject({ completion_state: 'pending', ready_to_restart: false });
    expect(f.store.get("SELECT count(*) AS n FROM events WHERE type='project.interrupted'").n).toBe(0);
    f.project.convergenceJobs.delete(999); f.project.observeMaintenanceCompletion();
    expect(f.project.maintenanceView()).toMatchObject({ completion_state: 'completed', ready_to_restart: true });
    expect(() => f.project.interrupt(helper.id)).toThrow('only order/child');
    expect(() => f.project.resumeTask(helper.id)).toThrow('only order/child');
    expect(JSON.parse(f.store.get("SELECT value FROM meta WHERE key='project_maintenance'").value).affected.map(row => row.id)).toEqual([helper.id]);
    f.project.resumeAll();
    await until(() => f.store.deliveryNode(1).state === 'ready' && !f.project.running.has(helper.id));
    expect(calls).toBe(2);
    expect(f.store.deliveryRun(1).generation).toBe(1);
    expect(f.store.deliveryNode(1).helper_id).toBe(helper.id);
    await assertSources(f);
  } finally { pause.resolve(); f.project.convergenceJobs?.delete(999); await f.close(); }
});

test('helper identity and node ownership are claimed atomically; ACK retries remain idempotent', async () => {
  const f = await setup({ run: async () => 'unused' });
  const transaction = f.store.transaction.bind(f.store), create = f.store.create.bind(f.store); let depth = 0, claims = 0;
  f.store.transaction = fn => transaction(() => { depth++; try { return fn(); } finally { depth--; } });
  f.store.create = data => { if (data.task_kind === 'integration') { claims++; expect(depth).toBeGreaterThan(0); } return create(data); };
  try {
    const helper = await f.project.createConvergenceIntegration(1, 1);
    expect((await f.project.createConvergenceIntegration(1, 1)).id).toBe(helper.id);
    expect(claims).toBe(1);
    expect(f.store.deliveryNode(1)).toMatchObject({ helper_id: helper.id, state: 'resolving' });
    await assertSources(f);
  } finally { await f.close(); }
});

test('integration factories do not restore the removed Worker quota when more than four helpers are active', async () => {
  const f = await setup({ run: async () => 'unused' });
  try {
    for (let i = 0; i < 3; i++) f.store.create({ parent_id: f.parent.id, input_id: null, role: 'agent', task_kind: 'integration', goal: 'existing identity' });
    const node = f.store.deliveryNode(1);
    f.store.createDeliveryNode({ run_id: 1, generation: 1, node_key: 'pair:1:1', state: 'conflict', data: node.data });
    const outcomes = await Promise.allSettled([f.project.createConvergenceIntegration(1, 1), f.project.createConvergenceIntegration(1, 2)]);
    expect(outcomes.map(result => result.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(f.store.tasks().filter(task => task.task_kind === 'integration')).toHaveLength(5);
    expect(f.project.convergenceIntegrationCapacity()).toBe(true); // Also releases historical integration_slot waits.
    expect(f.store.deliveryNode(2)).toMatchObject({ helper_id: outcomes[1].value.id, state: 'resolving' });
    await assertSources(f);
  } finally { await f.close(); }
});

for (const [reason, expected] of [['content_conflict', 'conflict'], ['validation_failed', 'validation']]) test(`fixed ${reason} node preserves prior calculated output and explains its purpose`, async () => {
  const f = await setup({ run: async () => 'unused' });
  try {
    const node = f.store.deliveryNode(1), output = JSON.stringify({ commit: f.seed, tree: await git(f.root, 'rev-parse', `${f.seed}^{tree}`), via: 'objects' });
    f.store.updateDeliveryNode(1, { data: JSON.stringify({ ...JSON.parse(node.data), reason }), result: output }, 1);
    const helper = await f.project.createConvergenceIntegration(1, 1);
    expect(f.project.convergenceIntegrationContext(helper).reason).toBe(expected);
    expect(f.store.deliveryNode(1).result).toBe(output);
    await assertSources(f);
  } finally { await f.close(); }
});

test('a non-conflict node cannot bypass the dedicated helper factory admission', async () => {
  const f = await setup({ run: async () => 'unused' });
  try {
    f.store.updateDeliveryNode(1, { state: 'ready' }, 1);
    await expect(f.project.createConvergenceIntegration(1, 1)).rejects.toThrow('conflict node');
    expect(f.store.tasks().filter(task => task.task_kind === 'integration')).toEqual([]); await assertSources(f);
  } finally { await f.close(); }
});

for (const outcome of ['success', 'awaiting', 'failed', 'stale', 'withdrawn']) test(`actual ${outcome} exit prefers cross-target availability wake without stale candidate promotion`, async () => {
  const entered = gate(), leave = gate();
  const f = await setup({ run: async ({ task, api, cwd }) => {
    entered.resolve(); await leave.promise;
    if (outcome === 'failed') throw new Error('controlled failed integration');
    if (outcome === 'awaiting') { api.notice(task.id, '等待组合决定'); return 'awaiting'; }
    await repair(cwd); return 'candidate';
  } });
  const wakeups = [];
  f.project.wakeConvergenceAfterIntegration = parentId => wakeups.push({ parentId, active: f.project.running.size,
    token: f.store.task(f.store.deliveryNode(1).helper_id).agent_token_hash });
  try {
    const helper = await f.project.createConvergenceIntegration(1, 1); f.start(); await entered.promise;
    expect(wakeups).toEqual([]);
    if (outcome === 'stale') f.store.updateDeliveryRun(1, { generation: 2, state: 'preparing' }, 1);
    if (outcome === 'withdrawn') f.store.updateDeliveryRun(1, { state: 'withdrawn' }, 1);
    f.project.onConvergenceIntegrationExit(helper.id); expect(wakeups).toEqual([]);
    leave.resolve(); await until(() => !f.project.running.has(helper.id));
    expect(wakeups).toEqual([{ parentId: f.parent.id, active: 0, token: null }]);
    expect(f.publications).toEqual([]); // Preferred callback replaces, rather than duplicates, local-only scheduling.
    if (outcome === 'success') expect(f.store.deliveryNode(1).state).toBe('ready');
    else expect(f.store.deliveryNode(1).result).toBeNull();
    if (outcome === 'stale') expect(f.store.deliveryRun(1)).toMatchObject({ generation: 2, state: 'preparing' });
    if (outcome === 'withdrawn') expect(f.store.deliveryRun(1).state).toBe('withdrawn');
    await assertSources(f);
  } finally { leave.resolve(); await f.close(); }
});
