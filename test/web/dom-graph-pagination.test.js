import { test, expect } from 'bun:test';
import { installDom, deepText, answerDialog } from './project-dom.js';
import { gate } from '../helpers.js';
import { ui, resetUiState } from '../../src/ui/web/assets/state.js';
import { openTaskGraph, loadTaskGraph, loadNextTaskGraph } from '../../src/ui/web/assets/render-task-graph.js';
import { activateDetailView } from '../../src/ui/web/assets/sidebar-ui.js';
import { setPref, resetPrefs } from '../../src/ui/web/assets/prefs.js';
import { runWorkerDelete } from '../../src/ui/web/assets/worker-delete.js';

const json = value => ({ ok: true, json: async () => value });
const worker = (id, extra = {}) => ({ id, parent_id: id === 1 ? null : 1, task_kind: id === 1 ? 'main' : 'child',
  status: 'waiting', title: `Worker ${id}`, ...extra });

function fixture({ size = 450, fullLimit = 200, summaryLimit = 200, observer = true } = {}) {
  const state = { nodes: Array.from({ length: size }, (_, index) => worker(index + 1)), fullLimit, summaryLimit,
    requests: [], delay: null, fail: false, intercept: null };
  const dom = installDom({ fetch: async (url, options) => {
    const query = new URL(String(url), 'http://localhost').searchParams;
    state.requests.push({ query, url: String(url), options });
    if (String(url).startsWith('/api/worker-graph') && query.get('scope') !== 'tree') throw Error('missing tree scope');
    const intercepted = state.intercept?.(query, options, String(url)); if (intercepted) return intercepted;
    if (query.has('cursor') && state.delay) return state.delay.promise;
    if (query.has('cursor') && state.fail) return { ok: false, json: async () => ({ error: '下一批不可用' }) };
    const hidden = new Set(JSON.parse(query.get('hidden_statuses') || '[]'));
    const archived = query.get('include_archived') === '1';
    const listed = state.nodes.filter(node => archived || !node.archived);
    const counts = {}; for (const node of listed) counts[node.status] = (counts[node.status] || 0) + 1;
    const matched = listed.filter(node => !hidden.has(node.status));
    const summary = query.get('details') === '0';
    const cursor = query.get('cursor');
    if (cursor && !cursor.startsWith(summary ? 's:' : 'f:')) throw Error('cursor crossed detail modes');
    const offset = cursor ? Number(cursor.slice(2)) : 0, limit = summary ? state.summaryLimit : state.fullLimit;
    const nodes = matched.slice(offset, offset + limit).map(node => ({ ...node, details_pending: summary,
      layout_parent_id: matched.some(parent => parent.id === node.parent_id) ? node.parent_id : null }));
    const has_more = offset + nodes.length < matched.length;
    return json({ nodes, edges: [], total: state.nodes.length, matched_total: matched.length,
      counts, archived_count: state.nodes.filter(node => node.archived).length, details_pending: summary,
      truncated: has_more, has_more, cursor: has_more ? `${summary ? 's' : 'f'}:${offset + nodes.length}` : null });
  } });
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'IntersectionObserver'), observers = [];
  class Observer {
    constructor(callback, options) { this.callback = callback; this.options = options; this.disconnected = false; observers.push(this); }
    observe(target) { this.target = target; }
    disconnect() { this.disconnected = true; }
    emit(near = true) { this.callback([{ target: this.target, isIntersecting: near }]); }
  }
  Object.defineProperty(globalThis, 'IntersectionObserver', { configurable: true, writable: true, value: observer ? Observer : undefined });
  resetUiState();
  const root = dom.node('detail'); root.clientHeight = 600; root.scrollHeight = 50000;
  dom.node('modal').hidden = true;
  return { state, dom, root, observers, activeObserver: () => observers.findLast(item => !item.disconnected),
    cards: () => root.querySelectorAll('.task-graph-card'),
    scroll: (amount = 500) => { root.scrollTop += amount; for (const callback of [...(root.listeners.scroll || [])]) callback(); },
    open: async () => { await openTaskGraph(); await loadTaskGraph(); },
    close: () => { resetUiState(); dom.restore();
      if (previous) Object.defineProperty(globalThis, 'IntersectionObserver', previous); else delete globalThis.IntersectionObserver; },
  };
}

