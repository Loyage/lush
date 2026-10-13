import { $, button, el } from './dom.js';
import { api } from './api.js';
import { projectBase } from './route.js';
import { readPref } from './prefs.js';
import { ui } from './state.js';

const filterKey = () => JSON.stringify([[...readPref('taskGraphStatuses')].sort(), ui.taskGraphShowArchived]);
const STALE_CURSOR = 'Worker graph cursor stale; refresh from first page';

/** One cache for the current project/filter/boot. Never reuse cursors across detail modes. */
export function graphPage() {
  const scope = projectBase(), filter = filterKey(), doc = globalThis.document;
  if (!ui.taskGraphPage || ui.taskGraphPage.scope !== scope || ui.taskGraphPage.filter !== filter || ui.taskGraphPage.doc !== doc) {
    ui.disposeTaskGraph?.();
    ui.taskGraphPage = { scope, filter, doc, graph: null, fetchedAt: 0, error: null, nextError: null,
      summaryPending: null, fullPending: null, fullStarted: false, cursor: null, hasMore: false,
      generation: 0, controllers: new Set(), disposeTail: null, view: ui.view,
      firstBatchIds: new Set(), staleRestarts: 0, restartRequired: false, restarted: false };
  }
  const page = ui.taskGraphPage;
  if (page.view !== ui.view) {
    disposeGraph(page);
    page.view = ui.view;
  }
  ui.disposeTaskGraph = () => disposeGraph(page);
  return page;
}

function disposeGraph(page) {
  page.disposeTail?.(); page.disposeTail = null;
  page.generation++;
  for (const controller of page.controllers) controller.abort();
  page.controllers.clear(); page.summaryPending = null; page.fullPending = null;
}

export function graphRequestUrl(page, { summary = false, next = false } = {}) {
  const [hidden, archived] = JSON.parse(page.filter);
  let url = `/api/worker-graph?details=${summary ? 0 : 1}&hidden_statuses=${encodeURIComponent(JSON.stringify(hidden))}&include_archived=${archived ? 1 : 0}&scope=tree`;
  if (next && page.cursor) url += `&cursor=${encodeURIComponent(page.cursor)}`;
  return url;
}

const currentPage = page => ui.taskGraphPage === page && ui.view === page.view && ui.view?.id === 'task-graph'
  && projectBase() === page.scope && filterKey() === page.filter && globalThis.document === page.doc;

/** Refresh only the first batch. Retained historical bodies are explicitly older
 * samples, not a claim that the whole loaded range was revalidated. */
function applyBatch(page, response, { summary, next, restart, previousCursor }) {
  const [hidden, archived] = JSON.parse(page.filter);
  const matches = node => !ui.deletedWorkerIds.has(node.id) && !hidden.includes(node.status)
    && (archived || node.acceptance_recovery === true || !(node.archived || node.branch_info?.archived));
  const paginated = typeof response.has_more === 'boolean';
  const nodes = (response.nodes || []).map(node => paginated ? { ...node, graph_cached: false } : node);
  const incoming = new Set(nodes.map(node => node.id));
  const refreshing = !summary && !next && page.fullStarted && !restart;
  // A shrinking matching set can invalidate previously sampled first-batch
  // membership. Otherwise absence alone proves nothing: detail-byte budgets
  // can shrink the first page without a structural change. Retain such bodies
  // as older samples, including the pages the user explicitly scrolled to.
  const shrinking = refreshing && response.matched_total < page.graph?.matched_total;
  const retained = paginated && !restart ? (page.graph?.nodes || [])
    .filter(node => !shrinking || !page.firstBatchIds.has(node.id) || incoming.has(node.id))
    .map(node => refreshing && !incoming.has(node.id) ? { ...node, graph_cached: true } : node) : [];
  const byId = new Map([...retained, ...nodes].map(node => [node.id, node]));
  const graph = { ...response, nodes: [...byId.values()].filter(paginated ? matches : node => !ui.deletedWorkerIds.has(node.id)) };
  const loadedIds = new Set(graph.nodes.map(node => node.id));
  graph.edges = graph.nodes.filter(node => loadedIds.has(node.parent_id)).map(node => ({ from: node.parent_id, to: node.id }));
  graph.details_pending = response.details_pending === true || graph.nodes.some(node => node.details_pending === true);
  if (!summary && (!page.fullStarted || next || restart || !paginated || page.nextError
    || (!page.hasMore && response.matched_total > graph.nodes.length))) {
    page.fullStarted = true; page.cursor = response.cursor ?? null;
    page.hasMore = response.has_more === true && Boolean(page.cursor);
    page.nextError = null; page.restartRequired = false;
    if (next && !restart && page.hasMore && page.cursor === previousCursor) {
      page.nextError = '服务端分页位置未推进，请刷新后重试。';
      page.hasMore = false; page.restartRequired = true;
    }
  }
  if (!summary && (!next || restart)) page.firstBatchIds = incoming;
  if (restart) page.restarted = true;
  else if (next && !page.nextError) { page.staleRestarts = 0; page.restarted = false; }
  // Summary and full can have different byte boundaries. Only a full cursor is
  // ever exposed for continuation; summary-only nodes keep details_pending.
  if (paginated) { graph.cursor = page.cursor; graph.has_more = page.hasMore; }
  page.graph = graph; page.fetchedAt = Date.now(); page.error = null;
  ui.taskGraphFetchedAt = page.fetchedAt;
  return graph;
}

