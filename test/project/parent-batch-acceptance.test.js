import { test, expect, setDefaultTimeout, describe, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, repo, git, gate, until } from '../helpers.js';
import { Project } from '../../src/core/project.js';
import { Dispatcher } from '../../src/rpc/dispatcher.js';
import { tokenHash } from '../../src/core/project/internal.js';

setDefaultTimeout(30000);
const accepts = (f, row) => f.store.history(row.id).filter(event => event.type === 'task.accepted');
async function idle(f, row, status = 'awaiting_acceptance') {
  await f.project.workspaces.finish(f.store.task(row.id));
  f.store.update(row.id, { status, reservation: null, result: `result-${row.id}` });
}
async function setup() {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  const parent = (await f.project.order('parent batch')).task;
  f.store.update(parent.id, { status: 'waiting' });
  const child = await f.project.spawn(parent.id, 'retained child');
  f.store.update(child.id, { status: 'waiting' });
  const grandchild = await f.project.spawn(child.id, 'retained grandchild');
  await idle(f, grandchild); await idle(f, child); await idle(f, parent, 'waiting');
  return { ...f, parent, child, grandchild, rows: [parent, child, grandchild] };
}
async function deliver(f, row) {
  f.store.update(row.id, { status: 'waiting' });
  await f.project.reserveTask(row.id, 'merge');
  const kick = f.project.kick; f.project.kick = () => {}; f.project.stopping = false;
  try { await f.project.driveTaskMerge(row.parent_id); }
  finally { f.project.kick = kick; f.project.stopping = true; }
  f.store.run('UPDATE messages SET consumed=1 WHERE task_id=?', row.parent_id);
}
async function batch(f) { return f.project.acceptTask(f.parent.id); }
function intact(f) {
  for (const row of f.rows) {
    expect(fs.existsSync(row.workspace)).toBe(true);
    expect(accepts(f, row)).toHaveLength(0);
    expect(f.store.task(row.id).status).not.toBe('completed');
  }
}

// A stopped Project has no concurrent writer. Metadata-only rejection cases can reuse
// its real three-worktree graph with SQLite savepoint isolation and explicit Runtime reset.
// Git-changing, successful reclamation and recovery cases below still get fresh fixtures.
function rejectionCases(title, cases, check) {
  describe(title, () => {
    let f, original;
    beforeAll(async () => {
      f = await setup();
      original = { finish: f.project.workspaces.finish, assertBranchWritable: f.project.assertBranchWritable,
        taskSyncBusy: f.project.taskSyncBusy, commandHookRunning: f.project.commandHookRunning };
    });
    beforeEach(() => { f.store.run('SAVEPOINT acceptance_case'); });
    afterEach(() => {
      try { f.store.run('ROLLBACK TO acceptance_case'); f.store.run('RELEASE acceptance_case'); }
      finally {
        f.project.workspaces.finish = original.finish;
        f.project.assertBranchWritable = original.assertBranchWritable;
        f.project.taskSyncBusy = original.taskSyncBusy; f.project.commandHookRunning = original.commandHookRunning;
        f.project.running.clear(); f.project.workspaces.busy.clear();
      }
      intact(f);
      expect(f.project.acceptanceBusy?.size ?? 0).toBe(0);
    });
    afterAll(async () => {
      if (!f) return;
      try {
        for (const row of f.rows) {
          expect(await git(row.workspace, 'rev-parse', 'HEAD')).toBe(row.base_commit);
          expect(await git(row.workspace, 'status', '--porcelain')).toBe('');
        }
      } finally { await f.close(); }
    });
    for (const value of cases) test(title.replace('%s', value), () => check(f, value));
  });
}

