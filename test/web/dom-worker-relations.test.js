import { afterAll, beforeEach, expect, test } from 'bun:test';
import { deepText, installDom } from '../dom-stub.js';

const worker = (id, extra = {}) => ({ id, worker_number: `W227-${id}`, role: 'agent', task_kind: 'child',
  goal: `目标 ${id}`, auto_title: `标题 ${id}`, status: 'waiting', integration: 'none', calls: 0,
  created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-02T00:00:00Z', children: [], deps: [], dependents: [], runs: [], ...extra });
const page = (items, extra = {}) => ({ parent: worker(2, { status: 'running' }),
  children: { items, total: items.length, cursor: items.at(-1)?.id ?? 0, has_more: false, limit: 50, ...extra } });
const json = value => ({ ok: true, json: async () => value });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
let intercept, requests;
const dom = installDom({ fetch: (url, options) => { requests.push([String(url), options]); return intercept(String(url), options); } });
const { ui, resetUiState } = await import('../../src/ui/web/assets/state.js');
const { renderWorkerRelations, loadWorkerRelations } = await import('../../src/ui/web/assets/render-worker-relations.js');
const { loadDetail, disposeDetailRequests } = await import('../../src/ui/web/assets/detail.js');
const { registerNavigation } = await import('../../src/ui/web/assets/navigate.js');
const panel = dom.node('detail');
const drain = async () => { for (let i = 0; i < 25; i++) await Promise.resolve(); };
beforeEach(() => {
  disposeDetailRequests(); resetUiState(); panel.replaceChildren(); delete panel.dataset.taskId;
  ui.selected = null; ui.detailTask = null; ui.noticeFocus = null; ui.transcriptView = null; ui.view = null;
  dom.document.activeElement = null; dom.window.getSelection = () => ({ isCollapsed: true });
  dom.location.pathname = '/'; requests = [];
  intercept = url => url.includes('/relations') ? json(page([])) : url.includes('/history') ? json({ events: [] }) : json(worker(3, { parent_id: 2 }));
});
afterAll(() => { disposeDetailRequests(); dom.restore(); });

test('关系树嵌套为直接父→当前→直接子，显示真实编号、标题和文字状态，不显示孙节点', async () => {
  const child = worker(40, { worker_number: 'W227-1-2', status: 'awaiting_acceptance', integration: 'merged',
    display_title: '用户标题', children: [worker(41)] });
  const section = renderWorkerRelations(worker(3, { parent_id: 2 }), { data: page([child]) });
  panel.append(section);
  const tree = section.querySelector('.worker-relation-tree');
  const rows = tree.querySelectorAll('.worker-relation-row');
  expect(rows.map(row => row.dataset.workerId)).toEqual(['2', '3', '40']);
  expect(tree.children[0].querySelector('ul').children[0].querySelector('ul').children).toHaveLength(1);
  expect(rows[1].getAttribute('aria-current')).toBe('true');
  expect(deepText(section)).toContain('W227-1-2'); expect(deepText(section)).toContain('用户标题');
  expect(deepText(rows[0])).toContain('运行中'); expect(deepText(rows[2])).toContain('待父确认'); expect(deepText(rows[2])).toContain('已合并');
  expect(deepText(section)).not.toContain('标题 41');
  expect(section.querySelector('.worker-relations-count').textContent).toBe('直接子 Worker：1 / 1');
  const opened = [], restore = registerNavigation({ detail: id => opened.push(id) });
  try { await rows[0].querySelector('button').onclick(); await rows[2].querySelector('button').onclick(); }
  finally { restore(); }
  expect(opened).toEqual([2, 40]);
});

test('根 Worker 与无子节点也显示模块；缺少编号使用内部 ID，不根据 ID 推算', () => {
  const section = renderWorkerRelations(worker(3, { worker_number: null, parent_id: null }), { data: { ...page([]), parent: null } });
  expect(deepText(section)).toContain('没有直接父 Worker');
  for (const text of ['直接子 Worker：0 / 0', '没有直接子 Worker', '本 Worker 依赖', '本 Worker 不依赖其他 Worker', '依赖本 Worker', '没有 Worker 在等它']) {
    expect(deepText(section)).not.toContain(text);
  }
  expect(section.querySelector('.worker-relations-count')).toBeNull();
  expect(section.querySelectorAll('.worker-relation-dependencies')).toHaveLength(0);
  expect(deepText(section)).toContain('#3'); expect(deepText(section)).not.toContain('W3');
  expect(section.querySelectorAll('.worker-relation-row')).toHaveLength(1);
});

test('子节点分页去重，保留失败/取消/已合入状态与节点引用，失败后仍可重试', async () => {
  const initial = page([worker(4, { status: 'failed' })], { total: 3, has_more: true });
  const section = renderWorkerRelations(worker(3, { parent_id: 2 }), { data: initial }); panel.append(section);
  intercept = async () => ({ ok: false, json: async () => ({ error: '故意读取失败' }) });
  await section.querySelector('.worker-relations-more').onclick();
  expect(deepText(section)).toContain('故意读取失败'); expect(deepText(section)).toContain('标题 4');
  expect(section.querySelector('.worker-relations-more')).toBeTruthy();
  expect(section.querySelector('.worker-relations-count').textContent).toBe('直接子 Worker：1 / 3');
  intercept = () => json(page([worker(4, { status: 'failed' }), worker(5, { status: 'cancelled' }), worker(6, { status: 'completed', integration: 'merged' })], { total: 3 }));
  await section.querySelector('.worker-relations-more').onclick();
  expect(requests.at(-1)[0]).toContain('after=4');
  expect(section.querySelector('.worker-relation-children').children).toHaveLength(3);
  expect(deepText(section)).toContain('已取消'); expect(deepText(section)).not.toContain('故意读取失败');
  expect(section.querySelector('.worker-relations-more')).toBeNull();
  expect(section.querySelector('[data-worker-id="5"]').dataset.ref).toContain('task-5');
});

test('关系读取失败不冒充无父或无子，父节点编号仍可导航且可重试', async () => {
  const section = renderWorkerRelations(worker(3, { parent_id: 2, parent_worker_number: 'W227', children: [worker(4)] }));
  panel.append(section); section.updateRelations(null, false);
  expect(deepText(section)).toContain('状态不可用'); expect(deepText(section)).toContain('可能不完整');
  expect(deepText(section)).toContain('W227'); expect(deepText(section)).toContain('标题 4');
  expect(deepText(section)).not.toContain('没有直接子 Worker');
  intercept = () => json(page([])); await section.querySelector('.worker-relations-retry').onclick();
  expect(section.querySelector('.worker-relation-children').children).toHaveLength(0);
  expect(section.querySelector('.worker-relations-count')).toBeNull();
  expect(deepText(section)).not.toContain('没有直接子 Worker'); expect(deepText(section)).not.toContain('状态不可用');
});

test('换页、取消或同 Worker 重绑定后，迟到的加载更多不得覆盖当前关系', async () => {
  const gate = deferred(), controller = new AbortController();
  const section = renderWorkerRelations(worker(3, { parent_id: 2 }), { data: page([worker(4)], { total: 2, has_more: true }), signal: controller.signal });
  intercept = () => gate.promise;
  const reading = section.querySelector('.worker-relations-more').onclick();
  controller.abort(); section.bindRelations(worker(3, { parent_id: 2 }), { current: () => true });
  section.updateRelations(page([worker(6)]), true);
  gate.resolve(json(page([worker(5)]))); await reading;
  expect(deepText(section)).toContain('标题 6'); expect(deepText(section)).not.toContain('标题 5');
});

test('按已展开数量刷新关系分页，并绑定来源项目与取消信号', async () => {
  dom.location.pathname = '/p/0123456789abcdef/';
  const controller = new AbortController();
  intercept = url => json(url.includes('after=0') ? page([worker(4)], { total: 2, has_more: true }) : page([worker(5)], { total: 2 }));
  const result = await loadWorkerRelations(3, { count: 2, signal: controller.signal });
  expect(result.children.items.map(item => item.id)).toEqual([4, 5]);
  expect(requests.map(([url]) => url)).toEqual(['/p/0123456789abcdef/api/worker/3/relations?after=0&limit=50', '/p/0123456789abcdef/api/worker/3/relations?after=4&limit=50']);
  expect(requests.every(([, options]) => options.signal === controller.signal)).toBe(true);
});

test('详情主体不等待关系读取，补齐父状态；同 Worker 刷新保留已展开范围与模块节点', async () => {
  const gate = deferred();
  intercept = url => url.includes('/relations') ? gate.promise : url.includes('/history') ? json({ events: [] }) : json(worker(3, { parent_id: 2 }));
  expect(await loadDetail(3)).toBe(true);
  const section = panel.querySelector('.worker-relations');
  expect(deepText(section)).toContain('状态加载中');
  gate.resolve(json(page([worker(4)], { total: 2, has_more: true }))); await drain();
  expect(deepText(section)).toContain('运行中');
  intercept = url => url.includes('/relations') ? json(url.includes('after=4') ? page([worker(5)], { total: 2 }) : page([worker(4)], { total: 2, has_more: true }))
    : url.includes('/history') ? json({ events: [] }) : json(worker(3, { parent_id: 2 }));
  await section.querySelector('.worker-relations-more').onclick();
  await loadDetail(3); await drain();
  expect(panel.querySelector('.worker-relations')).toBe(section);
  expect(section.querySelector('.worker-relation-children').children).toHaveLength(2);
  expect(deepText(section)).toContain('标题 5');
  expect(panel.querySelectorAll('h2').some(node => node.textContent === '子 Worker')).toBe(false);
});
