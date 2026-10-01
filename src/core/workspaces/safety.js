import fs from 'node:fs';
import path from 'node:path';
import { check } from '../types.js';

const treeCaches = new WeakMap();

/** Shared fixed-commit identity and branch cleanliness gates for merge and sync. */
export const methods = {
  async commitTree(commit) {
    check(typeof commit === 'string' && /^[0-9a-f]{40,64}$/.test(commit), 'invalid commit');
    let cache = treeCaches.get(this);
    if (!cache) { cache = new Map(); treeCaches.set(this, cache); }
    if (!cache.has(commit)) {
      cache.set(commit, await this.git(this.config.project, 'rev-parse', '--verify', `${commit}^{tree}`));
      if (cache.size > 400) cache.delete(cache.keys().next().value);
    }
    return cache.get(commit);
  },

  async assertCleanBranches(branches) {
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
            '分支有尚未结束的 Git 操作，请结束后重试');
        }
        continue;
      }
      const status = await this.gitOutput(cwd, '--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none', '--', '.', ':(exclude).lush');
      check(!status, `分支 ${branch} 工作区有未提交修改或冲突，请提交后重试`);
      for (const marker of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer', 'BISECT_START']) {
        check(!fs.existsSync(path.join(gitDir, marker)), '分支有尚未结束的 Git 操作，请结束后重试');
      }
      check(await this.git(cwd, 'symbolic-ref', '--quiet', 'HEAD') === `refs/heads/${branch}`, '分支检出已变化，请刷新后重试');
    }
  },
};