test('one user acceptance settles multilevel no-code children, preserving results, sessions, messages and all acceptance hooks', async () => {
  const f = await setup();
  try {
    const configs = f.rows.map(row => f.store.task(row.id).auto_merge);
    const hooks = [], emit = f.project.emitTaskHook.bind(f.project);
    f.project.emitTaskHook = (id, trigger, ...args) => { if (trigger === 'worker.accepted') hooks.push(id); return emit(id, trigger, ...args); };
    for (const row of f.rows) {
      const file = path.join(f.config.home, 'sessions', `task-${row.id}-history.txt`);
      fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `session-${row.id}`);
      const message = f.store.message(row.id, 'historical input'); f.store.run('UPDATE messages SET consumed=1 WHERE id=?', message);
    }
    expect((await batch(f)).status).toBe('completed');
    const rootEvent = accepts(f, f.parent)[0];
    for (const [index, row] of f.rows.entries()) {
      expect(f.store.task(row.id)).toMatchObject({ status: 'completed', workspace: null, result: `result-${row.id}`, integration: 'none', auto_merge: configs[index] });
      expect(fs.existsSync(row.workspace)).toBe(false);
      expect(f.store.branch(row.branch).status).toBe('archived');
      expect(accepts(f, row)).toHaveLength(1);
      expect(accepts(f, row)[0].data).toMatchObject({ accepted_by: 'user', resources_reclaimed: true, acceptance_execution: rootEvent.data.acceptance_execution });
      if (row.id !== f.parent.id) expect(accepts(f, row)[0].data).toMatchObject({ via: 'parent_acceptance', acceptance_root_id: f.parent.id, delegator_id: row.parent_id });
      expect(fs.readFileSync(path.join(f.config.home, 'sessions', `task-${row.id}-history.txt`), 'utf8')).toBe(`session-${row.id}`);
      expect(f.store.get('SELECT count(*) AS n FROM messages WHERE task_id=?', row.id).n).toBe(1);
      expect(f.project.inspect(row.id).accepted).toBe(true);
    }
    expect(hooks.sort()).toEqual(f.rows.map(row => row.id).sort());
    await batch(f);
    expect(hooks).toHaveLength(3);
    expect(f.store.history(f.parent.id).filter(event => event.type === 'task.acceptance_started')).toHaveLength(1);
  } finally { await f.close(); }
});

test('one acceptance validates multilevel Squash deliveries before reclaiming their refs', async () => {
  const f = await setup();
  try {
    fs.writeFileSync(path.join(f.grandchild.workspace, 'nested.txt'), 'nested code\n');
    await git(f.grandchild.workspace, 'add', '.'); await git(f.grandchild.workspace, 'commit', '-m', 'nested code');
    await deliver(f, f.grandchild); await deliver(f, f.child); await deliver(f, f.parent);
    expect(await git(f.root, 'show', 'main:nested.txt')).toBe('nested code');
    await batch(f);
    for (const row of f.rows) {
      expect(f.store.task(row.id)).toMatchObject({ status: 'completed', integration: 'merged' });
      expect(accepts(f, row)).toHaveLength(1);
      expect(f.store.history(row.id).filter(event => event.type === 'task.merge_integrated')).toHaveLength(1);
    }
  } finally { await f.close(); }
});

test('delivery retains the original child for revisions until the user accepts the parent', async () => {
  const f = fixture({ resolve() { return { agent: 'mock' }; }, async run({ task, messages }) {
    return task.task_kind === 'child' ? messages.some(message => message.body === 'revise') ? 'revised child' : 'first child' : 'collected';
  } });
  f.project.stopping = true; await repo(f.root);
  try {
    const parent = (await f.project.order('collect child')).task; f.store.update(parent.id, { status: 'waiting' });
    const child = await f.project.spawn(parent.id, 'answer');
    f.project.stopping = false; f.project.kick();
    await until(() => f.store.task(child.id).status === 'awaiting_acceptance' && f.store.task(parent.id).status === 'waiting' && !f.project.running.size);
    expect(fs.existsSync(child.workspace)).toBe(true); expect(accepts(f, child)).toHaveLength(0);
    const agentBefore = f.project.inspect(child.id).agent;
    f.project.message(child.id, 'revise');
    await until(() => f.store.task(child.id).calls === 2 && f.store.task(child.id).status === 'awaiting_acceptance' && f.store.task(parent.id).status === 'waiting' && !f.project.running.size);
    expect(f.store.task(child.id)).toMatchObject({ branch: child.branch, workspace: child.workspace, result: 'revised child' });
    expect(f.project.inspect(child.id).agent.id).toBe(agentBefore.id);
    await f.project.acceptTask(parent.id);
    expect(f.store.task(child.id)).toMatchObject({ status: 'completed', result: 'revised child' });
  } finally { await f.close(); }
});

