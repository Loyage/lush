import { test, expect, setDefaultTimeout } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, repo, git, gate, until } from '../helpers.js';
import { Project } from '../../src/core/project.js';

setDefaultTimeout(20000);
async function setup() { const f = fixture(); f.project.stopping = true; await repo(f.root); return f; }
async function idle(f, task, historical = false) {
  await f.project.workspaces.finish(task);
  f.store.update(task.id, { status: historical ? 'completed' : 'waiting', reservation: null, result: 'retained result' });
  if (historical) f.store.event(task.id, 'task.accepted', { head_commit: f.store.task(task.id).head_commit, accepted_by: 'user' });
}
const accepts = (f, task) => f.store.history(task.id).filter(event => event.type === 'task.accepted');

for (const failAt of ['worktree', 'ref']) test(`unified acceptance only completes after ${failAt} removal succeeds, and explicitly resumes partial facts`, async () => {
  const f = await setup();
  try {
    const { task } = await f.project.order('retain recovery evidence'); await idle(f, task);
    const session = path.join(f.config.home, 'sessions', `task-${task.id}-keep.txt`);
    fs.mkdirSync(path.dirname(session), { recursive: true }); fs.writeFileSync(session, 'run history');
    const original = f.project.workspaces.git.bind(f.project.workspaces); let fail = true;
    f.project.workspaces.git = async (cwd, ...args) => {
      if (fail && ((failAt === 'worktree' && args[0] === 'worktree' && args[1] === 'remove')
        || (failAt === 'ref' && args[0] === 'update-ref' && args[1] === '-d'))) throw new Error('synthetic deletion failure');
      return original(cwd, ...args);
    };
    await expect(f.project.acceptTask(task.id)).rejects.toThrow('reclamation incomplete');
    expect(f.store.task(task.id).status).toBe('waiting'); expect(accepts(f, task)).toHaveLength(0);
    const summary = f.store.history(task.id).find(event => event.type === 'branch.archive');
    expect(summary.data.failed).toHaveLength(1);
    expect(fs.existsSync(task.workspace)).toBe(failAt === 'worktree');
    expect(f.store.task(task.id).workspace).toBe(failAt === 'ref' ? null : task.workspace);
    if (failAt === 'ref') expect(() => f.project.message(task.id, 'must not start a replacement checkout')).toThrow('回收未完成');
    fail = false;
    const accepted = await f.project.acceptTask(task.id);
    expect(accepted).toMatchObject({ status: 'completed', workspace: null, result: 'retained result' });
    expect(f.store.branch(task.branch).status).toBe('archived'); expect(accepts(f, task)).toHaveLength(1);
    expect(fs.readFileSync(session, 'utf8')).toBe('run history');
    expect(await git(f.root, 'show-ref', '--verify', `refs/heads/${task.branch}`).catch(() => null)).toBeNull();
    await f.project.acceptTask(task.id); expect(accepts(f, task)).toHaveLength(1);
  } finally { await f.close(); }
});

for (const historical of [false, true]) test(`partial subtree acceptance resumes without its reclaimed parent ref (historical parent=${historical})`, async () => {
  const f = await setup();
  try {
    const { task } = await f.project.order('subtree');
    const child = await f.project.spawn(task.id, 'old accepted child');
    await idle(f, child, true); await idle(f, task, historical);
    const original = f.project.workspaces.git.bind(f.project.workspaces); let removes = 0;
    f.project.workspaces.git = async (cwd, ...args) => {
      if (args[0] === 'worktree' && args[1] === 'remove' && ++removes === 2) throw new Error('second worktree I/O failure');
      return original(cwd, ...args);
    };
    await expect(f.project.acceptTask(task.id)).rejects.toThrow('reclamation incomplete');
    expect(f.store.branch(task.branch).status).toBe('archived'); expect(f.store.branch(child.branch).status).toBe('active');
    expect(f.store.task(task.id).status).toBe(historical ? 'completed' : 'waiting'); expect(accepts(f, task)).toHaveLength(historical ? 1 : 0);
    expect((await f.project.acceptTask(task.id)).status).toBe('completed');
    expect(f.store.branch(child.branch).status).toBe('archived'); expect(removes).toBe(3);
    expect(accepts(f, task)).toHaveLength(1); expect(accepts(f, child)).toHaveLength(1);
  } finally { await f.close(); }
});

test('an exact deleted-ref outcome can finish database reclamation without guessing from an absent path', async () => {
  const f = await setup();
  try {
    const { task } = await f.project.order('ref deleted before branch fact'); await idle(f, task);
    const original = f.store.markBranchArchived.bind(f.store); let fail = true;
    f.store.markBranchArchived = branch => { if (fail) throw new Error('synthetic fact-write failure'); return original(branch); };
    await expect(f.project.acceptTask(task.id)).rejects.toThrow('reclamation incomplete');
    expect(f.store.branch(task.branch).status).toBe('active'); expect(f.store.task(task.id).workspace).toBeNull();
    expect(accepts(f, task)).toHaveLength(0);
    fail = false;
    expect((await f.project.acceptTask(task.id)).status).toBe('completed');
    expect(f.store.branch(task.branch).status).toBe('archived'); expect(accepts(f, task)).toHaveLength(1);
  } finally { await f.close(); }
});

