import { el } from './dom.js';

// A deliberately small list of durable effects, not a parser/audit of arbitrary shell commands.
export const AGENT_OPERATIONS = Object.freeze({
  'task.auto_titled': '设置自动标题',
  'progress.plan': '制定／调整计划',
  'progress.completed': '完成计划步骤',
  'progress.archived': '更新前的计划快照',
});

/** Read only this event's complete source; never fill old snapshots from the current plan. */
export function renderAgentOperation(entry) {
  const root = el('div', undefined, 'conversation-operation-content');
  if (entry.truncated || entry.unreadable) {
    root.append(el('p', '操作记录尚未完整读取，暂不能确认详情或结果。', 'hint'));
    return root;
  }
  let data;
  try { data = JSON.parse(entry.text); } catch { /* Malformed history is not evidence of success. */ }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    root.append(el('p', '操作记录格式不可用，详情与结果未知。', 'hint'));
    return root;
  }
  if (entry.operationType === 'task.auto_titled') {
    root.append(el('p', typeof data.auto_title === 'string' ? `已设置自动标题：${data.auto_title}` : '自动标题内容未知'));
    return root;
  }
  const archived = entry.operationType === 'progress.archived';
  if (archived) root.append(el('p', `更新前保存的计划 · ${data.reason === 'new_input' ? '收到追加输入' : data.reason === 'replan' ? '调整计划' : '原因未知'}`, 'hint'));
  if (entry.operationType === 'progress.completed') root.append(el('p', `已完成步骤：${data.label || data.step || '步骤未知'}`));
  const snapshot = Array.isArray(data.progress?.items) ? data.progress.items : null;
  const steps = snapshot ?? (Array.isArray(data.steps) ? data.steps : []);
  const list = el('ol', undefined, 'conversation-operation-steps');
  for (const item of steps) {
    if (!item || typeof item.key !== 'string' || typeof item.label !== 'string') continue;
    const known = snapshot && ['completed', 'pending'].includes(item.status);
    const done = known && item.status === 'completed';
    const state = !known ? '状态未知' : done ? '已完成' : item.unconfirmed ? '未确认完成' : '当时未完成';
    const row = el('li');
    row.append(el('span', `${done ? '✓' : known ? '○' : '?'} ${item.label}`),
      el('span', ` · ${state}`, 'hint'));
    list.append(row);
  }
  if (list.children.length) root.append(list);
  else root.append(el('p', '此旧记录未保存完整计划，不能用当前计划补齐。', 'hint'));
  if (!snapshot && list.children.length) root.append(el('p', '此旧记录只有步骤清单，当时的完成状态未知。', 'hint'));
  return root;
}
