import { randomUUID } from 'node:crypto';
import { check, TERMINAL } from '../types.js';
import { assertTaskAncestorsOpen } from './iteration.js';
import { hookConditionsMatch } from '../hooks.js';

const read = task => JSON.parse(task.hooks ?? '{"version":1,"mounts":[],"observed":{}}');
const save = (project, taskId, data) => project.store.update(taskId, { hooks: JSON.stringify(data) });
export const hasCommand = mount => mount.actions.some(a => a.type === 'command');
const timestamp = () => new Date().toISOString();
const FAILURE = 'Shell 命令 Hook 未完成；输出不公开。请检查命令、认证、remote 和现场，未来执行已停用，须显式恢复。';
const UNKNOWN = '后台中断；Shell 命令可能已生效，禁止自动重放。检查现场后可显式恢复未来触发。';

export function commandAdmission(project, task) {
  if (TERMINAL.has(task.status) || !task.branch || ['archived','deleted'].includes(project.store.branch(task.branch)?.status))
    return { stop: '挂载 Worker 已结束、归档或无分支，命令授权停止。' };
  try { assertTaskAncestorsOpen(project, task); } catch { return { stop: '挂载 Worker 的祖先已结束，命令授权停止。' }; }
  if (project.maintenancePaused()) return { wait: '项目维护暂停，等待显式全部继续。' };
  if (project.stopping || project.clearing || project.workerDeleteIds?.size || project.settingsMigrationApplying)
    return { wait: '项目正在停止、清理或迁移，命令等待安全点。' };
  if (project.taskSyncBusy?.has(task.id) || project.workspaces.busy.has(task.id)) return { wait: '工作区正在同步或清理，命令等待安全点。' };
  if (project.running.has(task.id) || task.status === 'running') return { wait: 'Agent 尚未实际退出，命令等待安全点。' };
  if (project.branchFreeze(task.branch) || project.activeTaskMerge(task.id)) return { wait: '挂载分支冻结，命令等待安全点。' };
  return {};
}

