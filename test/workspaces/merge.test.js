import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, repo, git, until } from '../helpers.js';
import { setup, change } from './harness.js';

for (const operation of ['merge', 'catchup', 'fast-forward']) {
  for (const drift of ['checkout', 'detached', 'advance']) {
    test(`${operation} does not report success after external ${drift} during landing`, async () => {
      const f = await setup();
      try {
        const base = await git(f.root, 'rev-parse', 'main');
        await git(f.root, 'branch', 'unrelated', base);
        let target, cwd, landed;
        if (operation === 'catchup') {
          f.store.update(f.task.id, { status: 'completed' });
          fs.writeFileSync(path.join(f.root, 'main.txt'), 'ahead');
          await git(f.root, 'add', 'main.txt'); await git(f.root, 'commit', '-m', 'parent ahead');
          target = f.task.branch; cwd = f.task.workspace; landed = await git(f.root, 'rev-parse', 'main');
        } else {
          await change(f, f.task);
          target = 'main'; cwd = f.root; landed = f.store.task(f.task.id).head_commit;
        }
        const workspaces = f.project.workspaces, original = workspaces.git.bind(workspaces);
        let injected = false;
        workspaces.git = async (dir, ...args) => {
          if (!injected && dir === cwd && args[0] === 'merge' && args[1] === '--ff-only') {
            injected = true;
            if (drift === 'checkout') await git(cwd, 'checkout', 'unrelated');
            if (drift === 'detached') await git(cwd, 'checkout', '--detach', base);
            const result = await original(dir, ...args);
            if (drift === 'advance') await git(cwd, 'commit', '--allow-empty', '-m', 'external advancement');
            return result;
          }
          return original(dir, ...args);
        };
        const action = operation === 'merge' ? workspaces.merge(f.task.id)
          : operation === 'catchup' ? workspaces.catchupBranch(f.task.branch)
          : workspaces.fastForwardBranch('main', landed);
        await expect(action).rejects.toThrow('changed during landing');
        expect(injected).toBe(true);
        if (operation === 'merge') expect(f.store.task(f.task.id).integration).toBe('pending');
        if (drift !== 'advance') expect(await git(f.root, 'rev-parse', target)).toBe(base);
        // No automatic reset/checkout hides the failed operation's evidence.
        if (drift === 'checkout') expect(await git(cwd, 'rev-parse', 'unrelated')).toBe(landed);
        if (drift === 'detached') expect(await git(cwd, 'rev-parse', 'HEAD')).toBe(landed);
        if (drift === 'advance') expect(await git(cwd, 'log', '-1', '--format=%s')).toBe('external advancement');
      } finally { await f.close(); }
    });
  }
}

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
    // 新模型里 order 一创建就有分支与 worktree：还没干活时是「没有提交」的空 diff，而不是 null。
    expect(await f.project.workspaces.diff(f.store.task(f.task.id)))
      .toMatchObject({ committed: false, head_commit: null, files: [], pending: [] });
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

test('independent order Tasks get different worktrees and land one at a time', async () => {
  const f = await setup();
  try {
    const other = await f.project.order('other');
    const b = f.store.task(other.task.id);
    await Promise.all([change(f,f.task,'A','a.txt'), change(f,b,'B','b.txt')]);
    // 两条 order 各有独立 worktree，互不干扰；落地顺序由 v2 队列串行决定（见 merge-queue 用例）。
    expect(b.workspace).not.toBe(f.store.task(f.task.id).workspace);
    expect(fs.existsSync(path.join(b.workspace,'b.txt'))).toBe(true);
    expect(fs.existsSync(path.join(f.store.task(f.task.id).workspace,'a.txt'))).toBe(true);
    await f.project.workspaces.merge(f.task.id);
    expect(fs.readFileSync(path.join(f.root,'a.txt'),'utf8')).toBe('A');
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

test('merge refuses a task that has not finished', async () => {
  const f = await setup();
  try {
    // 新路径（order/child）用固定提交 + compare-and-swap 落地，不再要求用户把检出切到目标分支。
    await expect(f.project.workspaces.merge(f.task.id)).rejects.toThrow('completed');
    await change(f,f.task); await git(f.root,'checkout','-b','other');
    expect((await f.project.workspaces.merge(f.task.id)).branch).toBeTruthy();
    expect(await git(f.root,'rev-parse','main')).toBe(f.store.task(f.task.id).head_commit);
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

test('end-to-end order Agent works inside its worktree and cannot silently finish dirty', async () => {
  const f = fixture({ async run({ cwd }) {
    fs.writeFileSync(path.join(cwd,'new.txt'),'not committed');
    return 'done';
  } });
  try {
    await repo(f.root);
    // 主树带未提交改动：order 仍然能开工（基于已提交 HEAD），但 Lush 不会动这份改动。
    fs.writeFileSync(path.join(f.root,'wip.txt'),'uncommitted');
    const order = await f.project.order('edit');
    f.project.kick();
    await until(() => f.store.task(order.task.id).status !== 'running' && f.store.task(order.task.id).status !== 'queued');
    const task = f.store.task(order.task.id);
    expect(task.status).toBe('failed'); expect(task.error).toContain('dirty');
    expect(task.error).toContain('new.txt');
    expect(fs.existsSync(path.join(task.workspace,'new.txt'))).toBe(true);
    expect(fs.existsSync(path.join(f.root,'new.txt'))).toBe(false);
    expect(fs.readFileSync(path.join(f.root,'wip.txt'),'utf8')).toBe('uncommitted');
    expect(await git(f.root,'status','--porcelain')).toBe('?? wip.txt');
  } finally { await f.close(); }
});
