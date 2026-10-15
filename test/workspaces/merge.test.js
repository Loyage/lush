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
    // 合进目标分支的提交还在历史里，任务自己的 ref 不再是恢复点。
    expect(result.cleanup).toEqual({ id: f.task.id, worktree: 'removed', branch: 'removed', reason: null });
    expect(f.store.task(f.task.id).branch).toBeNull();
    expect(await git(f.root,'branch','--list',branch)).toBe('');
    expect(await git(f.root,'rev-parse',f.store.task(f.task.id).head_commit)).toBeTruthy();
  } finally { await f.close(); }
});

test('父分支前进之后，第二条分支不会被覆盖：分歧交回源 Task，主树一个字节不动', async () => {
  const f = await setup();
  try {
    const other = await f.project.order('other');
    const b = f.store.task(other.task.id);
    await change(f,f.task,'A\n'); await change(f,b,'B\n');
    // 第一条落地，main 前进。
    expect((await f.project.workspaces.merge(f.task.id)).conflict).toBeNull();
    const head = await git(f.root,'rev-parse','HEAD');
    // 新路径只有 ff-only / compare-and-swap：第二条已经分歧，于是原样交回，不写 main、不留 merge 中间态。
    const result = await f.project.workspaces.merge(b.id);
    expect(result.diverged).toBeTruthy();
    expect(result.task.integration).toBe('pending');
    expect(result.task.integration_error).toContain('diverged');
    expect(await git(f.root,'rev-parse','HEAD')).toBe(head);
    expect(await git(f.root,'status','--porcelain')).toBe('');
    // 两个分支都还在：稍后由源 Task 自己吸收父提交，或交给 v2 队列处理。
    expect(fs.readFileSync(path.join(b.workspace,'file.txt'),'utf8')).toBe('B\n');
  } finally { await f.close(); }
});

test('dirty main tree no longer blocks worktrees, but still blocks merge and dirty worker', async () => {
  const f = await setup();
  try {
    // 主树有未提交改动：order 只基于已提交的 HEAD 建 worktree，允许开工；分歧写进事件供审阅。
    fs.writeFileSync(path.join(f.root, 'file.txt'), 'uncommitted\n');
    const fresh = await f.project.order('dirty main work');
    const task = fresh.task;
    const cwd = task.workspace;
    expect(cwd).toBe(path.join(f.config.home, 'worktrees', `input-${fresh.id}`));
    expect(fs.readFileSync(path.join(cwd, 'file.txt'), 'utf8')).toBe('base\n');
    const created = f.store.all("SELECT data FROM events WHERE task_id=? AND type='input.anchor'", task.id)[0];
    expect(JSON.parse(created.data).dirty_source).toMatchObject({ files: 1, sample: [' M file.txt'], more: 0 });

    // worker 必须自己提交：这条门槛与主树无关。
    fs.writeFileSync(path.join(cwd, 'file.txt'), 'dirty');
    await expect(f.project.workspaces.finish(f.store.task(task.id))).rejects.toThrow('dirty');
    await git(cwd, 'add', '.'); await git(cwd, 'commit', '-m', 'first');
    await f.project.workspaces.finish(f.store.task(task.id)); f.store.update(task.id, { status: 'completed' });

    // main 正被项目检出：落地要先 fast-forward 这棵工作树，所以脏树照样挡住合并，报错要点出文件。
    await expect(f.project.workspaces.merge(task.id)).rejects.toThrow('file.txt');
    expect(f.store.task(task.id).integration).toBe('pending');
    expect(fs.readFileSync(path.join(f.root, 'file.txt'), 'utf8')).toBe('uncommitted\n');
    // 用户自己把改动安顿好之后，同一份固定提交就能落地。
    await git(f.root, 'checkout', '--', 'file.txt');
    expect((await f.project.workspaces.merge(task.id)).task.integration).toBe('merged');
    expect(fs.readFileSync(path.join(f.root, 'file.txt'), 'utf8')).toBe('dirty');
  } finally { await f.close(); }
});