test('a resource owner appearing during preflight blocks reclamation without deleting any checkout', async () => {
  const f = await setup(), entered = gate(), release = gate();
  try {
    const { task } = await f.project.order('shared resource'); await idle(f, task);
    const original = f.project.workspaces.archiveBranchesUnsafe.bind(f.project.workspaces);
    f.project.workspaces.archiveBranchesUnsafe = async (...args) => { entered.resolve(); await release.promise; return original(...args); };
    const accepting = f.project.acceptTask(task.id); await entered.promise;
    const verifier = f.store.create({ role: 'verifier', goal: 'hold shared checkout', verifies_task_id: task.id });
    release.resolve(); await expect(accepting).rejects.toThrow('resource users');
    expect(fs.existsSync(task.workspace)).toBe(true); expect(accepts(f, task)).toHaveLength(0);
    f.store.update(verifier.id, { status: 'cancelled' });
  } finally { release.resolve(); await f.close(); }
});

test('the irreversible reclaim boundary rejects late input instead of launching an Agent in a disappearing checkout', async () => {
  const f = await setup(), entered = gate(), release = gate();
  try {
    const { task } = await f.project.order('late input'); await idle(f, task);
    const original = f.project.workspaces.git.bind(f.project.workspaces);
    f.project.workspaces.git = async (cwd, ...args) => {
      if (args[0] === 'worktree' && args[1] === 'remove') { entered.resolve(); await release.promise; }
      return original(cwd, ...args);
    };
    const accepting = f.project.acceptTask(task.id); await entered.promise;
    expect(() => f.project.message(task.id, 'new input')).toThrow('正在回收');
    expect(f.store.unread(task.id)).toHaveLength(0); expect(f.project.running.size).toBe(0);
    release.resolve(); expect((await accepting).status).toBe('completed');
  } finally { release.resolve(); await f.close(); }
});

for (const savedLevel of ['accept', 'archive']) test(`existing saved ${savedLevel} authorization adopts resource-reclaiming acceptance without rewriting its level`, async () => {
  const f = await setup();
  try {
    const { task } = await f.project.order('existing saved authorization'); await idle(f, task);
    f.store.update(task.id, { status: 'awaiting_acceptance', auto_merge: JSON.stringify({ version: 1, enabled: true, locked: false, level: savedLevel,
      completion: { authorization: 'existing-auth', round: 0, executions: {}, notices: {} } }) });
    f.project.stopping = false; f.project.scheduleTaskCompletion(task.id); await f.project.completionQueue;
    expect(f.store.task(task.id)).toMatchObject({ status: 'completed', workspace: null });
    expect(JSON.parse(f.store.task(task.id).auto_merge).level).toBe(savedLevel);
    expect(f.project.autoCompletionView(f.store.task(task.id))).toMatchObject({ level: 'accept', phase: 'accept', state: 'succeeded' });
    expect(f.project.taskHooks(task.id).mounts.map(mount => mount.id)).toEqual(['auto-merge', 'auto-accept']);
  } finally { await f.close(); }
});

for (const savedLevel of ['accept', 'archive']) test(`old completed ${savedLevel} authorization safely completes its retained resource tail without repeating acceptance`, async () => {
  const f = await setup();
  try {
    const { task } = await f.project.order('old completed authorization'); await idle(f, task, true);
    f.store.update(task.id, { auto_merge: JSON.stringify({ version: 1, enabled: true, locked: false, level: savedLevel,
      completion: { authorization: 'old-completed-auth', round: 0,
        executions: { accept: { id: 999, phase: 'accept', status: 'succeeded', head_commit: f.store.task(task.id).head_commit } }, notices: {} } }) });
    f.project.stopping = false; f.project.scheduleTaskCompletion(task.id); await f.project.completionQueue;
    expect(f.store.task(task.id).workspace).toBeNull(); expect(f.store.branch(task.branch).status).toBe('archived');
    expect(accepts(f, task)).toHaveLength(1);
    expect(f.store.history(task.id).filter(event => event.type === 'task.acceptance_reclaimed')).toHaveLength(1);
    expect(JSON.parse(f.store.task(task.id).auto_merge).completion.executions.archive.status).toBe('succeeded');
  } finally { await f.close(); }
});

test('a partial new automatic acceptance is unknown after restart and only explicit acceptance resumes deletion', async () => {
  const f = await setup(); let restarted;
  try {
    const { task } = await f.project.order('new automatic partial'); await idle(f, task);
    await f.project.setTaskCompletion(task.id, 'accept', f.project.taskHooks(task.id).revision);
    const original = f.project.workspaces.git.bind(f.project.workspaces); let deletes = 0;
    f.project.workspaces.git = async (cwd, ...args) => {
      if (args[0] === 'update-ref' && args[1] === '-d' && ++deletes === 1) throw new Error('synthetic I/O failure');
      return original(cwd, ...args);
    };
    f.project.stopping = false; f.project.scheduleTaskCompletion(task.id);
    await until(() => JSON.parse(f.store.task(task.id).auto_merge).completion.executions.accept?.status === 'unknown');
    expect(accepts(f, task)).toHaveLength(0);
    await f.project.shutdown(); restarted = new Project(f.config, f.store); restarted.stopping = true;
    restarted.recoverTaskCompletion(); restarted.stopping = false; restarted.scheduleTaskCompletion(); await restarted.completionQueue;
    expect(f.store.task(task.id).status).toBe('awaiting_acceptance');
    expect(f.store.history(task.id).filter(event => event.type === 'branch.archive')).toHaveLength(1);
    expect((await restarted.acceptTask(task.id)).status).toBe('completed');
    expect(f.store.history(task.id).filter(event => event.type === 'branch.archive')).toHaveLength(2);
    expect(JSON.parse(f.store.task(task.id).auto_merge).completion.executions.accept.status).toBe('unknown');
  } finally { await restarted?.shutdown(); await f.close(); }
});