test('over 200 Workers: actual scroll-root observer, one batch per downward gesture, manual final page, no background drain', async () => {
  const f = fixture();
  try {
    await f.open(); expect(f.cards()).toHaveLength(200); expect(f.state.requests).toHaveLength(2);
    expect(f.activeObserver().options.root).toBe(f.root);
    expect(f.activeObserver().options.rootMargin).toContain('300px');
    expect(deepText(f.root)).toContain('已加载 200 / 450 Worker');
    expect(deepText(f.root)).not.toContain('只显示最近及活动');
    f.activeObserver().emit(); await Promise.resolve(); expect(f.state.requests).toHaveLength(2);
    f.scroll(); await loadTaskGraph();
    expect(f.cards()).toHaveLength(400); expect(f.state.requests).toHaveLength(3);
    expect(f.state.requests[2].query.get('cursor')).toBe('f:200');
    // Re-observation caused by paint must not silently load the rest of the tree.
    f.activeObserver().emit(); await Promise.resolve(); expect(f.state.requests).toHaveLength(3);
    await f.root.querySelector('[data-graph-focus="load-next"]').onclick();
    expect(f.cards()).toHaveLength(450); expect(f.state.requests).toHaveLength(4);
    expect(deepText(f.root)).toContain('已加载 450 / 450 Worker');
    expect(deepText(f.root)).toContain('已加载全部匹配');
    expect(f.root.querySelector('[data-graph-focus="load-next"]').hidden).toBe(true);
    expect(f.dom.intervals).toHaveLength(0);
  } finally { f.close(); }
});

test('repeated observer and manual triggers share the same next-page flight; loading placeholder remains accessible', async () => {
  const f = fixture();
  try {
    await f.open(); const delayed = f.state.delay = gate();
    f.activeObserver().emit(); f.scroll();
    f.activeObserver().emit(); f.scroll(); const manual = loadNextTaskGraph();
    expect(f.state.requests).toHaveLength(3);
    expect(deepText(f.root)).toContain('加载中');
    expect(f.root.querySelector('[data-graph-focus="load-next"]').disabled).toBe(true);
    expect(f.root.querySelector('.task-graph-page-tail').getAttribute('aria-busy')).toBe('true');
    delayed.resolve(json({ nodes: Array.from({ length: 200 }, (_, i) => worker(i + 201)), total: 450,
      matched_total: 450, counts: { waiting: 450 }, archived_count: 0, has_more: true, cursor: 'f:400' }));
    await manual; expect(f.cards()).toHaveLength(400); expect(f.state.requests).toHaveLength(3);
  } finally { f.close(); }
});

test('server filters, full-range counts and archive controls do not load hidden status or recycled bodies', async () => {
  const f = fixture({ size: 420 });
  f.state.nodes = f.state.nodes.map(node => ({ ...node, status: node.id > 200 ? 'completed' : 'waiting', archived: node.id > 410 }));
  try {
    await f.open(); const chip = status => f.root.querySelector(`[data-status="${status}"]`);
    expect(chip('completed').textContent).toContain('210');
    expect(f.root.querySelector('[data-graph-focus="show-archived"]').textContent).toContain('10');
    await chip('completed').onclick(); await loadTaskGraph();
    expect(f.cards()).toHaveLength(200); expect(ui.taskGraphPage.graph.nodes.every(node => node.status === 'waiting')).toBe(true);
    expect(chip('completed').textContent).toContain('210'); expect(chip('completed').getAttribute('aria-pressed')).toBe('false');
    for (const request of f.state.requests.slice(2)) {
      expect(request.query.get('hidden_statuses')).toBe('["completed"]');
      expect(request.query.get('include_archived')).toBe('0'); expect(request.query.has('cursor')).toBe(false);
    }
    await f.root.querySelector('[data-graph-focus="show-archived"]').onclick(); await loadTaskGraph();
    expect(f.state.requests.at(-1).query.get('include_archived')).toBe('1');
    expect(chip('completed').textContent).toContain('220'); expect(f.cards()).toHaveLength(200);
    await chip('completed').onclick(); await loadTaskGraph(); await loadNextTaskGraph(); await loadNextTaskGraph();
    expect(f.cards()).toHaveLength(420); expect(f.root.querySelector('[data-task-id="420"]')).toBeTruthy();
    activateDetailView({ view: 'overview' }); await f.open();
    expect(ui.taskGraphShowArchived).toBe(false); expect(f.state.requests.at(-1).query.get('include_archived')).toBe('0');
  } finally { f.close(); }
});

