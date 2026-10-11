import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, repo, git } from '../helpers.js';

async function setup() {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  const order = await f.project.order('discard orphan checkout');
  const task = f.store.task(order.task.id); f.project.cancel(task.id);
  await git(f.root, 'worktree', 'remove', task.workspace);
  fs.mkdirSync(task.workspace); await git(task.workspace, 'init');
  fs.writeFileSync(path.join(task.workspace, 'residual.txt'), 'discard');
  return { ...f, task };
}
const forced = f => f.project.deleteTaskPreview(f.task.id, { force: true });
const destroy = (f, preview, force = true) => f.project.deleteTask(f.task.id, { force, confirm: true, revision: preview.revision });

test('explicit force deletes deterministic orphan checkout and history; normal mode stays blocked', async () => {
  const f = await setup();
  try {
    const normal = await f.project.deleteTaskPreview(f.task.id);
    expect(normal.can_delete).toBe(false); expect(normal.force_available).toBe(true);
    expect(normal.blockers.join(' ')).toContain('unknown ownership');
    const preview = await forced(f);
    expect(preview.force).toBe(true); expect(preview.can_delete).toBe(true);
    expect(preview.resources.worktrees).toContain(f.task.workspace);
    expect(preview.warnings.join(' ')).toContain('全部残留代码');
    expect(preview.revision).not.toBe(normal.revision);
    await expect(destroy(f, normal)).rejects.toThrow('changed');
    await expect(destroy(f, preview, false)).rejects.toThrow('unknown ownership');
    const outside = path.join(f.root, 'keep.txt'); fs.writeFileSync(outside, 'keep');
    fs.symlinkSync(outside, path.join(f.task.workspace, 'keep-link'));
    const fresh = await forced(f); await destroy(f, fresh);
    expect(fs.existsSync(f.task.workspace)).toBe(false);
    expect(fs.readFileSync(outside, 'utf8')).toBe('keep');
    expect(f.store.get('SELECT id FROM tasks WHERE id=?', f.task.id)).toBeNull();
    expect(f.store.get('SELECT id FROM inputs WHERE id=?', f.task.input_id)).toBeNull();
  } finally { await f.close(); }
});

test('force preview remains fixed to resource state and failure preserves Worker identity', async () => {
  const f = await setup();
  try {
    const preview = await forced(f);
    fs.writeFileSync(path.join(f.task.workspace, 'new.txt'), 'changed');
    await expect(destroy(f, preview)).rejects.toThrow('changed');
    expect(fs.existsSync(f.task.workspace)).toBe(true);
    const fresh = await forced(f), original = f.project.workspaces.deleteWorkerResourcesUnsafe;
    f.project.workspaces.deleteWorkerResourcesUnsafe = () => { throw new Error('injected failure'); };
    await expect(destroy(f, fresh)).rejects.toThrow('injected failure');
    expect(f.store.task(f.task.id).status).toBe('cancelled');
    f.project.workspaces.deleteWorkerResourcesUnsafe = original;
    await destroy(f, await forced(f));
  } finally { await f.close(); }
});

test('force never bypasses shared paths, external dependencies, active Workers or main', async () => {
  const f = await setup();
  try {
    const other = (await f.project.order('keep worker')).task;
    f.store.update(other.id, { baseline_workspace: f.task.workspace });
    expect((await forced(f)).blockers.join(' ')).toContain('shared');
    expect((await f.project.deleteTaskPreview(f.task.id)).force_available).toBe(false);
    f.store.update(other.id, { baseline_workspace: null });
    f.store.run('INSERT INTO task_deps(task_id,depends_on,kind) VALUES (?,?,?)', other.id, f.task.id, 'order');
    expect((await forced(f)).blockers.join(' ')).toContain('dependent');
    f.store.run('DELETE FROM task_deps WHERE task_id=?', other.id);
    f.store.update(f.task.id, { status: 'running' });
    expect((await forced(f)).blockers.join(' ')).toContain('cancel');
    f.store.update(f.task.id, { status: 'cancelled' });
    expect((await f.project.deleteTaskPreview(f.task.parent_id, { force: true })).blockers.join(' ')).toContain('main/owner');
    expect(fs.existsSync(f.task.workspace)).toBe(true);
  } finally { await f.close(); }
});

test('force never bypasses arbitrary directory ownership, canonical/external paths or root links', async () => {
  const f = await setup();
  try {
    const backup = path.join(f.config.home, 'worktrees', 'unowned-backup'); fs.mkdirSync(backup);
    const external = path.join(f.root, 'external'); fs.mkdirSync(external);
    for (const workspace of [backup, f.root, external]) {
      f.store.update(f.task.id, { workspace });
      const preview = await forced(f); expect(preview.can_delete).toBe(false);
      await expect(destroy(f, preview)).rejects.toThrow();
      expect(fs.existsSync(f.task.workspace)).toBe(true);
    }
    f.store.update(f.task.id, { workspace: f.task.workspace });
    fs.rmSync(f.task.workspace, { recursive: true }); fs.symlinkSync(external, f.task.workspace);
    expect((await forced(f)).blockers.join(' ')).toContain('symlink');
    expect(fs.existsSync(external)).toBe(true);
  } finally { await f.close(); }
});

test('force still refuses locked worktrees, checkout branch changes and invalid flag types', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const order = await f.project.order('keep protections'); const task = f.store.task(order.task.id);
    f.project.cancel(task.id);
    await git(f.root, 'worktree', 'lock', task.workspace);
    expect((await f.project.deleteTaskPreview(task.id, { force: true })).blockers.join(' ')).toContain('locked');
    await git(f.root, 'worktree', 'unlock', task.workspace);
    await git(task.workspace, 'checkout', '-b', 'unexpected-ref');
    expect((await f.project.deleteTaskPreview(task.id, { force: true })).blockers.join(' ')).toContain('another branch');
    await expect(f.project.deleteTaskPreview(task.id, { force: 'true' })).rejects.toThrow('boolean');
    await expect(f.project.deleteTask(task.id, { force: 'true' })).rejects.toThrow('boolean');
  } finally { await f.close(); }
});
