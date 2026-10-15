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

for (const level of ['merge', 'accept']) test(`completion ${level} follows only its configured stages and reminder policy`, async () => {
  const f = await setup();
  try {
    const { task } = await f.project.order(`level ${level}`);
    await configure(f, task, level); start(f);
    if (level === 'off') await until(() => f.store.task(task.id).status === 'waiting' && !f.project.running.has(task.id));
    else if (level === 'merge') await until(() => notices(f, task).some(row => row.title.includes('待验收')), 10000);
    else await until(() => f.store.branch(task.branch).status === 'archived' && config(f, task).completion.executions.accept.status === 'succeeded', 10000);
    expect(f.store.task(task.id).status).toBe(level === 'off' ? 'waiting' : level === 'merge' ? 'awaiting_acceptance' : 'completed');
    expect(f.store.task(task.id).integration).toBe(level === 'off' ? 'pending' : 'merged');
    const rows = notices(f, task);
    expect(rows).toHaveLength(level === 'merge' ? 1 : 0);
    if (level === 'merge') expect(rows[0].title).toContain('待验收');
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
    if (['accept', 'archive'].includes(level)) {
      expect(acceptance.id).toBeGreaterThan(archive.id);
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
      ['auto-merge', 'succeeded'], ['auto-accept', 'succeeded'],
    ]);
    expect(notices(f, task)).toHaveLength(0);
  } finally { await f.close(); }
});
