import { check, id, text, TERMINAL } from '../types.js';
import { assertTaskAncestorsOpen, assertTaskNotSyncing, consumeIntegratedReservation, resumeTaskDelivery } from './iteration.js';
import fs from 'node:fs';
import { readInputRule, saveInputRule, snapshotPath } from '../task-input-rule.js';
import { forkCheckpoint } from '../../agent/fork.js';
import { checkDraftRevision } from './input-history.js';
import { profileEvent } from './internal.js';
import { workerLabel } from '../worker-number.js';
import { emissionLocked } from './input-emission-data.js';
import { inputSource } from '../../persistence/store/input-sources.js';
import { assertLocalWorker, RETIRED_EXECUTION } from './execution-retired.js';

/** Input / draft admission and atomic creation of branch-owning orders. */
export default {

  /**
   * Every new order is one Input and one branch-owning Task, regardless of whether it writes code.
   * `profile` is the optional full run-settings override, validated before creating a Git anchor.
   * Explicit `defer` authorizes a frozen parent to hold a one-shot creation Hook instead.
   */
  order(content = undefined, branch = null, references = [], draftId = null, start = true, expectedRevision = undefined, profile = null, defer = false, runnerNodeId = undefined, source = { kind: 'user' }) {
    check(typeof defer === 'boolean', 'defer must be boolean');
    return this.write('send this order', () => this.sendOrder(content, branch, references, draftId, start, expectedRevision, profile, defer,
      null, null, null, null, runnerNodeId, source));
  },

  /** Convenience wrapper for the same creation-time override without the legacy positional options. */
  submitOrder(content, branch = null, references = [], profile = null, start = true, runnerNodeId = undefined) {
    return this.write('send this order', () => this.sendOrder(content, branch, references, null, start, undefined, profile,
      false, null, null, null, null, runnerNodeId, { kind: 'user' }));
  },

  /** The body of order(); runs under the clear gate so an anchor created before a clear cannot commit after its purge. */
  async sendOrder(content = undefined, branch = null, references = [], draftId = null, start = true, expectedRevision = undefined, profile = null, defer = false, hookReceipt = null, creationGuard = null, shortcutReceipt = null, emissionReceipt = null, runnerNodeId = undefined, source = null) {
    // Runtime Hook creation is not a user submission. Only a private deferred
    // authorization may retain its original submitter across the wait/restart.
    if (source === null && hookReceipt) {
      const owner = this.store.task(hookReceipt.task_id);
      const mount = owner.hooks ? JSON.parse(owner.hooks).mounts.find(item => item.id === hookReceipt.hook_id) : null;
      source = mount?.input_source ?? { kind: mount?.registry_id === 'system:deferred-order' ? 'unknown' : 'system' };
    }
    source = inputSource(this.store, source ?? { kind: 'system' });
    check(runnerNodeId === undefined, RETIRED_EXECUTION);
    // Only explicit deferred draft submission can carry a creation-time run-settings override.
    check(defer || draftId === null || draftId === undefined || profile === null || profile === undefined,
      'a buffered draft cannot carry run settings unless explicit deferred submission is authorized');
    let draft = null, draftReferences = null;
    const buffered = expectedRevision !== undefined;
    if (draftId !== null && draftId !== undefined) {
      check(content === undefined && references.length === 0, 'draft_id cannot be combined with content or references');
      draft = this.store.draft(id(draftId));
      check(!this.draftHookMount(draft.id), 'draft is already mounted on a Hook; remove that mount before sending');
      check(!emissionLocked(draft), 'draft has a mounted input; dispatch it through the input queue');
      check(draft.input_id === null, `draft ${draft.id} was already submitted as input O${draft.input_id}`);
      if (buffered) {
        checkDraftRevision(draft, expectedRevision);
        check(draft.parent_id !== null, 'legacy draft has no saved parent Worker; edit it and explicitly select a parent before sending');
        branch = this.assertInputParent(draft.parent_id).branch;
      }
      draftReferences = this.store.draftReferences(draft.id);
      content = draft.content;
      references = draftReferences;
    }
    text(content, 'input');
    // Resolve the optional creation-time override before creating the Git anchor: an invalid
    // profile must fail without leaving a half-created input branch behind.
    const runProfile = profile === null || profile === undefined ? null : this.agentSettings.retryProfile('agent', profile);
    const normalized = this.normalizeReferences(references);
    if (branch !== null && branch !== undefined) text(branch, 'branch');
    const target = branch ?? await this.workspaces.git(this.config.project, 'symbolic-ref', '--short', 'HEAD')
      .catch(() => { throw new Error('select a local parent branch before sending from detached HEAD'); });
    if (!defer) this.assertBranchWritable(target, 'create a new worker on it');
    if (target === 'main') await this.ensureMainTask();
    const owner = this.store.all("SELECT * FROM tasks WHERE branch=? AND task_kind IN ('main','owner','order','say') ORDER BY id", target);
    check(owner.length === 1, `branch ${target} needs exactly one explicitly bound Worker before order`);
    const parent = owner[0];
    check(!this.inputExclusiveReason(parent.id, emissionReceipt?.draft_id), this.inputExclusiveReason(parent.id, emissionReceipt?.draft_id));
    if (buffered) check(parent.id === draft.parent_id, 'saved parent Worker changed; edit the draft before sending');
    assertTaskNotSyncing(this, parent.id);
    check(!TERMINAL.has(parent.status), `parent worker ${workerLabel(parent)} has ended; select an active parent Worker`);
    assertTaskAncestorsOpen(this, parent);
    if (defer && this.branchFreeze(target))
      return this.deferOrderHook(parent, content, normalized, runProfile, start, draft, source);
    this.assertBranchWritable(target, 'create a new worker on it');
    assertLocalWorker(this, parent.id);
    // Recheck inside the Git writer queue, not only before waiting to acquire it.
    const { inputId, anchor } = await this.anchorInput(target, () => {
      this.assertWritable('send this order');
      assertLocalWorker(this, parent.id);
      check(!this.inputExclusiveReason(parent.id, emissionReceipt?.draft_id), this.inputExclusiveReason(parent.id, emissionReceipt?.draft_id));
      creationGuard?.();
      this.assertInputParent(parent.id, target);
      assertTaskNotSyncing(this, parent.id);
      this.assertBranchWritable(target, 'create a new worker on it');
    });
    let ruleTaskId = null;
    try {
      const pointer = this.store.get('SELECT session_path AS session, entry_id AS entry FROM commit_contexts WHERE commit_hash=?', anchor.commit);
      if (pointer) forkCheckpoint(this.config.home, { ...pointer, commit: anchor.commit });
      const rule = await readInputRule(this.workspaces, this.config.project, anchor.commit);
      // Git was asynchronous: a clear may have started while the anchor was being created.
      this.assertWritable('send this order');
      const result = this.store.transaction(() => {
        assertLocalWorker(this, parent.id);
        const current = this.store.task(parent.id);
        check(!this.inputExclusiveReason(parent.id, emissionReceipt?.draft_id), this.inputExclusiveReason(parent.id, emissionReceipt?.draft_id));
        creationGuard?.();
        this.assertBranchWritable(target, 'create a new worker on it');
        if (buffered) this.assertInputParent(draft.parent_id, target);
        check(!TERMINAL.has(current.status) && current.branch === target, 'parent worker changed while creating the worktree');
        assertTaskAncestorsOpen(this, current);
        assertTaskNotSyncing(this, current.id);
        resumeTaskDelivery(this, current.id, 'new child input');
        if (current.status === 'awaiting_acceptance') {
          consumeIntegratedReservation(this, current, 'new child input');
          this.store.update(current.id, { status: 'waiting' });
        }
        if (draft) {
          const live = this.store.draft(draft.id);
          if (buffered) {
            checkDraftRevision(live, expectedRevision);
            check(live.parent_id === draft.parent_id, 'draft parent changed while being submitted');
          }
          check(live.input_id === null && live.content === draft.content
            && JSON.stringify(this.store.draftReferences(draft.id)) === JSON.stringify(draftReferences),
            `draft ${draft.id} changed while being submitted; retry with its latest contents`);
        }
        this.store.run(`INSERT INTO inputs(id,content,anchor_branch,anchor_commit,anchor_workspace,anchor_target_branch)
          VALUES (?,?,?,?,?,?)`, inputId, content, anchor.branch, anchor.commit, anchor.workspace, anchor.target);
        this.store.setInputReferences(inputId, normalized.map(reference => ({ segment: 1, reference })));
        const task = this.store.create({ parent_id: parent.id, input_id: inputId, role: 'agent', goal: content,
          name: `order-${inputId}`, task_kind: 'order' });
        this.store.update(task.id, { branch: anchor.branch, workspace: anchor.workspace,
          auto_merge: JSON.stringify(this.newOrderCompletionConfig()),
          base_commit: anchor.commit, target_branch: target, ...(start ? {} : { status: 'paused' }),
          ...(runProfile ? { retry_profile: JSON.stringify(runProfile) } : {}) });
        this.initializeNewWorkerConvergence(this.store.task(task.id));
        if (runProfile) this.store.event(task.id, 'task.configured', { ...profileEvent(runProfile), profile_override: true, via: 'order' });
        if (rule !== null) {
          ruleTaskId = task.id;
          saveInputRule(this.config.home, task.id, rule);
          this.store.event(task.id, 'task.input_rule_frozen', { source: '.lush-task/input.mjs', commit: anchor.commit });
        }
        this.store.run('UPDATE inputs SET task_id=? WHERE id=?', task.id, inputId);
        const attached = this.store.run('UPDATE branches SET task_id=? WHERE branch=? AND task_id IS NULL', task.id, anchor.branch);
        check(attached.changes === 1, 'input branch already belongs to another worker');
        if (draft) {
          this.store.run('UPDATE drafts SET input_id=? WHERE id=?', inputId, draft.id);
          this.store.event(task.id, 'input.draft', { draft_ids: [draft.id] });
        }
        if (hookReceipt) {
          const hookOwner = this.store.task(hookReceipt.task_id);
          const mounted = JSON.parse(hookOwner.hooks).mounts.find(m => m.id === hookReceipt.hook_id);
          check(mounted?.enabled && mounted.state === 'running' && mounted.last_execution?.id === hookReceipt.execution_id,
            'Hook creation authorization changed');
          if (mounted.draft_id) {
            const source = this.store.draft(mounted.draft_id);
            check(source.input_id === null && source.revision === mounted.draft_revision, 'mounted draft changed');
            this.store.run('UPDATE drafts SET input_id=? WHERE id=?', inputId, source.id);
            this.store.event(task.id, 'input.draft', { draft_ids: [source.id] });
          }
          this.store.event(hookOwner.id, 'hook.worker_created', { ...hookReceipt, worker_id: task.id, input_id: inputId });
        }
        if (emissionReceipt) this.recordInputDispatch(emissionReceipt.draft_id, emissionReceipt.dispatch_id,
          { input_id: inputId, worker_id: task.id, worker_number: task.worker_number ?? null });
        if (shortcutReceipt) this.finishShortcutExecution(shortcutReceipt.command_id, shortcutReceipt.execution_id,
          shortcutReceipt.worker_id, 'succeeded', null,
          { created_worker_id: task.id, created_worker_number: task.worker_number, input_id: inputId });
        this.store.event(task.id, 'input.anchor', { input_id: inputId, branch: anchor.branch, commit: anchor.commit,
          target_branch: target, workspace: anchor.workspace, dirty_source: anchor.dirty_source, input_source: source });
        if (!start) {
          const eventId = this.store.event(task.id, 'task.start_pending', { input_id: inputId });
          this.notifyTaskLifecycle(task.id, eventId);
        }
        return { id: inputId, content, references: normalized, task: this.store.task(task.id), anchor,
          ...(draft ? { draft: draft.id } : {}) };
      });
      this.kick();
      return result;
    } catch (error) {
      if (ruleTaskId !== null) fs.rmSync(snapshotPath(this.config.home, ruleTaskId), { force: true });
      await this.workspaces.releaseAnchor(anchor)
        .catch(failure => console.error(`order O${inputId}: anchor cleanup failed: ${failure.message}`));
      throw error;
    }
  },
};