export async function readTaskGraph({ summary = false, next = false, retry = false } = {}) {
  const page = graphPage(), slot = summary ? 'summaryPending' : 'fullPending';
  if (!currentPage(page)) return null;
  if (!summary && page.summaryPending) {
    await page.summaryPending;
    return currentPage(page) ? readTaskGraph({ summary, next, retry }) : null;
  }
  if (summary && page.fullStarted) return page.graph;
  if (page[slot]) return page[slot];
  // After repeated structural changes only a deliberate retry can reopen the
  // chain. Automatic refresh must not accidentally replenish the retry budget.
  if (page.restartRequired && !retry) return page.graph;
  let restart = page.restartRequired && retry;
  if (restart) { summary = false; next = false; page.staleRestarts = 0; }
  if (next && (!page.fullStarted || !page.hasMore || !page.cursor)) return page.graph;
  const generation = page.generation, view = page.view;
  const controller = new AbortController(); page.controllers.add(controller);
  const current = () => currentPage(page) && page.generation === generation && page.view === view;
  page.error = null; if (next || restart) page.nextError = null;
  const previousCursor = page.cursor;
  const request = (async () => {
    try {
      let response;
      try { response = await api(graphRequestUrl(page, { summary, next }), { signal: controller.signal }); }
      catch (error) {
        if (!current() || error.name === 'AbortError') return null;
        if (!next || !error.message.startsWith(STALE_CURSOR)) throw error;
        page.restartRequired = true;
        if (page.staleRestarts >= 1) {
          page.hasMore = false;
          throw new Error('工作树结构连续变化，已停止自动重开；请手动重试。');
        }
        page.staleRestarts++;
        restart = true;
        // One bounded first-full-batch read, never another cursor read or a loop.
        response = await api(graphRequestUrl(page), { signal: controller.signal });
      }
      if (!current()) return null;
      return applyBatch(page, response, { summary, next, restart, previousCursor });
    } catch (error) {
      if (!current() || error.name === 'AbortError') return null;
      if (next || restart) page.nextError = error.message; else page.error = error.message;
      throw error;
    }
  })().finally(() => {
    page.controllers.delete(controller);
    if (page[slot] === request) page[slot] = null;
    if (current()) paintGraphStatus();
  });
  page[slot] = request; paintGraphStatus();
  return request;
}

