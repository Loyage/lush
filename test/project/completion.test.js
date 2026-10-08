import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, repo, git, until, gate } from '../helpers.js';
import { Project } from '../../src/core/project.js';
import { normalizeHook } from '../../src/core/hooks.js';

const config = (f, task) => JSON.parse(f.store.task(task.id).auto_merge);
const notices = (f, task) => f.store.all("SELECT * FROM notices WHERE task_id=? AND kind='info' ORDER BY id", task.id);
const configure = (f, task, level) => f.project.setTaskCompletion(task.id, level, f.project.taskHooks(task.id).revision);
async function commit(task, name = 'work') {
  fs.writeFileSync(path.join(task.workspace, `${name}.txt`), name);
  await git(task.workspace, 'add', '.'); await git(task.workspace, 'commit', '-m', name);
}
async function setup(provider = { resolve() { return { agent: 'mock' }; }, async run({ task }) { await commit(task); return 'done'; } }) {
  const f = fixture(provider); f.project.stopping = true; await repo(f.root); return f;
}
function start(f) { f.project.stopping = false; f.project.kick(); }
async function delivered(f, task) {
  await until(() => f.store.task(task.id).status === 'awaiting_acceptance' && !f.project.running.has(task.id)
    && !f.project.taskMergeBusy?.size, 10000);
}

for (const level of ['off', 'merge', 'accept', 'archive']) test(`completion ${level} follows only its configured stages and reminder policy`, async () => {
  const f = await setup();
  try {
    const { task } = await f.project.order(`level ${level}`);
    await configure(f, task, level); start(f);
    if (level === 'off') await until(() => f.store.task(task.id).status === 'waiting' && !f.project.running.has(task.id));
    else if (level === 'merge') await until(() => notices(f, task).some(row => row.title.includes('待验收')), 10000);
    else if (level === 'accept') await until(() => notices(f, task).some(row => row.title.includes('待归档')), 10000);
    else await until(() => f.store.branch(task.branch).status === 'archived' && config(f, task).completion.executions.archive.status === 'succeeded', 10000);
    expect(f.store.task(task.id).status).toBe(level === 'off' ? 'waiting' : level === 'merge' ? 'awaiting_acceptance' : 'completed');
    expect(f.store.task(task.id).integration).toBe(level === 'off' ? 'pending' : 'merged');
    const rows = notices(f, task);
    expect(rows).toHaveLength(level === 'archive' ? 0 : 1);
    if (level === 'off') expect(rows[0].title).toContain('本轮已结束');
    else if (level !== 'archive') expect(rows[0].title).toContain(level === 'merge' ? '待验收' : '待归档');
    const events = f.store.history(task.id);
    expect(events.some(row => row.type === 'invocation.target_branch_moved')).toBe(false);
    const merge = events.find(row => row.type === 'task.merge_integrated');
    const acceptance = events.find(row => row.type === 'task.accepted');
    const archive = events.find(row => row.type === 'branch.archive');
    if (level !== 'off') expect(merge).toBeDefined();
    if (['accept', 'archive'].includes(level)) {
      expect(acceptance.id).toBeGreaterThan(merge.id);
      expect(acceptance.data).toMatchObject({ accepted_by: 'user', via: 'completion_hook' });
    } else expect(acceptance).toBeUndefined();
    if (level === 'archive') {
      expect(archive.id).toBeGreaterThan(acceptance.id);
      expect(f.store.task(task.id).workspace).toBeNull();
      expect(fs.existsSync(task.workspace)).toBe(false);
      expect(await git(f.root, 'show', 'main:work.txt')).toBe('work');
    } else expect(fs.existsSync(task.workspace)).toBe(true);
    const count = f.store.history(task.id).length;
    f.project.scheduleTaskCompletion(task.id); await f.project.completionQueue;
    f.project.inspect(task.id); f.project.taskHooks(task.id);
    expect(f.store.history(task.id)).toHaveLength(count);
    expect(f.project.inspect(task.id).completion).toEqual(f.project.taskHooks(task.id).completion);
    expect((await f.project.taskGraph()).nodes.find(row => row.id === task.id).completion).toEqual(f.project.inspect(task.id).completion);
  } finally { await f.close(); }
});

