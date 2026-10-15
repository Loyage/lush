import { randomUUID } from 'node:crypto';
import { check, id, isPlainObject, text } from '../types.js';
import { expectedRevision, checkDraftRevision } from './input-history.js';
import { inheritedRunProfile } from './internal.js';
import { inputOptions, inputEmission, saveEmission, emissionLocked, normalizeInputOptions, requestKey,
  definitionHash, attachInputSignal, removeInputSignals, hookData, publicDispatch, INPUT_EMISSION_LIMIT } from './input-emission-data.js';
import { roundEvent } from './input-emission-safety.js';

function wait(reason) { const error = new Error(reason); error.inputEmissionWait = true; throw error; }
const pending = state => state && ['waiting_conditions','queued'].includes(state.state);

export default {
  draftEmissionView(draft) {
    const options = inputOptions(draft), state = inputEmission(draft);
    const target = options.target_id ? this.store.get('SELECT worker_number FROM tasks WHERE id=?', options.target_id) : null;
    return { mode: options.mode, target_id: options.target_id ?? null, target_worker_number: target?.worker_number ?? null,
      conditions: options.conditions, exclusive: options.exclusive, dispatch: publicDispatch(state) };
  },

  inputEmissionResult(draftId) {
    const draft = this.store.draft(draftId), options = inputOptions(draft);
    return { emitted: true, draft_id: draft.id, mode: options.mode, parent_id: draft.parent_id,
      ...(options.target_id ? { target_id: options.target_id } : {}), dispatch: publicDispatch(inputEmission(draft)), revision: draft.revision };
  },

  emitBufferedInput(options) {
    return this.write('mount an input', async () => {
      check(isPlainObject(options) && Object.keys(options).every(key => ['content','references','branch','mode','target_id','conditions','exclusive','profile','client_request_id','draft_id','expected_revision'].includes(key)), 'invalid input emission fields');
      const key = requestKey(options.client_request_id), hash = definitionHash(options);
      if (key) {
        const prior = this.store.get("SELECT data FROM events WHERE type='input.emitted' AND json_extract(data,'$.request_key')=? ORDER BY id DESC LIMIT 1", key);
        if (prior) {
          const receipt = JSON.parse(prior.data);
          check(receipt.definition_hash === hash, 'client_request_id was used for different input');
          return this.inputEmissionResult(receipt.draft_id);
        }
      }
      let draft;
      if (options.draft_id !== undefined) {
        check(Object.keys(options).every(key => ['draft_id','expected_revision','profile','client_request_id'].includes(key)), 'draft_id cannot be combined with content or input options; edit the draft first');
        expectedRevision(options.expected_revision);
        draft = this.store.draft(id(options.draft_id));
        const existing = inputEmission(draft);
        if (existing && existing.revision === options.expected_revision && existing.state !== 'cancelled') {
          check(existing.definition_hash === hash, 'mounted input parameters changed; do not replace an existing authorization');
          return this.inputEmissionResult(draft.id);
        }
        checkDraftRevision(draft, options.expected_revision);
      } else {
        check(options.expected_revision === undefined, 'expected_revision requires draft_id');
        text(options.content, 'input');
        const fields = Object.fromEntries(['mode','target_id','conditions','exclusive'].filter(key => options[key] !== undefined).map(key => [key, options[key]]));
        // Validate everything before buffering: failed dispatch authorization must not consume the caller's text.
        const normalized = normalizeInputOptions(this, fields);
        const references = this.normalizeReferences(options.references ?? []);
        check(normalized.mode !== 'append' || references.length === 0, 'append references are not supported; retain the text and attachments');
        if (normalized.mode === 'append') this.assertAppendInputTarget(normalized.target_id);
        if (options.profile !== undefined && options.profile !== null) this.agentSettings.retryProfile('agent', options.profile);
        draft = await this.addBufferedDraft(options.content, references, options.branch ?? 'main', fields);
        draft = this.store.draft(draft.id);
      }
      const normalized = inputOptions(draft), references = this.store.draftReferences(draft.id);
      check(!this.draftHookMount(draft.id), 'draft is already mounted on a legacy Hook');
      check(!emissionLocked(draft), 'draft already has an input emission');
      check(draft.parent_id !== null, 'legacy draft has no saved parent Worker; edit it before emitting');
      const parent = this.assertInputParent(draft.parent_id);
      if (normalized.mode === 'append') {
        this.assertAppendInputTarget(normalized.target_id);
        check(references.length === 0, 'append references are not supported; retain the text and attachments');
        check(options.profile === undefined || options.profile === null, 'append inputs use the target Worker run settings');
      }
      const profile = normalized.mode === 'order'
        ? options.profile === undefined || options.profile === null
          ? inheritedRunProfile(this, { ...parent, role: 'agent', retry_profile: null })
          : this.agentSettings.retryProfile('agent', options.profile)
        : null;
      return this.store.transaction(() => {
        // Recheck keyed identity after awaiting parent/profile resolution and competing tabs.
        if (key) {
          const prior = this.store.get("SELECT data FROM events WHERE type='input.emitted' AND json_extract(data,'$.request_key')=? ORDER BY id DESC LIMIT 1", key);
          if (prior) {
            const receipt = JSON.parse(prior.data); check(receipt.definition_hash === hash, 'client_request_id was used for different input');
            // A racing direct-path temporary draft is unmounted and can be safely discarded.
            if (options.draft_id === undefined && draft.id !== receipt.draft_id) {
              this.store.run('DELETE FROM draft_references WHERE draft_id=?', draft.id); this.store.run('DELETE FROM drafts WHERE id=?', draft.id);
            }
            return this.inputEmissionResult(receipt.draft_id);
          }
        }
        checkDraftRevision(this.store.draft(draft.id), draft.revision);
        check(!emissionLocked(this.store.draft(draft.id)), 'draft already has an input emission');
        check(this.store.get("SELECT count(*) AS n FROM drafts WHERE emission IS NOT NULL AND json_extract(emission,'$.state') IN ('waiting_conditions','queued','dispatching')").n < INPUT_EMISSION_LIMIT, 'too many mounted inputs');
        const signals = normalized.conditions.map(condition => ({ ...condition, satisfied: false,
          ...(condition.worker_id ? { snapshot: roundEvent(this, condition.worker_id) } : {}) }));
        const state = { version: 1, revision: draft.revision, state: signals.length ? 'waiting_conditions' : 'queued',
          signals, profile, definition_hash: hash, created_at: new Date().toISOString(), reason: signals.length ? '等待发射条件全部满足' : '已挂载，等待父 Worker 安全空闲',
          exclusive_active: false, exclusive_released: false };
        for (let index = 0; index < signals.length; index++)
          signals[index].mount = attachInputSignal(this, draft.id, index, signals[index], signals[index].snapshot ?? 0,
            signals[index].worker_id ?? this.inputRoot(parent).id);
        saveEmission(this, draft.id, state);
        this.store.event(parent.id, 'input.emitted', { draft_id: draft.id, revision: draft.revision, mode: normalized.mode,
          ...(key ? { request_key: key, definition_hash: hash } : {}), conditions: normalized.conditions, exclusive: normalized.exclusive });
        this.scheduleInputEmissions();
        return this.inputEmissionResult(draft.id);
      });
    });
  },

  cancelInputEmission(draftId, revision) {
    this.assertWritable('cancel pending input emission'); expectedRevision(revision);
    return this.store.transaction(() => {
      const draft = this.store.draft(id(draftId));
      check(draft.revision === revision, 'draft changed; reload its latest revision');
      const state = inputEmission(draft);
      check(state && ['waiting_conditions','queued','failed','cancelled'].includes(state.state), 'input has started or its result is unknown; inspect its receipt before changing authorization');
      if (state.state !== 'cancelled') {
        state.state = 'cancelled'; state.reason = '已撤销未来发射，保留原文'; state.exclusive_active = false;
        removeInputSignals(this, draft.id); saveEmission(this, draft.id, state);
        this.store.event(draft.parent_id, 'input.emission_cancelled', { draft_id: draft.id });
        this.kick();
      }
      return this.inputEmissionResult(draft.id);
    });
  },

  scheduleInputEmissions() {
    if (this.recoveringHooks) return;
    this.runtimeCoordinator.request('inputs');
  },

  recordInputDispatch(draftId, dispatchId, outcome) {
    const draft = this.store.draft(draftId), state = inputEmission(draft);
    check(state?.state === 'dispatching' && state.dispatch_id === dispatchId, 'input dispatch authorization changed');
    Object.assign(state, outcome, { state: 'succeeded', finished_at: new Date().toISOString(), reason: null });
    if (outcome.input_id) this.store.run('UPDATE drafts SET input_id=? WHERE id=?', outcome.input_id, draft.id);
    saveEmission(this, draft.id, state); removeInputSignals(this, draft.id);
    this.store.event(draft.parent_id, 'input.dispatch_succeeded', { draft_id: draft.id, dispatch_id: dispatchId, ...outcome });
  },

  assertInputDispatch(draftId, dispatchId) {
    const draft = this.store.draft(draftId), state = inputEmission(draft), options = inputOptions(draft);
    check(state?.state === 'dispatching' && state.dispatch_id === dispatchId && state.revision === draft.revision, 'input dispatch authorization changed');
    check(!this.stopping && !this.maintenancePaused(), 'input dispatch stopped before creation');
    const reason = this.inputCreationReason(draft.parent_id, draft.id);
    if (reason) wait(reason);
    if (options.conditions.some(condition => condition.kind === 'parent_quiet')) {
      const quiet = this.inputQuietStateReason(this.inputRoot(draft.parent_id).id, null, options.exclusive);
      if (quiet) wait(quiet);
    }
  },

  async satisfyInputSignal(draftId, index) {
    const draft = this.store.draft(draftId), state = inputEmission(draft), signal = state?.signals[index];
    if (!pending(state) || !signal || signal.satisfied || !signal.worker_id) return;
    const task = this.store.get('SELECT * FROM tasks WHERE id=?', signal.worker_id);
    if (!task || task.status === 'cancelled') throw new Error('condition Worker no longer exists or was cancelled');
    const observedRound = roundEvent(this, task.id), observedHead = task.head_commit;
    const satisfied = signal.kind === 'worker_merged' ? await this.inputWorkerMergedToMain(task, signal.snapshot)
      : this.inputWorkerSettled(task, signal.snapshot) && await this.inputWorkspaceClean(task);
    if (!satisfied) return;
    this.store.transaction(() => {
      const live = this.store.draft(draftId), current = inputEmission(live);
      if (!pending(current) || current.signals[index]?.satisfied) return;
      // Git checks await; do not latch an old round after a new message or invocation arrived.
      const source = this.store.task(signal.worker_id);
      if (!this.inputWorkerSettled(source, signal.snapshot) || source.head_commit !== observedHead || roundEvent(this, source.id) !== observedRound) return;
      const eventId = this.store.event(source.id, 'input.condition_satisfied', { draft_id: draftId, condition_index: index, kind: signal.kind });
      current.signals[index].satisfied = true; current.signals[index].event_id = eventId;
      saveEmission(this, draftId, current);
      const data = hookData(source), mounted = data.mounts.find(mount => mount.id === signal.mount?.hook_id);
      if (mounted) {
        mounted.state = 'succeeded'; mounted.enabled = false;
        mounted.last_execution = { id: eventId, trigger: mounted.trigger, status: 'succeeded', created_at: new Date().toISOString(), finished_at: new Date().toISOString() };
        this.store.update(source.id, { hooks: JSON.stringify(data) });
        this.removeSucceededTaskHook(source.id, mounted.id);
      }
    });
  },

  async drainInputEmissions() {
    if (this.stopping || this.maintenancePaused() || this.clearing || this.workerDeleteIds?.size || this.settingsMigrationApplying) return;
    // Release only a finished, proven-safe exclusive result. Failures/unknown/awaiting keep the lease visible.
    for (const exclusive of this.activeInputExclusive()) {
      if (exclusive.state !== 'succeeded' || !exclusive.worker_id) continue;
      const task = this.store.get('SELECT * FROM tasks WHERE id=?', exclusive.worker_id);
      const delivered = task && this.inputWorkerSettled(task) && await this.inputWorkspaceClean(task)
        && (await this.inputWorkerMergedToMain(task) || (task.head_commit === task.base_commit && this.inputWorkerSettled(task)));
      if (delivered) {
        const state = inputEmission(this.store.draft(exclusive.draft_id)); state.exclusive_active = false; state.exclusive_released = true;
        saveEmission(this, exclusive.draft_id, state); this.kick();
      }
    }
    const rows = this.store.all("SELECT id FROM drafts WHERE emission IS NOT NULL AND json_extract(emission,'$.state') IN ('waiting_conditions','queued') ORDER BY id LIMIT ?", INPUT_EMISSION_LIMIT);
    for (const row of rows) {
      if (this.stopping || this.maintenancePaused()) break;
      let state = inputEmission(this.store.draft(row.id));
      if (!pending(state)) continue;
      try {
        for (let index = 0; index < state.signals.length; index++) await this.satisfyInputSignal(row.id, index);
        const draft = this.store.draft(row.id), options = inputOptions(draft);
        state = inputEmission(draft);
        if (!pending(state)) continue;
        let reason = null;
        if (options.mode === 'append') {
          const target = this.assertAppendInputTarget(options.target_id);
          if (this.taskSyncBusy?.has(target.id) || this.workspaces.busy.has(target.id)) reason = '追加目标正在同步或清理，等待安全点';
        } else this.assertInputParent(draft.parent_id);
        if (state.signals.some(signal => signal.worker_id && !signal.satisfied)) reason = '等待所选 Worker 条件全部满足';
        if (!reason && state.signals.some(signal => signal.kind === 'parent_quiet')) reason = await this.inputParentQuiet(this.inputRoot(draft.parent_id).id, null, options.exclusive);
        if (!reason && options.mode === 'order') reason = this.inputCreationReason(draft.parent_id, draft.id);
        if (reason) {
          const current = inputEmission(this.store.draft(draft.id));
          if (pending(current)) {
            current.state = current.signals.some(signal => signal.worker_id && !signal.satisfied) || (current.signals.some(signal => signal.kind === 'parent_quiet') && reason !== '父 Worker 正忙，等待可创建安全点') ? 'waiting_conditions' : 'queued';
            current.reason = reason; saveEmission(this, draft.id, current);
          }
          continue;
        }
        const claim = this.store.transaction(() => {
          const live = this.store.draft(draft.id), current = inputEmission(live);
          if (!pending(current)) return null;
          current.state = 'dispatching'; current.reason = '正在安全投递'; current.dispatch_id = randomUUID();
          if (options.exclusive && !current.exclusive_released) current.exclusive_active = true;
          for (const signal of current.signals) if (signal.kind === 'parent_quiet') signal.satisfied = true;
          saveEmission(this, live.id, current);
          this.store.event(live.parent_id, 'input.dispatch_started', { draft_id: live.id, dispatch_id: current.dispatch_id });
          return current;
        });
        if (!claim) continue;
        if (options.mode === 'append') {
          this.store.transaction(() => {
            const before = this.store.get('SELECT max(id) AS id FROM messages')?.id ?? 0;
            this.message(options.target_id, draft.content);
            const message = this.store.get('SELECT id,append_number FROM messages WHERE task_id=? AND id>? ORDER BY id DESC LIMIT 1', options.target_id, before);
            check(message, 'input append receipt missing');
            this.recordInputDispatch(draft.id, claim.dispatch_id, { message_id: message.id, append_number: message.append_number, worker_id: options.target_id,
              worker_number: this.store.task(options.target_id).worker_number ?? null });
          });
        } else {
          const parent = this.assertInputParent(draft.parent_id);
          await this.write('dispatch mounted input', () => this.sendOrder(draft.content, parent.branch, this.store.draftReferences(draft.id), null, true, undefined,
            claim.profile ?? null, false, null, () => this.assertInputDispatch(draft.id, claim.dispatch_id), null,
            { draft_id: draft.id, dispatch_id: claim.dispatch_id }));
        }
      } catch (error) {
        const current = inputEmission(this.store.draft(row.id));
        if (!current || ['succeeded','cancelled'].includes(current.state)) continue;
        current.state = error.inputEmissionWait ? 'queued' : 'failed';
        current.reason = error.inputEmissionWait ? error.message : '发射未通过条件、目标或运行设置检查；原文保留，请检查现场。';
        current.exclusive_active = false;
        saveEmission(this, row.id, current);
        this.store.event(this.store.draft(row.id).parent_id, 'input.dispatch_failed', { draft_id: row.id, retryable_gate: Boolean(error.inputEmissionWait) });
      }
    }
  },

  recoverInputEmissions() {
    for (const draft of this.store.all('SELECT * FROM drafts WHERE emission IS NOT NULL')) {
      const state = inputEmission(draft);
      if (state.state !== 'dispatching') continue;
      const receipt = this.store.get("SELECT data FROM events WHERE type='input.dispatch_succeeded' AND json_extract(data,'$.draft_id')=? AND json_extract(data,'$.dispatch_id')=? ORDER BY id DESC LIMIT 1", draft.id, state.dispatch_id);
      if (receipt) Object.assign(state, JSON.parse(receipt.data), { state: 'succeeded', reason: null });
      else { state.state = 'unknown'; state.reason = '后台中断；发射副作用未知，保留现场且不自动重放'; }
      saveEmission(this, draft.id, state);
    }
    this.scheduleInputEmissions();
  },
};
