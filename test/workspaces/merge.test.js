import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, repo, git, until } from '../helpers.js';
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

test('review diff is read-only and reports commits, files and dirty worktrees', async () => {
  const f = await setup();
  try {
    expect(await f.project.workspaces.diff(f.store.task(f.task.id))).toBeNull();
    const cwd = await change(f, f.task);
    const diff = await f.project.workspaces.diff(f.store.task(f.task.id));
    expect(diff.committed).toBe(true);
    expect(diff.files).toEqual([{ path: 'file.txt', added: 1, deleted: 1 }]);
    expect(diff.pending).toEqual([]);
    expect(diff.commits).toHaveLength(1);
    expect(diff.base_behind).toBe(0);
    expect(await git(f.root, 'rev-parse', 'HEAD')).not.toBe(f.store.task(f.task.id).head_commit);
    fs.writeFileSync(path.join(cwd, 'file.txt'), 'uncommitted\n');
    fs.writeFileSync(path.join(cwd, 'untracked.txt'), 'new\n');
    const dirty = await f.project.workspaces.diff(f.store.task(f.task.id));
    expect(dirty.pending).toEqual([
      { path: 'file.txt', code: 'M', added: 1, deleted: 1 },
      { path: 'untracked.txt', code: '??', added: null, deleted: null },
    ]);
    expect(dirty.files).toEqual([{ path: 'file.txt', added: 1, deleted: 1 }]);
    expect(f.store.task(f.task.id).integration).toBe('pending');
    // 主树可以在 worker 干活期间继续前进：审阅要能看出 base 已经落后。
    fs.writeFileSync(path.join(f.root, 'main.txt'), 'main\n');
    await git(f.root, 'add', '.'); await git(f.root, 'commit', '-m', 'main moves on');
    expect((await f.project.workspaces.diff(f.store.task(f.task.id))).base_behind).toBe(1);
  } finally { await f.close(); }
});

test('independent workers get different worktrees and merge serially', async () => {
  const f = await setup();
  try {
    const b = f.project.spawn(f.task.parent_id,'other','worker');
    await Promise.all([change(f,f.task,'A','a.txt'), change(f,b,'B','b.txt')]);
    expect(f.store.task(b.id).workspace).not.toBe(f.store.task(f.task.id).workspace);
    await Promise.all([f.project.workspaces.merge(f.task.id), f.project.workspaces.merge(b.id)]);
    expect(fs.readFileSync(path.join(f.root,'a.txt'),'utf8')).toBe('A');
    expect(fs.readFileSync(path.join(f.root,'b.txt'),'utf8')).toBe('B');
  } finally { await f.close(); }
});

test('merge conflicts come back as a structured result and leave the main tree untouched', async () => {
  const f = await setup();
  try {
    const b = f.project.spawn(f.task.parent_id,'other','worker');
    await change(f,f.task,'A\n'); await change(f,b,'B\n');
    // 干净合并：conflict 为空。
    expect((await f.project.workspaces.merge(f.task.id)).conflict).toBeNull();
    const head = await git(f.root,'rev-parse','HEAD');
    // 内容冲突不是异常：它带着冲突文件列表回来，main 已 abort 回合并前的干净状态。
    const result = await f.project.workspaces.merge(b.id);
    expect(result.conflict.files).toEqual(['file.txt']);
    expect(result.conflict.output).toContain('CONFLICT');
    expect(result.task.integration).toBe('pending');
    expect(await git(f.root,'rev-parse','HEAD')).toBe(head);
    expect(await git(f.root,'status','--porcelain')).toBe('');
    expect(f.store.task(b.id).integration_error).toBeTruthy();
    // 两边分支都留着：稍后还能重试，或者交给解冲突任务。
    expect(fs.readFileSync(path.join(f.store.task(b.id).workspace,'file.txt'),'utf8')).toBe('B\n');
    expect((await f.project.workspaces.merge(b.id)).conflict.files).toEqual(['file.txt']);
    expect(await git(f.root,'status','--porcelain')).toBe('');
  } finally { await f.close(); }
});