test('archive authorization cannot turn an out-of-worktree target commit into successful delivery', async () => {
  const f = await setup({ resolve() { return { agent: 'mock' }; }, async run({ api }) {
    fs.writeFileSync(path.join(api.config.project, 'rogue.txt'), 'preserve unauthorized commit');
    await git(api.config.project, 'add', 'rogue.txt');
    await git(api.config.project, 'commit', '-m', 'rogue direct target commit');
    return 'must not be accepted';
  } });
  try {
    const { task } = await f.project.order('guard automatic archive');
    await configure(f, task, 'archive'); start(f);
    await until(() => f.store.task(task.id).status === 'failed' && !f.project.running.has(task.id), 10000);
    await f.project.completionQueue;
    const events = f.store.history(task.id);
    expect(events.find(row => row.type === 'invocation.target_branch_moved').data.branch).toBe('main');
    expect(events.filter(row => ['task.merge_integrated', 'task.accepted', 'branch.archive'].includes(row.type))).toHaveLength(0);
    expect(f.store.branch(task.branch).status).toBe('active');
    expect(fs.existsSync(task.workspace)).toBe(true);
    expect(await git(f.root, 'show', 'main:rogue.txt')).toBe('preserve unauthorized commit');
    expect(notices(f, task).some(row => row.title.includes('异常停止') && row.body.includes('目标分支 main'))).toBe(true);
  } finally { await f.close(); }
}, 15000);

test('no-code order explicitly delivers before accepting and archiving, without empty Squash', async () => {
  const f = await setup({ resolve() { return { agent: 'mock' }; }, async run() { return 'answer only'; } });
  try {
    const { task } = await f.project.order('no changes'); await configure(f, task, 'archive'); start(f);
    await until(() => f.store.branch(task.branch).status === 'archived', 10000);
    expect(f.store.task(task.id)).toMatchObject({ status: 'completed', integration: 'none' });
    expect(await git(f.root, 'rev-list', '--count', 'main')).toBe('1');
    const events = f.store.history(task.id);
    expect(events.filter(row => row.type === 'task.merge_integrated')).toHaveLength(0);
    expect(events.find(row => row.type === 'task.delivered').data.no_changes).toBe(true);
    expect(events.find(row => row.type === 'task.accepted').id).toBeGreaterThan(events.find(row => row.type === 'task.delivered').id);
    expect(f.project.taskHooks(task.id).mounts.slice(0, 3).map(row => [row.id, row.state])).toEqual([
      ['auto-merge', 'succeeded'], ['auto-accept', 'succeeded'], ['auto-archive', 'succeeded'],
    ]);
    expect(notices(f, task)).toHaveLength(0);
  } finally { await f.close(); }
});

test('post-delivery upgrades continue the tail without remerging or accepting twice', async () => {
  const f = await setup();
  try {
    const { task } = await f.project.order('upgrade'); await configure(f, task, 'merge'); start(f);
    await delivered(f, task); await until(() => notices(f, task).length === 1);
    await configure(f, task, 'accept'); await until(() => f.store.task(task.id).status === 'completed');
    await until(() => notices(f, task).some(row => row.title.includes('待归档')));
    await configure(f, task, 'archive'); await until(() => f.store.branch(task.branch).status === 'archived');
    expect(f.store.history(task.id).filter(row => row.type === 'task.merge_integrated')).toHaveLength(1);
    expect(f.store.history(task.id).filter(row => row.type === 'task.accepted')).toHaveLength(1);
    expect(notices(f, task)).toHaveLength(2); // previous reminders remain history
    await expect(configure(f, task, 'off')).rejects.toThrow('归档');
  } finally { await f.close(); }
});

