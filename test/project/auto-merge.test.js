import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { Database } from 'bun:sqlite';
import { Store } from '../../src/persistence/store.js';
import { Project } from '../../src/core/project.js';
import { fixture, repo, git, until, gate } from '../helpers.js';

const booking = (f, id) => JSON.parse(f.store.task(id).reservation);
const settings = (f, id) => JSON.parse(f.store.task(id).auto_merge);
async function commit(task, name = 'work') {
  fs.writeFileSync(path.join(task.workspace, `${name}.txt`), `${name}\n`);
  await git(task.workspace, 'add', '.'); await git(task.workspace, 'commit', '-m', name);
}
async function setup(provider) {
  const f = fixture(provider); f.project.stopping = true; await repo(f.root); return f;
}

test('new order hook is off; new delegated child is on and locked through both mutation routes', async () => {
  const f = await setup();
  try {
    const { task } = await f.project.order('parent');
    expect(settings(f, task.id)).toEqual({ version: 1, enabled: false, locked: false, mounted_features: { completion: true, acceptance_notice: true }, acceptance_notice: { enabled: true } });
    expect(f.store.task(task.id).reservation).toBeNull();
    const child = await f.project.spawn(task.id, 'child');
    expect(settings(f, child.id)).toEqual({ version: 1, enabled: true, locked: true, mounted_features: { completion: true, acceptance_notice: true }, acceptance_notice: { enabled: false } });
    expect(booking(f, child.id)).toMatchObject({ version: 2, status: 'pending', auto_merge: true });
    const expected = { enabled: true, locked: true, editable: false };
    expect(f.project.inspect(child.id).auto_merge).toMatchObject(expected);
    expect((await f.project.taskGraph()).nodes.find(row => row.id === child.id).auto_merge).toMatchObject(expected);
    await expect(f.project.setTaskAutoMerge(child.id, false)).rejects.toThrow('不能关闭');
    expect(() => f.project.unreserveTask(child.id)).toThrow('锁定');
    await expect(f.project.setTaskAutoMerge(child.id, true)).rejects.toThrow('锁定');
    expect(f.project.inspect(task.parent_id).auto_merge).toBeNull();
    await expect(f.project.setTaskAutoMerge(task.parent_id, true)).rejects.toThrow('only version 2');
  } finally { await f.close(); }
});

test('persistent order hook automatically delivers multiple rounds and settles no-op follow-up', async () => {
  let rounds = 0;
  const f = await setup({ resolve() { return { agent: 'mock' }; }, async run({ task, messages }) {
    const repair = messages.find(row => row.body.includes('合并分歧'));
    if (repair) await git(task.workspace, 'merge', '--no-edit', repair.body.match(/[0-9a-f]{40}/)[0]);
    else if (++rounds <= 2) await commit(task, `round-${rounds}`);
    return 'done';
  } });
  try {
    const { task } = await f.project.order('persistent');
    await f.project.setTaskAutoMerge(task.id, true);
    f.project.stopping = false; f.project.kick();
    await until(() => f.store.task(task.id).status === 'awaiting_acceptance', 10000);
    expect(settings(f, task.id).enabled).toBe(true);
    f.project.message(task.id, 'second round');
    expect(booking(f, task.id)).toMatchObject({ status: 'pending', auto_merge: true });
    await until(() => f.store.history(task.id).filter(row => row.type === 'task.merge_integrated').length === 2, 10000);
    await until(() => !f.project.running.has(task.id));
    expect(settings(f, task.id)).toMatchObject({ version: 1, enabled: true, locked: false });
    expect(settings(f, task.id).completion.executions.merge.status).toBe('succeeded');
    expect(await git(f.root, 'show', 'main:round-2.txt')).toBe('round-2');
    f.project.message(task.id, 'explain only');
    await until(() => rounds === 3 && f.store.task(task.id).status === 'awaiting_acceptance' && !f.project.running.has(task.id), 10000);
    expect(f.store.task(task.id).reservation).toBeNull();
    expect(settings(f, task.id).enabled).toBe(true);
    expect(f.store.history(task.id).filter(row => row.type === 'task.merge_integrated')).toHaveLength(2);
  } finally { await f.close(); }
}, 30000);
