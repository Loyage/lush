import { test, expect } from 'bun:test';
import { installDom, deepText } from '../dom-stub.js';
import { renderDetail } from '../../src/ui/web/assets/render-detail.js';
import { loadDetail } from '../../src/ui/web/assets/detail.js';
import { renderTree } from '../../src/ui/web/assets/render-tree.js';
import { renderTaskGraph } from '../../src/ui/web/assets/render-task-graph.js';
import { refreshProgressDurations, renderTaskProgress } from '../../src/ui/web/assets/render-progress.js';
import { ui, resetUiState } from '../../src/ui/web/assets/state.js';

const at = '2026-10-08T10:00:00Z';
const progress = { version: 1, items: [
  { key: 'inspect', label: '当前检查', status: 'completed', duration_ms: 2000 },
  { key: 'implement', label: '当前实现', status: 'pending', work_ms: 1000, active_since: at, started_at: at },
] };
const record = (id, reason = 'replan') => ({ id, archived_at: at, reason,
  progress: { version: 1, items: [
    { key: 'inspect', label: `旧检查 ${id}`, status: 'completed', duration_ms: 2000 },
    { key: 'implement', label: `旧实现 ${id}`, status: 'pending', work_ms: 5000, active_since: at, started_at: at },
    { key: 'test', label: `旧测试 ${id}`, status: 'pending' },
  ] } });
const page = (ids, hasMore = true) => ({ items: ids.map(id => record(id, id === 20 ? 'new_input' : 'replan')),
  cursor: ids.at(-1) ?? null, has_more: hasMore, limit: 10 });
const task = { id: 7, worker_number: 'W7', parent_id: 1, role: 'agent', task_kind: 'order', status: 'running', calls: 0,
  goal: '目标', created_at: at, updated_at: at, progress, progress_history: page([20, 19]) };
const history = dom => dom.node('detail').querySelector('.progress-history-panel');
const versions = dom => history(dom).querySelectorAll('.progress-history-version');
const more = dom => history(dom).querySelector('.progress-history-controls').querySelector('button');
const response = value => ({ ok: true, json: async () => value });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function fixture(run, fetchImpl = () => { throw new Error('unexpected fetch'); }) {
  const dom = installDom({ fetch: fetchImpl }); resetUiState();
  ui.view = { id: 'task', key: 'task-7' };
  try { await run(dom); } finally { resetUiState(); dom.restore(); }
}

test('current plan comes first; historical versions fold independently with date/reason and one whole-module preview', () => fixture(async dom => {
  renderDetail(task, null, null, null);
  const panel = dom.node('detail'), section = history(dom), folds = versions(dom);
  const current = panel.querySelector('.task-progress-panel');
  expect(panel.children.indexOf(current)).toBeLessThan(panel.children.indexOf(section));
  expect(folds.map(node => Boolean(node.open))).toEqual([false, false]);
  expect(deepText(folds[0].querySelector('summary'))).not.toContain('旧实现');
  expect(folds[0].querySelector('summary').textContent).toContain('收到追加输入');
  expect(folds[1].querySelector('summary').textContent).toContain('调整计划');
  expect(folds[0].querySelector('summary').textContent).toContain('2026');
  folds[0].open = true;
  expect(Boolean(folds[1].open)).toBe(false);
  expect(deepText(folds[0])).toContain('旧实现 20');
  folds[1].open = true; folds[0].open = false;
  expect(folds[1].open).toBe(true);
  expect(section.querySelectorAll('.detail-preview-body')).toHaveLength(1);
  expect(more(dom).getAttribute('data-help')).toContain('不调用 Agent');
}));

