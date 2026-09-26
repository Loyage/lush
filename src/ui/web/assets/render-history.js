import { button, el } from './dom.js';
import { EVENTS, ROLE, absolute, relative, short } from './format.js';
import { structuredValue } from './structured-value.js';
import { agentText } from './text.js';
import { referenceable } from './context-references.js';

/**
 * 事件引用的消息正文：直接看得到 Agent 之间说了什么，而不是只有 message_id。
 * 信号是 versioned JSON 信封，展开 payload 用结构化视图；普通消息按 Agent 输出渲染，原文由结构化视图保留。
 */
function messageContent({ body, task_id: to, sender_id: from, signal_type: signalType } = {}, taskId = null) {
  const text = String(body ?? '');
  const wrap = el('div', undefined, 'timeline-message');
  const outgoing = from !== null && from !== undefined && from === taskId;
  const who = outgoing ? `发给任务 #${to}` : from ? `来自任务 #${from}` : '来自你';
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* 普通文本消息 */ }
  const signal = typeof parsed?.signal === 'string' ? parsed.signal : signalType;
  wrap.append(el('div', `${who}${signal ? ` · 信号 ${signal}` : ''}`, 't-from'));
  const payload = parsed && typeof parsed === 'object' && parsed.payload && typeof parsed.payload === 'object' ? parsed.payload : null;
  if (payload && Object.keys(payload).length) wrap.append(structuredValue(JSON.stringify(payload), { openRoot: true }));
  else if (parsed && typeof parsed === 'object') wrap.append(structuredValue(text, { openRoot: true }));
  else if (text) wrap.append(agentText(text, { className: 't-body' }));
  return wrap;
}

function eventItem(event, { hot = false, taskId = null } = {}) {
  const item = el('li', undefined, `e-${event.type.replaceAll('.', '-')}${hot ? ' hot' : ''}`);
  const data = event.data || {};
  // kind='info' 的 notice 是结算提醒，不是「等你决定」的问题；其它事件语义不变。
  const label = event.type === 'notice.opened' && data.kind === 'info' ? '提醒' : (EVENTS[event.type] || event.type);
  const head = el('div'); head.append(el('strong', label), el('span', `${relative(event.created_at)} · ${absolute(event.created_at)}`, 't-when'));
  item.append(head);
  let body = '', agent = false, rich = null;
  if (event.type === 'invocation.started') body = `第 ${data.call ?? '?'} 次调用${data.cwd ? ` · ${data.cwd}` : ''}`;
  else if (event.type === 'invocation.completed' || event.type === 'completed' || event.type === 'failed') { body = String(data.result || data.error || '').slice(0, 600); agent = true; }
  else if (event.type === 'created') body = `${ROLE[data.role] || data.role}${data.parent_id ? ` ← #${data.parent_id}` : ' · 根任务'}`;
  else if (event.type === 'message') { rich = messageContent({ body: data.body, task_id: taskId, sender_id: data.sender }, taskId); body = String(data.body || ''); }
  else if (event.type === 'notice.opened') body = data.title || '';
  else if (event.type === 'notice.answered') body = data.dismiss ? '已忽略' : Array.isArray(data.answer?.answers)
    ? data.answer.answers.map(a => `${a.question}：${a.custom || a.labels.join('、')}`).join('\n') : String(data.answer || '');
  else if (event.type === 'workspace.created') body = [data.branch, data.workspace,
    data.dirty_source ? `创建时主树有 ${data.dirty_source.files} 处未提交改动，worker 看不到` : null].filter(Boolean).join(' · ');
  else if (event.type === 'workspace.removed') body = data.branch || '';
  else if (event.type === 'branch.removed') body = data.branch || '';
  else if (event.type === 'verify.requested') body = `检验任务 #${data.verify_task} · 对照 ${data.baseline}`;
  else if (event.type === 'baseline.created') body = [data.target_branch, short(data.commit), data.workspace].filter(Boolean).join(' · ');
  else if (event.type === 'baseline.removed') body = data.workspace || '';
  else if (event.type === 'merged' || event.type === 'merge.approved') body = short(data.commit);
  else if (event.type === 'merge.failed') body = data.error || '';
  // 子任务完成/请求合并等信号事件只存 message_id，后端已把被引用的消息正文附在 event.message 上。
  else if (event.message) { rich = messageContent(event.message, taskId); body = String(event.message.body || ''); }
  else body = Object.keys(data).length ? JSON.stringify(data).slice(0, 300) : '';
  if (rich) item.append(rich);
  else if (body) item.append(agent ? agentText(body, { className: 't-body' }) : el('div', body, 't-body'));
  if (event.id) referenceable(item, { kind: 'history_event', target: { event_id: event.id, ...(taskId ? { task_id: taskId } : {}) },
    label: `事件 #${event.id} · ${EVENTS[event.type] || event.type}`, quote: `${EVENTS[event.type] || event.type}${body ? `\n${body}` : ''}`,
    location: { view: 'task-detail', ...(taskId ? { task_id: taskId } : {}), section: 'history' } });
  return item;
}

export function renderHistory(history, { running = false, truncated = false, cursor = null, onMore = null, taskId = null } = {}) {
  const list = el('ol', undefined, 'timeline');
  let loaded = [...history], pageCursor = cursor, hasMore = truncated;
  const paint = () => {
    list.replaceChildren(...loaded.map((event, index) => eventItem(event, { hot: running && index === loaded.length - 1, taskId })));
    if (!hasMore) return;
    const paging = el('li', undefined, 't-body history-pagination');
    paging.append(el('span', `当前显示最近 ${loaded.length} 条事件；更早记录尚未加载。`));
    if (onMore && pageCursor) {
      const more = button('加载更早 100 条', async () => {
        more.disabled = true; more.textContent = '加载中…';
        try {
          const page = await onMore(pageCursor);
          loaded = [...page.events, ...loaded]; pageCursor = page.cursor; hasMore = page.truncated;
          paint();
        } catch (error) { more.disabled = false; more.textContent = '加载更早 100 条'; more.title = error.message; }
      }, 'ghost');
      more.type = 'button'; paging.append(more);
    }
    list.replaceChildren(paging, ...list.children);
  };
  paint();
  return list;
}
