import { test, expect, setDefaultTimeout } from 'bun:test';
setDefaultTimeout(15000);
import fs from 'node:fs';
import path from 'node:path';
import { Database } from 'bun:sqlite';
import { Store } from '../../src/persistence/store.js';
import iteration from '../../src/core/project/iteration.js';
import { TERMINAL, isSettled } from '../../src/core/types.js';
import { tokenHash } from '../../src/core/project/internal.js';
import { fixture, repo, git, until } from '../helpers.js';

function setup(provider) {
  const f = fixture(provider);
  Object.assign(f.project, iteration); // Production registration is owned by the parent Task.
  f.project.stopping = true;
  return f;
}
async function commit(dir, file, body) {
  fs.writeFileSync(path.join(dir, file), body);
  await git(dir, 'add', file); await git(dir, 'commit', '-m', file);
  return git(dir, 'rev-parse', 'HEAD');
}
async function deliver(f, source) {
  await f.project.reserveTask(source.id, 'merge');
  f.project.stopping = false;
  const kick = f.project.kick; f.project.kick = () => {};
  try { await f.project.driveTaskMerge(source.parent_id); }
  finally { f.project.kick = kick; f.project.stopping = true; }
  return f.store.task(source.id);
}
async function sourceTask(f, name = 'source') {
  const { task } = await f.project.order(name);
  await commit(task.workspace, `${name}.txt`, 'first\n');
  f.store.update(task.id, { status: 'waiting', result: 'first delivery' });
  return task;
}

test('multi-round Squash retains parent advances, Task identity, conversation and immutable receipts', async () => {
  const f = setup({ resolve() { return { agent: 'mock' }; }, async run({ cwd, messages }) {
    const repair = messages.find(message => message.body.includes('合并分歧'));
    if (repair) await git(cwd, 'merge', '--no-edit', repair.body.match(/[0-9a-f]{40}/)[0]);
    else await commit(cwd, 'second.txt', 'second iteration\n');
    return repair ? 'repaired and tested' : 'second delivery';
  } });
  await repo(f.root);
  try {
    const source = await sourceTask(f);
    const first = await deliver(f, source);
    expect(first).toMatchObject({ id: source.id, status: 'awaiting_acceptance', integration: 'merged', base_commit: source.base_commit });
    expect(TERMINAL.has(first.status)).toBe(false); expect(isSettled(first)).toBe(true);
    const receipt = JSON.parse(first.reservation);
    const repeated = await f.project.reserveTask(source.id, 'merge');
    expect(repeated.changed).toBe(false);
    expect(JSON.parse(f.store.task(source.id).reservation)).toEqual(receipt);
    await commit(f.root, 'parent.txt', 'new parent work must survive\n');
    f.project.stopping = false;
    f.project.message(source.id, 'please add the second iteration');
    expect(f.store.task(source.id).reservation).toBeNull();
    await until(() => f.store.task(source.id).status === 'waiting' && !f.project.running.has(source.id));
    expect(f.store.task(source.id).integration).toBe('pending');
    await f.project.reserveTask(source.id, 'merge');
    await until(() => f.store.task(source.id).status === 'awaiting_acceptance' && f.store.history(source.id).filter(event => event.type === 'task.merge_integrated').length === 2, 8000);
    const final = f.store.task(source.id);
    expect(final).toMatchObject({ id: source.id, parent_id: source.parent_id, branch: source.branch,
      workspace: source.workspace, base_commit: source.base_commit, calls: 2 });
    for (const file of ['source.txt', 'second.txt', 'parent.txt']) expect(await git(f.root, 'show', `main:${file}`)).toBeTruthy();
    expect(await git(f.root, 'rev-list', '--count', `${source.base_commit}..main`)).toBe('3');
    const receipts = f.store.history(source.id).filter(event => event.type === 'task.merge_integrated');
    expect(receipts[0].data).toMatchObject({ source_commit: receipt.commit, commit: receipt.landed_commit, parent_id: source.parent_id });
    expect(receipts[1].data.source_commit).toBe(final.head_commit);
    expect(final.iteration_base_commit).toBe(final.head_commit);
    await until(() => !f.project.running.has(source.id));
    const accepted = await f.project.acceptTask(source.id);
    expect(accepted.status).toBe('completed'); expect(fs.existsSync(source.workspace)).toBe(false);
    expect(() => f.project.message(source.id, 'not without reopening')).toThrow('ended');
    await f.project.workspaces.cleanup(source.id);
    await expect(f.project.reopenTask(source.id)).rejects.toThrow('accepted Workers');
  } finally { await f.close(); }
});