export function paintGraphStatus() {
  const page = ui.taskGraphPage;
  if (!page || !currentPage(page)) return;
  const status = $('detail').querySelector('.task-graph-load-status');
  const sampled = page.fetchedAt ? new Date(page.fetchedAt).toLocaleTimeString('zh-CN', { hour12: false }) : '';
  const cached = page.graph?.nodes.some(node => node.graph_cached);
  if (status) status.textContent = (page.error ? `更新失败：${page.error}；保留上次可用内容，可点刷新重试。`
    : page.graph?.details_pending ? 'Worker 结构已加载，Git 诊断与累计用量加载中；其余随滚动补齐。'
      : page.fullPending || page.summaryPending ? `正在加载；${sampled ? `显示 ${sampled} 的缓存。` : '请稍候。'}`
        : sampled ? `首批采样 ${sampled}` : '')
    + (cached ? '；其余已加载历史为旧采样缓存，待更新。' : '')
    + (page.restartRequired ? '；分页已失效，旧缓存待重开，请手动重试。'
      : page.restarted ? '；结构已变化，已从首批重新加载，请继续向下滚动。' : '');
  const tail = $('detail').querySelector('.task-graph-page-tail');
  if (!tail) return;
  const count = tail.querySelector('.task-graph-page-count');
  if (count) count.textContent = `已加载 ${page.graph?.nodes.length || 0} / ${page.graph?.matched_total ?? page.graph?.total ?? 0} Worker`;
  const note = tail.querySelector('.task-graph-page-note');
  if (note) note.textContent = page.nextError ? `加载失败：${page.nextError}；请重试。`
    : page.fullPending ? '加载中…' : !page.fullStarted ? '正在补充详情…'
      : page.hasMore ? '向下滚动以加载下一批，或手动加载。'
        : cached ? '已加载范围含旧采样缓存，尚未重新核验全部历史。' : '已加载全部匹配 Worker。';
  const control = tail.querySelector('button');
  if (control) {
    control.textContent = page.nextError ? '重试加载' : '加载下一批';
    control.disabled = Boolean(page.fullPending || !page.fullStarted);
    control.hidden = !page.hasMore && !page.nextError;
  }
  tail.setAttribute('aria-busy', String(Boolean(page.fullPending)));
}

export function graphTail(loadNext) {
  const tail = el('section', undefined, 'task-graph-page-tail');
  tail.setAttribute('aria-label', '工作树分页');
  tail.append(el('p', undefined, 'task-graph-page-count'));
  const note = el('p', undefined, 'hint task-graph-page-note'); note.setAttribute('role', 'status');
  const control = button('加载下一批', () => loadNext(), 'ghost');
  control.dataset.graphFocus = 'load-next';
  tail.append(note, control);
  return tail;
}

/** The detail canvas is the vertical scroll root, not the horizontally scrolling tree.
 * Consume one downward-scroll intent per request. Reobserving after a repaint does
 * not fetch another page: a short tree/collapsed tree must never drain the backend. */
export function observeGraphTail(loadNext, protectedReading) {
  const page = graphPage(), root = $('detail'), tail = root.querySelector('.task-graph-page-tail');
  page.disposeTail?.(); page.disposeTail = null;
  if (!tail || !currentPage(page)) return;
  let active = true, near = false, armed = false, top = root.scrollTop;
  const current = () => active && currentPage(page) && root.querySelector('.task-graph-page-tail') === tail;
  const trigger = () => {
    if (!current() || !armed || !near || globalThis.document.hidden || page.fullPending || page.nextError
      || !page.fullStarted || !page.hasMore || protectedReading()) return;
    armed = false; void loadNext();
  };
  const scroll = () => {
    if (!current()) return;
    if (root.scrollTop > top) armed = true;
    top = root.scrollTop;
    if (!observer) near = root.scrollHeight - root.scrollTop - root.clientHeight <= 300;
    trigger();
  };
  const observer = typeof globalThis.IntersectionObserver === 'function' ? new globalThis.IntersectionObserver(entries => {
    if (!current()) return;
    near = entries.some(entry => entry.target === tail && entry.isIntersecting);
    trigger();
  }, { root, rootMargin: '0px 0px 300px 0px' }) : null;
  observer?.observe(tail); root.addEventListener('scroll', scroll, { passive: true });
  page.disposeTail = () => { active = false; observer?.disconnect(); root.removeEventListener?.('scroll', scroll); };
  paintGraphStatus();
}
