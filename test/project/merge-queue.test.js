import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, repo, git, until } from '../helpers.js';

test('child auto-delivery, explicit parent Squash and batch acceptance preserve code and reclaim worktrees', async () => {
  const f = fixture({ resolve() { return { agent: 'mock' }; }, async run({ task, cwd }) {
    if (task.task_kind === 'child') {
      fs.writeFileSync(path.join(cwd, 'feature.txt'), 'delivered code\n');
      await git(cwd, 'add', 'feature.txt'); await git(cwd, 'commit', '-m', 'child feature');
    }
    return 'reviewed result';
  } });
  f.project.stopping = true; await repo(f.root);
  try {
    const parent = (await f.project.order('collect feature')).task;
    f.store.update(parent.id, { status: 'waiting' });
    const child = await f.project.spawn(parent.id, 'implement feature');
    const baseline = await git(f.root, 'rev-parse', 'main');
    f.project.stopping = false; f.project.kick();
    await until(() => f.store.task(child.id).integration === 'merged' &&
      f.store.task(parent.id).calls === 1 && f.store.task(parent.id).status === 'waiting' && !f.project.running.size, 12000);
    expect(await git(parent.workspace, 'show', 'HEAD:feature.txt')).toBe('delivered code');
    expect(await git(f.root, 'rev-parse', 'main')).toBe(baseline);
    expect(fs.existsSync(child.workspace)).toBe(true);
    await f.project.reserveTask(parent.id, 'merge');
    await until(() => f.store.task(parent.id).integration === 'merged', 12000);
    expect(await git(f.root, 'show', 'main:feature.txt')).toBe('delivered code');
    expect(await git(f.root, 'rev-list', '--count', `${baseline}..main`)).toBe('1');
    expect(f.store.task(parent.id).status).toBe('awaiting_acceptance');
    await f.project.acceptTask(parent.id);
    for (const row of [parent, child]) {
      expect(f.store.task(row.id)).toMatchObject({ status: 'completed', integration: 'merged', workspace: null, result: 'reviewed result' });
      expect(fs.existsSync(row.workspace)).toBe(false);
      expect(f.store.branch(row.branch).status).toBe('archived');
    }
  } finally { await f.close(); }
});