for (const kind of ['order', 'say']) test(`independent ${kind} and children across that boundary are never implicitly accepted`, async () => {
  const f = await setup();
  try {
    const order = (await f.project.order('independent user work', f.parent.branch)).task;
    f.store.update(order.id, { status: 'waiting' });
    const child = await f.project.spawn(order.id, 'independent child');
    await idle(f, child); await idle(f, order); f.store.run('UPDATE tasks SET task_kind=? WHERE id=?', kind, order.id);
    await expect(batch(f)).rejects.toThrow('descendants'); intact(f);
    expect(accepts(f, order)).toHaveLength(0); expect(accepts(f, child)).toHaveLength(0);
    // Even a historical terminal order cannot authorize acceptance across its independent boundary.
    f.store.update(order.id, { status: 'completed' });
    await expect(batch(f)).rejects.toThrow('descendants'); intact(f);
  } finally { await f.close(); }
});

test('Agent target permission remains direct-child-only while acceptance of that target shares batch safety', async () => {
  const f = await setup();
  try {
    const token = 'active-parent', run = { controller: new AbortController(), parked: false };
    f.store.update(f.parent.id, { status: 'running' }); f.store.armAgent(f.parent.id, tokenHash(token)); f.project.running.set(f.parent.id, run);
    const rpc = new Dispatcher(f.project), accept = id => rpc.dispatch('worker.accept', { id, _token: token });
    const order = (await f.project.order('not a delegated child', f.parent.branch)).task; await idle(f, order);
    await expect(accept(f.parent.id)).rejects.toThrow('own direct child');
    await expect(accept(f.grandchild.id)).rejects.toThrow('own direct child');
    await expect(accept(order.id)).rejects.toThrow('user-created order');
    await accept(f.child.id);
    expect(f.store.task(f.parent.id).status).toBe('running'); expect(f.store.task(f.grandchild.id).status).toBe('completed');
    expect(accepts(f, f.grandchild)[0].data).toMatchObject({ accepted_by: 'parent', parent_id: f.parent.id, delegator_id: f.child.id, acceptance_root_id: f.child.id });
    f.project.running.delete(f.parent.id);
    await expect(accept(f.child.id)).rejects.toThrow('expired agent token');
  } finally { f.project.running.clear(); await f.close(); }
});

rejectionCases('a %s descendant is never treated as delivered', ['queued', 'running', 'waiting', 'paused', 'awaiting'], async (f, status) => {
  f.store.update(f.grandchild.id, { status }); await expect(batch(f)).rejects.toThrow('descendants'); intact(f);
});
for (const status of ['failed', 'cancelled']) test(`terminal ${status} compatibility does not fabricate child acceptance or clear errors`, async () => {
  const f = await setup();
  try {
    f.store.update(f.grandchild.id, { status, error: 'original failure' }); await batch(f);
    expect(f.store.task(f.grandchild.id)).toMatchObject({ status, error: 'original failure', result: `result-${f.grandchild.id}` });
    expect(accepts(f, f.grandchild)).toHaveLength(0); expect(accepts(f, f.child)).toHaveLength(1);
  } finally { await f.close(); }
});

async function rejectsPreflight(f, obstacle) {
  const row = f.grandchild;
  if (obstacle === 'actual invocation') f.project.running.set(row.id, { controller: new AbortController(), parked: true });
  if (obstacle === 'cleanup') f.project.workspaces.busy.add(row.id);
  if (obstacle === 'sync') f.project.taskSyncBusy = new Set([row.id]);
  if (obstacle === 'command') f.project.commandHookRunning = new Set([row.id]);
  if (obstacle === 'message' || obstacle === 'buffered message') f.store.message(row.id, 'must process', null, obstacle === 'buffered message' ? 'frozen' : null);
  if (obstacle === 'decision') f.project.notice(row.id, 'need choice', 'unresolved');
  if (obstacle.includes('reservation')) f.store.update(row.id, { reservation: JSON.stringify({ version: 2, kind: 'merge', status: obstacle.startsWith('pending') ? 'pending' : 'requested' }) });
  if (obstacle === 'dirty' || obstacle === 'new commit') {
    fs.writeFileSync(path.join(row.workspace, 'unreviewed.txt'), 'valuable');
    if (obstacle === 'new commit') { await git(row.workspace, 'add', '.'); await git(row.workspace, 'commit', '-m', 'undelivered'); }
  }
  if (obstacle === 'locked') await git(f.root, 'worktree', 'lock', row.workspace);
  if (obstacle === 'shared user') f.store.create({ role: 'verifier', goal: 'shared checkout', verifies_task_id: row.id });
  if (obstacle === 'freeze') {
    const assert = f.project.assertBranchWritable.bind(f.project);
    f.project.assertBranchWritable = (branch, ...args) => { if (branch === row.branch) throw new Error('synthetic freeze'); return assert(branch, ...args); };
  }
  await expect(batch(f)).rejects.toThrow(); intact(f);
  if (obstacle === 'locked') await git(f.root, 'worktree', 'unlock', row.workspace);
}
rejectionCases('batch preflight preserves every resource for descendant %s',
  ['actual invocation', 'cleanup', 'sync', 'command', 'message', 'buffered message', 'decision', 'pending reservation', 'requested reservation', 'shared user', 'freeze'], rejectsPreflight);