test('frozen historical timers ignore residual live timestamps and current Worker failure state', () => fixture(async dom => {
  const old = record(20);
  old.progress.items.push(
    { key: 'wait', label: '当时等待', kind: 'wait', status: 'pending', wait_ms: 3000, waiting_since: at },
    { key: 'missed', label: '漏报', status: 'pending', unconfirmed: true, timing_unknown: true, active_since: at },
    { key: 'legacy', label: '旧墙钟', status: 'pending', duration_ms: 4000, started_at: at },
  );
  renderDetail({ ...task, status: 'failed', progress_history: { ...page([20], false), items: [old] } }, null, null, null);
  const section = history(dom), text = deepText(section);
  expect(section.querySelectorAll('.is-running-duration')).toHaveLength(0);
  expect(section.querySelectorAll('.is-current')).toHaveLength(0);
  expect(section.querySelectorAll('.is-interrupted')).toHaveLength(0);
  expect(section.querySelectorAll('.is-terminal')).toHaveLength(0);
  expect(text).toContain('当时未完成 · 用时 5 秒');
  expect(text).toContain('当时未完成 · 等待 3 秒');
  expect(text).toContain('当时未完成 · 用时 4 秒');
  expect(text).toContain('当时未完成 · 用时未知');
  expect(text).toContain('未确认完成 · 用时未知');
  expect(text).not.toMatch(/失败时|计时中|已执行/);
  refreshProgressDurations(dom.node('detail'));
  expect(deepText(section)).toBe(text);
}));

test('pagination deduplicates versions, keeps cursor on error, supports retry and reports exhaustion', async () => {
  const urls = []; let count = 0;
  await fixture(async dom => {
    renderDetail(task, null, null, null);
    versions(dom)[0].open = true;
    await more(dom).click();
    expect(deepText(history(dom))).toContain('加载更早计划失败：分页错误');
    expect(more(dom).textContent).toBe('重试加载更早计划');
    expect(versions(dom)).toHaveLength(2);
    await more(dom).click();
    expect(versions(dom).map(node => node.dataset.progressHistoryId)).toEqual(['20', '19', '18', '17']);
    expect(versions(dom)[0].open).toBe(true);
    await more(dom).click();
    expect(versions(dom)).toHaveLength(5);
    expect(more(dom).hidden).toBe(true);
    expect(deepText(history(dom))).toContain('没有更早的计划了');
    expect(urls).toEqual([
      '/api/worker/7/progress-history?before=19&limit=10',
      '/api/worker/7/progress-history?before=19&limit=10',
      '/api/worker/7/progress-history?before=17&limit=10',
    ]);
  }, url => {
    urls.push(String(url)); count++;
    return count === 1 ? { ok: false, json: async () => ({ error: '分页错误' }) }
      : response(count === 2 ? page([19, 18, 17]) : page([16], false));
  });
});

test('same Worker refresh retains loaded pages, open versions, module expansion, focus and reading anchor', async () => {
  const urls = [];
  await fixture(async dom => {
    renderDetail(task, null, null, null);
    await more(dom).click();
    const panel = dom.node('detail'), section = history(dom), fold = versions(dom)[0], focus = fold.querySelector('summary');
    fold.open = true;
    await section.querySelector('.detail-preview-toggle').click();
    focus.focus(); panel.scrollTop = 250;
    panel.getBoundingClientRect = () => ({ top: 0, bottom: 600 });
    let top = -20;
    fold.getBoundingClientRect = () => ({ top, bottom: top + 100 });
    const replace = panel.replaceChildren.bind(panel);
    panel.replaceChildren = (...nodes) => { document.activeElement = null; top = 20; replace(...nodes); };
    renderDetail({ ...task, progress_history: page([21, 20]) }, null, null, null);
    expect(history(dom)).toBe(section); expect(versions(dom)[1]).toBe(fold);
    expect(fold.open).toBe(true); expect(section.classList.contains('detail-preview-expanded')).toBe(true);
    expect(document.activeElement).toBe(focus); expect(panel.scrollTop).toBe(290);
    expect(versions(dom).map(node => node.dataset.progressHistoryId)).toEqual(['21', '20', '19', '18', '17']);
    await more(dom).click();
    expect(urls.at(-1)).toContain('before=17');
    renderDetail({ ...task, progress_history: page([21, 20]) }, null, null, null);
    expect(more(dom).hidden).toBe(true); expect(versions(dom)).toHaveLength(6);
  }, url => { urls.push(String(url)); return response(urls.length === 1 ? page([18, 17]) : page([16], false)); });
});

