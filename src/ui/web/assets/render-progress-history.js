import { api } from './api.js';
import { block, button, el, syncChildren } from './dom.js';
import { absolute } from './format.js';
import { progressReportingEnabled, progressStats, renderTaskProgress } from './render-progress.js';
import { projectBase } from './route.js';
import { ui } from './state.js';

// Kept on the rendered section: switching Worker/page discards its pagination, not a global cache.
const histories = new WeakMap();
const REASONS = { new_input: '收到追加输入', replan: '调整计划' };

function mergeItems(state, items) {
  for (const item of items) {
    if (!item || !Number.isSafeInteger(item.id) || state.records.has(item.id)) continue;
    const fold = el('details', undefined, 'progress-history-version');
    fold.dataset.progressHistoryId = String(item.id);
    const stats = progressStats(item.progress);
    fold.append(el('summary', `计划记录 #${item.id} · ${absolute(item.archived_at)} · ${REASONS[item.reason] || '计划更新'} · ${stats.completed}/${stats.total}`));
    const progress = renderTaskProgress(item.progress, { historical: true });
    fold.append(progress || el('p', '该版本没有可展示的步骤。', 'hint'));
    state.records.set(item.id, fold);
  }
  syncChildren(state.list, [...state.records].sort(([a], [b]) => b - a).map(([, node]) => node));
}

function paintControls(state) {
  state.more.hidden = !state.hasMore && !state.error;
  state.more.disabled = state.loading;
  state.more.textContent = state.loading ? '加载中…' : state.error ? '重试加载更早计划' : '加载更早计划';
  state.note.textContent = state.error ? `加载更早计划失败：${state.error}` : state.hasMore ? '按需加载更早版本，每次最多 10 条。' : '没有更早的计划了。';
  state.note.className = state.error ? 'error progress-history-status' : 'hint progress-history-status';
}

/** Current plan stays separate; archived versions are collapsed, immutable and never live-ticked. */
export function renderProgressHistory(task, previous = null) {
  if (!progressReportingEnabled()) return null;
  const page = task.progress_history;
  if (!Array.isArray(page?.items)) return null; // Older daemon, not a claim of empty history.
  let state = histories.get(previous);
  if (state?.taskId !== task.id) state = null;
  if (!state && !page.items.length && !page.has_more) return null;
  if (!state) {
    const section = block('过往计划'); section.classList.add('progress-history-panel');
    const list = el('div', undefined, 'progress-history-list');
    const controls = el('div', undefined, 'progress-history-controls');
    const note = el('p', undefined, 'hint progress-history-status'); note.setAttribute('role', 'status');
    state = { section, list, note, taskId: task.id, records: new Map(), cursor: page.cursor,
      hasMore: Boolean(page.has_more), loading: false, error: null };
    const help = '只读取该 Worker 更早的冻结计划，不改变当前进度，也不调用 Agent。';
    state.more = button('加载更早计划', async () => {
      if (state.loading || !state.hasMore) return;
      const panel = document.getElementById('detail');
      const view = ui.view, base = projectBase();
      const current = () => progressReportingEnabled() && projectBase() === base && ui.view === view
        && panel.dataset.view === 'task' && panel.dataset.taskId === String(task.id)
        && panel.querySelector('.progress-history-panel') === section && !ui.deletedWorkerIds.has(task.id);
      if (!current()) return;
      state.loading = true; state.error = null; paintControls(state);
      const requestedCursor = state.cursor;
      try {
        const next = await api(`/api/worker/${task.id}/progress-history?before=${encodeURIComponent(requestedCursor)}&limit=10`);
        if (!current()) return;
        if (!Array.isArray(next?.items) || (next.has_more && (!Number.isSafeInteger(next.cursor) || next.cursor >= requestedCursor))) {
          throw new Error('历史分页响应无效，请更新服务后重试。');
        }
        mergeItems(state, next.items);
        // A refresh may discover a newer gap while this older request is in flight.
        if (state.cursor === requestedCursor) {
          state.cursor = next.cursor; state.hasMore = Boolean(next.has_more);
        }
      } catch (error) {
        if (current()) state.error = error.message;
      } finally {
        state.loading = false;
        if (current()) paintControls(state);
      }
    }, 'ghost', { help });
    const helpHost = el('span', undefined, 'help-host'); helpHost.setAttribute('data-help', help);
    helpHost.append(state.more); // In-flight disabled buttons need an event-capable help host.
    controls.append(helpHost, note); section.append(list, controls);
    histories.set(section, state);
  }
  // A disjoint newest window means enough plans changed since the last refresh to leave a gap.
  // Revisit from that window's cursor; keep all loaded/open nodes, but do not silently skip the gap.
  if (state.records.size && page.has_more && page.items.length
    && !page.items.some(item => state.records.has(item.id))
    && page.items.every(item => item.id > Math.max(...state.records.keys()))) {
    state.cursor = page.cursor; state.hasMore = true;
  }
  // Overlapping inspect windows must not reset the user's older pagination cursor.
  mergeItems(state, page.items);
  paintControls(state);
  return state.section;
}
