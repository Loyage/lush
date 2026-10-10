import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, repo, git, until, gate } from '../helpers.js';
import { retiredHook } from '../hook-assertions.js';

const value = (f, task) => JSON.parse(f.store.task(task.id).auto_merge);
const set = (f, task, level) => f.project.setTaskCompletion(task.id, level, f.project.taskHooks(task.id).revision);
async function setup() { const f = fixture(); f.project.stopping = true; await repo(f.root); return f; }
async function accepted(f) {
  const { task } = await f.project.order('archive guard');
  // Simulate an old accepted Worker with retained resources, not unified acceptance.
  await f.project.workspaces.finish(task);
  f.store.update(task.id, { status: 'completed' });
  f.store.event(task.id, 'task.accepted', { head_commit: f.store.task(task.id).head_commit, accepted_by: 'user' });
  return task;
}
async function runArchive(f, task) {
  await set(f, task, 'archive'); f.project.stopping = false; f.project.scheduleTaskCompletion(task.id);
  await until(() => value(f, task).completion.executions.archive?.status === 'failed', 10000);
}

test('automatic archive preserves committed but unreviewed changes made after acceptance', async () => {
  const f = await setup();
  try {
    const task = await accepted(f);
    fs.writeFileSync(path.join(task.workspace, 'late.txt'), 'new committed work');
    await git(task.workspace, 'add', '.'); await git(task.workspace, 'commit', '-m', 'late work');
    const tip = await git(task.workspace, 'rev-parse', 'HEAD');
    await runArchive(f, task);
    expect(f.store.branch(task.branch).status).toBe('active');
    expect(fs.readFileSync(path.join(task.workspace, 'late.txt'), 'utf8')).toBe('new committed work');
    expect(await git(f.root, 'rev-parse', `refs/heads/${task.branch}`)).toBe(tip);
  } finally { await f.close(); }
});

test('new branch resource users during archive preflight block all deletion', async () => {
  const f = await setup(), entered = gate(), release = gate();
  try {
    const task = await accepted(f); await set(f, task, 'archive');
    const original = f.project.workspaces.archiveBranchesUnsafe.bind(f.project.workspaces);
    f.project.workspaces.archiveBranchesUnsafe = async (names, options) => { entered.resolve(); await release.promise; return original(names, options); };
    f.project.stopping = false; f.project.scheduleTaskCompletion(task.id); await entered.promise;
    const verifier = f.store.create({ role: 'verifier', goal: 'late inspection', verifies_task_id: task.id });
    release.resolve(); await f.project.completionQueue;
    expect(value(f, task).completion.executions.archive.status).toBe('failed');
    expect(fs.existsSync(task.workspace)).toBe(true); expect(f.store.branch(task.branch).status).toBe('active');
    f.store.update(verifier.id, { status: 'cancelled' });
  } finally { release.resolve(); await f.close(); }
});

test('a new subtree branch at the Git boundary is not silently left behind by automatic archive', async () => {
  const f = await setup(), entered = gate(), release = gate();
  try {
    const task = await accepted(f); await set(f, task, 'archive');
    const original = f.project.workspaces.archiveBranchesUnsafe.bind(f.project.workspaces);
    f.project.workspaces.archiveBranchesUnsafe = async (names, options) => { entered.resolve(); await release.promise; return original(names, options); };
    f.project.stopping = false; f.project.scheduleTaskCompletion(task.id); await entered.promise;
    f.store.recordBranch({ branch: 'late-branch', parent: task.branch, commit: task.head_commit });
    release.resolve(); await f.project.completionQueue;
    expect(value(f, task).completion.executions.archive.status).toBe('failed');
    expect(fs.existsSync(task.workspace)).toBe(true); expect(f.store.branch(task.branch).status).toBe('active');
  } finally { release.resolve(); await f.close(); }
});

test('known failure is not silently retried, but manual acceptance may complete the authorized archive tail', async () => {
  const f = await setup();
  try {
    const { task } = await f.project.order('manual recovery');
    await set(f, task, 'merge'); f.store.update(task.id, { status: 'waiting' });
    await f.project.settleQueuedMerge(task.id);
    fs.writeFileSync(path.join(task.workspace, 'dirty.txt'), 'keep');
    await set(f, task, 'archive'); f.project.stopping = false; f.project.scheduleTaskCompletion(task.id);
    await until(() => value(f, task).completion.executions.accept?.status === 'failed');
    expect(f.store.task(task.id).status).toBe('awaiting_acceptance');
    fs.unlinkSync(path.join(task.workspace, 'dirty.txt'));
    await f.project.acceptTask(task.id);
    await until(() => f.store.branch(task.branch).status === 'archived');
    expect(value(f, task).completion.executions.accept.status).toBe('failed'); // failure history remains honest
    expect(value(f, task).completion.executions.archive).toBeUndefined(); // manual unified acceptance already reclaimed resources
    expect(f.store.history(task.id).filter(row => row.type === 'task.accepted')).toHaveLength(1);
  } finally { await f.close(); }
});

test('custom notify remains explicitly authorized even when all automatic completion successes are silent', async () => {
  const f = await setup();
  try {
    const { task } = await f.project.order('explicit notify'); await set(f, task, 'archive');
    const hook = f.project.attachTaskHook(task.id, { name: 'my notification', trigger: 'worker.accepted', mode: 'once', enabled: true,
      actions: [{ type: 'notify', title: 'explicit reminder', body: 'keep my rule' }] }, f.project.taskHooks(task.id).revision).mounts.at(-1);
    f.store.update(task.id, { status: 'waiting' }); await f.project.settleQueuedMerge(task.id);
    f.project.stopping = false; f.project.scheduleTaskCompletion(task.id);
    await until(() => f.store.branch(task.branch).status === 'archived'); await f.project.hookQueue;
    expect(f.store.all("SELECT title FROM notices WHERE task_id=? AND kind='info'", task.id)).toEqual([{ title: 'explicit reminder' }]);
    const receipt = retiredHook(f.project, task.id, hook.id);
    expect(receipt.notice_id).toBe(f.store.get("SELECT id FROM notices WHERE task_id=? AND title='explicit reminder'", task.id).id);
    expect(f.store.task(task.id)).toMatchObject({ status: 'completed', workspace: null });
    expect(f.store.task(task.id).hooks).toBeNull();
    expect(f.project.taskHooks(task.id).mounts.map(mount => mount.id)).toEqual(['auto-merge', 'auto-accept']);
  } finally { await f.close(); }
});

test('malformed historical completion JSON does not stop unrelated completion scheduling', async () => {
  const f = await setup();
  try {
    const { task } = await f.project.order('corrupt'); f.store.update(task.id, { auto_merge: '{', status: 'waiting' });
    f.project.stopping = false;
    expect(() => f.project.scheduleTaskCompletion()).not.toThrow();
    expect(() => f.project.recoverTaskCompletion()).not.toThrow();
    expect(f.store.task(task.id).auto_merge).toBe('{');
  } finally { await f.close(); }
});