for (const obstacle of ['dirty', 'new commit', 'locked']) {
  test(`batch preflight preserves every resource for descendant ${obstacle}`, async () => {
    const f = await setup();
    try { await rejectsPreflight(f, obstacle); } finally { await f.close(); }
  });
}

rejectionCases('descendant %s arriving during asynchronous batch inspection blocks reclamation',
  ['message', 'buffered message', 'decision', 'status', 'reparent', 'kind', 'invocation', 'sync', 'reservation', 'shared user'], async (f, arrival) => {
    const row = f.grandchild;
    const original = f.project.workspaces.finish.bind(f.project.workspaces); let injected = false;
    f.project.workspaces.finish = async task => {
      await original(task);
      if (injected) return; injected = true;
      if (arrival === 'message' || arrival === 'buffered message') f.store.message(row.id, 'late input', null, arrival === 'buffered message' ? 'frozen' : null);
      if (arrival === 'decision') f.project.notice(row.id, 'late decision', 'need answer');
      if (arrival === 'status') f.store.update(row.id, { status: 'queued' });
      if (arrival === 'reparent') f.store.update(row.id, { parent_id: f.parent.id });
      if (arrival === 'kind') f.store.update(row.id, { task_kind: 'order' });
      if (arrival === 'invocation') f.project.running.set(row.id, { controller: new AbortController() });
      if (arrival === 'sync') f.project.taskSyncBusy = new Set([row.id]);
      if (arrival === 'reservation') f.store.update(row.id, { reservation: JSON.stringify({ version: 2, kind: 'merge', status: 'requested' }) });
      if (arrival === 'shared user') f.store.create({ role: 'verifier', goal: 'late user', verifies_task_id: row.id });
    };
    await expect(batch(f)).rejects.toThrow(); intact(f);
  });

test('true reclaim boundary rejects messages to every batch participant, and guards against new decisions before deletion', async () => {
  const f = await setup(), entered = gate(), release = gate();
  try {
    const original = f.project.workspaces.archiveBranchesUnsafe.bind(f.project.workspaces);
    f.project.workspaces.archiveBranchesUnsafe = async (...args) => { entered.resolve(); await release.promise; return original(...args); };
    const accepting = batch(f); await entered.promise;
    for (const row of f.rows) expect(() => f.project.message(row.id, 'late input')).toThrow('正在回收');
    f.project.notice(f.grandchild.id, 'late decision', 'preserve resources');
    release.resolve(); await expect(accepting).rejects.toThrow('open decisions'); intact(f);
  } finally { release.resolve(); await f.close(); }
});

test('a child acceptance queued before parent partial reclamation rechecks the batch root after acquiring the Git gate', async () => {
  const f = await setup(), entered = gate(), release = gate();
  try {
    const original = f.project.workspaces.git.bind(f.project.workspaces);
    f.project.workspaces.git = async (cwd, ...args) => {
      if (args[0] === 'worktree' && args[1] === 'remove' && args[2] === f.child.workspace) throw new Error('partial failure');
      return original(cwd, ...args);
    };
    const blocker = f.project.workspaces.exclusive(async () => { entered.resolve(); await release.promise; });
    await entered.promise;
    const rootResult = batch(f).then(() => null, error => error);
    const childResult = f.project.acceptTask(f.child.id).then(() => null, error => error);
    release.resolve(); await blocker;
    expect((await rootResult).message).toContain('reclamation incomplete');
    expect((await childResult).message).toContain('partial parent acceptance');
    for (const row of f.rows) expect(accepts(f, row)).toHaveLength(0);
    expect(fs.existsSync(f.child.workspace)).toBe(true); expect(fs.existsSync(f.grandchild.workspace)).toBe(true);
  } finally { release.resolve(); await f.close(); }
});

