import { randomUUID } from 'node:crypto';
import { check, id, TERMINAL } from '../types.js';
import { HOOK_LIMITS, HOOK_TRIGGERS, HOOK_ACTIONS, normalizeHook, publicHookDefinition, hookConditionsMatch, hookRevision, hookObject } from '../hooks.js';
import { assertTaskAncestorsOpen, assertTaskNotSyncing } from './iteration.js';
import { inheritedRunProfile } from './internal.js';
import { nextHookRun } from '../hook-schedule.js';

const empty = () => ({ version: 1, mounts: [], observed: {} });
const parse = task => task.hooks ? JSON.parse(task.hooks) : empty();
const now = () => new Date().toISOString();
const safeError = action => ({ create_worker: 'Worker 创建未完成；检查父分支、运行设置和现场，未自动重试。',
  request_merge: '合并请求未通过安全检查；请查看交付诊断。', message: '消息未通过目标身份或生命周期检查。', notify: '告知未保存。' })[action] || 'Hook 执行未完成，请检查现场。';
function save(project, taskId, state) { project.store.update(taskId, { hooks: JSON.stringify(state) }); }
function definitions(project) {
  return JSON.parse(project.store.get("SELECT value FROM meta WHERE key='hook_templates'")?.value ?? '{"version":1,"templates":[]}');
}
function writeDefinitions(project, state) {
  check(Buffer.byteLength(JSON.stringify(state)) <= 4 * HOOK_LIMITS.bytes, 'Hook template library exceeds 512 KiB');
  project.store.run("INSERT INTO meta(key,value) VALUES ('hook_templates',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", JSON.stringify(state));
}
function revision(project, task) { return hookRevision({ hooks: task.hooks ?? null, automatic: project.autoMergeView(task), completion: task.auto_merge ?? null }); }
function readDefinition(project, value) {
  const view = publicHookDefinition(value);
  view.actions = view.actions.map(action => ['message','retry_worker','resume_worker'].includes(action.type) ? { ...action,
    target_worker_number: project.store.get('SELECT worker_number FROM tasks WHERE id=?', action.target_id)?.worker_number ?? null,
  } : action);
  return view;
}
function readExecution(project, execution) {
  if (!execution) return null;
  return execution.worker_id ? { ...execution,
    worker_number: project.store.get('SELECT worker_number FROM tasks WHERE id=?', execution.worker_id)?.worker_number ?? null,
  } : execution;
}
function scheduledSelfRetry(hook, task) {
  return hook?.trigger === 'time.scheduled' && hook.actions.some(a => a.type === 'retry_worker' && a.target_id === task.id)
    && hook.actions.every(a => a.type === 'notify' || (a.type === 'retry_worker' && a.target_id === task.id));
}
function ownerAvailable(project, task, allowFailed = false) {
  if (!['main','owner','order','child'].includes(task.task_kind) || (TERMINAL.has(task.status)
    && !(allowFailed && task.status === 'failed' && ['order','child'].includes(task.task_kind)))) return false;
  if (task.branch && ['archived','deleted'].includes(project.store.branch(task.branch)?.status)) return false;
  try { assertTaskAncestorsOpen(project, task); return true; } catch { return false; }
}
function editable(project, task, hook = null, disabling = false) {
  project.assertWritable('configure a Hook');
  check(ownerAvailable(project, task, scheduledSelfRetry(hook, task) || (disabling && hook?.schedule)), 'only active Worker owners or failed Workers with scheduled self-retry support this Hook');
}
function checkRevision(actual, expected) { check(typeof expected === 'string' && actual === expected, 'Hook revision changed; reload before editing'); }
function definition(project, raw, task = null) {
  if (raw?.template_id !== undefined) {
    hookObject(raw, ['template_id'], 'template mount');
    const stored = definitions(project).templates.find(t => t.id === raw.template_id);
    check(stored, 'Hook template not found'); raw = stored.definition;
  }
  const value = normalizeHook(raw);
  value.actions = value.actions.map(action => {
    if (action.type === 'create_worker') {
      if (task) check(['main','owner','order'].includes(task.task_kind), 'this Worker cannot create independent order Workers');
      const references = project.normalizeReferences(action.references);
      let profile = action.profile;
      try {
        profile = profile ? project.agentSettings.retryProfile('agent', profile)
          : task ? inheritedRunProfile(project, { ...task, role: 'agent', retry_profile: null }) : undefined;
      } catch { throw new Error('Hook run settings are invalid or unavailable'); }
      return { ...action, references, ...(profile ? { profile } : {}) };
    }
    if (['message','retry_worker','resume_worker'].includes(action.type) && task) {
      const target = project.store.task(action.target_id);
      check(target.id === task.id || target.parent_id === task.id || task.parent_id === target.id, 'Hook messages require the current Worker or a direct parent/child');
      check(!['main','owner'].includes(target.task_kind), 'branch owners are not Agent inboxes');
      if (action.type !== 'message') check(['order','child'].includes(target.task_kind), 'only order/child Workers support scheduled restart');
    }
    if (['retry_worker','resume_worker'].includes(action.type) && action.profile !== undefined) {
      try { return { ...action, profile: project.agentSettings.retryProfile(task ? project.store.task(action.target_id).role : 'agent', action.profile) }; }
      catch { throw new Error('Hook run settings are invalid or unavailable'); }
    }
    if (action.type === 'request_merge' && task) check(['order','child'].includes(task.task_kind), 'only order/child Workers can request a merge');
    return action;
  });
  check(Buffer.byteLength(JSON.stringify(value)) <= HOOK_LIMITS.bytes, 'Hook configuration exceeds its size limit');
  return value;
}
function creationIdentity(mount) {
  const value = publicHookDefinition(mount);
  value.actions = mount.actions.map(action => ({ ...action, ...(action.references ? {
    references: action.references.map(({ captured_at, ...reference }) => reference),
  } : {}) }));
  return hookRevision(value);
}
function eligible(mount) { return mount.enabled && !['running','failed','unknown'].includes(mount.state)
  && !(mount.mode === 'once' && mount.state === 'succeeded'); }

