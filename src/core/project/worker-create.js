import fs from 'node:fs';
import { check, id, text, TERMINAL, isPlainObject } from '../types.js';
import { assertTaskAncestorsOpen, assertTaskNotSyncing, consumeIntegratedReservation } from './iteration.js';
import { assertLocalWorker } from './execution-retired.js';
import { inheritedRunProfile, profileEvent } from './internal.js';
import { readInputRule, saveInputRule, snapshotPath } from '../task-input-rule.js';
import { validatedForkCheckpoint } from '../../agent/fork.js';
import { waitingFirstInput, publicCreatedWorker } from '../worker-creation.js';

export default {
  /** User-only container creation. No Input, messages, Hook state or invocation is copied. */
  createWorker(options) {
    return this.write('create a Worker', () => this.workspaces.exclusive(async () => {
      check(isPlainObject(options) && ['spawn','fork'].includes(options.mode), 'mode must be spawn or fork');
      const { mode, title = null, profile = null } = options;
      check(title === null || (typeof title === 'string' && title.trim().length <= 200
        && !/[\u0000-\u001f\u007f\u2028\u2029]/u.test(title)), 'title must be a single line of at most 200 characters');
      check(mode === 'fork' || options.source === undefined, 'spawn does not accept source');
      const explicitProfile = profile === null ? null : this.agentSettings.retryProfile('agent', profile);
      const source = mode === 'fork' ? this.store.task(id(options.source)) : null;
      if (source) {
        assertLocalWorker(this, source.id);
        assertTaskNotSyncing(this, source.id);
        check(['order','child'].includes(source.task_kind) && source.branch, 'fork source must be an order/child with a local branch');
        check(this.store.branch(source.branch)?.status === 'active', 'fork source branch is archived or missing');
        this.assertBranchWritable(source.branch, 'fork this Worker');
        check(options.parent === undefined || id(options.parent) === source.parent_id, 'fork parent must be the source direct parent');
      }
      const parentId = options.parent ?? source?.parent_id ?? (await this.ensureMainTask()).id;
      const parent = this.store.task(id(parentId));
      const admit = () => {
        this.assertWritable('create a Worker');
        const live = this.store.task(parent.id);
        assertTaskNotSyncing(this, live.id); assertTaskAncestorsOpen(this, live);
        check(['main','owner','order','child'].includes(live.task_kind) && live.branch === parent.branch
          && live.branch && !TERMINAL.has(live.status) && !waitingFirstInput(live), 'parent Worker is not available for new work');
        check(!this.store.branch(live.branch) || this.store.branch(live.branch).status === 'active', 'parent branch is archived');
        this.assertBranchWritable(live.branch, 'create a Worker');
        check(!this.inputExclusiveReason(live), this.inputExclusiveReason(live));
        if (source) {
          const current = this.store.task(source.id);
          assertTaskNotSyncing(this, current.id);
          check(current.branch === source.branch && current.parent_id === parent.id
            && this.store.branch(current.branch)?.status === 'active', 'fork source changed');
          this.assertBranchWritable(current.branch, 'fork this Worker');
        }
        let depth = 1;
        for (let node = live; node.parent_id; node = this.store.task(node.parent_id)) depth++;
        check(depth < this.config.maxDepth, 'worker nesting limit reached');
        check(this.store.get("SELECT count(*) AS n FROM tasks WHERE status NOT IN ('completed','failed','cancelled')").n < 1000, 'too many active workers');
      };
      admit();
      const runProfile = explicitProfile ?? (source ? inheritedRunProfile(this, source, this.running.get(source.id)) : null);
      if (source) check(runProfile?.agent === 'pi' && runProfile.config_mode !== 'pi',
        'fork 无法继承会话：需要支持导入检查点的托管 Pi 模式（Pi 默认模式或 Codex 不支持）；请改用空白 spawn，或显式选择托管 Pi 参数。');
      // Exact local tip, never a stored head or uncommitted file snapshot. The actual target remains the real parent.
      const commit = await this.workspaces.git(this.config.project, 'rev-parse', '--verify', `refs/heads/${source?.branch ?? parent.branch}^{commit}`);
      let pointer = null;
      if (source) {
        pointer = this.store.get('SELECT session_path AS session, entry_id AS entry FROM commit_contexts WHERE commit_hash=?', commit);
        check(pointer, 'fork 无法继承会话：来源提交没有 Pi 检查点；请改用空白 spawn，或选择有有效检查点的来源。');
        try { validatedForkCheckpoint(this.config.home, { ...pointer, commit }); }
        catch { check(false, 'fork 无法继承会话：来源提交的 Pi 检查点无效或不可用；请改用空白 spawn，或选择有有效检查点的来源。'); }
      }
      const rule = await readInputRule(this.workspaces, this.config.project, commit);
      admit();
      const creation = { mode, source_id: source?.id ?? null, source_worker_number: source?.worker_number ?? null,
        commit, session_inherited: Boolean(pointer) };
      const task = this.store.transaction(() => {
        const live = this.store.task(parent.id);
        if (live.status === 'awaiting_acceptance') {
          consumeIntegratedReservation(this, live, 'manual Worker creation');
          this.store.update(live.id, { status: 'waiting' });
        }
        const task = this.store.create({ parent_id: parent.id, input_id: null, role: 'agent', goal: '',
          name: mode === 'fork' ? 'fork' : 'spawn', task_kind: 'order' });
        this.store.update(task.id, { status: 'paused', creation: JSON.stringify(creation),
          session_fork: pointer ? JSON.stringify(pointer) : null,
          auto_merge: JSON.stringify({ version: 1, enabled: false, locked: false }),
          ...(runProfile ? { retry_profile: JSON.stringify(runProfile) } : {}) });
        if (title !== null) this.store.setTaskDisplayTitle(task.id, title.trim() || null);
        this.initializeNewWorkerConvergence(this.store.task(task.id));
        return this.store.task(task.id);
      });
      try {
        await this.workspaces.forkTaskUnsafe(task, parent.branch, commit);
        admit();
        if (rule !== null) saveInputRule(this.config.home, task.id, rule);
        this.store.event(task.id, 'task.manual_created', creation);
        if (runProfile) this.store.event(task.id, 'task.configured', { ...profileEvent(runProfile), profile_override: true,
          via: 'worker.create', ...(source ? { inherited_from: source.id } : {}) });
        return { task: publicCreatedWorker(this.store.task(task.id)) };
      } catch (error) {
        fs.rmSync(snapshotPath(this.config.home, task.id), { force: true });
        const failed = this.store.task(task.id);
        let cleanup;
        try { cleanup = failed.branch ? await this.workspaces.dropAnchor({ branch: failed.branch, workspace: failed.workspace, commit, target: parent.branch }) : null; }
        catch (failure) { cleanup = { status: 'kept', reason: failure.message }; }
        if (cleanup?.status === 'absent' && failed.branch) this.store.markBranchDeleted(failed.branch);
        this.store.update(task.id, { status: 'failed', error: `Worker creation failed: ${error.message}` });
        this.store.event(task.id, 'task.creation_failed', { error: error.message, cleanup });
        throw new Error(`Worker ${task.worker_number ?? '#' + task.id} creation failed; inspect creation diagnostics: ${error.message}`);
      }
    }));
  },

  /** Synchronous transaction shared by direct user messages and mounted append dispatch. */
  bindWorkerFirstInput(taskId, body) {
    text(body, 'input');
    this.assertWritable('submit the first Worker input');
    return this.store.transaction(() => {
      const task = this.store.task(taskId);
      check(waitingFirstInput(task) && task.status === 'paused', 'Worker is no longer waiting for its first input');
      this.assertAppendInputTarget(task.id); assertTaskNotSyncing(this, task.id);
      check(this.store.get("SELECT id FROM events WHERE task_id=? AND type='task.manual_created' LIMIT 1", task.id),
        'Worker creation is incomplete; inspect its recorded resources before submitting input');
      check(task.branch && task.workspace && fs.existsSync(task.workspace), 'Worker worktree is unavailable');
      const inputId = this.store.nextInputId();
      this.store.run(`INSERT INTO inputs(id,content,task_id,anchor_branch,anchor_commit,anchor_workspace,anchor_target_branch)
        VALUES (?,?,?,?,?,?,?)`, inputId, body, task.id, task.branch, task.base_commit, task.workspace, task.target_branch);
      const bound = this.store.run('UPDATE tasks SET input_id=?,goal=? WHERE id=? AND input_id IS NULL', inputId, body, task.id);
      check(bound.changes > 0 && this.store.task(task.id).input_id === inputId, 'Worker already has a first input');
      this.store.update(task.id, { status: 'queued' });
      this.store.event(task.id, 'input.anchor', { input_id: inputId, branch: task.branch, commit: task.base_commit,
        workspace: task.workspace, target_branch: task.target_branch, via: 'worker.first_input' });
      this.store.event(task.id, 'task.first_input', { input_id: inputId, authorized_by: 'user' });
      this.kick();
      return { ...publicCreatedWorker(this.store.task(task.id)), input_queue: this.taskInputQueue(this.store.task(task.id)) };
    });
  },
};
