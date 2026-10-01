import * as types from '../types.js';
const { check, id, TERMINAL } = types;
const isSettled = task => types.isSettled?.(task) ?? (TERMINAL.has(task.status)
  || (task.status === 'awaiting_acceptance' && task.integration === 'merged'));

const bookingOf = task => task.reservation ? JSON.parse(task.reservation) : null;
const eventOf = (store, taskId, type) => {
  const row = store.get('SELECT id,data FROM events WHERE task_id=? AND type=? ORDER BY id DESC LIMIT 1', taskId, type);
  return row ? { ...JSON.parse(row.data), event_id: row.id } : null;
};

function baselinePatch(project, taskId, commit) {
  // Also usable before the lifecycle additive schema arrives; audit retains the baseline.
  if (project.store.all('PRAGMA table_info(tasks)').some(column => column.name === 'iteration_base_commit'))
    project.store.run('UPDATE tasks SET iteration_base_commit=? WHERE id=?', commit, taskId);
}

function acquire(project, taskId, parentId) {
  project.taskSyncBusy ??= new Set();
  check(!project.taskSyncBusy.has(taskId) && !project.taskSyncBusy.has(parentId),
    'Task synchronization is already in progress');
  project.taskSyncBusy.add(taskId);
  project.taskSyncBusy.add(parentId);
}

function release(project, taskId, parentId) {
  project.taskSyncBusy.delete(taskId);
  project.taskSyncBusy.delete(parentId);
  project.scheduleTaskMerge(taskId);
  project.scheduleTaskMerge(parentId);
  project.kick();
}

