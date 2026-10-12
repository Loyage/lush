import { randomUUID } from 'node:crypto';
import { check, id } from '../types.js';

/** Prompt dispatch is order creation, not a Shell claim or an Agent completion receipt. */
export default {
  assertPromptShortcutParent(workerId, branch = undefined) {
    this.assertWritable('create a prompt shortcut Worker');
    check(!this.stopping && !this.maintenancePaused(), 'project is stopping or paused for maintenance');
    const parent = this.assertInputParent(workerId, branch);
    check(!this.acceptanceBusy?.has(parent.id) && !this.completionBusy?.has(parent.id) && !this.workspaces.busy.has(parent.id)
      && this.hookParentReady(parent.id), 'parent is not ready to create an order Worker');
    return parent;
  },

  acceptPromptShortcutExecution(action, workerId, source = 'hook') {
    const item = this.resolveShortcutCommand({ ...action, type: 'prompt_command' });
    const parent = this.assertPromptShortcutParent(workerId);
    const executionId = randomUUID(), authorizationId = this.shortcutAuthorizationId(item.id);
    const claim = this.claimShortcutExecution(item.id, item.version, parent.id, executionId, source);
    return { command_id: item.id, command_version: item.version, execution_id: executionId,
      authorization_id: authorizationId, ...claim };
  },

  startPromptShortcutCommand(definition, workerId) {
    const accepted = this.acceptPromptShortcutExecution({ command_id: definition.id, command_version: definition.version }, workerId, 'manual');
    const job = this.write('create an order from an accepted prompt shortcut', () => this.executePromptShortcutCommand(accepted, workerId));
    const tracked = job.catch(() => {}).finally(() => this.shortcutCommandJobs.delete(tracked));
    (this.shortcutCommandJobs ??= new Set()).add(tracked);
    return { execution_id: accepted.execution_id, execution: { event_id: accepted.event_id, ...accepted.execution }, commands: this.shortcutCommands() };
  },

  async executePromptShortcutCommand(accepted, workerId, hookReceipt = null) {
    const { command_id: commandId, command_version: version, execution_id: executionId } = accepted;
    const parent = this.store.task(id(workerId)), branch = parent.branch;
    const guard = () => {
      this.assertPromptShortcutParent(parent.id, branch);
      check(!this.store.get("SELECT id FROM events WHERE type IN ('shortcut.command_succeeded','shortcut.command_failed','shortcut.command_unknown') AND json_extract(data,'$.execution_id')=?", executionId), 'prompt shortcut execution already settled');
      // Compare durable authorization identity, not a boolean: revoke then grant is a new permission.
      check(this.shortcutAuthorizationId(commandId) === accepted.authorization_id, 'shortcut authorization changed');
      this.resolveShortcutCommand({ type: 'prompt_command', command_id: commandId, command_version: version });
      if (hookReceipt) {
        const mount = JSON.parse(this.store.task(parent.id).hooks ?? '{"mounts":[]}').mounts.find(m => m.id === hookReceipt.hook_id);
        check(mount?.enabled && mount.state === 'running' && mount.last_execution?.id === hookReceipt.execution_id, 'Hook creation authorization changed');
      }
    };
    try {
      guard();
      const item = this.resolveShortcutCommand({ type: 'prompt_command', command_id: commandId, command_version: version });
      this.startShortcutExecution(commandId, version, parent.id, executionId, hookReceipt ? 'hook' : 'manual');
      const receipt = hookReceipt ? { ...hookReceipt, shortcut_execution_id: executionId, command_id: commandId, command_version: version } : null;
      return await this.sendOrder(item.prompt, branch, [], null, true, undefined, null, false, receipt, guard,
        { command_id: commandId, execution_id: executionId, worker_id: parent.id });
    } catch {
      // sendOrder commits successful history atomically with Input/Worker and the exact Hook receipt.
      const completed = this.store.get("SELECT id FROM events WHERE type IN ('shortcut.command_succeeded','shortcut.command_failed','shortcut.command_unknown') AND json_extract(data,'$.execution_id')=?", executionId);
      if (!completed) this.finishShortcutExecution(commandId, executionId, parent.id, 'failed', { status: 'failed', reason: 'admission' });
      throw new Error('提示词指令创建未完成；请检查父 Worker、授权版本和现场，不会自动重试。');
    }
  },
};
