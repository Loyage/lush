import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, git, repo } from '../helpers.js';

async function setup() {
  const f = fixture(); await repo(f.root);
  const base = await git(f.root, 'rev-parse', 'HEAD');
  const workspace = path.join(f.config.home, 'worktrees', 'reader');
  await git(f.root, 'worktree', 'add', '-b', 'reader', workspace);
  const task = { id: 7, workspace, branch: 'reader', base_commit: base, head_commit: base };
  return { ...f, workspace, task,
    write(name, text) { fs.mkdirSync(path.dirname(path.join(workspace, name)), { recursive: true }); fs.writeFileSync(path.join(workspace, name), text); },
    state(opts) { return f.project.workspaces.codeState(task, opts); },
    tree(opts) { return f.project.workspaces.codeTree(task, opts); },
    file(name, opts) { return f.project.workspaces.codeFile(task, { path: name, ...opts }); },
    async commit() { await git(workspace, 'add', '.'); await git(workspace, 'commit', '-m', 'changes'); return git(workspace, 'rev-parse', 'HEAD'); },
  };
}

test('code reader includes unchanged files, computes task/iteration/working baselines and reads actual HEAD', async () => {
  const f = await setup();
  try {
    const clean = await f.state(); expect(clean.availability).toBe('available'); expect(clean.summary).toMatchObject({ changed_total: 0, pending_total: 0, files_total: 2 });
    expect((await f.tree()).entries.map(row => row.path)).toContain('file.txt');
    expect((await f.file('file.txt', { view: 'content' })).content.text).toBe('base\n');
    f.write('file.txt', 'first\n'); const head = await f.commit(); f.task.iteration_base_commit = head;
    f.write('file.txt', 'second\n');
    const task = await f.state(); expect(task.head_commit).toBe(head); expect(task.base_commit).toBe(f.task.base_commit);
    expect(task.files[0]).toMatchObject({ path: 'file.txt', status: 'M', unstaged: true, added: 1, deleted: 1 });
    expect((await f.state({ scope: 'iteration' })).base_commit).toBe(head);
    expect((await f.state({ scope: 'working' })).base_commit).toBe(head);
    const diff = await f.file('file.txt');
    expect(diff.availability).toBe('available');
    expect(diff.diff.hunks[0].lines).toContainEqual({ kind: 'delete', text: 'base', old_line: 1, new_line: null });
    expect(diff.diff.hunks[0].lines).toContainEqual({ kind: 'add', text: 'second', old_line: null, new_line: 1 });
    expect((await f.file('file.txt', { scope: 'working', view: 'content', side: 'old' })).content.text).toBe('first\n');
  } finally { await f.close(); }
});

test('ancestor symlinks, traversal and unregistered worktrees cannot read outside task scope', async () => {
  const f = await setup();
  try {
    f.write('dir/file.txt', 'safe\n'); await f.commit();
    const external = path.join(f.config.home, 'outside'); fs.mkdirSync(external); fs.writeFileSync(path.join(external, 'file.txt'), 'SECRET');
    fs.rmSync(path.join(f.workspace, 'dir'), { recursive: true }); fs.symlinkSync(external, path.join(f.workspace, 'dir'));
    const value = await f.file('dir/file.txt', { view: 'content' }); expect(value.content?.text ?? '').not.toContain('SECRET');
    for (const name of ['../file.txt', '/etc/passwd', 'dir/../../file.txt', '.git/config', 'a/.lush/token', 'a\0b']) await expect(f.file(name)).rejects.toThrow('invalid project-relative');
    f.task.workspace = f.root; expect((await f.state()).availability).toBe('unavailable');
    f.task.workspace = external; expect((await f.state()).availability).toBe('stale');
  } finally { await f.close(); }
});
