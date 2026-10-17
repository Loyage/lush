import { check, id, text, TERMINAL } from '../types.js';
import fs from 'node:fs';
import path from 'node:path';
import { forkCheckpoint } from '../../agent/fork.js';
import { workerLabel } from '../worker-number.js';
import { ensureSystemRegistry } from './automation-registry.js';

/** Branch ownership, bootstrap and read-only owner analysis. */
export default {
  /** Bootstrap only when the project's local main ref already exists; never create or guess a ref. */
  async bootstrapMain() {
    try { await this.workspaces.git(this.config.project, 'show-ref', '--verify', 'refs/heads/main'); }
    catch { return null; }
    const main = await this.ensureMainTask();
    this.initializeCommandHookExample();
    return main;
  },

  /** A stable logical root; no provider invocation is started merely by creating it. */
  async ensureMainTask() {
    ensureSystemRegistry(this);
    const existing = this.store.all("SELECT * FROM tasks WHERE task_kind='main' AND branch='main' ORDER BY id");
    check(existing.length <= 1, 'main branch has more than one owning worker');
    if (existing.length) {
      this.initializeMainConvergence(existing[0]);
      return existing[0];
    }
    let commit = null;
    try {
      await this.workspaces.git(this.config.project, 'show-ref', '--verify', 'refs/heads/main');
      commit = await this.workspaces.git(this.config.project, 'rev-parse', '--verify', 'refs/heads/main^{commit}');
    } catch { /* no local main ref */ }
    check(commit, 'the new order protocol needs a local main branch; no branch was created automatically');
    return this.store.transaction(() => {
      const root = this.store.create({ role: 'agent', goal: '管理 main 分支及子Worker合并请求', name: 'main', task_kind: 'main' });
      this.store.update(root.id, { status: 'waiting', branch: 'main', base_commit: commit, head_commit: commit });
      this.initializeMainConvergence(this.store.task(root.id));
      this.store.event(root.id, 'main.bound', { branch: 'main', commit });
      return this.store.task(root.id);
    });
  },

  /** User-confirmed ownership for an existing local branch. Do not rewrite a legacy task/branch row. */
  async bindBranch(branch, commit) {
    text(branch, 'branch');
    check(branch.length <= 512 && branch !== 'main', 'bind a non-main local branch; main has its own root');
    check(typeof commit === 'string' && /^[0-9a-f]{40,64}$/.test(commit), 'bind needs the exact local branch HEAD commit');
    this.assertBranchWritable(branch, 'bind it to a new Worker');
    return this.workspaces.exclusive(async () => {
      const actual = await this.workspaces.git(this.config.project, 'rev-parse', '--verify', `refs/heads/${branch}^{commit}`)
        .catch(() => { throw new Error(`local branch ${branch} does not exist`); });
      check(actual === commit, `branch ${branch} moved; confirm its current HEAD before binding`);
      const old = this.store.branch(branch);
      check(!old || !['deleted','archived'].includes(old.status), `branch ${branch} has a deleted/archived historical record; inspect before binding`);
      const unfinished = this.store.get(`SELECT t.id,t.worker_number FROM tasks t LEFT JOIN inputs i ON i.id=t.input_id
        WHERE t.task_kind IS NULL AND t.status NOT IN ('completed','failed','cancelled')
          AND (t.branch=? OR t.target_branch=? OR i.anchor_branch=?) LIMIT 1`, branch, branch, branch);
      check(!unfinished, `branch ${branch} still has an active old worker ${workerLabel(unfinished)}; finish it before binding`);
      return this.store.transaction(() => {
        ensureSystemRegistry(this);
        const owners = this.store.all("SELECT id FROM tasks WHERE branch=? AND task_kind IN ('main','owner','order','say')", branch);
        check(owners.length === 0, `branch ${branch} already has a new Worker owner`);
        const owner = this.store.create({ role: 'agent', name: 'branch-owner', goal: `管理显式绑定的分支 ${branch}`,
          task_kind: 'owner' });
        this.store.update(owner.id, { status: 'waiting', branch, base_commit: commit, head_commit: commit });
        if (!old) this.store.recordBranch({ branch, created_from_commit: commit, task_id: owner.id });
        this.store.event(owner.id, 'branch.bound', { branch, commit, previous_task_id: old?.task_id ?? null });
        return this.store.task(owner.id);
      });
    });
  },

  /**
   * 用户专属：在 main/owner 下开一个**只读分析子 Task**，回答针对这条分支当前状态的问题。
   * 不建分支、不占地板：工具不限，但机制上拿不到任何分支（分离检出），所以既改不了 ref 也交付不了代码；
   * 回答成为该 Task 的 result，并在结算时留一条信息 notice。
   */
  async analyze(taskId, question) {
    const parent = this.store.task(id(taskId));
    check(['main','owner'].includes(parent.task_kind), 'only a branch owner Worker analyzes its branch on demand');
    text(question, 'question');
    check(question.length <= 4000, 'analysis question exceeds 4000 characters');
    check(!TERMINAL.has(parent.status), 'branch owner has ended; bind the branch again first');
    return this.workspaces.exclusive(async () => {
      const branch = parent.branch;
      check(branch, `worker ${workerLabel(parent)} owns no branch to analyze`);
      const commit = await this.workspaces.git(this.config.project, 'rev-parse', '--verify', `refs/heads/${branch}^{commit}`)
        .catch(() => { throw new Error(`local branch ${branch} does not exist; nothing to analyze`); });
      const created = this.store.transaction(() => {
        const owner = this.store.task(parent.id);
        check(!TERMINAL.has(owner.status) && owner.branch === branch, 'branch owner changed while starting analysis');
        check(this.store.activeTasks().length < 1000, 'too many active workers');
        const task = this.store.create({ parent_id: owner.id, input_id: null, role: 'agent', task_kind: 'analysis',
          goal: question });
        this.store.update(task.id, { target_branch: branch, base_commit: commit });
        this.store.event(task.id, 'task.analyze_requested', { parent_id: owner.id, branch, commit });
        return task;
      });
      // Read-only tasks still fork a private checkout at creation. They never own a
      // writable branch; their Pi conversation can fork from the same frozen commit.
      const dir = path.join(this.config.home, 'worktrees', `task-${created.id}-analysis`);
      try {
        this.store.update(created.id, { baseline_workspace: dir });
        fs.mkdirSync(path.dirname(dir), { recursive: true });
        await this.workspaces.git(this.config.project, 'worktree', 'add', '--detach', dir, commit);
        this.store.event(created.id, 'analysis.checkout', { workspace: dir, commit, branch });
        const pointer = this.store.get('SELECT session_path AS session, entry_id AS entry FROM commit_contexts WHERE commit_hash=?', commit);
        if (pointer) forkCheckpoint(this.config.home, { ...pointer, commit });
      } catch (error) {
        this.store.transaction(() => {
          this.store.update(created.id, { status: 'failed', error: `analysis fork failed: ${error.message}` });
          const eventId = this.store.event(created.id, 'analysis.fork_failed', { error: error.message });
          this.notifyTaskLifecycle(created.id, eventId);
        });
        throw new Error(`analysis ${workerLabel(created)} fork failed; inspect its checkout: ${error.message}`);
      }
      this.kick();
      return { status: 'queued', task: this.progressView(created), branch, commit };
    });
  },
};