for (const failAt of ['child worktree', 'grandchild ref']) test(`partial ${failAt} removal retains all child outcomes until explicit parent resume, including restart unknown protection`, async () => {
  const f = await setup(); let restarted;
  try {
    f.store.update(f.parent.id, { status: 'awaiting_acceptance' });
    await f.project.setTaskCompletion(f.parent.id, 'accept', f.project.taskHooks(f.parent.id).revision);
    const original = f.project.workspaces.git.bind(f.project.workspaces);
    f.project.workspaces.git = async (cwd, ...args) => {
      if ((failAt === 'child worktree' && args[0] === 'worktree' && args[1] === 'remove' && args[2] === f.child.workspace)
        || (failAt === 'grandchild ref' && args[0] === 'update-ref' && args[1] === '-d' && args[2] === `refs/heads/${f.grandchild.branch}`)) throw new Error('synthetic partial failure');
      return original(cwd, ...args);
    };
    f.project.stopping = false; f.project.scheduleTaskCompletion(f.parent.id);
    await until(() => JSON.parse(f.store.task(f.parent.id).auto_merge).completion.executions.accept?.status === 'unknown');
    for (const row of f.rows) { expect(accepts(f, row)).toHaveLength(0); expect(f.store.task(row.id).status).toBe('awaiting_acceptance'); }
    expect(f.store.branch(f.parent.branch).status).toBe('archived');
    for (const row of f.rows) expect(() => f.project.message(row.id, 'must not restart partial tree')).toThrow('回收未完成');
    for (const row of [f.child, f.grandchild]) await expect(f.project.acceptTask(row.id)).rejects.toThrow('partial parent acceptance');
    await f.project.shutdown(); restarted = new Project(f.config, f.store); restarted.stopping = true;
    restarted.recoverTaskCompletion(); restarted.stopping = false; restarted.scheduleTaskCompletion(); await restarted.completionQueue;
    expect(f.store.history(f.parent.id).filter(event => event.type === 'branch.archive')).toHaveLength(1);
    expect(restarted.inspect(f.parent.id).acceptance_recovery).toBe(true);
    for (const row of [f.child, f.grandchild]) await expect(restarted.acceptTask(row.id)).rejects.toThrow('partial parent acceptance');
    await restarted.acceptTask(f.parent.id);
    for (const row of f.rows) { expect(accepts(f, row)).toHaveLength(1); expect(f.store.task(row.id).status).toBe('completed'); }
    expect(JSON.parse(f.store.task(f.parent.id).auto_merge).completion.executions.accept.status).toBe('unknown');
  } finally { await restarted?.shutdown(); await f.close(); }
});

for (const missing of ['workspace pointer', 'ref']) test(`a delivered child with missing ${missing} cannot be accepted without an exact recovery receipt`, async () => {
  const f = await setup();
  try {
    if (missing === 'workspace pointer') f.store.update(f.grandchild.id, { workspace: null });
    else await git(f.root, 'update-ref', '-d', `refs/heads/${f.grandchild.branch}`, f.grandchild.base_commit);
    await expect(batch(f)).rejects.toThrow(); intact(f);
  } finally { await f.close(); }
});

test('checkout registration changes during asynchronous preflight are not applied to an unrelated detached checkout', async () => {
  const f = await setup();
  try {
    const clean = f.project.workspaces.clean.bind(f.project.workspaces); let checks = 0;
    f.project.workspaces.clean = async cwd => {
      await clean(cwd);
      if (cwd === f.grandchild.workspace && ++checks === 2) await git(f.parent.workspace, 'checkout', '--detach');
    };
    await expect(batch(f)).rejects.toThrow('reclamation incomplete'); intact(f);
    expect(f.store.history(f.parent.id).find(event => event.type === 'branch.archive').data.failed[0].reason).toContain('registration changed');
    expect(await git(f.parent.workspace, 'symbolic-ref', '--short', 'HEAD').catch(() => null)).toBeNull();
  } finally { await f.close(); }
});

