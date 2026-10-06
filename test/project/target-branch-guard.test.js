import { test, expect, setDefaultTimeout } from 'bun:test';
setDefaultTimeout(15000);
import fs from 'node:fs';
import path from 'node:path';
import { fixture, repo, git } from '../helpers.js';

const run = (f, id) => f.project.invoke(id, { controller: new AbortController(), token: 'test', recordId: null });
const movedEvent = (f, id) => f.store.history(id).find(event => event.type === 'invocation.target_branch_moved');

test('agent 越过 worktree 直接把提交写进目标分支时，调用按失败处理并保留现场', async () => {
  let target = null;
  const f = fixture({ resolve: () => ({ agent: 'mock' }), async run() {
    fs.writeFileSync(path.join(f.root, 'rogue.txt'), 'rogue\n');
    await git(f.root, 'add', 'rogue.txt');
    await git(f.root, 'commit', '-m', 'rogue direct commit');
    return 'done';
  } });
  f.project.stopping = true; await repo(f.root);
  try {
    const order = (await f.project.order('guarded order')).task;
    f.store.update(order.id, { status: 'waiting' });
    await run(f, order.id);
    target = f.store.task(order.id);
    expect(target.status).toBe('failed');
    expect(target.error).toContain('目标分支 main');
    const event = movedEvent(f, order.id);
    expect(event).toBeTruthy();
    expect(event.data).toMatchObject({ branch: 'main' });
    expect(event.data.commits.join('\n')).toContain('rogue direct commit');
    // 保留现场：越界提交仍在 main，worker 的 worktree 没有被清理。
    expect(await git(f.root, 'log', '--oneline', '-1')).toContain('rogue direct commit');
    expect(fs.existsSync(target.workspace)).toBe(true);
  } finally { await f.close(); }
});

test('只在自己的 worktree 内提交不会被目标分支防护误判', async () => {
  const f = fixture({ resolve: () => ({ agent: 'mock' }), async run({ cwd }) {
    fs.writeFileSync(path.join(cwd, 'own.txt'), 'own\n');
    await git(cwd, 'add', 'own.txt');
    await git(cwd, 'commit', '-m', 'own worktree commit');
    return 'done';
  } });
  f.project.stopping = true; await repo(f.root);
  try {
    const order = (await f.project.order('normal order')).task;
    f.store.update(order.id, { status: 'waiting' });
    await run(f, order.id);
    const live = f.store.task(order.id);
    expect(live.status).not.toBe('failed');
    expect(movedEvent(f, order.id)).toBeFalsy();
    // main 没动，改动留在 worker 自己的分支上。
    expect(await git(f.root, 'log', '--oneline', '-1')).toContain('initial');
    expect(live.head_commit).not.toBe(live.base_commit);
  } finally { await f.close(); }
});

test('daemon 经 Workspaces 写入目标分支会被计入打点，不作为越界', async () => {
  const f = fixture({ resolve: () => ({ agent: 'mock' }), async run({ api }) {
    // 模拟一次交付推进：走 daemon 的 Workspaces（会打点），而不是外部 git。
    await api.workspaces.git(api.config.project, 'commit', '--allow-empty', '-m', 'delivery-like landing');
    return 'done';
  } });
  f.project.stopping = true; await repo(f.root);
  try {
    const order = (await f.project.order('delivery during run')).task;
    f.store.update(order.id, { status: 'waiting' });
    await run(f, order.id);
    expect(f.store.task(order.id).status).not.toBe('failed');
    expect(movedEvent(f, order.id)).toBeFalsy();
    expect(await git(f.root, 'log', '--oneline', '-1')).toContain('delivery-like landing');
  } finally { await f.close(); }
});

test('目标分支归属的 Worker 正在运行时，它自己对该分支的提交不算越界', async () => {
  const f = fixture({ resolve: () => ({ agent: 'mock' }), async run({ cwd }) {
    fs.writeFileSync(path.join(cwd, 'child.txt'), 'x\n');
    await git(cwd, 'add', 'child.txt'); await git(cwd, 'commit', '-m', 'child commit');
    const parent = f.store.task(parentId);
    fs.writeFileSync(path.join(parent.workspace, 'parent-extra.txt'), 'p\n');
    await git(parent.workspace, 'add', 'parent-extra.txt');
    await git(parent.workspace, 'commit', '-m', 'parent direct commit');
    return 'done';
  } });
  f.project.stopping = true; await repo(f.root);
  let parentId = null;
  try {
    const order = await f.project.order('parent owns branch');
    parentId = order.task.id;
    f.store.update(order.task.id, { status: 'waiting' });
    const child = await f.project.spawn(order.task.id, 'child under parent');
    f.store.update(child.id, { status: 'waiting' });
    // 模拟父 Worker 的 agent 正在并发运行，它有权写自己的分支。
    f.project.running.set(order.task.id, {});
    try {
      await run(f, child.id);
      expect(f.store.task(child.id).status).not.toBe('failed');
      expect(movedEvent(f, child.id)).toBeFalsy();
    } finally { f.project.running.delete(order.task.id); }
  } finally { await f.close(); }
});
