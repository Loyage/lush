import fs from 'node:fs';
import path from 'node:path';
import { check } from '../types.js';

export const methods = {
  async showcaseSnapshot(branch, baseline = null) {
    const project = this.config.project;
    const localCommit = async name => {
      check(typeof name === 'string' && name.length > 0 && name.length <= 512, 'branch must be non-empty local branch text');
      await this.git(project, 'check-ref-format', `refs/heads/${name}`);
      await this.git(project, 'show-ref', '--verify', `refs/heads/${name}`);
      return this.git(project, 'rev-parse', '--verify', `refs/heads/${name}^{commit}`);
    };
    const commit = await localCommit(branch);
    const record = this.store.branch(branch);
    let baselineCommit, baselineBranch;
    if (baseline !== null && baseline !== undefined) {
      const tip = await localCommit(baseline);
      baselineCommit = await this.git(project, 'merge-base', commit, tip);
      baselineBranch = baseline;
    } else {
      check(record?.created_from_commit, 'this branch has no recorded fork point; specify a local baseline branch');
      baselineCommit = await this.git(project, 'rev-parse', '--verify', `${record.created_from_commit}^{commit}`);
      baselineBranch = record.parent;
    }
    return { version: 1, branch, commit, baseline_branch: baselineBranch, baseline_commit: baselineCommit };
  },

  async assertShowcaseCheckout(dir, commit) {
    check(fs.realpathSync(await this.git(dir, 'rev-parse', '--show-toplevel')) === fs.realpathSync(dir), 'showcase workspace is not a worktree root');
    check(await this.git(dir, 'rev-parse', 'HEAD') === commit, 'showcase checkout changed; preserve and inspect it before retrying or cleanup');
    let branch = null;
    try { branch = await this.git(dir, 'symbolic-ref', '--short', 'HEAD'); } catch { /* detached */ }
    check(!branch, 'showcase checkout must remain detached');
    await this.clean(dir);
  },

  ensureShowcase(task) {
    return this.exclusive(async () => {
      task = this.store.task(task.id);
      const snapshot = JSON.parse(task.showcase);
      const workspace = task.workspace || path.join(this.config.home, 'worktrees', `showcase-${task.id}`);
      const baseline = task.baseline_workspace || path.join(this.config.home, 'worktrees', `showcase-${task.id}-base`);
      this.store.update(task.id, { workspace, base_commit: snapshot.commit, head_commit: snapshot.commit,
        baseline_workspace: baseline, baseline_commit: snapshot.baseline_commit });
      for (const [dir, commit] of [[workspace, snapshot.commit], [baseline, snapshot.baseline_commit]]) {
        if (fs.existsSync(dir)) {
          await this.assertShowcaseCheckout(dir, commit);
        } else {
          fs.mkdirSync(path.dirname(dir), { recursive: true });
          await this.git(this.config.project, 'worktree', 'add', '--detach', dir, commit);
        }
      }
      return workspace;
    });
  },
};
