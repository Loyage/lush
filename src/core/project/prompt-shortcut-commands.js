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

  acceptPromptShortcutExecution(action, workerId) {
    const item = this.resolveShortcutCommand({ ...action, type: 'prompt_command' });
    const parent = this.assertPromptShortcutParent(workerId);
    const executionId = randomUUID();
    const claim = this.claimShortcutExecution(item.id, item.version, parent.id, executionId, 'hook');
    return { command_id: item.id, command_version: item.version, execution_id: executionId,
      ...claim };
  },

  async executePromptShortcutCommand(accepted, workerId, hookReceipt) {
    check(hookReceipt && hookReceipt.task_id === workerId, 'prompt shortcut execution requires a Hook receipt');
    const { command_id: commandId, command_version: version, execution_id: executionId } = accepted;
    const parent = this.store.task(id(workerId)), branch = parent.branch;
    const guard = () => {
      this.assertPromptShortcutParent(parent.id, branch);
      check(!this.store.get("SELECT id FROM events WHERE type IN ('shortcut.command_succeeded','shortcut.command_failed','shortcut.command_unknown') AND json_extract(data,'$.execution_id')=?", executionId), 'prompt shortcut execution already settled');
      // Bind the claimed body/version throughout asynchronous anchor and DB admission.
      check(this.resolveShortcutCommand({ type: 'prompt_command', command_id: commandId }).version === version, 'shortcut command definition changed');
      const mount = JSON.parse(this.store.task(parent.id).hooks ?? '{"mounts":[]}').mounts.find(m => m.id === hookReceipt.hook_id);
      const claim = mount?.prompt_executions?.find(claim => claim.index === hookReceipt.action_index);
      check(mount?.enabled && mount.state === 'running' && mount.last_execution?.id === hookReceipt.execution_id
        && claim?.execution_id === executionId && claim.command_id === commandId && claim.command_version === version, 'Hook creation authorization changed');
    };
    try {
      guard();
      const item = this.resolveShortcutCommand({ type: 'prompt_command', command_id: commandId, command_version: version });
      this.startShortcutExecution(commandId, version, parent.id, executionId, 'hook');
      const receipt = { ...hookReceipt, shortcut_execution_id: executionId, command_id: commandId, command_version: version };
      return await this.sendOrder(item.prompt, branch, [], null, true, undefined, null, false, receipt, guard,
        { command_id: commandId, execution_id: executionId, worker_id: parent.id });
    } catch {
      // sendOrder commits successful history atomically with Input/Worker and the exact Hook receipt.
      const completed = this.store.get("SELECT id FROM events WHERE type IN ('shortcut.command_succeeded','shortcut.command_failed','shortcut.command_unknown') AND json_extract(data,'$.execution_id')=?", executionId);
      if (!completed) this.finishShortcutExecution(commandId, executionId, parent.id, 'failed', { status: 'failed', reason: 'admission' });
      throw new Error('提示词指令创建未完成；请检查父 Worker、指令定义和现场，不会自动重试。');
    }
  },
};
