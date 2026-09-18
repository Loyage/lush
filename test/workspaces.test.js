import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, repo, git, until } from './helpers.js';

async function setup() {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  const parent = f.project.submit('build').task;
  const task = f.project.spawn(parent.id,'implement','worker');
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
    await f.project.workspaces.cleanup(f.task.id);
    expect(fs.existsSync(cwd)).toBe(false);
    expect(f.store.task(f.task.id).workspace).toBeNull();
    expect(await git(f.root,'rev-parse',f.store.task(f.task.id).branch)).toBeTruthy();
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

test('merge conflicts abort safely, retain both branches and allow later review', async () => {
  const f = await setup();
  try {
    const b = f.project.spawn(f.task.parent_id,'other','worker');
    await change(f,f.task,'A\n'); await change(f,b,'B\n');
    await f.project.workspaces.merge(f.task.id);
    const head = await git(f.root,'rev-parse','HEAD');
    await expect(f.project.workspaces.merge(b.id)).rejects.toThrow('git merge');
    expect(await git(f.root,'rev-parse','HEAD')).toBe(head);
    expect(await git(f.root,'status','--porcelain')).toBe('');
    expect(f.store.task(b.id).integration).toBe('pending');
    expect(f.store.task(b.id).integration_error).toBeTruthy();
    expect(fs.readFileSync(path.join(f.store.task(b.id).workspace,'file.txt'),'utf8')).toBe('B\n');
  } finally { await f.close(); }
});

test('dirty source, dirty worker and changed reviewed branch all refuse unsafe operations', async () => {
  const f = await setup();
  try {
    fs.writeFileSync(path.join(f.root,'dirty.txt'),'uncommitted');
    await expect(f.project.workspaces.ensure(f.task)).rejects.toThrow('dirty');
    fs.rmSync(path.join(f.root,'dirty.txt'));
    const cwd = await f.project.workspaces.ensure(f.task);
    fs.writeFileSync(path.join(cwd,'file.txt'),'dirty');
    await expect(f.project.workspaces.finish(f.store.task(f.task.id))).rejects.toThrow('dirty');
    await git(cwd,'add','.'); await git(cwd,'commit','-m','first');
    await f.project.workspaces.finish(f.store.task(f.task.id)); f.store.update(f.task.id,{status:'completed'});
    await git(cwd,'commit','--allow-empty','-m','unreviewed');
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

test('cleaned failed worktree can be recreated from its preserved branch', async () => {
  const f = await setup();
  try {
    const cwd = await f.project.workspaces.ensure(f.task);
    const branch = f.store.task(f.task.id).branch;
    f.store.update(f.task.id,{status:'failed'});
    await f.project.workspaces.cleanup(f.task.id);
    expect(fs.existsSync(cwd)).toBe(false);
    f.project.retry(f.task.id);
    expect(await f.project.workspaces.ensure(f.store.task(f.task.id))).toBe(cwd);
    expect(await git(cwd,'symbolic-ref','--short','HEAD')).toBe(branch);
  } finally { await f.close(); }
});

test('pre-existing branch collisions do not become task-owned on retry', async () => {
  const f = await setup();
  try {
    const branch = `lush/${f.project.workspaces.namespace}/task-${f.task.id}`;
    await git(f.root,'branch',branch);
    await expect(f.project.workspaces.ensure(f.task)).rejects.toThrow('already exists');
    expect(f.store.task(f.task.id).branch).toBeNull();
    await expect(f.project.workspaces.ensure(f.task)).rejects.toThrow('already exists');
  } finally { await f.close(); }
});

test('end-to-end worker executes inside worktree and cannot silently finish dirty', async () => {
  const f = fixture({ async run({ task, cwd, api }) {
    if (task.role === 'planner' && task.calls === 1) { api.spawn(task.id,'edit','worker'); return 'delegated'; }
    if (task.role === 'worker') fs.writeFileSync(path.join(cwd,'new.txt'),'not committed');
    return 'done';
  } });
  try {
    await repo(f.root); const root = f.project.submit('edit').task;
    await until(() => f.store.task(root.id).status === 'completed');
    const child = f.store.children(root.id)[0];
    expect(child.status).toBe('failed'); expect(child.error).toContain('dirty');
    expect(fs.existsSync(path.join(child.workspace,'new.txt'))).toBe(true);
    expect(fs.existsSync(path.join(f.root,'new.txt'))).toBe(false);
  } finally { await f.close(); }
});