test('revision, lock and legacy boolean routes cannot conflict with the highest level; children do not inherit', async () => {
  const f = await setup();
  try {
    const { task } = await f.project.order('parent');
    const stale = f.project.taskHooks(task.id).revision;
    await configure(f, task, 'archive');
    await expect(f.project.setTaskCompletion(task.id, 'accept', stale)).rejects.toThrow('revision');
    for (const value of [true, 'all', null]) await expect(configure(f, task, value)).rejects.toThrow('level');
    await f.project.setTaskAutoMerge(task.id, true); expect(config(f, task).level).toBe('archive');
    await f.project.setTaskAutoMerge(task.id, false); expect(f.project.autoCompletionView(f.store.task(task.id)).level).toBe('off');
    await f.project.setTaskAutoMerge(task.id, true); expect(f.project.autoCompletionView(f.store.task(task.id)).level).toBe('merge');
    await configure(f, task, 'archive');
    const child = await f.project.spawn(task.id, 'default child');
    expect(config(f, child)).toEqual({ version: 1, enabled: true, locked: true });
    expect(f.project.autoCompletionView(f.store.task(child.id))).toMatchObject({ level: 'merge', min_level: 'merge', locked: true, editable: false });
    const original = f.store.task(child.id), history = f.store.history(child.id);
    for (const level of ['off', 'merge', 'accept', 'archive']) await expect(configure(f, child, level)).rejects.toThrow('锁定');
    for (const enabled of [true, false]) {
      await expect(f.project.setTaskAutoMerge(child.id, enabled)).rejects.toThrow('锁定');
      await expect(f.project.updateTaskHook(child.id, 'auto-merge', enabled, f.project.taskHooks(child.id).revision)).rejects.toThrow('锁定');
    }
    const mounted = f.project.taskHooks(child.id);
    expect(mounted.mounts.slice(0, 3).every(row => row.locked && !row.editable && !row.removable)).toBe(true);
    expect(mounted.mounts.find(row => row.id === 'auto-accept').enabled).toBe(false);
    expect(f.store.task(child.id).auto_merge).toBe(original.auto_merge);
    expect(f.store.task(child.id).reservation).toBe(original.reservation);
    expect(f.store.history(child.id)).toEqual(history);
    for (const phase of ['accept', 'archive']) expect(() => normalizeHook({ name: 'bypass', trigger: phase === 'accept' ? 'delivery.integrated' : 'worker.accepted', mode: 'persistent', enabled: true, actions: [{ type: `${phase}_worker` }] })).toThrow('built-in');
    f.store.update(task.id, { reservation: JSON.stringify({ version: 1, kind: 'merge', status: 'pending' }) });
    expect(f.project.autoCompletionView(f.store.task(task.id))).toBeNull();
  } finally { await f.close(); }
}, 15000);

test('child identity locks historical flow settings without rewriting saved authorizations', async () => {
  const f = await setup();
  try {
    const { task } = await f.project.order('parent');
    const child = await f.project.spawn(task.id, 'historical child');
    for (const saved of [null, { version: 1, enabled: false, locked: false }, { version: 1, enabled: true, locked: false, level: 'archive' }]) {
      f.store.update(child.id, { auto_merge: saved ? JSON.stringify(saved) : null });
      const original = f.store.task(child.id).auto_merge;
      for (const status of ['waiting', 'awaiting_acceptance', 'completed']) {
        f.store.update(child.id, { status });
        expect(f.project.autoCompletionView(f.store.task(child.id))).toMatchObject({ locked: true, editable: false });
        expect(f.project.autoMergeView(f.store.task(child.id))).toMatchObject({ locked: true, editable: false });
        for (const level of ['off', 'merge', 'accept', 'archive']) await expect(configure(f, child, level)).rejects.toThrow('锁定');
        for (const enabled of [true, false]) await expect(f.project.setTaskAutoMerge(child.id, enabled)).rejects.toThrow('锁定');
        expect(f.store.task(child.id).auto_merge).toBe(original);
      }
    }
  } finally { await f.close(); }
});

