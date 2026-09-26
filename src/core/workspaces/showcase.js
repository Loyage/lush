import fs from 'node:fs';
import path from 'node:path';
import { check } from '../types.js';

const treeCaches = new WeakMap();

export const methods = {
  async showcaseTree(commit) {
    check(typeof commit === 'string' && /^[0-9a-f]{40,64}$/.test(commit), 'invalid showcase commit');
    let cache = treeCaches.get(this);
    if (!cache) { cache = new Map(); treeCaches.set(this, cache); }
    if (!cache.has(commit)) {
      cache.set(commit, await this.git(this.config.project, 'rev-parse', '--verify', `${commit}^{tree}`));
      if (cache.size > 400) cache.delete(cache.keys().next().value);
    }
    return cache.get(commit);
  },

  async showcaseCleanBranches(branches) {
    const names = new Set(branches);
    const list = await this.gitOutput(this.config.project, 'worktree', 'list', '--porcelain', '-z');
    for (const entry of list.split('\0\0')) {
      const fields = entry.split('\0');
      const cwd = fields.find(field => field.startsWith('worktree '))?.slice(9);
      if (!cwd) continue;
      const branch = fields.find(field => field.startsWith('branch refs/heads/'))?.slice(18);
      if (branch && !names.has(branch)) continue;
      const gitDir = await this.git(cwd, 'rev-parse', '--absolute-git-dir');
      if (!branch) {
        // A rebase detaches HEAD, but the original branch is still being changed.
        for (const dir of ['rebase-merge', 'rebase-apply']) {
          const file = path.join(gitDir, dir, 'head-name');
          if (fs.existsSync(file)) check(!names.has(fs.readFileSync(file, 'utf8').trim().replace(/^refs\/heads\//, '')),
            '分支有尚未结束的 Git 操作，暂不开放效果展示');
        }
        continue;
      }
      const status = await this.gitOutput(cwd, '--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none', '--', '.', ':(exclude).lush');
      check(!status, `分支 ${branch} 工作区有未提交修改或冲突，暂不开放效果展示`);
      for (const marker of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer', 'BISECT_START']) {
        check(!fs.existsSync(path.join(gitDir, marker)), '分支有尚未结束的 Git 操作，暂不开放效果展示');
      }
      check(await this.git(cwd, 'symbolic-ref', '--quiet', 'HEAD') === `refs/heads/${branch}`, '分支检出已变化，请刷新后重试');
    }
  },

  async showcaseSnapshot(branch, baseline = null) {
    const project = this.config.project;
    const record = this.store.branch(branch);
    check(record?.parent && record.parent_relation === 'recorded' && record.created_from_commit,
      '效果展示仅开放给已登记且有明确父分支和基线的分支');
    check(!['archived', 'deleted'].includes(record.status), '已归档或删除的分支不能展示');
    const defaults = await this.git(project, 'for-each-ref', '--format=%(refname) %(symref)', 'refs/remotes');
    const mainline = defaults.split('\n').some(line => {
      const [ref, target] = line.split(' ');
      return ref.endsWith('/HEAD') && target?.replace(/^refs\/remotes\/[^/]+\//, '') === branch;
    });
    check(!['main', 'master'].includes(branch) && !mainline, '主干分支不开放效果展示');
    const localCommit = async name => {
      check(typeof name === 'string' && name.length > 0 && name.length <= 512, 'branch must be non-empty local branch text');
      await this.git(project, 'check-ref-format', `refs/heads/${name}`);
      await this.git(project, 'show-ref', '--verify', `refs/heads/${name}`);
      return this.git(project, 'rev-parse', '--verify', `refs/heads/${name}^{commit}`);
    };
    const commit = await localCommit(branch);
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
    const tree = await this.showcaseTree(commit);
    check(tree !== await this.showcaseTree(record.created_from_commit), '分支相对创建基线没有实际文件改动');
    check(tree !== await this.showcaseTree(baselineCommit), '分支相对展示基线没有实际文件改动');
    await this.showcaseCleanBranches([branch]);
    check(await localCommit(branch) === commit, '分支提交已变化，请刷新后重试');
    return { version: 1, branch, commit, tree, baseline_branch: baselineBranch, baseline_commit: baselineCommit };
  },

  async assertShowcaseCheckout(dir, commit, { allowDirty = false } = {}) {
    check(fs.realpathSync(await this.git(dir, 'rev-parse', '--show-toplevel')) === fs.realpathSync(dir), 'showcase workspace is not a worktree root');
    check(await this.git(dir, 'rev-parse', 'HEAD') === commit, 'showcase checkout changed; preserve and inspect it before retrying or cleanup');
    let branch = null;
    try { branch = await this.git(dir, 'symbolic-ref', '--short', 'HEAD'); } catch { /* detached */ }
    check(!branch, 'showcase checkout must remain detached');
    if (!allowDirty) await this.clean(dir);
  },

  /** 收到「工作完成」信号后，把既有 prep 检出移到新的冻结提交；保留未跟踪的依赖/缓存，强制更新跟踪文件。 */
  async showcaseRepin(task, previous, snapshot) {
    for (const [dir, from, to] of [[task.workspace, previous?.commit, snapshot.commit],
      [task.baseline_workspace, previous?.baseline_commit, snapshot.baseline_commit]]) {
      if (!dir || from === to || !fs.existsSync(dir)) continue;
      await this.git(dir, 'checkout', '--detach', '--force', to);
    }
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
