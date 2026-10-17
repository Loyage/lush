import { test, expect } from 'bun:test';
import { fixture, repo, git } from '../helpers.js';

test('order creates one Input and an independent Worker at the parent tip', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const sent = await f.project.order('develop a page');
    const parent = f.store.task(sent.task.parent_id);
    expect(parent).toMatchObject({ task_kind: 'main', branch: 'main', calls: 0 });
    expect(sent.task).toMatchObject({ task_kind: 'order', input_id: sent.id, target_branch: 'main' });
    expect(f.store.get('SELECT task_id FROM inputs WHERE id=?', sent.id).task_id).toBe(sent.task.id);
    expect(f.store.branch(sent.task.branch).task_id).toBe(sent.task.id);
    expect(await git(sent.task.workspace, 'symbolic-ref', '--short', 'HEAD')).toBe(sent.task.branch);
    expect(await git(sent.task.workspace, 'rev-parse', 'HEAD')).toBe(await git(f.root, 'rev-parse', 'main'));
    expect(await f.project.workspaces.ensure(sent.task)).toBe(sent.task.workspace);
  } finally { await f.close(); }
});