for (const obstacle of ['message', 'decision', 'child', 'dirty', 'freeze']) test(`automatic acceptance preserves ${obstacle} and stops once with a safe diagnostic`, async () => {
  const f = await setup();
  try {
    const { task } = await f.project.order(obstacle); await configure(f, task, 'merge'); start(f); await delivered(f, task);
    f.project.stopping = true; await f.project.completionQueue;
    if (obstacle === 'message') f.store.message(task.id, 'must not lose');
    if (obstacle === 'decision') f.project.notice(task.id, 'must answer');
    if (obstacle === 'child') {
      const child = f.store.create({ parent_id: task.id, role: 'agent', task_kind: 'child', goal: 'unfinished' });
      f.store.update(child.id, { status: 'waiting' });
    }
    if (obstacle === 'dirty') fs.writeFileSync(path.join(task.workspace, 'private.txt'), 'SECRET_MUST_NOT_APPEAR');
    // Mount while safe; then install the freeze, because configuring through a frozen branch is rejected.
    await configure(f, task, 'accept');
    if (obstacle === 'freeze') {
      const child = f.store.create({ parent_id: task.id, role: 'agent', task_kind: 'child', goal: 'fixed legacy delivery' });
      f.store.update(child.id, { status: 'completed', target_branch: task.branch,
        reservation: JSON.stringify({ version: 1, kind: 'merge', status: 'requested' }) });
    }
    start(f); await until(() => config(f, task).completion.executions.accept?.status === 'failed');
    expect(f.store.task(task.id).status).toBe('awaiting_acceptance');
    expect(fs.existsSync(task.workspace)).toBe(true);
    expect(f.store.history(task.id).some(row => row.type === 'task.accepted')).toBe(false);
    expect(JSON.stringify(f.project.taskHooks(task.id))).not.toContain('SECRET_MUST_NOT_APPEAR');
    const diagnostics = notices(f, task).filter(row => row.title.includes('受阻')); expect(diagnostics).toHaveLength(1);
    f.project.scheduleTaskCompletion(task.id); await f.project.completionQueue;
    expect(notices(f, task).filter(row => row.title.includes('受阻'))).toHaveLength(1);
    if (obstacle === 'message') expect(f.store.get('SELECT body FROM messages WHERE task_id=? AND consumed=0', task.id).body).toBe('must not lose');
  } finally { await f.close(); }
});

test('new input during acceptance Git checks supersedes the old claim, without discarding input or accepting new work', async () => {
  const f = await setup(), paused = gate(), entered = gate();
  try {
    const { task } = await f.project.order('late input'); await configure(f, task, 'merge'); start(f); await delivered(f, task);
    f.project.stopping = true; await f.project.completionQueue; await configure(f, task, 'accept');
    const finish = f.project.workspaces.finish.bind(f.project.workspaces);
    f.project.workspaces.finish = async value => { entered.resolve(); await paused.promise; return finish(value); };
    f.project.stopping = false; f.project.scheduleTaskCompletion(task.id); await entered.promise;
    f.project.stopping = true; // prevent a test provider from consuming the new input while we inspect the race
    f.project.message(task.id, 'new work'); paused.resolve(); await f.project.completionQueue;
    expect(f.store.task(task.id).status).toBe('queued');
    expect(f.store.history(task.id).filter(row => row.type === 'task.accepted')).toHaveLength(0);
    expect(f.store.history(task.id).filter(row => row.type === 'completion.execution_superseded')).toHaveLength(1);
    expect(f.store.get('SELECT body FROM messages WHERE task_id=? AND consumed=0', task.id).body).toBe('new work');
    expect(notices(f, task).filter(row => row.title.includes('受阻'))).toHaveLength(0);
  } finally { paused.resolve(); await f.close(); }
});

test('dirty automatic archive retains accepted workspace and does not replay after restart', async () => {
  const f = await setup();
  try {
    const { task } = await f.project.order('keep dirty archive'); await configure(f, task, 'accept'); start(f);
    await until(() => f.store.task(task.id).status === 'completed'); await f.project.completionQueue;
    fs.writeFileSync(path.join(task.workspace, 'keep.txt'), 'user changes');
    await configure(f, task, 'archive'); await until(() => config(f, task).completion.executions.archive?.status === 'failed');
    expect(f.store.branch(task.branch).status).toBe('active'); expect(fs.readFileSync(path.join(task.workspace, 'keep.txt'), 'utf8')).toBe('user changes');
    const count = f.store.history(task.id).filter(row => row.type === 'completion.execution_started').length;
    f.project.stopping = true; await f.project.shutdown();
    const restarted = new Project(f.config, f.store); restarted.stopping = true;
    restarted.recoverTaskCompletion(); restarted.stopping = false; restarted.scheduleTaskCompletion(); await restarted.completionQueue;
    expect(f.store.history(task.id).filter(row => row.type === 'completion.execution_started')).toHaveLength(count);
    await restarted.shutdown();
  } finally { await f.close(); }
});
