import { randomUUID } from 'node:crypto';
import { check, id, text, TERMINAL } from '../types.js';
import { hookObject, hookRevision, normalizeHook, HOOK_LIMITS } from '../hooks.js';
import { commandAdmission } from './command-hooks.js';
import { commandHistory, executionSnapshot, recoverCommandHistory, safeCommandResult } from './shortcut-command-history.js';

const KEY = 'shortcut_commands';
const empty = () => ({ version: 1, generation: 0, items: [] });
const read = project => JSON.parse(project.store.get('SELECT value FROM meta WHERE key=?', KEY)?.value ?? JSON.stringify(empty()));
const revision = data => hookRevision(data);
const now = () => new Date().toISOString();
const LEGACY = '旧内联 Shell 命令已停止；请显式导入快捷指令并重新授权。';
const UNAVAILABLE = '快捷指令不存在、版本已变更或未授权；请确认版本并重新授权。';
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
function save(project, data) {
  data.generation = (data.generation ?? 0) + 1;
  check(data.items.length <= 100 && Buffer.byteLength(JSON.stringify(data)) <= 4 * HOOK_LIMITS.bytes, 'shortcut command library exceeds its limit');
  project.store.run('INSERT INTO meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', KEY, JSON.stringify(data));
}
function expected(data, value) { check(typeof value === 'string' && revision(data) === value, 'shortcut command revision changed; reload before editing'); }
function record(data, commandId, version) {
  check(uuid(commandId) && Number.isSafeInteger(version) && version > 0, 'invalid shortcut command reference');
  const item = data.items.find(item => item.id === commandId);
  check(item && item.version === version, UNAVAILABLE); return item;
}
function normalized(value) {
  hookObject(value, ['id','name','command'], 'shortcut command');
  check(value.id === undefined || uuid(value.id), 'invalid shortcut command id');
  text(value.name, 'shortcut command name'); check(value.name.length <= 120, 'shortcut command name exceeds 120 characters');
  text(value.command, 'shortcut command'); check(value.command.length <= 16000 && !value.command.includes('\0'), 'invalid shortcut command');
  return { name: value.name, command: value.command };
}
function invalidate(project, commandId = null) {
  for (const task of project.store.all('SELECT id,hooks FROM tasks WHERE hooks IS NOT NULL')) {
    const data = JSON.parse(task.hooks); let changed = false;
    for (const mount of data.mounts) {
      const affected = mount.actions.some(action => action.type === 'command' && (commandId === null ? action.command !== undefined : action.command_id === commandId));
      if (!affected) continue;
      const cursor = project.store.get("SELECT max(id) AS id FROM events WHERE task_id=? AND type='hook.command_submitted' AND json_extract(data,'$.hook_id')=?", task.id, mount.id)?.id ?? 0;
      const reason = commandId === null ? LEGACY : UNAVAILABLE;
      if (mount.enabled || mount.command_pending || mount.reason !== reason) {
        mount.enabled = false; mount.command_cursor = cursor;
        mount.command_pending = mount.state === 'running' ? 1 : 0;
        mount.reason = reason;
        if (mount.state === 'waiting') mount.state = 'idle';
        changed = true;
      }
    }
    if (changed) project.store.update(task.id, { hooks: JSON.stringify(data) });
  }
}
function executionView(project, execution) {
  if (!execution) return null;
  const result = safeCommandResult(execution.command_result);
  const workerId = Number.isSafeInteger(execution.worker_id) && execution.worker_id > 0 ? execution.worker_id : null;
  const number = execution.worker_number ?? (workerId ? project.store.get('SELECT worker_number FROM tasks WHERE id=?', workerId)?.worker_number : null);
  const date = value => typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value)) ? value : null;
  return { id: typeof execution.id === 'string' && execution.id.length <= 128 ? execution.id : null,
    worker_id: workerId, command_version: Number.isSafeInteger(execution.command_version) && execution.command_version > 0 ? execution.command_version : null,
    status: ['pending','running','succeeded','failed','unknown'].includes(execution.status) ? execution.status : 'unknown',
    created_at: date(execution.created_at), finished_at: date(execution.finished_at),
    worker_number: typeof number === 'string' && /^W\d+(?:-\d+)*$/.test(number) ? number : null,
    ...(result ? { command_result: result } : {}) };
}
function executionResult(project, commandId, executionId, workerId, status, result = null) {
  check(['succeeded','failed','unknown'].includes(status), 'invalid command execution outcome');
  const safeResult = safeCommandResult(result), finishedAt = now();
  project.store.transaction(() => {
    const data = read(project), item = data.items.find(item => item.id === commandId);
    const execution = item?.last_execution;
    if (execution?.id === executionId) {
      Object.assign(execution, { status, finished_at: finishedAt, ...(safeResult ? { command_result: safeResult } : {}) }); save(project, data);
    }
    project.store.event(workerId, `shortcut.command_${status}`, { command_id: commandId, execution_id: executionId, finished_at: finishedAt, ...(safeResult ? { command_result: safeResult } : {}) });
  });
}