test('refresh samples only the first full batch and retains the loaded historical range/cursor and scroll/focus', async () => {
  const f = fixture();
  try {
    await f.open(); await loadNextTaskGraph();
    f.root.scrollTop = 1600;
    const focus = f.root.querySelector('[data-graph-focus="title-350"]'); focus.focus();
    f.state.nodes[1].title = '首批新标题';
    const before = f.state.requests.length; await loadTaskGraph();
    expect(f.state.requests).toHaveLength(before + 1); expect(f.state.requests.at(-1).query.has('cursor')).toBe(false);
    expect(f.cards()).toHaveLength(400); expect(f.root.querySelector('[data-task-id="350"]')).toBeTruthy();
    expect(deepText(f.root)).toContain('首批新标题'); expect(ui.taskGraphPage.cursor).toBe('f:400');
    expect(f.root.scrollTop).toBe(1600); expect(document.activeElement.dataset.graphFocus).toBe('title-350');
    await loadNextTaskGraph(); expect(f.cards()).toHaveLength(450);
    expect(f.state.requests.at(-1).query.get('cursor')).toBe('f:400');
  } finally { f.close(); }
});

test('different summary/full byte boundaries retain summary-only nodes and advance exclusively along full cursors', async () => {
  const f = fixture({ size: 230, fullLimit: 70 });
  try {
    await f.open(); expect(f.cards()).toHaveLength(200); expect(f.state.requests).toHaveLength(2);
    expect(ui.taskGraphPage.cursor).toBe('f:70');
    expect(ui.taskGraphPage.graph.nodes.find(node => node.id === 170).details_pending).toBe(true);
    await loadNextTaskGraph(); expect(f.cards()).toHaveLength(200);
    await loadNextTaskGraph(); expect(f.cards()).toHaveLength(210);
    await loadNextTaskGraph(); expect(f.cards()).toHaveLength(230);
    expect(ui.taskGraphPage.graph.nodes.every(node => node.details_pending === false)).toBe(true);
    expect(ui.taskGraphPage.graph.details_pending).toBe(false);
    expect(f.state.requests.slice(2).map(request => request.query.get('cursor'))).toEqual(['f:70', 'f:140', 'f:210']);
    expect(new Set(ui.taskGraphPage.graph.nodes.map(node => node.id)).size).toBe(230);
  } finally { f.close(); }
});

test('full page larger than summary boundary does not drop full-only IDs', async () => {
  const f = fixture({ size: 230, summaryLimit: 60 });
  try {
    await f.open(); expect(f.cards()).toHaveLength(200); await loadNextTaskGraph();
    expect(f.cards()).toHaveLength(230); expect(f.state.requests.at(-1).query.get('cursor')).toBe('f:200');
  } finally { f.close(); }
});

test('inline next-page errors preserve cards and cursor, stop automatic retry, and explicit retry resumes', async () => {
  const f = fixture();
  try {
    await f.open(); f.state.fail = true;
    await loadNextTaskGraph(); expect(f.cards()).toHaveLength(200); expect(ui.taskGraphPage.cursor).toBe('f:200');
    expect(deepText(f.root)).toContain('加载失败：下一批不可用');
    expect(f.root.querySelector('[data-graph-focus="load-next"]').textContent).toBe('重试加载');
    f.activeObserver().emit(); f.scroll(); expect(f.state.requests).toHaveLength(3);
    f.state.fail = false; await f.root.querySelector('[data-graph-focus="load-next"]').onclick();
    expect(f.cards()).toHaveLength(400); expect(f.state.requests.at(-1).query.get('cursor')).toBe('f:200');
    expect(deepText(f.root)).not.toContain('下一批不可用');
  } finally { f.close(); }
});

test('a filter change resets paging identity; a late old page cannot populate the new filter cache', async () => {
  const f = fixture();
  try {
    f.state.nodes = f.state.nodes.map(node => ({ ...node, status: node.id > 200 ? 'completed' : 'waiting' }));
    await f.open(); const delayed = f.state.delay = gate(), old = loadNextTaskGraph();
    await f.root.querySelector('[data-status="completed"]').onclick(); await loadTaskGraph();
    expect(f.cards()).toHaveLength(200); const page = ui.taskGraphPage;
    delayed.resolve(json({ nodes: [worker(449, { title: '旧筛选迟到' })], has_more: false, cursor: null })); await old;
    expect(ui.taskGraphPage).toBe(page); expect(f.root.querySelector('[data-task-id="449"]')).toBeNull();
    expect(deepText(f.root)).not.toContain('旧筛选迟到');
    expect(f.state.requests.at(-1).query.get('hidden_statuses')).toBe('["completed"]');
    expect(f.state.requests.at(-1).query.has('cursor')).toBe(false);
  } finally { f.close(); }
});

