import { el } from './dom.js';
import { EVENTS, ROLE, absolute, relative, short } from './format.js';
import { agentText } from './text.js';

export function renderHistory(history, { running = false, truncated = false } = {}) {
  const list = el('ol', undefined, 'timeline');
  history.forEach((event, index) => {
    const item = el('li', undefined, `e-${event.type.replaceAll('.', '-')}${running && index === history.length - 1 ? ' hot' : ''}`);
    const data = event.data || {};
    // kind='info' 的 notice 是结算提醒，不是「等你决定」的问题；只改这一处标签映射，其它事件语义不变。
    const label = event.type === 'notice.opened' && data.kind === 'info' ? '提醒' : (EVENTS[event.type] || event.type);
    const head = el('div'); head.append(el('strong', label), el('span', `${relative(event.created_at)} · ${absolute(event.created_at)}`, 't-when'));
    item.append(head);
    let body = '', agent = false;
    if (event.type === 'invocation.started') body = `第 ${data.call ?? '?'} 次调用${data.cwd ? ` · ${data.cwd}` : ''}`;
    else if (event.type === 'invocation.completed' || event.type === 'completed' || event.type === 'failed') { body = String(data.result || data.error || '').slice(0, 600); agent = true; }
    else if (event.type === 'created') body = `${ROLE[data.role] || data.role}${data.parent_id ? ` ← #${data.parent_id}` : ' · 根任务'}`;
    else if (event.type === 'message') { body = String(data.body || '').slice(0, 400); agent = true; }
    else if (event.type === 'notice.opened') body = data.title || '';
    else if (event.type === 'notice.answered') body = data.dismiss ? '已忽略' : String(data.answer || '');
    else if (event.type === 'workspace.created') body = [data.branch, data.workspace,
      data.dirty_source ? `创建时主树有 ${data.dirty_source.files} 处未提交改动，worker 看不到` : null].filter(Boolean).join(' · ');
    else if (event.type === 'workspace.removed') body = data.branch || '';
    else if (event.type === 'branch.removed') body = data.branch || '';
    else if (event.type === 'verify.requested') body = `检验任务 #${data.verify_task} · 对照 ${data.baseline}`;
    else if (event.type === 'baseline.created') body = [data.target_branch, short(data.commit), data.workspace].filter(Boolean).join(' · ');
    else if (event.type === 'baseline.removed') body = data.workspace || '';
    else if (event.type === 'merged' || event.type === 'merge.approved') body = short(data.commit);
    else if (event.type === 'merge.failed') body = data.error || '';
    else body = Object.keys(data).length ? JSON.stringify(data).slice(0, 300) : '';
    if (body) item.append(agent ? agentText(body, { className: 't-body' }) : el('div', body, 't-body'));
    list.append(item);
  });
  if (truncated) list.append(el('li', '… 更早的事件未显示（每页 100 条）', 't-body'));
  return list;
}
