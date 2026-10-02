import fs from 'node:fs';
import path from 'node:path';
import { check } from '../types.js';
import { taskLabel, inputLabel } from '../naming.js';
import { deletionPath, deletionFingerprint, present } from '../deletion-resources.js';

function worktreeRecords(text) {
  const records = []; let current = null;
  for (const field of text.split('\0')) {
    if (field.startsWith('worktree ')) { current = { path: field.slice(9), branch: null, head: null, locked: false }; records.push(current); }
    else if (current && field.startsWith('branch refs/heads/')) current.branch = field.slice(18);
    else if (current && field.startsWith('HEAD ')) current.head = field.slice(5);
    else if (current && (field === 'locked' || field.startsWith('locked '))) current.locked = true;
  }
  return records;
}

export const methods = {
  /** Git queue caller owns serialization. Metadata alone is never proof of worktree identity. */
  async workerDeletionResourcesUnsafe(tasks, inputs, records, blockers) {
    const project = this.config.project, home = this.config.home;
    const allWorktrees = worktreeRecords(await this.gitOutput(project, 'worktree', 'list', '--porcelain', '-z'));
    const branches = new Set(records.map(record => record.branch));
    const paths = new Set(), generatedPaths = new Set();
    const generated = file => { const resolved = path.resolve(file); paths.add(resolved); generatedPaths.add(resolved); };
    for (const task of tasks) {
      if (task.branch) branches.add(task.branch);
      for (const file of [task.workspace, task.baseline_workspace]) if (file) paths.add(file);
      const label = taskLabel(task.id, task.name);
      for (const suffix of ['', '-base', '-analysis']) generated(path.join(home, 'worktrees', label + suffix));
    }
    for (const input of inputs) {
      if (input.anchor_branch) branches.add(input.anchor_branch);
      if (input.anchor_workspace) paths.add(input.anchor_workspace);
      generated(path.join(home, 'worktrees', inputLabel(input.id)));
    }
    for (const record of records) if (record.worktree) paths.add(record.worktree);
    // Recover exact runtime names after metadata loss; IDs are never reused.
    for (const task of tasks) branches.add(`lush/${this.namespace}/${taskLabel(task.id, task.name)}`);
    for (const input of inputs) branches.add(`lush/${this.namespace}/${inputLabel(input.id)}`);
    for (const tree of allWorktrees) if (branches.has(tree.branch)) paths.add(tree.path);
    const branchPlan = [];
    for (const branch of [...branches].sort()) {
      if (branch === 'main') { blockers.push('main branch cannot be deleted'); continue; }
      let tip = null;
      try { tip = await this.git(project, 'rev-parse', '--verify', `refs/heads/${branch}`); } catch { /* missing */ }
      if (tip || records.some(record => record.branch === branch)) branchPlan.push({ branch, tip });
    }
    const treePlan = [];
    for (const file of [...paths].sort()) {
      const tree = allWorktrees.find(entry => entry.path === file);
      try {
        const resolved = deletionPath(this.config, file);
        check(resolved.startsWith(path.resolve(home, 'worktrees') + path.sep),
          `worktree path is outside the private worktrees root: ${file}`);
        const stat = present(file);
        if (!stat && !tree) continue;
        check(!stat || stat.isDirectory(), `worktree is not a directory: ${file}`);
        if (tree) {
          check(!tree.locked, `worktree is locked: ${file}`);
          check(!tree.branch || branches.has(tree.branch), `worktree now checks out another branch: ${file}`);
          // Canonical and external worktrees are rejected by deletionPath before this point.
          if (stat) {
            const common = await this.git(file, 'rev-parse', '--path-format=absolute', '--git-common-dir');
            const expected = await this.git(project, 'rev-parse', '--path-format=absolute', '--git-common-dir');
            check(fs.realpathSync(common) === fs.realpathSync(expected), `worktree belongs to another repository: ${file}`);
          }
        } else {
          check(generatedPaths.has(resolved), `unregistered directory has unknown Worker ownership: ${file}`);
          check(!present(path.join(file, '.git')), `unregistered checkout has unknown ownership: ${file}`);
        }
        treePlan.push({ path: file, registered: Boolean(tree), head: tree?.head ?? null, branch: tree?.branch ?? null,
          fingerprint: deletionFingerprint(this.config, file) });
      } catch (error) { blockers.push(error.message); }
    }
    return { branches: branchPlan, worktrees: treePlan };
  },

  /** Explicit confirmed abandonment only. No reset, prune, branch -D, or shell interpolation. */
  async deleteWorkerResourcesUnsafe(plan, guard) {
    guard();
    for (const tree of plan.worktrees) {
      deletionPath(this.config, tree.path);
      check(deletionFingerprint(this.config, tree.path) === tree.fingerprint, `resource changed; preview again: ${tree.path}`);
      guard();
      if (tree.registered) await this.git(this.config.project, 'worktree', 'remove', '--force', tree.path);
      else fs.rmSync(tree.path, { recursive: true, force: true });
    }
    for (const entry of plan.branches) if (entry.tip) {
      check(!(await this.checkedOut(entry.branch)), `branch is still checked out: ${entry.branch}`);
      guard();
      await this.git(this.config.project, 'update-ref', '-d', `refs/heads/${entry.branch}`, entry.tip);
    }
  },
};