test('navigation releases common modules and graph observers, cancels reads, and ignores late callback/response', async () => {
  const f = fixture();
  try {
    await f.open(); const observer = f.activeObserver(), page = ui.taskGraphPage;
    const delayed = f.state.delay = gate(), pending = loadNextTaskGraph();
    let modulesDisposed = 0;
    ui.disposePageModules = () => { modulesDisposed++; };
    activateDetailView({ view: 'overview' }); f.root.textContent = '另一页';
    expect(modulesDisposed).toBe(1);
    expect(f.state.requests.at(-1).options.signal.aborted).toBe(true);
    expect(observer.disconnected).toBe(true); expect(f.root.listeners.scroll).toHaveLength(0);
    observer.emit(); f.scroll(); expect(f.state.requests).toHaveLength(3);
    delayed.resolve(json({ nodes: [worker(430, { title: '迟到历史' })], has_more: false, cursor: null })); await pending;
    expect(f.root.textContent).toBe('另一页'); expect(page.graph.nodes).toHaveLength(200);
    expect(page.cursor).toBe('f:200');
    f.state.delay = null; await f.open(); expect(f.cards()).toHaveLength(200);
    expect(f.root.listeners.scroll).toHaveLength(1); expect(f.observers.filter(item => !item.disconnected)).toHaveLength(1);
  } finally { f.close(); }
});

test('reset, project switch and deletion invalidate pending next-page results', async () => {
  for (const mode of ['reset', 'project', 'delete']) {
    const f = fixture();
    try {
      await f.open(); const delayed = f.state.delay = gate(), pending = loadNextTaskGraph();
      if (mode === 'reset') { resetUiState(); activateDetailView({ view: 'overview' }); }
      if (mode === 'project') { f.dom.location.pathname = '/p/bbbbbbbbbbbbbbbb/'; await f.open(); }
      if (mode === 'delete') {
        f.state.intercept = (_query, _options, url) => {
          if (url.endsWith('/delete-preview')) return json({ id: 201, revision: 'fixed', can_delete: true,
            blockers: [], warnings: [], workers: [{ id: 201, goal: '已删除', status: 'completed' }], inputs: [],
            resources: { worktrees: [], branches: [], files: [] } });
          if (url === '/api/action') return json({ deleted: true });
          return null;
        };
        const deleting = runWorkerDelete(worker(201, { status: 'completed' }));
        for (let i = 0; i < 8; i++) await Promise.resolve();
        await answerDialog(f.dom, '彻底删除'); expect(await deleting).toBe(true);
      }
      const page = ui.taskGraphPage;
      delayed.resolve(json({ nodes: [worker(201, { title: '已失效' })], has_more: false, cursor: null })); await pending;
      expect(ui.taskGraphPage).toBe(page); expect(deepText(f.root)).not.toContain('已失效');
      expect(page?.graph?.nodes.some(node => node.id === 201) || false).toBe(false);
    } finally { f.close(); }
  }
});

test('preference reset discards the old filtered cache and encodes statuses in stable order', async () => {
  const f = fixture();
  try {
    setPref('taskGraphStatuses', new Set(['waiting', 'completed'])); await f.open();
    expect(f.state.requests[0].query.get('hidden_statuses')).toBe('["completed","waiting"]');
    expect(f.cards()).toHaveLength(0);
    resetPrefs(); await loadTaskGraph();
    expect(f.state.requests.at(-1).query.get('hidden_statuses')).toBe('[]');
    expect(f.state.requests.at(-1).query.has('cursor')).toBe(false); expect(f.cards()).toHaveLength(200);
  } finally { f.close(); }
});

