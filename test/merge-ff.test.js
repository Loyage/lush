import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, repo, git } from './helpers.js';

/** 批准合并的策略：能快进就快进（无合并提交），目标分支已前进时才生成合并提交。 */

async function setup() {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  // planner 只写 spec 队列，这里直接造一个能派活的 coordinator。
  const parent = f.store.create({ input_id: null, role: 'coordinator', goal: 'build' });
  const task = f.project.spawn(parent.id, 'implement', 'worker', [], 'implement-feature');
  return { ...f, parent, task };
}
async function change(f, task, content = 'changed\n', filename = 'file.txt') {
  const cwd = await f.project.workspaces.ensure(task);
  fs.writeFileSync(path.join(cwd, filename), content);
  await git(cwd, 'add', filename); await git(cwd, 'commit', '-m', 'implementation');
  await f.project.workspaces.finish(f.store.task(task.id));
  f.store.update(task.id, { status: 'completed' });
  return cwd;
}
function lastApproval(f, taskId) {
  const row = f.store.all("SELECT data FROM events WHERE task_id=? AND type='merge.approved' ORDER BY id DESC LIMIT 1", taskId)[0];
  return JSON.parse(row.data);
}

test('a merge that can fast-forward does not create a merge commit', async () => {
  const f = await setup();
  try {
    await change(f, f.task);
    const head = f.store.task(f.task.id).head_commit;
    expect(await git(f.root, 'rev-parse', 'HEAD')).not.toBe(head);

    await f.project.workspaces.merge(f.task.id);

    expect(f.store.task(f.task.id).integration).toBe('merged');
    // 快进：目标分支顶端就是那次审阅过的提交，且这一段历史里没有合并提交。
    expect(await git(f.root, 'rev-parse', 'HEAD')).toBe(head);
    expect(await git(f.root, 'rev-list', '--merges', '--count', 'HEAD~1..HEAD')).toBe('0');
    expect((await git(f.root, 'rev-list', '--parents', '-n', '1', 'HEAD')).split(' ')).toHaveLength(2);
    expect(fs.readFileSync(path.join(f.root, 'file.txt'), 'utf8')).toBe('changed\n');
    expect(lastApproval(f, f.task.id)).toMatchObject({ commit: head, fast_forward: true });
  } finally { await f.close(); }
});

test('a successful delivery reconciles another pending task whose reviewed commit was carried along', async () => {
  const f = await setup();
  const carrier = f.project.spawn(f.task.parent_id, 'carrier', 'worker', [], 'carrier');
  try {
    await change(f, f.task, 'A\n', 'a.txt');
    const upstreamHead = f.store.task(f.task.id).head_commit;
    const cwd = await f.project.workspaces.ensure(carrier);
    await git(cwd, 'merge', '--ff-only', upstreamHead);
    fs.writeFileSync(path.join(cwd, 'b.txt'), 'B\n');
    await git(cwd, 'add', 'b.txt'); await git(cwd, 'commit', '-m', 'carrier change');
    await f.project.workspaces.finish(f.store.task(carrier.id));
    f.store.update(carrier.id, { status: 'completed' });

    const landed = await f.project.approveMerge(carrier.id);
    expect(landed.merge.included_task_ids).toEqual([f.task.id]);
    expect(f.store.task(f.task.id).integration).toBe('merged');
    expect(f.store.all("SELECT id FROM events WHERE task_id=? AND type='merge.included'", f.task.id)).toHaveLength(1);
  } finally { await f.close(); }
});

test('a merge whose target branch has moved on creates the merge commit instead', async () => {
  const f = await setup();
  try {
    await change(f, f.task);
    const head = f.store.task(f.task.id).head_commit;
    // 目标分支在 worker 完成后前进：快进不了，只能生成合并提交。
    fs.writeFileSync(path.join(f.root, 'main.txt'), 'main\n');
    await git(f.root, 'add', 'main.txt'); await git(f.root, 'commit', '-m', 'main moves on');
    const mainHead = await git(f.root, 'rev-parse', 'HEAD');

    await f.project.workspaces.merge(f.task.id);

    expect(f.store.task(f.task.id).integration).toBe('merged');
    const parents = (await git(f.root, 'rev-list', '--parents', '-n', '1', 'HEAD')).split(' ');
    expect(parents).toHaveLength(3); // 合并提交：两个父
    expect(parents[1]).toBe(mainHead);
    expect(parents[2]).toBe(head);
    expect(fs.readFileSync(path.join(f.root, 'main.txt'), 'utf8')).toBe('main\n');
    expect(fs.readFileSync(path.join(f.root, 'file.txt'), 'utf8')).toBe('changed\n');
    expect(lastApproval(f, f.task.id)).toMatchObject({ commit: head, fast_forward: false });
  } finally { await f.close(); }
});

test('a diverged but clean merge is a merge commit, not a conflict', async () => {
  const f = await setup();
  const other = f.project.spawn(f.task.parent_id, 'other', 'worker', [], 'other-file');
  try {
    await change(f, f.task, 'A\n', 'a.txt');
    await change(f, other, 'B\n', 'b.txt');
    // 先快进落地一个，目标分支前进；第二个分支只改别的文件，仍能干净合并但快进不了。
    await f.project.workspaces.merge(f.task.id);
    expect(await git(f.root, 'rev-parse', 'HEAD')).toBe(f.store.task(f.task.id).head_commit);
    const result = await f.project.workspaces.merge(other.id);
    expect(result.conflict).toBeNull();
    expect(f.store.task(other.id).integration).toBe('merged');
    expect((await git(f.root, 'rev-list', '--parents', '-n', '1', 'HEAD')).split(' ')).toHaveLength(3);
    expect(fs.readFileSync(path.join(f.root, 'a.txt'), 'utf8')).toBe('A\n');
    expect(fs.readFileSync(path.join(f.root, 'b.txt'), 'utf8')).toBe('B\n');
    expect(lastApproval(f, other.id).fast_forward).toBe(false);
  } finally { await f.close(); }
});