export default {
  hooksList() {
    const data = definitions(this);
    return { version: 1, revision: hookRevision(data), daemon_hooks: this.daemonHooks(), signals: this.hookSignals(),
      management_workers: this.managementWorkers(), triggers: HOOK_TRIGGERS, actions: HOOK_ACTIONS,
      templates: data.templates.map(item => ({ id: item.id, ...readDefinition(this, item.definition) })) };
  },

  saveHookTemplate(template, expectedRevision) {
    this.assertWritable('save a Hook template');
    hookObject(template, ['id','name','trigger','mode','enabled','conditions','actions','schedule'], 'Hook template');
    const { id: templateId, ...raw } = template;
    // Public templates deliberately omit private profiles. Editing a name or condition must not
    // silently replace an existing model/Prompt/env selection with the current project default.
    if (templateId !== undefined) {
      const stored = definitions(this).templates.find(item => item.id === templateId);
      check(stored, 'Hook template not found');
      if (Array.isArray(raw.actions)) raw.actions = raw.actions.map((action, index) => {
        const old = stored.definition.actions[index];
        return ['create_worker','retry_worker','resume_worker'].includes(action?.type) && action.profile === undefined && old?.type === action.type && old.profile
          ? { ...action, profile: old.profile } : action;
      });
    }
    const normalized = definition(this, raw);
    this.store.transaction(() => {
      const data = definitions(this); checkRevision(hookRevision(data), expectedRevision);
      const index = data.templates.findIndex(t => t.id === templateId);
      if (templateId !== undefined) check(index >= 0, 'Hook template not found');
      else check(data.templates.length < HOOK_LIMITS.templates, 'too many Hook templates');
      const item = { id: templateId ?? randomUUID(), definition: normalized };
      if (index >= 0) data.templates[index] = item; else data.templates.push(item);
      writeDefinitions(this, data);
    });
    return this.hooksList();
  },

  removeHookTemplate(templateId, expectedRevision) {
    this.assertWritable('remove a Hook template');
    this.store.transaction(() => {
      const data = definitions(this); checkRevision(hookRevision(data), expectedRevision);
      const index = data.templates.findIndex(t => t.id === templateId); check(index >= 0, 'Hook template not found');
      data.templates.splice(index, 1); writeDefinitions(this, data);
    });
    return this.hooksList();
  },

  taskHooks(taskId) {
    const task = this.store.task(id(taskId)), data = parse(task), automatic = this.autoMergeView(task);
    const available = ownerAvailable(this, task);
    const mounts = data.mounts.map(m => ({ id: m.id, ...readDefinition(this, m), builtin: false, locked: false,
      editable: (available || (ownerAvailable(this, task, true) && (scheduledSelfRetry(m, task) || (m.schedule && m.enabled)))) && m.state !== 'running', removable: ['main','owner','order','child'].includes(task.task_kind) && m.state !== 'running', reason: m.state === 'running' ? 'Hook 已领取执行，不能修改' : !available && !(ownerAvailable(this, task, true) && scheduledSelfRetry(m, task)) ? 'Worker 已结束或归档' : m.reason ?? null,
      state: m.state, last_execution: readExecution(this, m.last_execution),
      ...(m.schedule ? { next_run_at: m.next_run_at ?? null, pending_due_at: m.pending_due_at ?? null } : {}),
      ...(m.actions.find(a => a.type === 'create_worker')?.profile ? { model_selection: publicHookDefinition(m).actions.find(a => a.type === 'create_worker').model_selection } : {}) }));
    if (automatic) {
      const booking = task.reservation ? JSON.parse(task.reservation) : null;
      mounts.unshift({ id: 'auto-merge', name: '自动合并', trigger: 'worker.delivery_ready', mode: 'persistent',
        enabled: automatic.enabled, builtin: true, locked: automatic.locked, editable: automatic.editable, removable: false, reason: automatic.reason,
        conditions: {}, actions: [{ type: 'request_merge' }], state: booking?.status === 'integrated' ? 'succeeded'
          : ['executing','resolving','blocked'].includes(booking?.status) ? 'running' : automatic.enabled ? 'waiting' : 'idle',
        last_execution: booking?.delivery_id ? { id: booking.delivery_id, trigger: 'worker.delivery_ready', status: booking.status,
          created_at: booking.requested_at ?? booking.created_at, finished_at: booking.integrated_at ?? null } : null });
    }
    const completion = this.autoCompletionView(task);
    if (completion && mounts[0]?.id === 'auto-merge') {
      const receipt = this.completionMountState(task, 'merge');
      if (receipt.last_execution) Object.assign(mounts[0], receipt);
    }
    if (completion) for (const [phase, name, trigger, type, threshold] of [
      ['accept', '自动验收', 'delivery.integrated', 'accept_worker', 2],
      ['archive', '自动归档', 'worker.accepted', 'archive_worker', 3],
    ]) {
      const status = this.completionMountState(task, phase);
      mounts.splice(threshold - 1, 0, { id: `auto-${phase}`, name, trigger, mode: 'persistent',
        enabled: ['off','merge','accept','archive'].indexOf(completion.level) >= threshold,
        builtin: true, locked: false, editable: false, removable: false,
        conditions: {}, actions: [{ type }], ...status,
        reason: status.reason ?? '通过最高自动级别统一设置，仍需前一步与现有安全检查通过' });
    }
    return { version: 1, worker_id: task.id, revision: revision(this, task), completion, can_attach: ownerAvailable(this, task, true), mounts };
  },

  attachTaskHook(taskId, raw, expectedRevision) {
    const task = this.store.task(id(taskId));
    const value = definition(this, raw, task); editable(this, task, value);
    const next = value.schedule ? nextHookRun(value.schedule, this.hookClock()) : null;
    check(!value.schedule || value.schedule.kind !== 'once' || next, 'one-shot schedule must be in the future when mounted');
    this.store.transaction(() => {
      const current = this.store.task(task.id); checkRevision(revision(this, current), expectedRevision);
      const data = parse(current); check(data.mounts.length < HOOK_LIMITS.mounts, 'too many mounted Hooks');
      check(this.store.get("SELECT count(*) AS n FROM tasks WHERE hooks IS NOT NULL").n < 500 || current.hooks,
        'too many Workers with mounted Hooks (limit 500)');
      data.mounts.push({ ...value, id: randomUUID(), state: value.trigger === 'worker.parent_ready' || value.schedule ? 'waiting' : 'idle', created_at: now(), last_execution: null,
        ...(value.schedule ? { next_run_at: next, pending_due_at: null } : {}) });
      check(Buffer.byteLength(JSON.stringify(data)) <= HOOK_LIMITS.bytes, 'mounted Hooks exceed size limit');
      save(this, task.id, data);
      this.store.event(task.id, 'hook.attached', { hook_id: data.mounts.at(-1).id, trigger: value.trigger, name: value.name });
    });
    this.scheduleTaskHooks();
    return this.taskHooks(task.id);
  },

  async updateTaskHook(taskId, hookId, enabled, expectedRevision) {
    check(typeof enabled === 'boolean', 'Hook enabled must be boolean');
    const task = this.store.task(id(taskId)), existing = parse(task).mounts.find(m => m.id === hookId);
    editable(this, task, existing, !enabled); checkRevision(revision(this, task), expectedRevision);
    if (hookId === 'auto-merge') { await this.setTaskAutoMerge(task.id, enabled); return this.taskHooks(task.id); }
    this.store.transaction(() => {
      const data = parse(this.store.task(task.id)), mount = data.mounts.find(m => m.id === hookId); check(mount, 'Hook mount not found');
      check(mount.state !== 'running', 'Hook is executing; wait for its result');
      check(!enabled || !['failed','unknown'].includes(mount.state), 'Hook effects require inspection; mount a new explicitly authorized rule instead of replaying');
      check(!enabled || mount.mode !== 'once' || !['succeeded','skipped'].includes(mount.state), 'one-shot Hook already executed or skipped; mount a new rule instead of replaying');
      if (enabled && !mount.enabled && mount.schedule && !mount.pending_due_at) {
        const clock = this.hookClock();
        mount.next_run_at = nextHookRun(mount.schedule, Math.max(clock, Date.parse(mount.last_due_at ?? '') || clock));
        check(mount.next_run_at, 'one-shot schedule has expired; mount a new future rule');
      }
      mount.enabled = enabled; save(this, task.id, data); this.store.event(task.id, 'hook.enabled', { hook_id: hookId, enabled });
    });
    this.scheduleTaskHooks(); return this.taskHooks(task.id);
  },

  removeTaskHook(taskId, hookId, expectedRevision) {
    // Removing future authorization does not write a branch or revive an ended Worker.
    // Keep this release path available when a cancelled/accepted parent holds a draft.
    this.assertWritable('remove a Hook');
    const task = this.store.task(id(taskId));
    check(['main','owner','order','child'].includes(task.task_kind), 'this Worker does not support Hooks');
    checkRevision(revision(this, task), expectedRevision);
    check(hookId !== 'auto-merge', 'built-in automatic merge cannot be removed; use its persistent switch');
    this.store.transaction(() => {
      const data = parse(this.store.task(task.id)), index = data.mounts.findIndex(m => m.id === hookId); check(index >= 0, 'Hook mount not found');
      check(data.mounts[index].state !== 'running', 'Hook is executing; wait for its result');
      data.mounts.splice(index, 1);
      if (data.mounts.length) save(this, task.id, data); else this.store.update(task.id, { hooks: null });
      this.store.event(task.id, 'hook.removed', { hook_id: hookId });
    });
    this.scheduleTaskHooks();
    return this.taskHooks(task.id);
  },

  /** Stable parent identity can be mounted while its branch is temporarily frozen. */
  hookParentReady(taskId) {
    try {
      const parent = this.assertInputParent(taskId); assertTaskNotSyncing(this, parent.id);
      this.assertBranchWritable(parent.branch, 'create a Hook Worker');
      check(!this.activeTaskMerge(parent.id), 'parent execution slot occupied');
      return true;
    } catch { return false; }
  },

  hookDeliveryReady(task) {
    return ['order','child'].includes(task.task_kind) && task.status === 'waiting' && Boolean(task.head_commit)
      && !this.reservationWaitReason(task) && !this.branchFreeze(task.branch)
      && !this.store.get("SELECT id FROM notices WHERE task_id=? AND status='open' LIMIT 1", task.id);
  },

  /** Persist claims before dispatch; reads never call this. */
  emitTaskHook(taskId, trigger, sourceId = null, pendingOnly = false) {
    if (trigger === 'time.scheduled' || this.stopping || this.clearing || this.workerDeleteIds?.size) return;
    if (this.recoveringHooks) { (this.hookRecoveryEvents ??= []).push([taskId, trigger, sourceId]); return; }
    const task = this.store.task(taskId); if (!task.hooks) return;
    const data = parse(task), mounts = data.mounts.filter(m => m.trigger === trigger && eligible(m) && hookConditionsMatch(m, task)
      && (!pendingOnly || m.mode === 'once' || !m.last_execution));
    if (!mounts.length) return;
    const eventId = sourceId ?? this.store.event(task.id, 'hook.triggered', { trigger });
    for (const mount of mounts) {
      if (mount.last_source === `${trigger}:${eventId}`) continue;
      const executionId = this.store.transaction(() => {
        const executionId = this.store.event(task.id, 'hook.execution_started', { hook_id: mount.id, trigger, source_id: eventId });
        mount.state = 'running'; mount.last_source = `${trigger}:${eventId}`;
        mount.last_execution = { id: executionId, trigger, status: 'running', created_at: now(), finished_at: null };
        mount.receipts = []; save(this, task.id, data);
        return executionId;
      });
      const previous = this.hookQueue ?? Promise.resolve();
      const job = previous.then(async () => {
        this.hookBatchCount = ((this.hookBatchCount ?? 0) + 1) % HOOK_LIMITS.batch;
        if (this.hookBatchCount === 0) await new Promise(resolve => setImmediate(resolve));
        await this.runTaskHook(task.id, mount.id, executionId);
      });
      this.hookQueue = job.catch(() => {});
    }
  },

  async runTaskHook(taskId, hookId, executionId) {
    if (this.stopping) return; // recovery diagnoses the persisted unexecuted claim, never blindly replays
    let actionType = null;
    try {
      await this.write('execute a Hook', async () => {
        for (let index = 0; ; index += 1) {
          const task = this.store.task(taskId), mount = parse(task).mounts.find(m => m.id === hookId);
          if (!mount || mount.last_execution?.id !== executionId || mount.state !== 'running') return;
          const action = mount.actions[index]; if (!action) break;
          actionType = action.type;
          if (this.stopping) return;
          let outcome = {};
          if (action.type === 'create_worker') {
            const parent = this.assertInputParent(taskId); check(this.hookParentReady(taskId), 'parent no longer ready');
            const receipt = { task_id: taskId, hook_id: hookId, execution_id: executionId, action_index: index };
            const result = await this.sendOrder(action.content, parent.branch, action.references, null, action.start, undefined, action.profile ?? null, false, receipt);
            outcome = { worker_id: result.task.id, input_id: result.id };
          } else if (action.type === 'request_merge') {
            check(this.mergeReadiness(task)?.ready, 'source is not delivery-ready'); await this.requestTaskMerge(task.id);
          } else {
            // These DB-only effects and their receipts commit atomically, so restart cannot duplicate them.
            this.store.transaction(() => {
              if (action.type === 'notify') outcome = { notice_id: this.notify(taskId, action.title, action.body).id };
              else {
                const target = this.store.task(action.target_id);
                check(target.id === task.id || target.parent_id === task.id || task.parent_id === target.id, 'Hook relationship changed');
                this.message(target.id, action.body); // user-authorized rule, still uses ordinary target safety checks
              }
              this.recordHookAction(taskId, hookId, executionId, index, outcome);
            });
            continue;
          }
          this.recordHookAction(taskId, hookId, executionId, index, outcome);
        }
        this.finishTaskHook(taskId, hookId, executionId, 'succeeded');
      });
    } catch { this.finishTaskHook(taskId, hookId, executionId, 'failed', safeError(actionType)); }
  },

  recordHookAction(taskId, hookId, executionId, index, outcome) {
    const data = parse(this.store.task(taskId)), mount = data.mounts.find(m => m.id === hookId);
    check(mount?.last_execution?.id === executionId && mount.state === 'running', 'Hook execution changed');
    if (!mount.receipts.some(r => r.index === index)) mount.receipts.push({ index, ...outcome });
    Object.assign(mount.last_execution, outcome); save(this, taskId, data);
    this.store.event(taskId, 'hook.action_completed', { hook_id: hookId, execution_id: executionId, index, ...outcome });
  },

  finishTaskHook(taskId, hookId, executionId, status, error = null) {
    this.store.transaction(() => {
      const data = parse(this.store.task(taskId)), mount = data.mounts.find(m => m.id === hookId);
      if (!mount || mount.last_execution?.id !== executionId) return;
      mount.state = status; mount.reason = error;
      if (mount.mode === 'once' && status === 'succeeded') mount.enabled = false;
      Object.assign(mount.last_execution, { status, finished_at: now(), ...(error ? { error } : {}) });
      save(this, taskId, data); this.store.event(taskId, `hook.execution_${status}`, { hook_id: hookId, execution_id: executionId, error });
    });
  },

  scheduleTaskHooks() {
    if (this.stopping || this.hookScheduled) return;
    this.hookScheduled = true;
    queueMicrotask(() => { this.hookScheduled = false; if (!this.stopping) this.observeTaskHooks(); });
  },

  /** Runtime state edges, bounded by the number of mounted Workers, not UI polling. */
  observeTaskHooks(taskId = null, parentBoundary = false) {
    if (this.stopping || this.clearing || this.workerDeleteIds?.size) return;
    const tasks = taskId === null ? this.store.all('SELECT * FROM tasks WHERE hooks IS NOT NULL ORDER BY id')
      : this.store.all('SELECT * FROM tasks WHERE id=? AND hooks IS NOT NULL', taskId);
    for (const task of tasks) {
      const data = parse(task), previous = data.observed;
      const current = { frozen: Boolean(task.branch && this.branchFreeze(task.branch)),
        awaiting: Boolean(this.store.get("SELECT id FROM notices WHERE task_id=? AND status='open' LIMIT 1", task.id)),
        ready: this.hookDeliveryReady(task), parent: this.hookParentReady(task.id) };
      if (JSON.stringify(current) !== JSON.stringify(previous)) { data.observed = current; save(this, task.id, data); }
      if (current.frozen && previous.frozen !== true) this.emitTaskHook(task.id, 'worker.frozen');
      if (!current.frozen && previous.frozen === true) this.emitTaskHook(task.id, 'worker.unfrozen');
      if (current.awaiting && previous.awaiting !== true) this.emitTaskHook(task.id, 'worker.awaiting');
      if (!current.awaiting && previous.awaiting === true) this.emitTaskHook(task.id, 'worker.resumed');
      if (current.ready && previous.ready !== true) this.emitTaskHook(task.id, 'worker.delivery_ready');
      // A new one-shot mount can be attached while a parent is already writable.
      if (current.parent && (parentBoundary || !this.taskMergeBusy?.has(task.id))) this.emitTaskHook(task.id, 'worker.parent_ready', null, previous.parent === true);
    }
    this.observeScheduledTaskHooks(taskId);
  },

  async runParentReadyHooks(parentId) {
    if (this.stopping) return;
    this.observeTaskHooks(parentId, true);
    if (!this.hookParentReady(parentId)) return;
    this.emitTaskHook(parentId, 'worker.parent_ready', null, true);
    await this.hookQueue;
  },

  recoverTaskHooks() {
    this.recoverScheduledTaskHooks();
    for (const task of this.store.all('SELECT * FROM tasks WHERE hooks IS NOT NULL')) {
      for (const mount of parse(task).mounts) if (mount.state === 'running' && !mount.schedule) {
        const created = this.store.get("SELECT data FROM events WHERE task_id=? AND type='hook.worker_created' AND json_extract(data,'$.execution_id')=? ORDER BY id DESC LIMIT 1", task.id, mount.last_execution.id);
        // Only a complete single create action is an exact sufficient recovery proof.
        if (created && mount.actions.length === 1 && mount.actions[0].type === 'create_worker') {
          const result = JSON.parse(created.data);
          this.recordHookAction(task.id, mount.id, mount.last_execution.id, 0, { worker_id: result.worker_id, input_id: result.input_id });
          this.finishTaskHook(task.id, mount.id, mount.last_execution.id, 'succeeded');
        } else this.finishTaskHook(task.id, mount.id, mount.last_execution.id, 'unknown', '后台中断；动作可能已生效，保留现场并禁止自动重放。');
      }
    }
    this.recoveringHooks = false;
    for (const [taskId, trigger, sourceId] of this.hookRecoveryEvents ?? []) this.emitTaskHook(taskId, trigger, sourceId);
    this.hookRecoveryEvents = [];
    this.scheduleTaskHooks();
  },

  /** A draft remains a draft while mounted, but cannot be edited or fired twice. */
  draftHookMountMap() {
    const mounted = new Map();
    for (const task of this.store.all('SELECT id,hooks FROM tasks WHERE hooks IS NOT NULL')) {
      for (const mount of parse(task).mounts) if (mount.draft_id && !mounted.has(mount.draft_id)
        && ((mount.enabled && mount.state !== 'succeeded') || ['running','unknown'].includes(mount.state)))
        mounted.set(mount.draft_id, { parent_id: task.id, hook_id: mount.id, state: mount.state });
    }
    return mounted;
  },

  draftHookMount(draftId) { return this.draftHookMountMap().get(draftId) ?? null; },

  deferOrderHook(parent, content, references, profile, start, draft = null) {
    if (draft) check(!this.draftHookMount(draft.id), 'draft is already mounted on a Hook; remove that mount before editing or sending');
    const value = definition(this, { name: '预约发射 Worker', trigger: 'worker.parent_ready', mode: 'once', enabled: true,
      conditions: {}, actions: [{ type: 'create_worker', content, references, start, ...(profile ? { profile } : {}) }] }, parent);
    if (!draft) {
      const existing = parse(this.store.task(parent.id)).mounts.find(m => eligible(m)
        && m.trigger === 'worker.parent_ready' && creationIdentity(m) === creationIdentity(value));
      if (existing) return { deferred: true, parent_id: parent.id, hook_id: existing.id, hooks: this.taskHooks(parent.id) };
    }
    const before = this.taskHooks(parent.id);
    this.attachTaskHook(parent.id, value, before.revision);
    const data = parse(this.store.task(parent.id)), mount = data.mounts.at(-1);
    if (draft) { mount.draft_id = draft.id; mount.draft_revision = draft.revision; save(this, parent.id, data); }
    return { deferred: true, parent_id: parent.id, hook_id: mount.id, hooks: this.taskHooks(parent.id) };
  },
};