test('reading protection defers scroll requests and DOM replacement during selection, editing, or an open action layer', async () => {
  const f = fixture();
  try {
    await f.open(); f.activeObserver().emit();
    const tree = f.root.querySelector('.task-graph');
    f.dom.setSelection('选中文字'); f.scroll(); expect(f.state.requests).toHaveLength(2);
    f.state.nodes[0].title = '刷新后的标题'; await loadTaskGraph();
    expect(f.root.querySelector('.task-graph')).toBe(tree);
    f.dom.setSelection(''); const input = document.createElement('textarea'); input.value = '未提交'; f.root.append(input);
    f.scroll(); expect(f.state.requests).toHaveLength(3); await loadTaskGraph();
    expect(f.root.querySelector('textarea')).toBe(input); expect(f.root.querySelector('.task-graph')).toBe(tree);
    input.remove(); const panel = f.root.querySelector('.task-graph-actions-popover'); panel.dataset.open = 'true';
    f.scroll(); expect(f.state.requests).toHaveLength(4); await loadTaskGraph();
    expect(f.root.querySelector('.task-graph')).toBe(tree);
    panel.dataset.open = 'false'; await loadTaskGraph();
    expect(f.root.querySelector('.task-graph')).not.toBe(tree); expect(deepText(f.root)).toContain('刷新后的标题');
  } finally { f.close(); }
});

test('without IntersectionObserver the manual button and near-end downward scrolling still load safely', async () => {
  const f = fixture({ observer: false });
  try {
    await f.open(); f.scroll(); expect(f.state.requests).toHaveLength(2);
    f.root.scrollHeight = 2000; f.root.scrollTop = 1100; f.scroll(100); await loadTaskGraph();
    expect(f.cards()).toHaveLength(400); await f.root.querySelector('[data-graph-focus="load-next"]').onclick();
    expect(f.cards()).toHaveLength(450);
  } finally { f.close(); }
});

test('server layout ancestor is used without rewriting the real parent; oversize details have a visible truncation marker', async () => {
  const f = fixture({ size: 3 });
  f.state.nodes[1].status = 'completed'; f.state.nodes[2].parent_id = 2; f.state.nodes[2].details_unavailable = true;
  try {
    setPref('taskGraphStatuses', new Set(['completed'])); await f.open();
    // The synthetic server returns null when the real parent is filtered; its explicit null is authoritative.
    const child = f.root.querySelector('[data-task-id="3"]'); expect(child).toBeTruthy();
    expect(deepText(child)).toContain('详情过大不可用'); expect(ui.taskGraphPage.graph.nodes.find(node => node.id === 3).parent_id).toBe(2);
    expect(child.parentNode.parentNode).toBe(f.root.querySelector('.task-graph'));
    ui.taskGraphMinimal = false; await loadTaskGraph();
    expect(deepText(f.root)).toContain('图中详情不可用');
    expect(deepText(f.root)).toContain('打开 Worker 详情单独读取');
  } finally { f.close(); }
});

test('manual full refresh joins a slow summary and cannot race a late summary downgrade', async () => {
  const f = fixture({ size: 20 });
  try {
    const delayed = gate();
    f.state.intercept = query => query.get('details') === '0' ? delayed.promise : null;
    const opening = openTaskGraph(); const refresh = loadTaskGraph();
    expect(f.state.requests).toHaveLength(1);
    delayed.resolve(json({ nodes: [worker(1, { title: '摘要', details_pending: true })], counts: { waiting: 20 },
      matched_total: 20, total: 20, archived_count: 0, details_pending: true, has_more: true, cursor: 's:1' }));
    await opening; await refresh;
    expect(f.state.requests).toHaveLength(2); expect(f.cards()).toHaveLength(20);
    expect(ui.taskGraphPage.graph.nodes.every(node => node.details_pending === false)).toBe(true);
    expect(ui.taskGraphPage.graph.details_pending).toBe(false);
  } finally { f.close(); }
});

test('non-advancing cursors stop scroll loading; retry safely restarts the full continuation', async () => {
  const f = fixture();
  try {
    await f.open();
    f.state.intercept = query => query.has('cursor') ? json({ nodes: [], counts: { waiting: 450 },
      matched_total: 450, total: 450, archived_count: 0, has_more: true, cursor: 'f:200' }) : null;
    await loadNextTaskGraph(); expect(deepText(f.root)).toContain('分页位置未推进');
    f.activeObserver().emit(); f.scroll(); expect(f.state.requests).toHaveLength(3);
    f.state.intercept = null;
    await f.root.querySelector('[data-graph-focus="load-next"]').onclick();
    expect(f.state.requests.at(-1).query.has('cursor')).toBe(false);
    expect(ui.taskGraphPage.hasMore).toBe(true); expect(ui.taskGraphPage.nextError).toBeNull();
    await loadNextTaskGraph(); expect(f.cards()).toHaveLength(400);
  } finally { f.close(); }
});

