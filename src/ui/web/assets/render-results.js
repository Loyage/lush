import { block, el, button } from './dom.js';
import { agentText } from './text.js';
import { absolute } from './format.js';
import { loadHistory } from './api.js';
import { referenceable } from './context-references.js';
import { workerLabel } from './worker-label.js';

/** Runs supply persisted results; event pagination reaches history beyond inspect's byte budget. */
export function renderResults(task, history = {}, previous = null) {
  history ||= {};
  const signature = JSON.stringify([workerLabel(task), task.result, (task.runs || []).filter(run => run.result).map(run => run.id),
    (history.events || []).filter(event => event.type === 'invocation.completed').map(event => event.id)]);
  if (previous?.resultSignature === signature) return previous;
  const entries = new Map();
  for (const run of task.runs || []) if (typeof run.result === 'string' && run.result) entries.set(`run:${run.id}`, {
    key: `run:${run.id}`, runId: run.id, text: run.result, at: run.ended_at || run.started_at });
  function addEvents(events) {
    for (const event of events || []) {
      if (event.type !== 'invocation.completed' || !event.data?.result) continue;
      const runId = event.data.run_id, key = runId ? `run:${runId}` : `event:${event.id}`;
      entries.set(key, { key, runId, eventId: event.id, text: event.data.result, at: event.created_at });
    }
  }
  addEvents(history.events);
  if (!task.result && !entries.size && !history.truncated) return null;
  const result = block('结果'); result.classList.add('result-panel'); result.resultSignature = signature;
  if (task.result) {
    const latest = agentText(task.result, { plain: 'pre' }); result.append(latest);
    referenceable(latest, { kind: 'result', target: { task_id: task.id, section: 'result' }, label: `Worker 结果 ${workerLabel(task)}`,
      quote: task.result, location: { view: 'task-detail', task_id: task.id, section: 'result' } });
  } else result.append(el('p', '当前没有最新结果；此前调用的结果保留在下方。', 'hint'));
  const fold = el('details', undefined, 'result-history');
  fold.open = previous?.querySelector('.result-history')?.open ?? true;
  const summary = el('summary'); const list = el('div'); const status = el('p', '', 'hint');
  let cursor = history.cursor, hasMore = Boolean(history.truncated || history.has_more);
  const rendered = new Map();
  const more = button('加载更早结果', async () => {
    more.disabled = true; status.textContent = '正在读取更早的调用结果…';
    try {
      const page = await loadHistory(task.id, cursor);
      if (page.cursor === cursor && (page.truncated || page.has_more)) throw new Error('历史游标未前进');
      addEvents(page.events); cursor = page.cursor; hasMore = Boolean(page.truncated || page.has_more); paint();
      status.textContent = hasMore ? '更早历史尚未全部读取，可继续加载。' : '已读取全部结果历史。';
    } catch (error) { status.textContent = `读取未完成：${error.message}`; }
    finally { more.disabled = false; }
  }, 'ghost');
  function paint() {
    const ordered = [...entries.values()].sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')) || (b.runId || b.eventId || 0) - (a.runId || a.eventId || 0));
    // Only the newest occurrence is represented by the default latest-result body. Equal older results remain distinct.
    const latest = ordered[0]?.text === task.result ? ordered[0].key : null;
    const older = ordered.filter(entry => entry.key !== latest);
    for (const entry of older) {
      if (rendered.has(entry.key)) { list.insertBefore(rendered.get(entry.key), null); continue; }
      const item = el('div', undefined, 'result-history-entry'); item.dataset.resultKey = entry.key;
      item.append(el('p', `${entry.runId ? `调用 #${entry.runId}` : `记录 #${entry.eventId}`} · ${absolute(entry.at)}`, 'hint result-history-time'),
        agentText(entry.text, { plain: 'pre' }));
      // Historical results refer to their immutable event, never to the mutable latest result.
      if (entry.eventId) referenceable(item, { kind: 'history_event', target: { task_id: task.id, event_id: entry.eventId },
        label: `历史结果 ${workerLabel(task)} · 事件 #${entry.eventId}`, quote: entry.text,
        location: { view: 'task-detail', task_id: task.id, section: 'history' } });
      rendered.set(entry.key, item); list.append(item);
    }
    summary.textContent = `此前结果（已加载 ${older.length} 次${hasMore ? ' · 还有更早历史' : ''}）`;
    fold.hidden = !older.length && !hasMore; more.hidden = !hasMore || !cursor;
  }
  fold.append(summary, list, status, more); result.append(fold); paint();
  return result;
}
