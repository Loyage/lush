import { workerKind } from './worker-kind.js';
import { isHistoricalDelivery, TERMINAL_STATUS } from './format.js';
import { ui } from './state.js';
import { workerLabel } from './worker-label.js';

/** Receiving input is independent of permission to mutate a frozen branch. */
export function appendInputBlocker(task, workers = ui.lastSnapshot?.tasks || []) {
  if (isHistoricalDelivery(task) || !['order', 'child'].includes(workerKind(task))) return '此 Worker 不支持追加输入。';
  if (TERMINAL_STATUS.has(task.status)) return task.status === 'completed'
    ? 'Worker 已完成；请先显式恢复开发。' : 'Worker 已结束；请先重试。';
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
  return queue?.buffered ? `已暂存 ${queue.buffered} 条追加输入，等待投递 · ${inputWaitReason(task)}` : null;
}

/** A successful message ACK proves persistence, not receipt by an Agent. */
export function appendInputAcknowledgement(task, result) {
  const queue = inputQueue(result);
  const label = `Worker ${workerLabel(task)}`;
  if (queue?.buffered) return `已保存给 ${label}，等待投递；${queue.reason || '等待 Agent 可接收输入的安全点'}。`;
  if (!queue && inputWaitReason(task)) return `已追加给 ${label}；投递状态暂不可用，请在 Worker 详情查看。`;
  return `已追加给 ${label}${task.status === 'paused' || result?.status === 'paused' ? '；开始 / 继续后处理' : '；Agent 将在可接收输入时处理'}。`;
}