export default {
  shortcutCommands() {
    const data = read(this);
    return { version: 1, revision: revision(data), items: data.items.map(item => ({ id: item.id, name: item.name,
      command: item.command, version: item.version, authorized: item.authorized === true, last_execution: executionView(this, item.last_execution) })) };
  },

  saveShortcutCommand(value, expectedRevision) {
    this.assertWritable('save a shortcut command'); const definition = normalized(value);
    this.store.transaction(() => {
      const data = read(this); expected(data, expectedRevision);
      let item = data.items.find(item => item.id === value.id);
      check(value.id === undefined || item, 'shortcut command not found');
      if (item) {
        check(item.version < Number.MAX_SAFE_INTEGER, 'shortcut command version limit reached');
        Object.assign(item, definition, { version: item.version + 1, authorized: false }); invalidate(this, item.id);
      } else { item = { id: randomUUID(), ...definition, version: 1, authorized: false, last_execution: null }; data.items.push(item); }
      save(this, data); this.store.event(null, 'shortcut.command_saved', { command_id: item.id, version: item.version });
    });
    return this.hooksList();
  },

  authorizeShortcutCommand(commandId, version, authorized, expectedRevision) {
    this.assertWritable('authorize a shortcut command'); check(typeof authorized === 'boolean', 'authorized must be boolean');
    this.store.transaction(() => {
      const data = read(this); expected(data, expectedRevision); const item = record(data, commandId, version);
      item.authorized = authorized; if (!authorized) invalidate(this, item.id);
      save(this, data); this.store.event(null, 'shortcut.command_authorized', { command_id: item.id, version, authorized });
    });
    return this.hooksList();
  },

  removeShortcutCommand(commandId, expectedRevision) {
    this.assertWritable('remove a shortcut command'); check(uuid(commandId), 'invalid shortcut command id');
    this.store.transaction(() => {
      const data = read(this); expected(data, expectedRevision); const index = data.items.findIndex(item => item.id === commandId);
      check(index >= 0, 'shortcut command not found'); invalidate(this, commandId); data.items.splice(index, 1); save(this, data);
      this.store.event(null, 'shortcut.command_removed', { command_id: commandId });
    });
    return this.hooksList();
  },

  resolveShortcutCommand(action, requireAuthorized = true) {
    check(action.command === undefined, LEGACY);
    const item = record(read(this), action.command_id, action.command_version);
    check(!requireAuthorized || item.authorized, UNAVAILABLE); return item;
  },

  validateShortcutHook(hook) {
    for (const action of hook.actions) if (action.type === 'command') this.resolveShortcutCommand(action, hook.enabled);
  },

  shortcutHookIssue(hook) {
    for (const action of hook.actions) if (action.type === 'command') {
      try { this.resolveShortcutCommand(action); } catch { return action.command !== undefined ? LEGACY : UNAVAILABLE; }
    }
    return null;
  },

  shortcutCommandHistory(options = {}) { return commandHistory(this, options); },

  /** Reopen every affected queue after durable settlement, including ancestor acceptance and parent delivery. */
  releaseShortcutCommand(workerId) {
    this.shortcutCommandClaims?.delete(workerId); this.commandHookRunning?.delete(workerId);
    const task = this.store.task(workerId);
    if (!this.stopping) {
      this.scheduleTaskMerge(workerId); this.scheduleTaskMerge(task.parent_id);
      this.scheduleTaskCompletion();
      const settle = this.settleQueuedMerge(workerId);
      settle.catch(() => this.noteCompletionMergeFailure(workerId));
    }
    this.kick();
  },

  /** Accept once, durably, without making the HTTP/RPC connection wait for Git or Shell. */
  startShortcutCommand(commandId, version, workerId, expectedRevision) {
    this.assertWritable('start a shortcut command');
    const data = read(this); expected(data, expectedRevision);
    const definition = structuredClone(record(data, commandId, version)); check(definition.authorized, UNAVAILABLE);
    const task = this.store.task(id(workerId));
    check(['main','owner','order','child'].includes(task.task_kind) && !TERMINAL.has(task.status), 'Worker cannot execute shortcut commands');
    check(!this.commandHookRunning?.has(task.id), 'Worker is already executing a shortcut command');
    const admission = commandAdmission(this, task); check(!admission.wait && !admission.stop, admission.wait ?? admission.stop);
    const executionId = randomUUID();
    const authorization = () => this.store.get(`SELECT max(id) AS id FROM events WHERE type IN
      ('shortcut.command_saved','shortcut.command_authorized','shortcut.command_removed') AND json_extract(data,'$.command_id')=?`, commandId)?.id ?? 0;
    const authorizationId = authorization();
    const execution = executionSnapshot(this, definition, task.id, executionId, 'manual', 'pending');
    let eventId;
    this.store.transaction(() => {
      data.items.find(item => item.id === commandId).last_execution = execution;
      save(this, data);
      eventId = this.store.event(task.id, 'shortcut.command_pending', { ...execution, execution_id: executionId });
    });
    (this.commandHookRunning ??= new Set()).add(task.id);
    (this.shortcutCommandClaims ??= new Map()).set(task.id, executionId);
    // write() enters its drain barrier synchronously. Outcomes and lock release happen inside it.
    const job = this.write('execute an accepted shortcut command', async () => {
      let started = false;
      try {
        const result = await this.workspaces.runHookCommand(task, definition.command, () => {
          check(this.shortcutCommandClaims.get(task.id) === executionId, 'shortcut claim changed');
          check(authorization() === authorizationId, UNAVAILABLE);
          this.resolveShortcutCommand({ command_id: commandId, command_version: version });
          const gate = commandAdmission(this, this.store.task(task.id), true);
          check(!gate.wait && !gate.stop, gate.wait ?? gate.stop);
          return true;
        }, { ...this.commandHookOptions, started: () => {
          this.startShortcutExecution(commandId, version, task.id, executionId, 'manual'); started = true;
        } });
        this.finishShortcutExecution(commandId, executionId, task.id, result.status, result);
      } catch {
        this.finishShortcutExecution(commandId, executionId, task.id, started ? 'unknown' : 'failed',
          { status: started ? 'unknown' : 'failed', reason: started ? 'interrupted' : 'admission' });
      } finally {
        this.releaseShortcutCommand(task.id);
      }
    });
    const tracked = job.catch(() => {}).finally(() => this.shortcutCommandJobs.delete(tracked));
    (this.shortcutCommandJobs ??= new Set()).add(tracked);
    return { execution_id: executionId, execution: { event_id: eventId, ...execution }, commands: this.shortcutCommands() };
  },

  async runShortcutCommand(commandId, version, workerId, expectedRevision) {
    const data = read(this); expected(data, expectedRevision);
    const definition = structuredClone(record(data, commandId, version)); check(definition.authorized, UNAVAILABLE);
    const task = this.store.task(id(workerId));
    check(['main','owner','order','child'].includes(task.task_kind) && !TERMINAL.has(task.status), 'Worker cannot execute shortcut commands');
    check(!this.commandHookRunning?.has(task.id), 'Worker is already executing a shortcut command');
    const admission = commandAdmission(this, task); check(!admission.wait && !admission.stop, admission.wait ?? admission.stop);
    const job = this.write('execute a shortcut command', async () => {
      let executionId = null;
      try {
        const result = await this.workspaces.runHookCommand(task, definition.command, () => {
          expected(read(this), expectedRevision);
          this.resolveShortcutCommand({ command_id: commandId, command_version: version });
          check(!this.commandHookRunning?.has(task.id), 'Worker is already executing a shortcut command');
          const gate = commandAdmission(this, this.store.task(task.id)); check(!gate.wait && !gate.stop, gate.wait ?? gate.stop);
          return true;
        }, { ...this.commandHookOptions, started: () => {
          const startedId = randomUUID();
          this.startShortcutExecution(commandId, version, task.id, startedId); executionId = startedId;
          (this.commandHookRunning ??= new Set()).add(task.id);
        } });
        this.finishShortcutExecution(commandId, executionId, task.id, result.status, result);
        return { execution_id: executionId, command_result: safeCommandResult(result), commands: this.shortcutCommands() };
      } catch {
        if (executionId) this.finishShortcutExecution(commandId, executionId, task.id, 'unknown');
        throw new Error(executionId ? '快捷指令执行结果未知；请检查现场，不会自动重放。' : '快捷指令未开始；请重新检查授权版本、Worker 状态与安全门。');
      } finally {
        if (executionId) this.releaseShortcutCommand(task.id);
      }
    });
    (this.shortcutCommandJobs ??= new Set()).add(job);
    try { return await job; } finally { this.shortcutCommandJobs.delete(job); }
  },

  startShortcutExecution(commandId, version, workerId, executionId, source = 'manual') {
    this.store.transaction(() => {
      const data = read(this), item = record(data, commandId, version); check(item.authorized, UNAVAILABLE);
      const acceptedAt = item.last_execution?.id === executionId ? item.last_execution.created_at : undefined;
      item.last_execution = executionSnapshot(this, item, workerId, executionId, source, 'running', acceptedAt);
      save(this, data); this.store.event(workerId, 'shortcut.command_started', { ...item.last_execution, version, execution_id: executionId });
    });
  },

  finishShortcutExecution(commandId, executionId, workerId, status, result = null) {
    executionResult(this, commandId, executionId, workerId, status, result);
  },

  importLegacyHookCommands(source, expectedRevision) {
    this.assertWritable('import legacy Hook commands'); hookObject(source, ['worker_id','hook_id','template_id'], 'legacy command source');
    const worker = source.worker_id !== undefined;
    check(worker ? source.template_id === undefined && typeof source.hook_id === 'string' && source.hook_id.length > 0
      : source.hook_id === undefined && typeof source.template_id === 'string' && source.template_id.length > 0, 'provide a Worker Hook or template source');
    const imported = []; let workerId = null;
    this.store.transaction(() => {
      let original, saveSource;
      if (worker) {
        const task = this.store.task(id(source.worker_id)); workerId = task.id;
        check(this.taskHooks(task.id).revision === expectedRevision, 'Hook revision changed; reload before editing');
        check(this.taskHooks(task.id).mounts.find(m => m.id === source.hook_id)?.editable, 'Hook cannot be imported in its current lifecycle');
        const state = JSON.parse(task.hooks ?? '{"mounts":[]}'); original = state.mounts.find(m => m.id === source.hook_id);
        check(original && original.state !== 'running', 'Hook is executing or unavailable');
        saveSource = replacement => {
          Object.assign(original, replacement); original.command_pending = 0;
          original.command_cursor = this.store.get("SELECT max(id) AS id FROM events WHERE task_id=? AND type='hook.command_submitted' AND json_extract(data,'$.hook_id')=?", task.id, original.id)?.id ?? 0;
          original.command_last_source = this.store.get('SELECT max(id) AS id FROM events')?.id ?? 0;
          if (original.state === 'waiting') original.state = 'idle'; original.reason = UNAVAILABLE;
          check(Buffer.byteLength(JSON.stringify(state)) <= HOOK_LIMITS.bytes, 'mounted Hooks exceed size limit');
          this.store.update(task.id, { hooks: JSON.stringify(state) });
        };
      } else {
        const templates = JSON.parse(this.store.get("SELECT value FROM meta WHERE key='hook_templates'")?.value ?? '{"version":1,"templates":[]}');
        expected(templates, expectedRevision); const item = templates.templates.find(item => item.id === source.template_id);
        check(item, 'Hook template not found'); original = item.definition;
        saveSource = replacement => {
          item.definition = replacement;
          check(Buffer.byteLength(JSON.stringify(templates)) <= 4 * HOOK_LIMITS.bytes, 'Hook template library exceeds size limit');
          this.store.run("UPDATE meta SET value=? WHERE key='hook_templates'", JSON.stringify(templates));
        };
      }
      check(original.actions.some(a => a.type === 'command' && a.command !== undefined), 'source has no legacy inline commands');
      const commands = read(this);
      const actions = original.actions.map((action, index) => {
        if (action.type !== 'command' || action.command === undefined) return action;
        const item = { id: randomUUID(), ...normalized({ name: `${original.name.slice(0, 110)} · ${index + 1}`, command: action.command }), version: 1, authorized: false, last_execution: null };
        commands.items.push(item); imported.push(item.id);
        return { type: 'command', command_id: item.id, command_version: item.version };
      });
      const { name, trigger, mode, conditions, schedule } = original;
      const replacement = normalizeHook({ name, trigger, mode, enabled: false, conditions, actions, ...(schedule ? { schedule } : {}) });
      save(this, commands); this.validateShortcutHook(replacement); saveSource(replacement);
      this.store.event(workerId, 'shortcut.commands_imported', { command_ids: imported, ...(worker ? { hook_id: source.hook_id } : { template_id: source.template_id }) });
    });
    return { ...this.hooksList(), imported_command_ids: imported, ...(worker ? { worker_hooks: this.taskHooks(workerId) } : {}) };
  },

  recoverShortcutCommands() {
    invalidate(this);
    recoverCommandHistory(this, (...args) => this.finishShortcutExecution(...args));
    // Historical stores may have only a last_execution slot, without a started event.
    const data = read(this); let changed = false;
    for (const item of data.items) if (['pending','running'].includes(item.last_execution?.status)) {
      const execution = item.last_execution;
      Object.assign(execution, { status: 'unknown', finished_at: now() }); changed = true;
      this.store.event(execution.worker_id, 'shortcut.command_unknown', { command_id: item.id, execution_id: execution.id, finished_at: execution.finished_at });
    }
    if (changed) save(this, data);
  },
};
