import { el } from './dom.js';
import { agentText } from './text.js';
import { workerLabel } from './worker-label.js';

// Categories and durable event registration share one source. These are not shell-command guesses.
export const OPERATION_CATEGORIES = Object.freeze([
  ['progress', '进度相关', false, 'var(--queued)'],
  ['auto_title', '自动标题', false, 'var(--muted)'],
  ['delegation', '派工', false, 'var(--queued)'],
  ['communication', 'Worker 通信', false, 'var(--muted)'],
  ['notification', '通知', false, 'var(--accent)'],
]);
export const isOperationCategory = category => OPERATION_CATEGORIES.some(([key]) => key === category);
export const AGENT_OPERATIONS = Object.freeze({
  'task.auto_titled': { category: 'auto_title', label: '设置自动标题' },
  'progress.plan': { category: 'progress', label: '制定／调整计划' },
  'progress.completed': { category: 'progress', label: '完成计划步骤' },
  'progress.archived': { category: 'progress', label: '更新前的计划快照' },
  'worker.delegated': { category: 'delegation', label: '派工' },
  'worker.message_sent': { category: 'communication', label: '发送 Worker 消息' },
  'notice.reported': { category: 'notification', label: '发送通知' },
});

function workerLink(id, number) {
  if (!Number.isSafeInteger(id) || id <= 0) return el('span', 'Worker 身份未知');
  const link = el('a', workerLabel(id, number)); link.setAttribute('href', `#worker-${id}`); return link;
}
function meter(root, completed, total) {
  const valid = Number.isSafeInteger(total) && total > 0 && Number.isSafeInteger(completed) && completed >= 0 && completed <= total;
  const caption = el('span', valid ? `${completed} / ${total}` : '完成度未知', 'operation-progress-count');
  root.append(caption);
  if (valid) {
    const bar = el('progress', undefined, 'operation-progress-meter'); bar.max = total; bar.value = completed;
    bar.setAttribute('aria-label', `当时已完成 ${completed} / ${total} 个步骤`); root.append(bar);
  }
}

/** Use only this event's complete immutable source, never the current plan or a live timer. */
export function renderAgentOperation(entry) {
  const root = el('div', undefined, 'conversation-operation-content');
  if (entry.truncated || entry.unreadable) {
    root.append(el('p', '操作记录尚未完整读取，暂不能确认详情或结果。', 'hint')); return root;
  }
  let data;
  try { data = JSON.parse(entry.text); } catch { /* Malformed history is not success evidence. */ }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    root.append(el('p', '操作记录格式不可用，详情与结果未知。', 'hint')); return root;
  }
  if (entry.operationType === 'task.auto_titled') {
    root.append(el('p', typeof data.auto_title === 'string' ? `已设置自动标题：${data.auto_title}` : '自动标题内容未知')); return root;
  }
  if (entry.operationType === 'worker.delegated') {
    const title = el('p', '已创建子 Worker：', 'operation-target'); title.append(workerLink(data.child_id, data.child_worker_number)); root.append(title);
    if (typeof data.goal === 'string') root.append(agentText(data.goal, { copyCode: true })); return root;
  }
  if (entry.operationType === 'worker.message_sent') {
    const title = el('p', '发给 Worker：', 'operation-target'); title.append(workerLink(data.target_task_id, data.target_worker_number)); root.append(title);
    if (typeof data.content === 'string') root.append(agentText(data.content, { copyCode: true }));
    else root.append(el('p', '消息正文未保存。', 'hint')); return root;
  }
  if (entry.operationType === 'notice.reported') {
    root.append(el('strong', typeof data.title === 'string' ? data.title : '通知标题未知'));
    if (typeof data.content === 'string') root.append(agentText(data.content, { copyCode: true }));
    else root.append(el('p', '旧通知记录未保存正文，请到通知历史查看。', 'hint')); return root;
  }

  const snapshot = Array.isArray(data.progress?.items) ? data.progress.items : null;
  const steps = (snapshot ?? (Array.isArray(data.steps) ? data.steps : []))
    .filter(item => item && item.kind !== 'wait' && typeof item.key === 'string' && typeof item.label === 'string');
  if (entry.operationType === 'progress.completed') {
    root.classList.add('operation-completion');
    root.append(el('strong', data.label || data.step || '步骤名称未知', 'operation-completed-name'));
    const known = snapshot && steps.length && steps.every(item => ['pending', 'completed'].includes(item.status));
    meter(root, known ? steps.filter(item => item.status === 'completed').length : data.completed,
      known ? steps.length : data.total);
    return root; // Completion records intentionally show only the completed name and saved completion meter.
  }
  if (entry.operationType === 'progress.archived') root.append(el('p', `更新前的计划 · ${data.reason === 'new_input' ? '收到追加输入' : data.reason === 'replan' ? '调整计划' : '原因未知'}`, 'operation-snapshot-caption'));
  else root.append(el('p', `历史计划 · ${steps.length} 个步骤`, 'operation-snapshot-caption'));
  const list = el('ol', undefined, 'conversation-operation-steps operation-step-line');
  const current = snapshot && steps.find(item => item.status === 'pending' && !item.unconfirmed && !item.timing_unknown && item.started_at);
  for (const item of steps) {
    const known = snapshot && ['completed', 'pending'].includes(item.status);
    const state = !known || item.unconfirmed ? 'unknown' : item.status === 'completed' ? 'completed' : item === current ? 'current' : 'pending';
    const label = !known ? '状态未知' : item.unconfirmed ? '未确认完成' : state === 'completed' ? '已完成'
      : state === 'current' ? '当时当前步骤' : item.started_at === null && !item.timing_unknown ? '未开始' : '当时未完成';
    const row = el('li', undefined, `operation-step operation-step-${state}`);
    row.append(el('span', state === 'completed' ? '✓' : state === 'current' ? '●' : state === 'unknown' ? '?' : '○', 'operation-step-icon'),
      el('span', item.label, 'operation-step-label'), el('span', label, 'operation-step-state'));
    list.append(row);
  }
  if (steps.length) root.append(list);
  else root.append(el('p', '此旧记录未保存完整计划，不能用当前计划补齐。', 'hint'));
  if (!snapshot && steps.length) root.append(el('p', '此旧记录只有步骤清单，当时的完成状态未知。', 'hint'));
  return root;
}