test('an exhausted cache can discover new matching history without prefetching it all on refresh', async () => {
  const f = fixture({ size: 200 });
  try {
    await f.open(); expect(ui.taskGraphPage.hasMore).toBe(false);
    f.state.nodes.push(...Array.from({ length: 50 }, (_, index) => worker(index + 201)));
    await loadTaskGraph(); expect(f.cards()).toHaveLength(200);
    expect(ui.taskGraphPage.hasMore).toBe(true); expect(ui.taskGraphPage.cursor).toBe('f:200');
    await loadNextTaskGraph(); expect(f.cards()).toHaveLength(250);
  } finally { f.close(); }
});

const staleResponse = () => ({ ok: false, json: async () => ({ error: 'Worker graph cursor stale; refresh from first page: structure changed' }) });

test('stale cursor automatically reopens just one full first batch, discards old structure, and keeps all filter/scope parameters', async () => {
  const f = fixture();
  try {
    setPref('taskGraphStatuses', new Set(['completed'])); await f.open(); await loadNextTaskGraph();
    expect(f.cards()).toHaveLength(400);
    f.state.nodes[399].status = 'completed'; let rejected = false;
    f.state.intercept = query => query.has('cursor') && !rejected ? (rejected = true, staleResponse()) : null;
    await loadNextTaskGraph(); expect(f.state.requests).toHaveLength(5); expect(f.cards()).toHaveLength(200);
    expect(f.state.requests.at(-1).query.has('cursor')).toBe(false);
    expect(f.state.requests.at(-1).query.get('details')).toBe('1');
    expect(deepText(f.root)).toContain('结构已变化，已从首批重新加载');
    for (const request of f.state.requests) {
      expect(request.query.get('scope')).toBe('tree'); expect(request.query.get('hidden_statuses')).toBe('["completed"]');
      expect(request.query.get('include_archived')).toBe('0');
    }
    // The new continuation belongs to the new first full batch; old hidden Worker 400 cannot revive.
    await loadNextTaskGraph(); expect(f.cards()).toHaveLength(400);
    expect(f.root.querySelector('[data-task-id="400"]')).toBeNull();
    expect(ui.taskGraphPage.staleRestarts).toBe(0);
  } finally { f.close(); }
});

test('consecutive structural changes stop after one automatic first-batch reopen, including across automatic refresh; manual retry starts a new chain', async () => {
  const f = fixture();
  try {
    await f.open(); let remaining = 2;
    f.state.intercept = query => query.has('cursor') && remaining > 0 ? (remaining--, staleResponse()) : null;
    await loadNextTaskGraph(); expect(f.state.requests).toHaveLength(4); expect(ui.taskGraphPage.staleRestarts).toBe(1);
    // A routine first-batch refresh must not reset the structural retry budget.
    await loadTaskGraph(); expect(f.state.requests).toHaveLength(5);
    await loadNextTaskGraph(); expect(f.state.requests).toHaveLength(6);
    expect(deepText(f.root)).toContain('结构连续变化'); expect(deepText(f.root)).toContain('手动重试');
    expect(ui.taskGraphPage.restartRequired).toBe(true);
    await loadTaskGraph(); f.activeObserver().emit(); f.scroll();
    expect(f.state.requests).toHaveLength(6);
    await f.root.querySelector('[data-graph-focus="load-next"]').onclick();
    expect(f.state.requests).toHaveLength(7); expect(f.state.requests.at(-1).query.has('cursor')).toBe(false);
    expect(ui.taskGraphPage.staleRestarts).toBe(0); expect(ui.taskGraphPage.restartRequired).toBe(false);
    await loadNextTaskGraph(); expect(f.cards()).toHaveLength(400);
  } finally { f.close(); }
});

