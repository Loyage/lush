import { workerKind } from './worker-kind.js';
import { isHistoricalDelivery, TERMINAL_STATUS } from './format.js';
import { ui } from './state.js';
import { workerLabel } from './worker-label.js';

/** Valet rounds use their own admission, never the development branch/inbox rules. */
export function valetAppendBlocker(task) {
  if (task.role !== 'manager' || task.task_kind !== 'management') return '此目标不是可追加的项目管家。';
  if (task.management?.version !== 1 || typeof task.management.can_append !== 'boolean') return '服务未提供管家追加准入信息，请更新服务并刷新详情；不会尝试提交。';
  if (task.execution_retired === true || task.agent?.active || !['completed', 'waiting'].includes(task.status)
    || ['failed', 'unknown', 'stopping'].includes(task.management.state)) return task.management.append_reason || '管家尚未正常结束并安全收口；失败、取消或未知操作不能通过追加恢复。';
  return task.management.can_append === true ? null : task.management.append_reason || '当前管家暂不能追加，请刷新详情核对安全收口状态。';
}

/** Receiving input is independent of permission to mutate a frozen branch. */
export function appendInputBlocker(task, workers = ui.lastSnapshot?.tasks || []) {
  if (task.execution_retired === true) return '远端执行已退役，此 Worker 仅保留只读历史，不能追加输入。';
  if (isHistoricalDelivery(task) || !['order', 'child'].includes(workerKind(task))) return '此 Worker 不支持追加输入。';
  if (TERMINAL_STATUS.has(task.status) && task.creation?.waiting_first_input === true) return '空 Worker 已结束，不能开始或重试；请重新创建 Worker。';
  if (task.status === 'completed') {
    if (task.acceptance_recovery === true) return '资源回收尚未完成；请在详情页续办验收，不能追加开发输入。';
    if (task.accepted === true) return 'Worker 已验收完成，不能恢复开发；如有新要求，请新发指令。';
    if (!task.branch || task.archived || task.branch_archive?.archived || task.branch_info?.archived)
      return 'Worker 已完成，分支已归档或不可用，不能恢复开发；如有新要求，请新发指令。';
    if (!task.workspace || task.workspace_state === 'missing')
      return 'Worker 已完成，工作区未保留或缺失，不能恢复开发；如有新要求，请新发指令。';
    return task.integration === 'merged'
      ? 'Worker 已完成；请在详情页点击「继续开发」，恢复待验收后再追加输入。'
      : 'Worker 已完成，当前不支持恢复开发；如有新要求，请新发指令。';
  }
  if (TERMINAL_STATUS.has(task.status)) return 'Worker 已结束；请先重试。';
  if (!task.branch || task.archived || task.branch_archive?.archived || task.branch_info?.archived)
    return '分支已归档或不可用；不会重建工作区。';
  if (task.workspace_state === 'missing') return 'worktree 缺失；请先检查现场。';
  const byId = new Map(workers.map(worker => [worker.id, worker])), seen = new Set([task.id]);
  for (let parent = byId.get(task.parent_id); parent && !seen.has(parent.id); parent = byId.get(parent.parent_id)) {
    if (TERMINAL_STATUS.has(parent.status) && workerKind(parent) !== 'merge')
      return `祖先 Worker ${workerLabel(parent)} 已结束；请先恢复祖先。`;
    seen.add(parent.id);
  }
  // Partial read models cannot prove that an unseen ancestor is closed; runtime rechecks all admission.
  return null;
}

export function inputQueue(task) {
  const queue = task?.input_queue;
  return queue && Number.isSafeInteger(queue.buffered) && queue.buffered >= 0
    && (queue.reason === null || typeof queue.reason === 'string') ? queue : null;
}

export function inputWaitReason(task) {
  const queue = inputQueue(task);
  if (queue?.reason) return queue.reason;
  const freeze = task?.freeze || task?.branch_archive?.freeze
    || (ui.lastSnapshot?.status?.branch_freeze || []).find(row => row.branch === task?.branch || row.target_branch === task?.branch);
  if (freeze) return `冻结中：${freeze.reason || '等待在途交付结束'}；解除冻结且 Agent 静息后投递`;
  if (['requested', 'executing', 'resolving', 'blocked'].includes(task?.reservation?.status))
    return '在途交付或源侧修复中；解除冻结且 Agent 静息后投递';
  return queue?.buffered ? '等待 Agent 可接收输入的安全点' : null;
}

export function inputQueueText(task) {
  const queue = inputQueue(task);
  return queue?.buffered ? `已入箱 ${queue.buffered} 条追加指令，待交付给 Agent · ${inputWaitReason(task)}` : null;
}

/** A successful message ACK proves persistence, not receipt by an Agent. */
export function appendInputAcknowledgement(task, result) {
  const queue = inputQueue(result);
  const label = `Worker ${workerLabel(task)}`;
  if (task.creation?.waiting_first_input === true && Number.isSafeInteger(result?.input_id)) return `首条工作指令已提交给 ${label}，原始输入 O${result.input_id} 已创建并授权 Agent 执行；无需另点开始。`;
  if (queue?.buffered) return `追加指令已入箱给 ${label}，待交付给 Agent；${queue.reason || '等待 Agent 可接收输入的安全点'}。`;
  if (!queue && inputWaitReason(task)) return `已追加给 ${label}；投递状态暂不可用，请在 Worker 详情查看。`;
  return `已追加给 ${label}${task.status === 'paused' || result?.status === 'paused' ? '；开始 / 继续后处理' : '；Agent 将在可接收输入时处理'}。`;
}