export default {
  /** Called only from startup bootstrap, never from read APIs. Tombstone prevents reinstall after deletion. */
  initializeCommandHookExample() {
    const main = this.store.get("SELECT * FROM tasks WHERE task_kind='main' AND branch='main' ORDER BY id LIMIT 1");
    if (!main) return;
    const installed = JSON.parse(this.store.get("SELECT value FROM meta WHERE key='command_hook_example'")?.value ?? 'null');
    if (installed) {
      if (installed.version === 1) this.upgradeDefaultPushCommand(main, installed);
      return;
    }
    this.store.transaction(() => {
      const templates = JSON.parse(this.store.get("SELECT value FROM meta WHERE key='hook_templates'")?.value ?? '{"version":1,"templates":[]}');
      const commands = this.saveShortcutCommand({ name: 'git push', command: 'git push' }, this.shortcutCommands().revision).commands;
      const command = commands.items.at(-1);
      this.authorizeShortcutCommand(command.id, command.version, true, this.shortcutCommands().revision);
      const data = read(main), templateId = randomUUID(), hookId = randomUUID();
      const definition = { name: 'main 合并后 git push', trigger: 'worker.merge_received', mode: 'persistent', enabled: false,
        conditions: {}, actions: [{ type: 'command', command_id: command.id, command_version: command.version }] };
      templates.templates.push({ id: templateId, definition });
      data.mounts.push({ ...structuredClone(definition), id: hookId, state: 'idle', created_at: timestamp(), last_execution: null });
      save(this, main.id, data);
      this.store.run("INSERT INTO meta(key,value) VALUES ('hook_templates',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", JSON.stringify(templates));
      this.store.run("INSERT INTO meta(key,value) VALUES ('command_hook_example',?)", JSON.stringify({ version: 2, template_id: templateId, worker_id: main.id, hook_id: hookId }));
      this.store.event(main.id, 'hook.command_example_installed', { template_id: templateId, hook_id: hookId });
    });
  },

  /** One-time upgrade of installed built-ins only, never user commands, reads or deleted identities. */
  upgradeDefaultPushCommand(main, installed) {
    if (installed.worker_id !== main.id) return;
    const data = read(main), mount = data.mounts.find(m => m.id === installed.hook_id);
    if (mount?.state === 'running') return; // Recovery must settle unknown legacy effects first.
    this.store.transaction(() => {
      const templates = JSON.parse(this.store.get("SELECT value FROM meta WHERE key='hook_templates'")?.value ?? '{"version":1,"templates":[]}');
      const template = templates.templates.find(t => t.id === installed.template_id)?.definition;
      const definitions = [mount, template].filter(Boolean);
      const defaults = definitions.filter(h => h.actions.length === 1 && h.actions[0].type === 'command');
      const referenced = defaults.map(h => h.actions[0]).find(a => a.command === undefined && a.command_version === 1
        && this.shortcutCommands().items.some(c => c.id === a.command_id && c.version === 1 && c.name === 'git push' && c.command === 'git push'));
      const inline = defaults.filter(h => h.actions[0].command === 'git push');
      let command = referenced && this.shortcutCommands().items.find(c => c.id === referenced.command_id);
      if (!command && inline.length) command = this.saveShortcutCommand({ name: 'git push', command: 'git push' }, this.shortcutCommands().revision).commands.items.at(-1);
      if (command) {
        // A user's prior explicit revocation is not superseded by installing this release.
        const revoked = this.store.get("SELECT id FROM events WHERE type='shortcut.command_authorized' AND json_extract(data,'$.command_id')=? AND json_extract(data,'$.authorized')=0 LIMIT 1", command.id);
        if (!command.authorized && !revoked) this.authorizeShortcutCommand(command.id, command.version, true, this.shortcutCommands().revision);
        for (const definition of inline) {
          definition.actions = [{ type: 'command', command_id: command.id, command_version: command.version }];
          definition.enabled = false;
        }
        if (inline.includes(mount)) {
          mount.command_cursor = this.store.get("SELECT max(id) AS id FROM events WHERE task_id=? AND type='hook.command_submitted' AND json_extract(data,'$.hook_id')=?", main.id, mount.id)?.id ?? 0;
          mount.command_pending = 0; mount.command_last_source = this.store.get('SELECT max(id) AS id FROM events')?.id ?? 0;
          if (mount.state === 'waiting') mount.state = 'idle';
          if (mount.state === 'idle') mount.reason = null;
          save(this, main.id, data);
        }
        if (inline.includes(template)) this.store.run("UPDATE meta SET value=? WHERE key='hook_templates'", JSON.stringify(templates));
      }
      this.store.run("UPDATE meta SET value=? WHERE key='command_hook_example'", JSON.stringify({ ...installed, version: 2 }));
    });
  },

  commandHookExample() {
    const main = this.store.get("SELECT id FROM tasks WHERE task_kind='main' AND branch='main' ORDER BY id LIMIT 1");
    if (!main) return null;
    const record = JSON.parse(this.store.get("SELECT value FROM meta WHERE key='command_hook_example'")?.value ?? 'null');
    const hooks = this.taskHooks(main.id);
    // Keep the installed identities as a tombstone; callers inspect actual templates/mounts for availability.
    return { template_id: record?.template_id ?? null, worker_id: main.id, hook_id: record?.hook_id ?? null, hooks };
  },

  /** Merge success is durable even when shutdown has already closed ordinary lifecycle dispatch. */
  submitMergeReceivedCommandHooks(taskId, sourceId) {
    const task = this.store.task(taskId);
    for (const mount of read(task).mounts) if (hasCommand(mount) && mount.trigger === 'worker.merge_received'
      && hookConditionsMatch(mount, task)) this.submitCommandTaskHook(taskId, mount.id, sourceId);
  },

  /** Durable event ledger, rather than a single last_execution slot: busy triggers cannot overwrite each other. */
  submitCommandTaskHook(taskId, hookId, sourceId) {
    this.store.transaction(() => {
      const data = read(this.store.task(taskId)), mount = data.mounts.find(m => m.id === hookId);
      if (!mount?.enabled || this.shortcutHookIssue(mount) || ['failed','unknown'].includes(mount.state) || sourceId <= (mount.command_last_source ?? 0)) return;
      if (mount.mode === 'once' && (mount.command_pending > 0 || mount.state === 'succeeded')) return;
      this.store.event(taskId, 'hook.command_submitted', { hook_id: hookId, trigger: mount.trigger, source_id: sourceId });
      mount.command_last_source = sourceId; mount.command_pending = (mount.command_pending ?? 0) + 1;
      if (mount.state !== 'running') { mount.state = 'waiting'; mount.reason = '命令已提交，等待安全点。'; }
      save(this, taskId, data);
    });
    this.queueCommandTaskHook(taskId, hookId);
  },

  queueCommandTaskHook(taskId, hookId) {
    if (this.stopping || this.recoveringHooks) return;
    const task = this.store.task(taskId), mount = read(task).mounts.find(m => m.id === hookId);
    if (!mount?.enabled || !mount.command_pending || this.shortcutHookIssue(mount) || ['failed','unknown'].includes(mount.state)) return;
    const gate = commandAdmission(this, task);
    if (gate.wait) {
      if (mount.reason !== gate.wait) { const data = read(task); data.mounts.find(m => m.id === hookId).reason = gate.wait; save(this, taskId, data); }
      return;
    }
    const key = `${taskId}:${hookId}`, queued = this.commandHookQueued ??= new Set();
    if (queued.has(key)) return;
    queued.add(key);
    const job = (this.hookQueue ?? Promise.resolve()).then(() => this.runCommandTaskHooks(taskId, hookId))
      .finally(() => { queued.delete(key); });
    this.hookQueue = job.catch(() => {});
  },

  async runCommandTaskHooks(taskId, hookId) {
    let count = 0;
    while (!this.stopping) {
      const task = this.store.task(taskId), data = read(task), mount = data.mounts.find(m => m.id === hookId);
      if (!mount?.enabled || !mount.command_pending || this.shortcutHookIssue(mount) || ['failed','unknown'].includes(mount.state)) return;
      const next = this.store.get(`SELECT id FROM events WHERE task_id=? AND type='hook.command_submitted'
        AND json_extract(data,'$.hook_id')=? AND id>? ORDER BY id LIMIT 1`, taskId, hookId, mount.command_cursor ?? 0);
      if (!next) return;
      const executionId = next.id;
      if (mount.last_execution?.id !== executionId) {
        mount.last_execution = { id: executionId, trigger: mount.trigger, status: 'waiting', created_at: timestamp(), finished_at: null };
        mount.receipts = []; save(this, taskId, data);
      }
      let waiting = false;
      try {
        await this.write('execute a command Hook', async () => {
          for (let index = 0; ; index++) {
            const current = this.store.task(taskId), state = read(current), active = state.mounts.find(m => m.id === hookId);
            if (!active || active.last_execution?.id !== executionId) { waiting = true; return; }
            const action = active.actions[index]; if (!action) break;
            if (!active.enabled) {
              if (active.state === 'running') check(false, 'shortcut command authorization stopped');
              waiting = true; return;
            }
            if (active.receipts.some(r => r.index === index)) continue;
            const guard = () => {
              const live = this.store.task(taskId), snapshot = read(live), rule = snapshot.mounts.find(m => m.id === hookId);
              if (!rule?.enabled || rule.last_execution?.id !== executionId) return false;
              this.validateShortcutHook(rule);
              const gate = commandAdmission(this, live);
              check(!gate.stop, 'mounted Worker no longer available');
              if (gate.wait) {
                rule.state = 'waiting'; rule.reason = gate.wait; rule.last_execution.status = 'waiting';
                save(this, taskId, snapshot); return false;
              }
              return true;
            };
            if (!guard()) { waiting = true; return; }
            const begin = () => {
              const snapshot = read(this.store.task(taskId)), rule = snapshot.mounts.find(m => m.id === hookId);
              rule.state = 'running'; rule.reason = null; rule.command_started_index = index; rule.last_execution.status = 'running';
              save(this, taskId, snapshot);
              this.store.event(taskId, 'hook.execution_started', { hook_id: hookId, execution_id: executionId, trigger: rule.trigger, index });
            };
            let outcome = {};
            if (action.type === 'command') {
              let result, started = false;
              const shortcutExecutionId = randomUUID();
              try {
                const command = this.resolveShortcutCommand(action);
                result = await this.workspaces.runHookCommand(current, command.command, guard, { ...this.commandHookOptions, started: () => {
                  this.store.transaction(() => { begin(); this.startShortcutExecution(action.command_id, action.command_version, taskId, shortcutExecutionId); });
                  started = true; (this.commandHookRunning ??= new Set()).add(taskId);
                } });
                if (started) this.finishShortcutExecution(action.command_id, shortcutExecutionId, taskId, result.status, result);
              } catch (error) {
                if (started) this.finishShortcutExecution(action.command_id, shortcutExecutionId, taskId, 'unknown');
                throw error;
              } finally { this.commandHookRunning?.delete(taskId); this.kick(); }
              if (result.status === 'waiting') { waiting = true; return; }
              outcome = { command_result: result };
              this.store.transaction(() => {
                this.recordHookAction(taskId, hookId, executionId, index, outcome);
                const snapshot = read(this.store.task(taskId)); delete snapshot.mounts.find(m => m.id === hookId).command_started_index; save(this, taskId, snapshot);
              });
              check(result.status === 'succeeded', 'command failed');
              continue;
            }
            if (action.type === 'create_worker') {
              begin(); check(this.hookParentReady(taskId), 'parent no longer ready');
              const result = await this.sendOrder(action.content, current.branch, action.references, null, action.start, undefined, action.profile ?? null, false,
                { task_id: taskId, hook_id: hookId, execution_id: executionId, action_index: index });
              outcome = { worker_id: result.task.id, input_id: result.id };
            } else if (action.type === 'request_merge') {
              begin(); check(this.mergeReadiness(current)?.ready, 'source no longer ready'); await this.requestTaskMerge(taskId);
            } else {
              this.store.transaction(() => {
                begin();
                if (action.type === 'notify') outcome = { notice_id: this.notify(taskId, action.title, action.body).id };
                else if (action.type === 'message') {
                  const target = this.store.task(action.target_id);
                  check(target.id === current.id || target.parent_id === current.id || current.parent_id === target.id, 'Hook relationship changed');
                  this.message(target.id, action.body);
                } else check(false, 'unsupported command Hook action');
                this.recordHookAction(taskId, hookId, executionId, index, outcome);
                const snapshot = read(this.store.task(taskId)); delete snapshot.mounts.find(m => m.id === hookId).command_started_index; save(this, taskId, snapshot);
              });
              continue;
            }
            this.store.transaction(() => {
              this.recordHookAction(taskId, hookId, executionId, index, outcome);
              const snapshot = read(this.store.task(taskId)); delete snapshot.mounts.find(m => m.id === hookId).command_started_index; save(this, taskId, snapshot);
            });
          }
          this.finishCommandTaskHook(taskId, hookId, executionId, 'succeeded');
        });
      } catch { this.finishCommandTaskHook(taskId, hookId, executionId, 'failed', FAILURE); }
      if (waiting) return;
      if (++count % 16 === 0) await new Promise(resolve => setImmediate(resolve));
    }
  },

  finishCommandTaskHook(taskId, hookId, executionId, status, error = null) {
    this.store.transaction(() => {
      const data = read(this.store.task(taskId)), mount = data.mounts.find(m => m.id === hookId);
      if (mount?.last_execution?.id !== executionId) return;
      mount.command_cursor = executionId; mount.command_pending = Math.max(0, (mount.command_pending ?? 1) - 1);
      delete mount.command_started_index;
      mount.state = status; mount.reason = error;
      Object.assign(mount.last_execution, { status, finished_at: timestamp(), ...(error ? { error } : {}) });
      if (status !== 'succeeded' || mount.mode === 'once') mount.enabled = false;
      save(this, taskId, data);
      this.store.event(taskId, `hook.execution_${status}`, { hook_id: hookId, execution_id: executionId, error });
      this.removeSucceededTaskHook(taskId, hookId);
      if (error) this.notify(taskId, '命令 Hook 已停用', error);
    });
  },

  recoverCommandTaskHooks() {
    for (const task of this.store.all('SELECT * FROM tasks WHERE hooks IS NOT NULL')) for (const mount of read(task).mounts) {
      if (!hasCommand(mount) || mount.state !== 'running') continue;
      const complete = mount.actions.every((_, index) => mount.receipts?.some(r => r.index === index));
      const failed = mount.receipts?.some(r => r.command_result?.status === 'failed');
      if (complete && !failed) this.finishCommandTaskHook(task.id, mount.id, mount.last_execution.id, 'succeeded');
      else if (failed) this.finishCommandTaskHook(task.id, mount.id, mount.last_execution.id, 'failed', FAILURE);
      else if (mount.command_started_index !== undefined) this.finishCommandTaskHook(task.id, mount.id, mount.last_execution.id, 'unknown', UNKNOWN);
      else {
        const data = read(this.store.task(task.id)), current = data.mounts.find(m => m.id === mount.id);
        current.state = 'waiting'; current.last_execution.status = 'waiting'; save(this, task.id, data);
      }
    }
  },
};