test('stale recovery remains single flight and a failed recovery requires a deliberate first-batch retry, not another stale cursor read', async () => {
  const f = fixture();
  try {
    await f.open(); let recovering = false; const delayed = gate();
    f.state.intercept = query => {
      if (query.has('cursor')) { recovering = true; return staleResponse(); }
      return recovering ? delayed.promise : null;
    };
    const first = loadNextTaskGraph(); for (let i = 0; i < 8; i++) await Promise.resolve();
    const duplicate = loadNextTaskGraph();
    expect(f.state.requests).toHaveLength(4);
    delayed.resolve({ ok: false, json: async () => ({ error: '恢复首批失败' }) }); await first; await duplicate;
    expect(deepText(f.root)).toContain('恢复首批失败'); expect(f.cards()).toHaveLength(200);
    await loadTaskGraph(); expect(f.state.requests).toHaveLength(4);
    f.state.intercept = null; await f.root.querySelector('[data-graph-focus="load-next"]').onclick();
    expect(f.state.requests).toHaveLength(5); expect(f.state.requests.at(-1).query.has('cursor')).toBe(false);
    expect(ui.taskGraphPage.restartRequired).toBe(false);
  } finally { f.close(); }
});

test('leaving before the stale response prevents even the automatic first-batch recovery request', async () => {
  const f = fixture();
  try {
    await f.open(); const delayed = f.state.delay = gate(), pending = loadNextTaskGraph();
    activateDetailView({ view: 'overview' }); delayed.resolve(staleResponse()); await pending;
    expect(f.state.requests).toHaveLength(3); expect(ui.taskGraphPage.graph.nodes).toHaveLength(200);
  } finally { f.close(); }
});

test('late automatic recovery cannot populate a new filter or project cache', async () => {
  for (const change of ['filter', 'project']) {
    const f = fixture();
    try {
      await f.open(); let recovering = false; const delayed = gate();
      f.state.intercept = query => {
        if (query.has('cursor')) { recovering = true; return staleResponse(); }
        return recovering && query.get('hidden_statuses') === '[]' ? delayed.promise : null;
      };
      const pending = loadNextTaskGraph(); for (let i = 0; i < 8; i++) await Promise.resolve();
      expect(f.state.requests).toHaveLength(4); f.state.intercept = null;
      if (change === 'filter') { await f.root.querySelector('[data-status="waiting"]').onclick(); await loadTaskGraph(); }
      else { f.dom.location.pathname = '/p/bbbbbbbbbbbbbbbb/'; await f.open(); }
      const page = ui.taskGraphPage;
      delayed.resolve(json({ nodes: [worker(430, { title: '旧恢复迟到' })], matched_total: 1, total: 1,
        counts: { waiting: 1 }, archived_count: 0, has_more: false, cursor: null })); await pending;
      expect(ui.taskGraphPage).toBe(page); expect(deepText(f.root)).not.toContain('旧恢复迟到');
    } finally { f.close(); }
  }
});

test('first-batch refresh removes newly filtered/recycled sampled nodes but preserves scrolled history as explicitly older samples', async () => {
  const f = fixture();
  try {
    setPref('taskGraphStatuses', new Set(['completed'])); await f.open(); await loadNextTaskGraph();
    f.state.nodes[0].status = 'completed'; f.state.nodes[1].archived = true;
    await loadTaskGraph(); expect(f.cards()).toHaveLength(398);
    expect(f.root.querySelector('[data-task-id="1"]')).toBeNull(); expect(f.root.querySelector('[data-task-id="2"]')).toBeNull();
    expect(deepText(f.root.querySelector('[data-task-id="350"]'))).toContain('旧采样 · 待更新');
    expect(deepText(f.root.querySelector('[data-task-id="3"]'))).not.toContain('旧采样');
    expect(deepText(f.root)).toContain('其余已加载历史为旧采样缓存，待更新');
    expect(f.state.requests.at(-1).query.has('cursor')).toBe(false);
    expect(f.state.requests.at(-1).query.get('hidden_statuses')).toBe('["completed"]');
  } finally { f.close(); }
});

test('a smaller full byte-budget boundary on refresh does not drop previously loaded matching cards or reading focus', async () => {
  const f = fixture();
  try {
    await f.open(); await loadNextTaskGraph(); f.root.scrollTop = 1500;
    f.root.querySelector('[data-graph-focus="title-150"]').focus();
    f.state.fullLimit = 70; await loadTaskGraph();
    expect(f.cards()).toHaveLength(400); expect(f.root.querySelector('[data-task-id="150"]')).toBeTruthy();
    expect(f.root.scrollTop).toBe(1500); expect(document.activeElement.dataset.graphFocus).toBe('title-150');
    expect(deepText(f.root.querySelector('[data-task-id="150"]'))).toContain('旧采样 · 待更新');
    expect(ui.taskGraphPage.cursor).toBe('f:400'); expect(f.state.requests.at(-1).query.has('cursor')).toBe(false);
  } finally { f.close(); }
});
