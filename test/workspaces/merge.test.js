import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { git } from '../helpers.js';
import { setup, change } from './harness.js';

test('worker branch is isolated, committed results stay pending until explicit merge', async () => {
  const f = await setup();
  try {
    const cwd = await change(f, f.task);
    expect(fs.readFileSync(path.join(f.root,'file.txt'),'utf8')).toBe('base\n');
    expect(f.store.task(f.task.id).integration).toBe('pending');
    expect(cwd).toStartWith(path.join(f.config.home,'worktrees'));
    await f.project.workspaces.merge(f.task.id);
    expect(fs.readFileSync(path.join(f.root,'file.txt'),'utf8')).toBe('changed\n');
    expect(f.store.task(f.task.id).integration).toBe('merged');
    const branch = f.store.task(f.task.id).branch;
    const result = await f.project.workspaces.cleanup(f.task.id);
    expect(fs.existsSync(cwd)).toBe(false);
    expect(f.store.task(f.task.id).workspace).toBeNull();
    expect(result.cleanup).toEqual({ id: f.task.id, worktree: 'removed', branch: 'removed', reason: null });
    expect(f.store.task(f.task.id).branch).toBeNull();
    expect(await git(f.root,'branch','--list',branch)).toBe('');
    expect(await git(f.root,'rev-parse',f.store.task(f.task.id).head_commit)).toBeTruthy();
  } finally { await f.close(); }
});