test('dirty main tree no longer blocks worktrees, but still blocks merge and dirty worker', async () => {
  const f = await setup();
  try {
    // 主树有未提交改动：worker 只基于已提交的 HEAD，所以允许开工；分歧写进事件供审阅。
    fs.writeFileSync(path.join(f.root, 'file.txt'), 'uncommitted\n');
    const cwd = await f.project.workspaces.ensure(f.task);
    expect(cwd).toBe(path.join(f.config.home, 'worktrees', `${f.task.id}-implement-feature`));
    expect(fs.readFileSync(path.join(cwd, 'file.txt'), 'utf8')).toBe('base\n');
    const created = f.store.all("SELECT data FROM events WHERE task_id=? AND type='workspace.created'", f.task.id)[0];
    expect(JSON.parse(created.data).dirty_source).toEqual({ files: 1, sample: [' M file.txt'], more: 0 });

    // worker 必须自己提交：这条门槛与主树无关。
    fs.writeFileSync(path.join(cwd, 'file.txt'), 'dirty');
    await expect(f.project.workspaces.finish(f.store.task(f.task.id))).rejects.toThrow('dirty');
    await git(cwd, 'add', '.'); await git(cwd, 'commit', '-m', 'first');
    await f.project.workspaces.finish(f.store.task(f.task.id)); f.store.update(f.task.id, { status: 'completed' });

    // 合并门槛仍在 merge 自己身上，而且报错要点出是哪个文件；失败的合并不动 integration。
    await expect(f.project.workspaces.merge(f.task.id)).rejects.toThrow('file.txt');
    expect(f.store.task(f.task.id).integration).toBe('pending');
    await git(f.root, 'checkout', '--', 'file.txt');

    await git(cwd, 'commit', '--allow-empty', '-m', 'unreviewed');
    await expect(f.project.workspaces.merge(f.task.id)).rejects.toThrow('changed after review');
  } finally { await f.close(); }
});

test('merge refuses a different target branch and an active task', async () => {
  const f = await setup();
  try {
    await expect(f.project.workspaces.merge(f.task.id)).rejects.toThrow('completed');
    await change(f,f.task); await git(f.root,'checkout','-b','other');
    await expect(f.project.workspaces.merge(f.task.id)).rejects.toThrow('switch to main');
  } finally { await f.close(); }
});

test('an interrupted merge can only be reconciled by another explicit approval', async () => {
  const f = await setup();
  try {
    await change(f,f.task);
    await f.project.workspaces.merge(f.task.id);
    const head = await git(f.root,'rev-parse','HEAD');
    f.store.update(f.task.id,{integration:'merging'});
    f.project.recover();
    expect(f.store.task(f.task.id).integration).toBe('review');
    await f.project.workspaces.merge(f.task.id);
    expect(f.store.task(f.task.id).integration).toBe('merged');
    expect(await git(f.root,'rev-parse','HEAD')).toBe(head);
  } finally { await f.close(); }
});

test('a downstream code dependency stacks on a cleaned upstream commit, not on a deleted ref', async () => {
  const f = await setup();
  try {
    await change(f, f.task);
    await f.project.workspaces.merge(f.task.id);
    await f.project.workspaces.cleanup(f.task.id);
    expect(f.store.task(f.task.id).branch).toBeNull();
    const child = f.project.spawn(f.task.parent_id,'continue on top','worker',[{ id: f.task.id, kind: 'code' }],'stacked-on-cleaned');
    const cwd = await f.project.workspaces.ensure(child);
    expect(await git(cwd,'rev-parse','HEAD')).toBe(f.store.task(f.task.id).head_commit);
    expect(fs.readFileSync(path.join(cwd,'file.txt'),'utf8')).toBe('changed\n');
  } finally { await f.close(); }
});

test('end-to-end worker executes inside worktree and cannot silently finish dirty', async () => {
  const f = fixture({ async run({ task, cwd, api }) {
    if (task.role === 'coordinator' && task.calls === 1) { api.spawn(task.id,'edit','worker'); return 'delegated'; }
    if (task.role === 'worker') fs.writeFileSync(path.join(cwd,'new.txt'),'not committed');
    return 'done';
  } });
  try {
    await repo(f.root);
    // 主树带未提交改动：worker 仍然能开工（基于已提交 HEAD），但 Lush 不会动这份改动。
    fs.writeFileSync(path.join(f.root,'wip.txt'),'uncommitted');
    // 合并后的语义：planner 只写队列、不能直接 spawn，这里用一个 coordinator 作可派活的根任务。
    const root = f.store.create({ input_id: null, role: 'coordinator', goal: 'edit' });
    f.project.kick();
    await until(() => f.store.task(root.id).status === 'completed');
    const child = f.store.children(root.id)[0];
    expect(child.status).toBe('failed'); expect(child.error).toContain('dirty');
    expect(child.error).toContain('new.txt');
    expect(fs.existsSync(path.join(child.workspace,'new.txt'))).toBe(true);
    expect(fs.existsSync(path.join(f.root,'new.txt'))).toBe(false);
    expect(fs.readFileSync(path.join(f.root,'wip.txt'),'utf8')).toBe('uncommitted');
    expect(await git(f.root,'status','--porcelain')).toBe('?? wip.txt');
  } finally { await f.close(); }
});
