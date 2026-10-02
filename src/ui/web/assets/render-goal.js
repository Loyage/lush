import { block, button, el } from './dom.js';
import { agentText, markdownEnabled } from './text.js';
import { absolute } from './format.js';
import { loadHistory } from './api.js';
import { referenceable } from './context-references.js';

/** Only explicit user message events are follow-ups; inbox rows also contain runtime/Notice messages. */
export function renderGoal(task, history = {}, previous = null) {
  history ||= {};
  const signature = JSON.stringify([task.id, task.goal, markdownEnabled()]);
  if (previous?.goalSignature === signature) {
    previous.updateGoalHistory(history);
    return previous;
  }
  if (!task.goal && !(history.events || []).some(isFollowup) && !history.truncated && !history.has_more) return null;
  const goal = block('任务目标'); goal.classList.add('goal-panel'); goal.goalSignature = signature;
  if (task.goal) goal.append(agentText(task.goal, { className: 'goal-text', plain: 'div' }));
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
    const ordered = [...entries.values()].sort((a, b) => b.id - a.id);
    for (const event of ordered) {
      let item = rendered.get(event.id);
      if (!item) {
        item = el('details', undefined, 'goal-history-entry'); item.dataset.eventId = String(event.id);
        item.append(el('summary', `追加输入 · ${absolute(event.created_at)}`));
        item.addEventListener('toggle', () => {
          if (!item.open || item.dataset.loaded) return;
          item.dataset.loaded = 'true';
          item.append(agentText(event.data.body, { className: 'goal-text', plain: 'div' }));
        });
        referenceable(item, { kind: 'history_event', target: { task_id: task.id, event_id: event.id },
          label: `任务 #${task.id} 的追加输入`, quote: event.data.body,
          location: { view: 'task-detail', task_id: task.id, section: 'history' } });
        rendered.set(event.id, item);
      }
      list.insertBefore(item, null);
    }
    summary.textContent = `追加输入（已加载 ${ordered.length} 条${hasMore ? ' · 还有更早历史' : ''}）`;
    fold.hidden = !ordered.length && !hasMore;
    more.hidden = !hasMore || !cursor;
    goal.goalCursor = cursor; goal.goalHasMore = hasMore;
  }
  goal.updateGoalHistory = page => {
    for (const event of page.events || []) if (isFollowup(event)) entries.set(event.id, event);
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

function isFollowup(event) {
  return event.type === 'message' && event.data?.sender === null && typeof event.data.body === 'string';
}
