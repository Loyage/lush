import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, git, repo } from '../helpers.js';

async function commit(workspace, name) {
  fs.writeFileSync(path.join(workspace, name), name);
  await git(workspace, 'add', name);
  await git(workspace, 'commit', '-m', name);
}

test('Worker graph compares live direct parent tips, deduplicates Git reads and preserves summary-only loading', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const { task: parent } = await f.project.order('parent');
    const child = await f.project.spawn(parent.id, 'child');
    const read = async (params = {}) => (await f.project.taskGraph(params)).nodes.find(node => node.id === child.id);
    expect((await read()).parent_relation).toEqual({ ahead: 0, behind: 0 });
    await commit(child.workspace, 'child.txt');
    expect((await read()).parent_relation).toEqual({ ahead: 1, behind: 0 });
    await commit(parent.workspace, 'parent.txt');
    const fixed = await git(child.workspace, 'rev-parse', 'HEAD');
    f.store.update(child.id, { head_commit: child.base_commit, target_branch: 'main', integration: 'merged' });
    const originalGit = f.project.workspaces.git.bind(f.project.workspaces);
    const calls = [];
    f.project.workspaces.git = async (...args) => { calls.push(args); return originalGit(...args); };
    const node = await read();
    expect(node.parent_relation).toEqual({ ahead: 1, behind: 1 });
    expect(node.branch_info.current_head).toBe(fixed);
    expect(node.branch_info.diagnostics.working_tree.status).toBe('clean');
    // Genealogy and Worker relation share one fixed commit-pair read.
    const pair = `${await git(parent.workspace, 'rev-parse', 'HEAD')}...${fixed}`;
    expect(calls.filter(args => args.includes('rev-list') && args.includes(pair))).toHaveLength(1);
    calls.length = 0;
    const summary = await read({ details: false });
    expect(summary.parent_relation).toBeNull(); expect(calls).toHaveLength(0);
    fs.writeFileSync(path.join(child.workspace, 'untracked.txt'), 'pending');
    expect((await read()).branch_info.diagnostics.working_tree.status).toBe('dirty');
    fs.unlinkSync(path.join(child.workspace, 'untracked.txt'));
    await git(child.workspace, 'merge', '--no-edit', parent.branch);
    expect((await read()).parent_relation).toEqual({ ahead: 2, behind: 0 });
    await git(parent.workspace, 'merge', '--ff-only', child.branch);
    await commit(parent.workspace, 'later.txt');
    f.store.update(parent.id, { status: 'completed' });
    const events = f.store.get('SELECT count(*) AS n FROM events').n;
    const filtered = await read({ hidden_statuses: ['completed'] });
    expect(filtered.parent_relation).toEqual({ ahead: 0, behind: 1 });
    expect(f.store.get('SELECT count(*) AS n FROM events').n).toBe(events);
  } finally { await f.close(); }
});

test('Worker graph keeps missing refs, archived parents and failed Git reads unknown', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const { task } = await f.project.order('source');
    const read = async () => (await f.project.taskGraph()).nodes.find(node => node.id === task.id).parent_relation;
    const originalGit = f.project.workspaces.git.bind(f.project.workspaces);
    for (const command of ['for-each-ref', 'rev-list']) {
      f.project.workspaces.git = async (...args) => {
        if (args.includes(command)) throw new Error('unavailable');
        return originalGit(...args);
      };
      expect(await read()).toEqual({ ahead: null, behind: null });
    }
    f.project.workspaces.git = originalGit;
    f.store.update(task.parent_id, { branch: 'missing-parent' });
    expect(await read()).toEqual({ ahead: null, behind: null });
    f.store.update(task.parent_id, { branch: 'main' });
    f.store.recordBranch({ branch: 'main' });
    f.store.run("UPDATE branches SET status='archived' WHERE branch='main'");
    expect(await read()).toEqual({ ahead: null, behind: null });
    f.store.run("UPDATE branches SET status='archived' WHERE branch=?", task.branch);
    expect(await read()).toBeNull();
  } finally { await f.close(); }
});
