import { block, button, el } from './dom.js';
import { agentText, markdownEnabled } from './text.js';
import { absolute } from './format.js';
import { loadHistory } from './api.js';
import { referenceable } from './context-references.js';
import { workerLabel } from './worker-label.js';

/** Only explicit user message events are follow-ups; inbox rows also contain runtime/Notice messages. */
export function renderGoal(task, history = {}, previous = null) {
  history ||= {};
  const signature = JSON.stringify([task.id, workerLabel(task), task.goal, markdownEnabled()]);
  if (previous?.goalSignature === signature) {
    previous.updateGoalHistory(history, task.goal_input_delivery);
    return previous;
  }
  if (!task.goal && !(history.events || []).some(isFollowup) && !history.truncated && !history.has_more) return null;
  const goal = block('Worker 目标'); goal.classList.add('goal-panel'); goal.goalSignature = signature;
  const initialTime = el('p', inputTime(task.goal_input_delivery), 'hint goal-input-time');
  if (task.goal) goal.append(initialTime, agentText(task.goal, { className: 'goal-text', plain: 'div' }));
  const fold = el('details', undefined, 'goal-history');
  fold.open = previous?.querySelector('.goal-history')?.open || false;
  const summary = el('summary'), list = el('div'), status = el('p', '', 'hint');
  const entries = new Map(previous?.goalEntries || []), rendered = new Map();
  goal.goalEntries = entries;
  let cursor = previous?.goalCursor ?? null, hasMore = previous?.goalHasMore ?? false;
  const more = button('加载更早输入', async () => {
    more.disabled = true; status.textContent = '正在读取更早的追加输入…';
    try {
      const page = await loadHistory(task.id, cursor);
      if (page.cursor === cursor && (page.truncated || page.has_more)) throw new Error('历史游标未前进');
      cursor = page.cursor ?? null; hasMore = Boolean(page.truncated || page.has_more);
      goal.updateGoalHistory(page);
      status.textContent = hasMore ? '更早历史尚未全部读取，可继续加载。' : '已读取全部追加输入历史。';
    } catch (error) { status.textContent = `读取未完成：${error.message}`; }
    finally { more.disabled = false; }
  }, 'ghost');
  function paint() {
    const ordered = [...entries.values()].sort((a, b) => a.id - b.id);
    for (const event of ordered) {
      let item = rendered.get(event.id);
      if (!item) {
        item = el('div', undefined, 'goal-history-entry'); item.dataset.eventId = String(event.id);
        item.append(el('p', '', 'hint goal-input-time'),
          agentText(event.data.body, { className: 'goal-text', plain: 'div' }));
        referenceable(item, { kind: 'history_event', target: { task_id: task.id, event_id: event.id },
          label: `Worker ${workerLabel(task)} 的追加输入`, quote: event.data.body,
          location: { view: 'task-detail', task_id: task.id, section: 'history' } });
        rendered.set(event.id, item);
      }
      item.querySelector('.goal-input-time').textContent = `追加输入 · ${inputTime(event.input_delivery)}`;
      list.insertBefore(item, null);
    }
    summary.textContent = `追加输入（已加载 ${ordered.length} 条${hasMore ? ' · 还有更早历史' : ''}）`;
    fold.hidden = !ordered.length && !hasMore;
    more.hidden = !hasMore || !cursor;
    goal.goalCursor = cursor; goal.goalHasMore = hasMore;
  }
  goal.updateGoalHistory = (page, delivery) => {
    if (delivery) initialTime.textContent = inputTime(delivery);
    for (const event of page.events || []) if (isFollowup(event)) entries.set(event.id, event);
    // A pending input may have aged out of the latest event page before it is delivered.
    // Receipt projections retain its exact identity and first delivery time across pagination.
    const deliveries = new Map((page.events || []).flatMap(event => event.input_deliveries || [])
      .map(delivery => [delivery.message_id, delivery]));
    for (const [id, event] of entries) {
      const delivery = deliveries.get(event.data.message_id);
      if (delivery) entries.set(id, { ...event, input_delivery: delivery });
    }
    // A refresh supplies the newest page: never discard older pages or reset their cursor.
    if (page.cursor != null && (cursor === null || page.cursor <= cursor)) {
      cursor = page.cursor; hasMore = Boolean(page.truncated || page.has_more);
    } else if (cursor === null) hasMore = Boolean(page.truncated || page.has_more);
    paint();
  };
  fold.append(summary, list, status, more); goal.append(fold);
  goal.updateGoalHistory(history);
  return goal;
}

function inputTime(delivery) {
  if (delivery?.status === 'delivered' && absolute(delivery.at)) return `输入时间：${absolute(delivery.at)}`;
  return delivery?.status === 'pending' ? '待输入' : '输入时间未知';
}

function isFollowup(event) {
  return event.type === 'message' && event.data?.sender === null && typeof event.data.body === 'string';
}