test('a disjoint latest window reopens pagination without losing previously opened versions', async () => {
  const urls = [];
  await fixture(async dom => {
    renderDetail({ ...task, progress_history: page([20, 19], false) }, null, null, null);
    const old = versions(dom)[0]; old.open = true;
    expect(more(dom).hidden).toBe(true);
    renderDetail({ ...task, progress_history: page([40, 39]) }, null, null, null);
    expect(more(dom).hidden).toBe(false);
    await more(dom).click();
    expect(urls[0]).toContain('before=39');
    expect(versions(dom).map(node => node.dataset.progressHistoryId)).toEqual(['40', '39', '38', '20', '19']);
    expect(old.open).toBe(true);
  }, url => { urls.push(String(url)); return response(page([38, 20, 19], false)); });
});

test('an older in-flight page cannot close pagination over a newly discovered gap', async () => {
  const pending = deferred(), urls = [];
  await fixture(async dom => {
    renderDetail(task, null, null, null);
    const loading = more(dom).click();
    renderDetail({ ...task, progress_history: page([40, 39]) }, null, null, null);
    pending.resolve(response(page([18], false))); await loading;
    expect(more(dom).hidden).toBe(false);
    await more(dom).click();
    expect(urls[1]).toContain('before=39');
    expect(versions(dom).map(node => node.dataset.progressHistoryId)).toEqual(['40', '39', '38', '20', '19', '18']);
  }, url => { urls.push(String(url)); return urls.length === 1 ? pending.promise : response(page([38, 20, 19, 18], false)); });
});

test('invalid pagination responses are reported rather than looping or erasing readable history', async () => {
  await fixture(async dom => {
    renderDetail(task, null, null, null);
    await more(dom).click();
    expect(deepText(history(dom))).toContain('历史分页响应无效');
    expect(versions(dom)).toHaveLength(2);
    expect(more(dom).textContent).toBe('重试加载更早计划');
  }, () => response({ items: [record(18)], cursor: 19, has_more: true, limit: 10 }));
});

test('history request uses fixed project route and ignores response after project changes', async () => {
  const request = deferred(), urls = [];
  await fixture(async dom => {
    dom.location.pathname = '/p/aaaaaaaaaaaaaaaa/';
    renderDetail(task, null, null, null); const section = history(dom), loading = more(dom).click();
    expect(urls).toEqual(['/p/aaaaaaaaaaaaaaaa/api/worker/7/progress-history?before=19&limit=10']);
    dom.location.pathname = '/p/bbbbbbbbbbbbbbbb/';
    request.resolve(response(page([18], false))); await loading;
    expect(section.querySelectorAll('.progress-history-version')).toHaveLength(2);
  }, url => { urls.push(String(url)); return request.promise; });
});

test('refresh during page request keeps it single-flight and integrates into the same history', async () => {
  const request = deferred(); let calls = 0;
  await fixture(async dom => {
    renderDetail(task, null, null, null);
    const section = history(dom), loading = more(dom).click();
    expect(more(dom).disabled).toBe(true);
    renderDetail({ ...task, progress_history: page([21, 20]) }, null, null, null);
    await more(dom).click(); expect(calls).toBe(1);
    request.resolve(response(page([18], false))); await loading;
    expect(history(dom)).toBe(section); expect(versions(dom)).toHaveLength(4);
    expect(more(dom).hidden).toBe(true);
  }, () => { calls++; return request.promise; });
});