for (const drift of ['recreated ref', 'participant status', 'participant head']) test(`explicit partial batch recovery rejects ${drift} instead of guessing successful reclamation`, async () => {
  const f = await setup();
  try {
    const original = f.project.workspaces.git.bind(f.project.workspaces); let fail = true;
    f.project.workspaces.git = async (cwd, ...args) => {
      if (fail && args[0] === 'worktree' && args[1] === 'remove' && args[2] === f.child.workspace) throw new Error('partial failure');
      return original(cwd, ...args);
    };
    await expect(batch(f)).rejects.toThrow('reclamation incomplete'); fail = false;
    if (drift === 'recreated ref') await git(f.root, 'update-ref', `refs/heads/${f.parent.branch}`, f.parent.base_commit);
    if (drift === 'participant status') f.store.update(f.grandchild.id, { status: 'completed' });
    if (drift === 'participant head') f.store.update(f.grandchild.id, { head_commit: '0'.repeat(40) });
    await expect(batch(f)).rejects.toThrow();
    for (const row of f.rows) expect(accepts(f, row)).toHaveLength(0);
    expect(fs.existsSync(f.child.workspace)).toBe(true); expect(fs.existsSync(f.grandchild.workspace)).toBe(true);
    expect(f.store.history(f.parent.id).filter(event => event.type === 'branch.archive')).toHaveLength(1);
  } finally { await f.close(); }
});

test('restart explicitly resumes a worktree-only granular receipt when interruption prevented the aggregate archive receipt', async () => {
  const f = await setup(); let restarted;
  try {
    const gitCommand = f.project.workspaces.git.bind(f.project.workspaces), event = f.store.event.bind(f.store);
    f.project.workspaces.git = async (cwd, ...args) => {
      if (args[0] === 'update-ref' && args[1] === '-d') throw new Error('interrupted after worktree removal');
      return gitCommand(cwd, ...args);
    };
    f.store.event = (id, type, data) => { if (type === 'branch.archive') throw new Error('aggregate receipt unavailable'); return event(id, type, data); };
    await expect(batch(f)).rejects.toThrow('aggregate receipt unavailable');
    expect(f.store.history(f.parent.id).filter(row => row.type === 'branch.archive')).toHaveLength(0);
    expect(f.store.history(f.parent.id).find(row => row.type === 'branch.archive.outcome').data.outcomes[0])
      .toMatchObject({ worktree: 'removed', ref: 'kept', tip: f.parent.base_commit });
    for (const row of f.rows) expect(() => f.project.message(row.id, 'preserve unknown batch')).toThrow('回收未完成');
    for (const row of [f.child, f.grandchild]) await expect(f.project.acceptTask(row.id)).rejects.toThrow('partial parent acceptance');
    f.store.event = event; await f.project.shutdown(); restarted = new Project(f.config, f.store); restarted.stopping = true;
    expect(restarted.inspect(f.parent.id).acceptance_recovery).toBe(true);
    await restarted.acceptTask(f.parent.id);
    for (const row of f.rows) { expect(accepts(f, row)).toHaveLength(1); expect(f.store.task(row.id).status).toBe('completed'); }
  } finally { await restarted?.shutdown(); await f.close(); }
});

test('parent automatic-to-accept uses the same batch semantics without inheriting any authorization to children', async () => {
  const f = await setup();
  try {
    f.store.update(f.parent.id, { status: 'awaiting_acceptance' });
    const configs = [f.child, f.grandchild].map(row => f.store.task(row.id).auto_merge);
    await f.project.setTaskCompletion(f.parent.id, 'accept', f.project.taskHooks(f.parent.id).revision);
    f.project.stopping = false; f.project.scheduleTaskCompletion(f.parent.id); await f.project.completionQueue;
    for (const row of f.rows) expect(f.store.task(row.id)).toMatchObject({ status: 'completed', workspace: null });
    for (const [index, row] of [f.child, f.grandchild].entries()) {
      expect(f.store.task(row.id).auto_merge).toBe(configs[index]);
      expect(f.project.autoCompletionView(f.store.task(row.id))).toMatchObject({ level: 'merge', locked: true });
      expect(accepts(f, row)[0].data).toMatchObject({ via: 'parent_acceptance', acceptance_root_id: f.parent.id, completion_execution: accepts(f, f.parent)[0].data.completion_execution });
    }
    expect(f.project.autoCompletionView(f.store.task(f.parent.id))).toMatchObject({ level: 'accept', state: 'succeeded' });
  } finally { await f.close(); }
});
