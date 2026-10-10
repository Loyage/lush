import { block, button, el, syncChildren } from './dom.js';
import { agentText, markdownEnabled } from './text.js';
import { absolute } from './format.js';
import { loadHistory } from './api.js';
import { referenceable } from './context-references.js';
import { workerLabel } from './worker-label.js';

const followup = event => event.type === 'message' && event.data?.sender === null && typeof event.data.body === 'string';
const time = at => Number.isFinite(Date.parse(at)) ? Date.parse(at) : null;
const inputTime = delivery => delivery?.status === 'delivered' && time(delivery.at) !== null
  ? `输入时间：${absolute(delivery.at)}` : delivery?.status === 'pending' ? '待输入' : '输入时间未知';

/** One read-only conversation, backed by existing delivery receipts, runs and event pagination. */
export function renderConversation(task, history = {}, previous = null) {
  history ||= {};
  if (previous?.conversationTaskId === task.id) {
    previous.updateConversation(task, history);
    return previous;
  }
  if (!task.goal && !task.result && !(task.runs || []).some(run => run.result)
    && !(history.events || []).some(event => followup(event) || event.type === 'invocation.completed')
    && !history.loading && !history.unavailable && !history.has_more && !history.truncated) return null;
  const root = block('对话'); root.classList.add('conversation-panel'); root.conversationTaskId = task.id;
  const head = root.querySelector('.section-title');
  const count = el('span', '', 'count'), ordering = el('div', undefined, 'conversation-order');
  ordering.setAttribute('role', 'group'); ordering.setAttribute('aria-label', '对话排序');
  const list = el('div', undefined, 'conversation-list'), status = el('p', '', 'hint conversation-status');
  let current = task, direction = 'desc', cursor = null, hasMore = false, historyState = '';
  const inputs = new Map(), outputs = new Map(), rendered = new Map();
  const asc = button('正序', () => { direction = 'asc'; paint(); }, 'ghost', { help: '按时间从早到晚阅读已加载的输入和结果，只改变当前对话的显示顺序，不调用 Agent。' });
  const desc = button('倒序', () => { direction = 'desc'; paint(); }, 'ghost', { help: '按时间从晚到早阅读已加载的输入和结果，只改变当前对话的显示顺序，不调用 Agent。' });
  ordering.append(asc, desc); head.append(count, ordering);
  const more = button('加载更早对话', async () => {
    status.textContent = '正在读取更早的输入与结果…';
    try {
      const page = await loadHistory(current.id, cursor);
      if (page.cursor === cursor && (page.truncated || page.has_more)) throw new Error('历史游标未前进');
      root.updateConversation(current, page);
      status.textContent = hasMore ? '更早历史尚未全部读取，可继续加载。' : '已读取全部对话历史。';
    } catch (error) { status.textContent = `读取未完成：${error.message}`; }
  }, 'ghost conversation-more');
  root.append(list, status, more);

  function message(entry, latestKey) {
    let node = rendered.get(entry.key);
    const signature = JSON.stringify([entry.text, entry.side, markdownEnabled()]);
    if (!node) {
      node = el('article', undefined, `conversation-message conversation-${entry.side}`);
      node.dataset.conversationKey = entry.key;
      const meta = el('div', undefined, 'conversation-meta');
      const avatar = el('span', entry.side === 'input' ? '人' : 'W', `conversation-avatar avatar-${entry.side}`);
      avatar.setAttribute('aria-hidden', 'true');
      meta.append(avatar, el('strong', '', 'conversation-sender'), el('span', '', 'conversation-kind'), el('time', '', 'conversation-time'));
      const body = el('div', undefined, 'conversation-body');
      const toggle = button('', () => {
        setExpanded(!node.expanded);
        if (!node.expanded) toggle.scrollIntoView?.({ block: 'nearest', behavior: 'auto' });
      }, 'ghost conversation-expand', {
        help: '就地展开或收起这条消息的完整正文，只改变阅读长度，不删除内容，也不调用 Agent。',
      });
      const bodyId = `conversation-${current.id}-${entry.key.replace(/[^a-z0-9-]/gi, '-')}`;
      body.id = bodyId; toggle.setAttribute('aria-controls', bodyId);
      meta.append(toggle); node.append(meta, body); node.expanded = false;
      function setExpanded(value) {
        node.expanded = Boolean(value);
        node.classList.toggle('conversation-expanded', node.expanded);
        toggle.textContent = node.expanded ? '收起消息' : '展开消息';
        toggle.setAttribute('aria-expanded', String(node.expanded));
      }
      body.addEventListener('focusin', () => setExpanded(true));
      node.revealReadingContent = () => setExpanded(true);
      node.updateExpansion = () => setExpanded(node.expanded);
      node.measureReadingContent = limit => {
        const height = body.querySelector('.conversation-prose')?.getBoundingClientRect?.().height;
        if (height == null || !limit) return;
        const long = height > Math.min(260, limit * 0.7) + 60;
        node.classList.toggle('conversation-long', long); toggle.hidden = !long;
      };
      rendered.set(entry.key, node);
    }
    if (node.bodySignature !== signature) {
      node.querySelector('.conversation-body').replaceChildren(agentText(entry.text, { className: 'conversation-prose', plain: 'div' }));
      node.bodySignature = signature;
      const long = entry.text.length > 1200 || entry.text.split('\n').length > 12;
      node.classList.toggle('conversation-long', long);
      node.querySelector('.conversation-expand').hidden = !long;
      node.updateExpansion();
    }
    node.querySelector('.conversation-sender').textContent = entry.side === 'input' ? '用户' : `Worker ${workerLabel(current)}`;
    node.querySelector('.conversation-kind').textContent = entry.kind;
    const at = entry.side === 'input' ? entry.delivery?.at : entry.at;
    const clock = node.querySelector('.conversation-time');
    clock.textContent = entry.side === 'input' ? inputTime(entry.delivery) : time(at) === null ? '结果时间未知' : absolute(at);
    if (time(at) !== null && (entry.side !== 'input' || entry.delivery?.status === 'delivered')) clock.setAttribute('datetime', at);
    else clock.removeAttribute('datetime');
    const refs = [];
    if (entry.key === latestKey) refs.push({ kind: 'result', target: { task_id: current.id, section: 'result' },
      label: `Worker 结果 ${workerLabel(current)}`, quote: entry.text, location: { view: 'task-detail', task_id: current.id, section: 'result' } });
    if (entry.eventId) refs.push({ kind: 'history_event', target: { task_id: current.id, event_id: entry.eventId },
      label: `${entry.side === 'input' ? '追加输入' : '历史结果'} ${workerLabel(current)} · 事件 #${entry.eventId}`,
      quote: entry.text, location: { view: 'task-detail', task_id: current.id, section: 'history' } });
    referenceable(node, refs);
    return node;
  }
  function paint() {
    const results = [...outputs.values()].sort((a, b) => (time(b.at) ?? 0) - (time(a.at) ?? 0) || b.sequence - a.sequence);
    // Deduplicate only the newest occurrence, not equal text from independent earlier calls.
    const matched = current.result && results[0]?.text === current.result ? results[0].key : null;
    const latestKey = current.result ? matched || 'latest' : null;
    const entries = [...inputs.values(), ...results];
    if (current.goal) entries.push({ key: 'goal', side: 'input', kind: '原始目标', text: current.goal,
      delivery: current.goal_input_delivery, at: current.created_at, sequence: 0 });
    if (current.result && !matched) entries.push({ key: 'latest', side: 'output', kind: '最新结果', text: current.result, at: null, sequence: Infinity });
    entries.sort((a, b) => {
      // Delivery time is authoritative for received inputs; pending entries use event order for placement only.
      const aTime = time(a.side === 'input' && a.delivery?.status === 'delivered' ? a.delivery.at : a.at);
      const bTime = time(b.side === 'input' && b.delivery?.status === 'delivered' ? b.delivery.at : b.at);
      // An undated latest result stays at the latest edge; an undated original goal stays at the earliest edge.
      const rank = entry => entry.key === 'latest' ? Infinity : entry.key === 'goal' ? -Infinity : 0;
      const delta = (aTime ?? rank(a)) - (bTime ?? rank(b));
      return (Number.isNaN(delta) ? 0 : delta) || a.sequence - b.sequence || a.key.localeCompare(b.key);
    });
    if (direction === 'desc') entries.reverse();
    syncChildren(list, entries.map(entry => message({ ...entry, kind: entry.key === latestKey ? '最新结果' : entry.kind }, latestKey)));
    count.textContent = `已加载 ${entries.length} 条${hasMore ? ' · 还有更早历史' : ''}${historyState}`;
    asc.setAttribute('aria-pressed', String(direction === 'asc')); desc.setAttribute('aria-pressed', String(direction === 'desc'));
    root.dataset.order = direction;
    more.hidden = !hasMore || cursor == null;
  }
  root.updateConversation = (nextTask, page = {}) => {
    current = nextTask;
    historyState = page.loading ? ' · 历史加载中' : page.unavailable ? ' · 历史不可用' : '';
    for (const run of current.runs || []) if (typeof run.result === 'string' && run.result) {
      const key = `run:${run.id}`, old = outputs.get(key);
      outputs.set(key, { ...old, key, side: 'output', kind: `调用 #${run.id}`, text: run.result,
        at: run.ended_at || old?.at || null, sequence: run.id });
    }
    for (const event of page.events || []) {
      if (followup(event)) inputs.set(event.id, { key: `input:${event.id}`, eventId: event.id, messageId: event.data.message_id,
        side: 'input', kind: '追加输入', text: event.data.body, at: event.created_at, delivery: event.input_delivery, sequence: event.id });
      if (event.type === 'invocation.completed' && typeof event.data?.result === 'string' && event.data.result) {
        const key = event.data.run_id ? `run:${event.data.run_id}` : `event:${event.id}`;
        outputs.set(key, { key, side: 'output', kind: event.data.run_id ? `调用 #${event.data.run_id}` : `记录 #${event.id}`,
          eventId: event.id, text: event.data.result, at: event.created_at, sequence: event.id });
      }
    }
    const deliveries = new Map((page.events || []).flatMap(event => event.input_deliveries || []).map(delivery => [delivery.message_id, delivery]));
    for (const entry of inputs.values()) if (deliveries.has(entry.messageId)) entry.delivery = deliveries.get(entry.messageId);
    // A refresh contributes its newest page without losing the oldest already-loaded cursor.
    if (page.cursor != null && (cursor == null || page.cursor <= cursor)) {
      cursor = page.cursor; hasMore = Boolean(page.truncated || page.has_more);
    } else if (cursor == null) hasMore = Boolean(page.truncated || page.has_more);
    paint();
  };
  root.updateConversation(task, history);
  return root;
}
