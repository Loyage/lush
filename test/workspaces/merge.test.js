import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { git } from '../helpers.js';
import { setup, change } from './harness.js';

test('worker branch is isolated, committed results stay pending until explicit merge', async () => {
  const f = await setup();
  try {
    let cwd = await change(f, f.task);
    expect(fs.readFileSync(path.join(f.root,'file.txt'),'utf8')).toBe('base\n');
    expect(f.store.task(f.task.id).integration).toBe('pending');
    expect(cwd).toStartWith(path.join(f.config.home,'worktrees'));
    // Line-oriented output cannot safely delimit these legal path characters.
    const moved = path.join(path.dirname(cwd), 'checkout\t"审查"\n ');
    await git(f.root, 'worktree', 'move', cwd, moved); cwd = moved;
    f.store.update(f.task.id, { workspace: cwd });
    f.store.run('UPDATE inputs SET anchor_workspace=? WHERE id=?', cwd, f.task.input_id);
    f.store.run('UPDATE branches SET worktree=? WHERE branch=?', cwd, f.task.branch);
    expect(await f.project.workspaces.workspaceForBranch(f.task.branch)).toBe(cwd);
    expect(await f.project.workspaces.workspaceForBranch('missing')).toBeNull();
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
