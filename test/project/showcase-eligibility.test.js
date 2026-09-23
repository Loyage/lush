import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, repo, git } from '../helpers.js';
import { Dispatcher } from '../../src/rpc/protocol.js';

async function setup() {
  const f = fixture(); f.project.kick = () => {};
  await repo(f.root);
  f.base = await git(f.root, 'rev-parse', 'HEAD');
  await git(f.root, 'checkout', '-b', 'feature');
  fs.writeFileSync(path.join(f.root, 'file.txt'), 'feature\n');
  await git(f.root, 'commit', '-am', 'feature');
  f.commit = await git(f.root, 'rev-parse', 'HEAD');
  f.store.recordBranch({ branch: 'feature', parent: 'main', created_from_commit: f.base });
  return f;
}
const eligibility = f => f.project.showcaseEligibility('feature');

// Exercise the shared gate directly and through graph / RPC, not just hidden UI buttons.
test('showcase excludes mainline, unregistered, archived, deleted, missing and unchanged branches', async () => {
  const f = await setup();
  try {
    expect((await eligibility(f)).allowed).toBe(true);
    await git(f.root, 'branch', 'ordinary', f.commit);
    expect((await f.project.showcaseEligibility('ordinary', 'main')).allowed).toBe(false);
    for (const branch of ['main', 'master', 'trunk']) {
      if (branch !== 'main') await git(f.root, 'branch', branch, f.commit);
      f.store.recordBranch({ branch, parent: 'ordinary', created_from_commit: f.base });
    }
    await git(f.root, 'update-ref', 'refs/remotes/origin/trunk', f.commit);
    await git(f.root, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk');
    for (const branch of ['main', 'master', 'trunk']) expect((await f.project.showcaseEligibility(branch)).reason).toContain('主干');
    for (const status of ['archived', 'deleted']) {
      f.store.run('UPDATE branches SET status=? WHERE branch=?', status, 'feature');
      expect((await eligibility(f)).allowed).toBe(false);
    }
    f.store.run("UPDATE branches SET status='active' WHERE branch='feature'");
    await git(f.root, 'checkout', 'main');
    await git(f.root, 'update-ref', 'refs/heads/feature', f.base);
    await expect(f.project.startShowcase('feature')).rejects.toThrow('没有实际文件改动');
    await git(f.root, 'branch', '-D', 'feature');
    expect((await eligibility(f)).allowed).toBe(false);
    const rpc = new Dispatcher(f.project);
    await expect(rpc.dispatch('showcase.start', { branch: 'ordinary', baseline: 'main' })).rejects.toThrow('已登记');
    expect(f.store.all("SELECT id FROM tasks WHERE role='showcase'")).toHaveLength(0);
  } finally { await f.close(); }
});

test('showcase blocks pending, failed, cancelled and conflict tasks, dirty checkout and Git operations', async () => {
  const f = await setup();
  try {
    const task = f.store.create({ role: 'worker', goal: 'feature' });
    f.store.update(task.id, { branch: 'feature' });
    for (const status of ['queued', 'running', 'waiting', 'awaiting', 'failed', 'cancelled']) {
      f.store.update(task.id, { status });
      expect((await eligibility(f)).allowed).toBe(false);
    }
    f.store.update(task.id, { status: 'completed', integration: 'conflict' });
    expect((await eligibility(f)).allowed).toBe(false);
    f.store.update(task.id, { integration: 'pending' });
    expect((await eligibility(f)).allowed).toBe(true); // human merge approval is not a prerequisite
    const originalGit = f.project.workspaces.git;
    f.project.workspaces.git = async () => { throw new Error('read unavailable'); };
    expect((await eligibility(f)).allowed).toBe(false);
    f.project.workspaces.git = originalGit;
    const child = f.store.create({ parent_id: task.id, role: 'worker', goal: 'not yet assigned a branch' });
    expect((await eligibility(f)).allowed).toBe(false);
    f.store.update(child.id, { status: 'completed' });
    const graph = await f.project.graph();
    expect(graph.nodes.find(node => node.name === 'feature').showcase.allowed).toBe(true);
    fs.writeFileSync(path.join(f.root, 'untracked.txt'), 'pending');
    expect((await eligibility(f)).reason).toContain('未提交');
    expect((await f.project.graph()).nodes.find(node => node.name === 'feature').showcase.allowed).toBe(false);
    await expect(f.project.startShowcase('feature')).rejects.toThrow('未提交');
    fs.unlinkSync(path.join(f.root, 'untracked.txt'));
    fs.writeFileSync(path.join(f.root, 'file.txt'), 'pending\n');
    await git(f.root, 'add', 'file.txt');
    expect((await eligibility(f)).reason).toContain('未提交');
    await git(f.root, 'restore', '--staged', 'file.txt');
    fs.writeFileSync(path.join(f.root, 'file.txt'), 'feature\n');
    const gitDir = await git(f.root, 'rev-parse', '--absolute-git-dir');
    fs.writeFileSync(path.join(gitDir, 'CHERRY_PICK_HEAD'), f.base);
    expect((await eligibility(f)).reason).toContain('Git 操作');
    fs.unlinkSync(path.join(gitDir, 'CHERRY_PICK_HEAD'));
    await git(f.root, 'checkout', '--detach');
    fs.mkdirSync(path.join(gitDir, 'rebase-merge'));
    fs.writeFileSync(path.join(gitDir, 'rebase-merge', 'head-name'), 'refs/heads/feature\n');
    expect((await eligibility(f)).reason).toContain('Git 操作');
    fs.rmSync(path.join(gitDir, 'rebase-merge'), { recursive: true });
    expect((await eligibility(f)).allowed).toBe(true);
  } finally { await f.close(); }
});

test('showcase waits for input planning and unintegrated descendants, but not unrelated work', async () => {
  const f = await setup();
  try {
    const input = await f.project.submit('develop feature', 'feature');
    // The queued planner has no branch field, but its input anchor is a descendant.
    expect((await eligibility(f)).allowed).toBe(false);
    f.store.update(input.task.id, { status: 'completed' });
    const spec = f.store.addSpec({ planner_task_id: input.task.id, input_id: input.id, goal: 'pending plan' });
    expect((await eligibility(f)).reason).toContain('未编排');
    f.store.dropSpec(spec.id);
    expect((await eligibility(f)).allowed).toBe(true);
    const unrelated = f.store.create({ role: 'worker', goal: 'unrelated' });
    f.store.update(unrelated.id, { branch: 'other', target_branch: 'main', status: 'running' });
    expect((await eligibility(f)).allowed).toBe(true);
    // Keep the temporary checkout outside the tested source worktree.
    const external = `${f.root}-child`;
    try {
      await git(f.root, 'worktree', 'add', '-b', 'child', external, 'feature');
      f.store.recordBranch({ branch: 'child', parent: 'feature', created_from_commit: f.commit, worktree: external });
      fs.writeFileSync(path.join(external, 'file.txt'), 'child\n');
      expect((await eligibility(f)).reason).toContain('未提交');
      await git(external, 'commit', '-am', 'child');
      expect((await eligibility(f)).reason).toContain('尚未收拢');
      await git(f.root, 'merge', '--ff-only', 'child');
      expect((await eligibility(f)).allowed).toBe(true);
    } finally {
      await git(f.root, 'worktree', 'remove', external).catch(() => {});
      fs.rmSync(external, { recursive: true, force: true });
    }
  } finally { await f.close(); }
});

test('successful showcases deduplicate file trees across empty commits, baseline overrides and old history', async () => {
  const f = await setup();
  try {
    const first = await f.project.startShowcase('feature');
    f.store.update(first.id, { status: 'completed' });
    // Legacy snapshot without tree is still deduplicated without rewriting it.
    const legacy = { ...first.showcase }; delete legacy.tree;
    f.store.run('UPDATE tasks SET showcase=? WHERE id=?', JSON.stringify(legacy), first.id);
    for (let i = 0; i < 51; i++) {
      const failed = f.store.create({ role: 'showcase', goal: 'old failure', showcase: legacy });
      f.store.update(failed.id, { status: 'failed' });
    }
    await git(f.root, 'commit', '--allow-empty', '-m', 'metadata only');
    expect((await eligibility(f)).reason).toContain('相同代码');
    await expect(f.project.startShowcase('feature', 'main')).rejects.toThrow('相同代码');
    expect(JSON.parse(f.store.task(first.id).showcase).tree).toBeUndefined();
    fs.writeFileSync(path.join(f.root, 'file.txt'), 'new content\n');
    await git(f.root, 'commit', '-am', 'new code');
    expect((await eligibility(f)).allowed).toBe(true);
    const second = await f.project.startShowcase('feature');
    expect(second.showcase.tree).not.toBe(first.showcase.tree);
    f.store.update(second.id, { status: 'failed' });
    fs.writeFileSync(path.join(f.root, 'file.txt'), 'feature\n');
    await git(f.root, 'commit', '-am', 'restore previously shown content');
    expect((await eligibility(f)).reason).toContain('相同代码');
  } finally { await f.close(); }
});

test('concurrent starts and retries cannot bypass the gate; failed versions may retry only while stable and unchanged', async () => {
  const f = await setup();
  try {
    const results = await Promise.allSettled([f.project.startShowcase('feature'), f.project.startShowcase('feature')]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const task = results.find(result => result.status === 'fulfilled').value;
    f.store.update(task.id, { status: 'failed' });
    expect((await eligibility(f)).allowed).toBe(true);
    const attempts = await Promise.allSettled([f.project.retry(task.id), f.project.startShowcase('feature')]);
    expect(attempts.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    f.store.update(task.id, { status: 'cancelled' });
    fs.writeFileSync(path.join(f.root, 'file.txt'), 'dirty\n');
    await expect(f.project.retry(task.id)).rejects.toThrow('未提交');
    await git(f.root, 'commit', '-am', 'changed');
    await expect(f.project.retry(task.id)).rejects.toThrow('代码已变化');
    expect(f.store.task(task.id).status).toBe('cancelled');
    const newer = await f.project.startShowcase('feature');
    f.store.update(newer.id, { status: 'completed' });
    await expect(f.project.retry(task.id)).rejects.toThrow('相同代码');
  } finally { await f.close(); }
});