export default {
  assertTaskSyncable(taskId) {
    const task = this.store.task(id(taskId));
    check(['say', 'child'].includes(task.task_kind), 'only say/child Tasks can synchronize their direct parent');
    check(!TERMINAL.has(task.status), 'ended Tasks must first use task.reopen');
    check(['waiting', 'paused', 'awaiting_acceptance'].includes(task.status),
      'Task must be idle and not queued, running, or waiting for a user decision');
    check(!this.running.has(task.id), 'Task invocation is still running');
    check(task.branch && task.workspace && task.target_branch && task.parent_id, 'Task branch/worktree/direct parent is missing');
    const booking = bookingOf(task);
    check(!booking || ['pending', 'integrated', 'withdrawn', 'completed', 'failed', 'cancelled'].includes(booking.status),
      'Task is frozen for delivery or divergence repair');
    check(!this.store.get("SELECT id FROM notices WHERE task_id=? AND status='open' LIMIT 1", task.id),
      'Task has an unanswered user decision');
    check(!this.hasActionableMessages(task.id), 'Task has pending input; process it before synchronizing');
    check(this.subtreeTasks(task.id).every(child => child.id === task.id
      || (isSettled(child) && !this.running.has(child.id))), 'Task has active descendants');
    const parent = this.store.task(task.parent_id);
    check(['main', 'owner', 'say', 'child'].includes(parent.task_kind) && !TERMINAL.has(parent.status)
      && parent.branch === task.target_branch, 'Task parent identity no longer matches its fixed Git target');
    check(parent.status !== 'running' && parent.status !== 'queued' && !this.running.has(parent.id),
      'parent Task must be idle before synchronizing');
    const seen = new Set([task.id]);
    for (let ancestor = parent; ancestor; ancestor = ancestor.parent_id ? this.store.task(ancestor.parent_id) : null) {
      check(!seen.has(ancestor.id), 'Task ancestry contains a cycle');
      seen.add(ancestor.id);
      check(!TERMINAL.has(ancestor.status), 'an ancestor Task has ended; reopen it before synchronizing');
    }
    this.assertBranchWritable(task.branch, 'synchronize Task');
    this.assertBranchWritable(parent.branch, 'synchronize Task from parent');
    const record = this.store.branch(task.branch);
    check(record?.status === 'active' && record.task_id === task.id && record.parent_relation === 'recorded'
      && record.parent === parent.branch, 'Task branch ownership/direct parent record changed');
    return task;
  },

  async syncTaskParent(taskId) {
    const task = this.assertTaskSyncable(taskId);
    acquire(this, task.id, task.parent_id);
    try {
      return await this.workspaces.exclusive(async () => {
        const current = this.assertTaskSyncable(task.id);
        const recheck = () => {
          const live = this.assertTaskSyncable(task.id);
          check(['parent_id', 'branch', 'workspace', 'target_branch', 'status', 'reservation'].every(key => live[key] === current[key]),
            'Task changed during synchronization');
        };
        const project = this.config.project;
        const source = await this.workspaces.git(project, 'rev-parse', '--verify', `refs/heads/${current.branch}^{commit}`);
        const parent = await this.workspaces.git(project, 'rev-parse', '--verify', `refs/heads/${current.target_branch}^{commit}`);
        const prior = eventOf(this.store, task.id, 'task.parent_synced');
        const outcome = await this.workspaces.syncTaskParentUnsafe({ ...current,
          iteration_base_commit: current.iteration_base_commit ?? prior?.parent_commit ?? null }, source, parent, recheck);
        recheck();
        this.store.transaction(() => {
          if (outcome.conflict) {
            this.store.event(task.id, 'task.parent_sync_conflict', { ...outcome, parent_id: current.parent_id });
          } else {
            this.store.update(task.id, { head_commit: outcome.head_commit,
              integration: outcome.integration, integration_error: null,
              status: current.status === 'paused' ? 'paused'
                : outcome.integration === 'merged' ? 'awaiting_acceptance' : 'waiting' });
            baselinePatch(this, task.id, parent);
            this.store.event(task.id, 'task.parent_synced', { ...outcome, parent_id: current.parent_id });
          }
        });
        return { task: this.store.task(task.id), synced: outcome.synced, conflict: outcome.conflict,
          source_commit: source, parent_commit: parent, ...(outcome.reason ? { reason: outcome.reason } : {}) };
      });
    } finally { release(this, task.id, task.parent_id); }
  },

  /** Explicit user action: wake this Task once with the diagnostic's immutable parent, not a new child. */
  async resolveTaskSync(taskId) {
    const task = this.assertTaskSyncable(taskId);
    acquire(this, task.id, task.parent_id);
    try {
      return await this.workspaces.exclusive(async () => {
        const current = this.assertTaskSyncable(task.id);
        const diagnostic = eventOf(this.store, task.id, 'task.parent_sync_conflict');
        check(diagnostic && diagnostic.parent_id === current.parent_id, 'no fixed parent synchronization conflict to resolve');
        const resolution = eventOf(this.store, task.id, 'task.sync_resolution_requested');
        const synced = eventOf(this.store, task.id, 'task.parent_synced');
        check((!resolution || resolution.conflict_event_id !== diagnostic.event_id)
          && (!synced || synced.event_id < diagnostic.event_id), 'this synchronization conflict has already been handled');
        const source = await this.workspaces.git(this.config.project, 'rev-parse', '--verify', `refs/heads/${current.branch}^{commit}`);
        check(source === diagnostic.source_commit, 'source moved since the conflict; synchronize again before resolving');
        const verify = async () => {
          check(await this.workspaces.git(this.config.project, 'rev-parse', '--verify', `refs/heads/${current.target_branch}^{commit}`)
            === diagnostic.parent_commit, 'parent moved since the conflict; synchronize again before resolving');
          await this.workspaces.assertCleanBranches([current.branch, current.target_branch]);
          await this.workspaces.taskSyncCheckout(current, source);
          this.assertTaskSyncable(task.id);
          check(await this.workspaces.git(this.config.project, 'rev-parse', '--verify', `refs/heads/${current.target_branch}^{commit}`)
            === diagnostic.parent_commit, 'parent moved since the conflict; synchronize again before resolving');
        };
        await verify();
        this.store.transaction(() => {
          const body = `父分支同步冲突：在本 Task 工作区吸收固定父提交 ${diagnostic.parent_commit}，保留源提交 ${source} 的历史。`
            + (diagnostic.base_commit ? ` 三方合并必须以 ${diagnostic.base_commit} 为基线（Squash 历史不能用普通 merge 重放旧改动；可用 git merge-tree --write-tree --merge-base=${diagnostic.base_commit}，解决其冲突树后创建同时以固定源/父为祖先的提交）。` : ' 可用普通 Git merge。')
            + ' 解决冲突、运行测试并提交；不要修改父分支，不要 rebase/reset，不自动发起交付。\n固定诊断：\n' + diagnostic.reason;
          const messageId = this.store.message(task.id, body);
          this.store.event(task.id, 'task.sync_resolution_requested', { ...diagnostic,
            conflict_event_id: diagnostic.event_id, message_id: messageId });
          // Do not route this system diagnostic through user input rules or clear a historical integrated receipt.
          this.store.update(task.id, { status: 'queued', error: null });
        });
        return this.store.task(task.id);
      });
    } finally { release(this, task.id, task.parent_id); }
  },

  /** Lifecycle hook after the Agent finishes; validates repair, never advances the parent branch. */
  async settleTaskSyncResolution(taskId) {
    const task = this.store.task(id(taskId));
    const request = eventOf(this.store, task.id, 'task.sync_resolution_requested');
    const settled = eventOf(this.store, task.id, 'task.sync_resolution_settled');
    if (!request || settled?.request_event_id === request.event_id) return false;
    return this.workspaces.exclusive(async () => {
      const current = this.store.task(task.id);
      const parent = this.store.task(current.parent_id);
      const record = this.store.branch(current.branch);
      check(current.branch === task.branch && current.parent_id === request.parent_id
        && parent.branch === current.target_branch && record?.parent === parent.branch
        && record.task_id === current.id && record.status === 'active',
        'synchronization repair parent/source identity changed');
      check(await this.workspaces.isAncestor(this.config.project, request.parent_commit, `refs/heads/${parent.branch}`),
        'fixed synchronization parent is no longer in parent history');
      const commit = await this.workspaces.git(this.config.project, 'rev-parse', '--verify', `refs/heads/${current.branch}^{commit}`);
      await this.workspaces.taskSyncCheckout(current, commit);
      check(await this.workspaces.isAncestor(this.config.project, request.source_commit, commit)
        && await this.workspaces.isAncestor(this.config.project, request.parent_commit, commit),
        'synchronization repair must preserve both fixed source and parent commits');
      const integration = await this.workspaces.commitTree(commit) === await this.workspaces.commitTree(request.parent_commit)
        ? 'merged' : 'pending';
      await this.workspaces.taskSyncCheckout(current, commit);
      this.store.transaction(() => {
        this.store.update(task.id, { head_commit: commit, integration, integration_error: null });
        baselinePatch(this, task.id, request.parent_commit);
        this.store.event(task.id, 'task.parent_synced', { source_commit: request.source_commit,
          parent_commit: request.parent_commit, head_commit: commit, parent_id: current.parent_id, resolved: true });
        this.store.event(task.id, 'task.sync_resolution_settled', { request_event_id: request.event_id, commit });
      });
      return true;
    });
  },
};
