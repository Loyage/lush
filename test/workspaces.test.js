import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, repo, git, until } from './helpers.js';
import { Dispatcher } from '../src/rpc/protocol.js';
import { createSignal } from '../src/signal.js';

async function setup() {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  // planner 只写 spec 队列（spawn 会拒绝 planner 父任务），这里直接造一个能派活的 coordinator。
  const parent = f.store.create({ input_id: null, role: 'coordinator', goal: 'build' });
  const task = f.project.spawn(parent.id,'implement','worker',[],'implement-feature');
  return { ...f, task };
}
async function change(f, task, content = 'changed\n', filename = 'file.txt') {
  const cwd = await f.project.workspaces.ensure(task);
  fs.writeFileSync(path.join(cwd, filename), content);
  await git(cwd,'add',filename); await git(cwd,'commit','-m','implementation');
  await f.project.workspaces.finish(f.store.task(task.id));
  f.store.update(task.id,{status:'completed'});
  return cwd;
}

test('task names become the branch and worktree name, falling back to the goal', async () => {
  const f = await setup();
  const ns = f.project.workspaces.namespace;
  try {
    const named = f.project.spawn(f.task.parent_id,'改进 Web 页面布局','worker',[],'Web Composer Layout!');
    expect(named.name).toBe('web-composer-layout');
    const cwd = await f.project.workspaces.ensure(named);
    expect(f.store.task(named.id).branch).toBe(`lush/${ns}/${named.id}-web-composer-layout`);
    expect(cwd).toBe(path.join(f.config.home,'worktrees',`${named.id}-web-composer-layout`));

    const fallback = f.project.spawn(f.task.parent_id,'fix login redirect bug','worker');
    expect(fallback.name).toBe('fix-login-redirect-bug');
    await f.project.workspaces.ensure(fallback);
    expect(f.store.task(fallback.id).branch).toBe(`lush/${ns}/${fallback.id}-fix-login-redirect-bug`);
    expect(f.store.task(fallback.id).workspace).toBe(path.join(f.config.home,'worktrees',`${fallback.id}-fix-login-redirect-bug`));

    const unnamed = f.project.spawn(f.task.parent_id,'改进登录流程','worker');
    expect(unnamed.name).toBeNull();
    await f.project.workspaces.ensure(unnamed);
    expect(f.store.task(unnamed.id).branch).toBe(`lush/${ns}/task-${unnamed.id}`);
    expect(f.store.task(unnamed.id).workspace).toBe(path.join(f.config.home,'worktrees',`task-${unnamed.id}`));

    expect(() => f.project.spawn(f.task.parent_id,'goal','worker',[],'修复登录')).toThrow('ASCII');
  } finally { await f.close(); }
});

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

test('cleanup refuses unmerged work, including commits on failed tasks', async () => {
  const f = await setup();
  try {
    const cwd = await change(f,f.task);
    await expect(f.project.workspaces.cleanup(f.task.id)).rejects.toThrow('unmerged');
    f.store.update(f.task.id,{status:'failed',integration:'none'});
    await expect(f.project.workspaces.cleanup(f.task.id)).rejects.toThrow();
    expect(fs.existsSync(cwd)).toBe(true);
  } finally { await f.close(); }
});

test('task.cleanup over RPC honors keep_branch and reports what it reclaimed', async () => {
  const f = await setup();
  try {
    await change(f, f.task);
    await f.project.workspaces.merge(f.task.id);
    const branch = f.store.task(f.task.id).branch;
    const rpc = new Dispatcher(f.project, createSignal(), {});
    const kept = await rpc.dispatch('task.cleanup', { id: f.task.id, keep_branch: true });
    expect(kept.cleanup).toEqual({ id: f.task.id, worktree: 'removed', branch: 'kept', reason: 'kept by --keep-branch' });
    expect(await git(f.root,'branch','--list',branch)).toContain(branch);
    const removed = await rpc.dispatch('task.cleanup', { id: f.task.id });
    expect(removed.cleanup).toEqual({ id: f.task.id, worktree: 'absent', branch: 'removed', reason: null });
    expect(await git(f.root,'branch','--list',branch)).toBe('');
    await expect(rpc.dispatch('task.cleanup', { id: f.task.id, nope: true })).rejects.toThrow('unknown parameter');
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

test('cleanup reclaims a merged branch, and --keep-branch keeps it as a recovery point', async () => {
  const f = await setup();
  try {
    const cwd = await change(f, f.task);
    await f.project.workspaces.merge(f.task.id);
    const branch = f.store.task(f.task.id).branch;
    const kept = await f.project.workspaces.cleanup(f.task.id, { keepBranch: true });
    expect(kept.cleanup).toEqual({ id: f.task.id, worktree: 'removed', branch: 'kept', reason: 'kept by --keep-branch' });
    expect(await git(f.root,'branch','--list',branch)).toContain(branch);
    expect(f.store.task(f.task.id).branch).toBe(branch);
    // 第二次回收：worktree 已经不在，现在要收的就是这条分支。
    const again = await f.project.workspaces.cleanup(f.task.id);
    expect(again.cleanup).toEqual({ id: f.task.id, worktree: 'absent', branch: 'removed', reason: null });
    expect(f.store.task(f.task.id).branch).toBeNull();
    expect(await git(f.root,'branch','--list',branch)).toBe('');
    expect(fs.existsSync(cwd)).toBe(false);
  } finally { await f.close(); }
});

test('a preserved branch that no longer points at the reviewed commit is never deleted', async () => {
  const f = await setup();
  try {
    await change(f, f.task);
    await f.project.workspaces.merge(f.task.id);
    const branch = f.store.task(f.task.id).branch;
    await f.project.workspaces.cleanup(f.task.id, { keepBranch: true });
    // 用户在保留的恢复点上继续提交：分支不再等于审阅过的那次提交，就不删。
    await git(f.root,'update-ref',`refs/heads/${branch}`, await git(f.root,'rev-parse','HEAD'));
    const result = await f.project.workspaces.cleanup(f.task.id);
    expect(result.cleanup.worktree).toBe('absent');
    expect(result.cleanup.branch).toBe('kept');
    expect(result.cleanup.reason).toContain('is not the reviewed commit');
    expect(await git(f.root,'branch','--list',branch)).toContain(branch);
    expect(f.store.task(f.task.id).branch).toBe(branch);
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

test('cleaned failed worktree can be recreated by rebuilding its branch from base', async () => {
  const f = await setup();
  try {
    const cwd = await f.project.workspaces.ensure(f.task);
    const branch = f.store.task(f.task.id).branch;
    f.store.update(f.task.id,{status:'failed'});
    await f.project.workspaces.cleanup(f.task.id);
    expect(fs.existsSync(cwd)).toBe(false);
    // 没产出过提交：分支就是 base，回收掉不丢任何历史。
    expect(await git(f.root,'branch','--list',branch)).toBe('');
    f.project.retry(f.task.id);
    expect(await f.project.workspaces.ensure(f.store.task(f.task.id))).toBe(cwd);
    expect(await git(cwd,'symbolic-ref','--short','HEAD')).toBe(branch);
  } finally { await f.close(); }
});

test('pre-existing branch collisions do not become task-owned on retry', async () => {
  const f = await setup();
  try {
    const branch = `lush/${f.project.workspaces.namespace}/${f.task.id}-implement-feature`;
    await git(f.root,'branch',branch);
    await expect(f.project.workspaces.ensure(f.task)).rejects.toThrow('already exists');
    expect(f.store.task(f.task.id).branch).toBeNull();
    await expect(f.project.workspaces.ensure(f.task)).rejects.toThrow('already exists');
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