test('switching Worker discards loaded/open history; late response cannot leak even after returning', async () => {
  const request = deferred();
  await fixture(async dom => {
    renderDetail(task, null, null, null);
    const oldSection = history(dom); versions(dom)[0].open = true;
    const loading = more(dom).click();
    ui.view = { id: 'task', key: 'task-8' };
    renderDetail({ ...task, id: 8, worker_number: 'W8', progress_history: page([10], false) }, null, null, null);
    expect(versions(dom)).toHaveLength(1); expect(Boolean(versions(dom)[0].open)).toBe(false);
    ui.view = { id: 'task', key: 'task-7' }; renderDetail(task, null, null, null);
    request.resolve(response(page([18], false))); await loading;
    expect(history(dom)).not.toBe(oldSection); expect(versions(dom)).toHaveLength(2);
    expect(Boolean(versions(dom)[0].open)).toBe(false); expect(more(dom).disabled).toBe(false);
  }, () => request.promise);
});

test('late history response on another page or disabled progress is ignored', async () => {
  for (const change of ['page', 'switch']) {
    const request = deferred();
    await fixture(async dom => {
      renderDetail(task, null, null, null); const loading = more(dom).click();
      const section = history(dom);
      if (change === 'page') { ui.view = { id: 'settings', key: 'settings' }; dom.node('detail').dataset.view = 'settings'; }
      else ui.lastSnapshot = { status: { settings: { progress_reporting: { value: false } } } };
      request.resolve(response(page([18], false))); await loading;
      expect(section.querySelectorAll('.progress-history-version')).toHaveLength(2);
    }, () => request.promise);
  }
});

test('progress setting hides historical/current plans; older daemon and empty history do not fabricate history', () => fixture(async dom => {
  ui.lastSnapshot = { status: { settings: { progress_reporting: { value: false } } } };
  renderDetail(task, null, null, null);
  expect(history(dom)).toBeNull(); expect(dom.node('detail').querySelector('.task-progress-panel')).toBeNull();
  ui.lastSnapshot.status.settings.progress_reporting.value = true;
  renderDetail(task, null, null, null); expect(versions(dom)).toHaveLength(2);
  renderDetail({ ...task, progress_history: undefined }, null, null, null); expect(history(dom)).toBeNull();
  renderDetail({ ...task, progress_history: page([], false) }, null, null, null); expect(history(dom)).toBeNull();
  expect(renderTaskProgress(progress, { historical: true })).not.toBeNull();
}));

test('Worker list and both graph modes count current plan only, even if history is accidentally included in a summary', () => fixture(async dom => {
  renderTree({ tasks: [task], status: { concurrency: 1 }, notices: [] });
  expect(deepText(dom.node('tasks'))).toContain('1/2');
  expect(deepText(dom.node('tasks'))).not.toContain('旧实现');
  expect(dom.node('tasks').querySelector('.progress-history-panel')).toBeNull();
  ui.view = { id: 'task-graph', key: 'task-graph' };
  for (const minimal of [false, true]) {
    ui.taskGraphMinimal = minimal;
    renderTaskGraph({ nodes: [task], total: 1, truncated: false });
    expect(deepText(dom.node('detail'))).toContain('1/2');
    expect(deepText(dom.node('detail'))).not.toContain('旧实现');
    expect(history(dom)).toBeNull();
  }
}));

test('real detail refresh preserves pagination and reading moves made while inspect is in flight', async () => {
  const pending = deferred(); let wait = false;
  await fixture(async dom => {
    await loadDetail(7); await more(dom).click(); versions(dom)[0].open = true;
    const section = history(dom); dom.node('detail').scrollTop = 100;
    wait = true; const refresh = loadDetail(7); dom.node('detail').scrollTop = 350;
    pending.resolve(response({ ...task, updated_at: '2026-10-08T11:00:00Z' })); await refresh;
    expect(history(dom)).toBe(section); expect(versions(dom)).toHaveLength(3);
    expect(versions(dom)[0].open).toBe(true); expect(dom.node('detail').scrollTop).toBe(350);
  }, url => {
    if (url === '/api/worker/7') return wait ? pending.promise : response(task);
    if (url.includes('/progress-history?')) return response(page([18], false));
    if (url.includes('/history-page')) return response({ events: [], cursor: null, has_more: false });
    if (url === '/api/agent/connections') return response({ connections: [] });
    return response(null);
  });
});
