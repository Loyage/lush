import { test, expect, beforeEach, afterAll } from 'bun:test';
import fs from 'node:fs';
import { installDom, deepText } from '../dom-stub.js';

const sha = n => n.toString(16).padStart(40, '0');
const worker = { id: 71, worker_number: 'W263-7', task_kind: 'order', role: 'agent', status: 'running',
  integration: 'none', calls: 0, goal: '结果优先', branch: 'feature', children: [], deps: [], dependents: [],
  created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-02T00:00:00Z' };
const main = { ...worker, task_kind: 'main', branch: 'main' };
const association = { id: 93, worker_number: 'W263-7-2', evidence: 'task.merge_integrated', delivery_id: 611, delivery_available: true };
const node = n => ({ commit: sha(n), short_commit: sha(n).slice(-7), parents: [sha(n - 1)], subject: `提交 ${n}`,
  committed_at: '2026-10-02T00:00:00Z', author: { name: '作者' }, association: 'verified', tasks: [association] });
const graphPage = (offset = 0, extra = {}) => ({ worker: { id: 71 }, scope: 'main', branch: 'main', tip: sha(1000), base: null,
  delivery: null, snapshot: 'fixed-snapshot', commits: Array.from({ length: 30 }, (_, i) => node(1000 - offset * 30 - i)),
  cursor: `cursor +/${offset + 1}`, has_more: offset < 5, ...extra });
const mapping = (delivery_id, source = 998, landing = 3000, extra = {}) => ({ delivery_id, source_commit: sha(source), commit: sha(landing),
  parent_id: 1, delivered_at: '2026-10-02', evidence: 'task.merge_integrated', delivery_available: true, delivery_unavailable_reason: null, ...extra });
const lineagePage = (offset = 0, extra = {}) => {
  const commits = Array.from({ length: 30 }, (_, i) => node(1000 - offset * 30 - i));
  if (offset === 5) commits.at(-1).parents = [sha(1)];
  return { worker: { id: 71, worker_number: worker.worker_number }, scope: 'lineage', range: 'first-parent', branch: 'feature',
    parent: { id: 1, worker_number: 'W111', branch: 'parent' }, origin: { ...node(1), parents: [], tasks: [], association: 'unassociated' },
    tip: sha(1000), tip_evidence: 'branch.ref', tip_delivery_id: null, snapshot: 'fixed-lineage', commits,
    deliveries: offset === 0 ? [mapping(903, 1, 3002), mapping(902), mapping(901), mapping(900, 997),
      mapping(899, 996, 3001, { delivery_available: false, delivery_unavailable_reason: '对象核验失败' })] : [],
    untraceable_deliveries: [mapping(500, 5, 3005, { source_commit: null, commit: null, delivery_available: false, delivery_unavailable_reason: '缺失固定源' })],
    cursor: `cursor +/${offset + 1}`, has_more: offset < 5, ...extra };
};
const json = value => ({ ok: true, json: async () => value });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const drain = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
let intercept, requests = [], observers = [];
const defaultResponse = url => {
  const params = new URL(url, 'http://test').searchParams, offset = params.has('cursor') ? Number(params.get('cursor').split('/')[1]) : 0;
  return url.includes('/version-lineage') ? lineagePage(offset) : graphPage(offset);
};
const dom = installDom({ fetch: (url, options) => {
  requests.push({ url: String(url), signal: options?.signal });
  return intercept?.(String(url), options) ?? Promise.resolve(json(defaultResponse(String(url))));
} });
dom.document.createElementNS = (_namespace, tag) => dom.document.createElement(tag);
const prototype = Object.getPrototypeOf(dom.document.createElement('div'));
Object.defineProperty(prototype, 'isConnected', { configurable: true, get() {
  for (let at = this; at; at = at.parentNode) if (at === dom.node('detail')) return true; return false;
} });
const oldObserver = globalThis.IntersectionObserver;
class Observer {
  constructor(callback) { this.callback = callback; this.disconnected = false; observers.push(this); }
  observe(node) { this.node = node; }
  disconnect() { this.disconnected = true; }
  enter() { this.callback([{ target: this.node, isIntersecting: true }]); }
}
const { ui, resetUiState } = await import('../../src/ui/web/assets/state.js');
const { renderWorkerVersions, disposeWorkerVersions, renderVersionCommit } = await import('../../src/ui/web/assets/render-versions.js');
const { renderDetail } = await import('../../src/ui/web/assets/render-detail.js');
const { loadDetail } = await import('../../src/ui/web/assets/detail.js');
const { activateDetailView } = await import('../../src/ui/web/assets/sidebar-ui.js');
const { enhanceModule } = await import('../../src/ui/web/assets/shared-module.js');
const { limitDetailModules, revealDetailPreview } = await import('../../src/ui/web/assets/detail-preview.js');
const panel = dom.node('detail');
const root = () => panel.querySelector('.worker-versions');
const query = selector => selector.split(' ').reduce((at, part) => at?.querySelector(part), root());
const click = selector => query(selector).onclick();
const graphReads = () => requests.filter(r => r.url.includes('/version-graph'));
const lineageReads = () => requests.filter(r => r.url.includes('/version-lineage?'));
const detailReads = () => requests.filter(r => r.url.includes('/version-lineage-commit'));
const mount = (task = worker) => { const module = renderWorkerVersions(task); panel.append(module); return module; };
const open = async (task = worker) => { mount(task); observers.at(-1).enter(); await drain(); };
const detailResult = (commit = node(971)) => ({ worker: { id: 71 }, scope: 'lineage', commit: { ...commit,
  message: '<script>evil()</script>\n完整提交消息', tasks: [{ ...association, goal: '<img onerror=evil()>', input: { id: 263, content: '<svg onload=evil()>\n原始输入' } }] }, deliveries: [] });
beforeEach(() => {
  disposeWorkerVersions(); resetUiState(); panel.replaceChildren(); delete panel.dataset.taskId;
  ui.view = { id: 'task', key: 'task-71' }; ui.selected = 71; ui.detailTask = 71;
  dom.location.pathname = '/'; requests = []; observers = []; intercept = null; globalThis.IntersectionObserver = Observer;
});
afterAll(() => { disposeWorkerVersions(); globalThis.IntersectionObserver = oldObserver; delete prototype.isConnected; dom.restore(); });

test('滚入直接GET lineage limit30；双轨旧到新自身commit无需先选轮次，正文不预取', async () => {
  mount(); expect(requests).toHaveLength(0); observers[0].callback([{ isIntersecting: false }]); expect(requests).toHaveLength(0);
  observers[0].enter(); observers[0].enter(); await drain();
  expect(lineageReads()).toHaveLength(1); expect(lineageReads()[0].url).toBe('/api/worker/71/version-lineage?limit=30');
  expect(graphReads()).toHaveLength(0); expect(detailReads()).toHaveLength(0);
  expect(requests.some(r => r.url.includes('version-deliveries'))).toBe(false);
  expect(query('.versions-load').hidden).toBe(true); expect(observers[0].disconnected).toBe(true);
  const nodes = root().querySelectorAll('.lineage-source'); expect(nodes).toHaveLength(30);
  expect(nodes[0].dataset.commit).toBe(sha(971)); expect(nodes.at(-1).dataset.commit).toBe(sha(1000));
  expect(query('.lineage-tracks').children[0].textContent).toContain('W111');
  expect(query('.lineage-tracks').children[1].textContent).toContain(worker.worker_number);
  expect(query('.versions-feedback').textContent).toContain('从上到下旧到新');
  expect(deepText(query('.lineage-gap'))).toContain('创建起点与本段之间还有更早分段');
  expect(query('.lineage-fork')).toBeNull(); expect(query('.version-input')).toBeNull();
  expect(query('.lineage-source').querySelector('.version-task-link').getAttribute('href')).toBe('#worker-93');
});

test('窄双轨只放节点，所有描述统一右侧；引出/自身/落点形状和短标签不同', async () => {
  await open();
  expect(query('.lineage-origin .lineage-node').textContent).toBe('◇');
  expect(query('.lineage-source .lineage-node').textContent).toBe('●');
  expect(query('.lineage-landing .lineage-parent-node').textContent).toBe('□');
  for (const card of root().querySelectorAll('.lineage-card')) {
    expect(card.children[0].classList.contains('lineage-rail')).toBe(true);
    expect(card.children[0].children).toHaveLength(1);
    expect(card.children[1].classList.contains('lineage-body')).toBe(true);
    expect(card.children[1].querySelector('.lineage-kind')).toBeTruthy();
  }
  expect(query('.module-summary').querySelector('.versions-feedback')).toBe(query('.versions-feedback'));
  expect(query('.module-body').querySelector('.versions-feedback')).toBeNull();
  expect(deepText(query('.module-summary'))).toContain('缺失固定源');
  expect(deepText(query('.module-summary'))).toContain('对象核验失败');
});

for (const task of [worker, main]) test(`shared预览不删除图/详情，重绘保留选择、签名和缓存，焦点/引用展开，取消面板归内容区 ${task.task_kind}`, async () => {
  renderDetail(task, { events: [] }, null, null); observers.at(-1).enter(); await drain();
  const section = root(), view = enhanceModule(section), body = view.body;
  view.content.getBoundingClientRect = () => ({ height: 1800 });
  view.gauge.getBoundingClientRect = () => ({ height: 200 }); view.measure();
  expect(view.toggle.hidden).toBe(false); expect(view.expanded).toBe(false);
  const selector = task === worker ? '.lineage-source' : '.version-commit', cards = section.querySelectorAll(selector);
  const marker = cards[0].querySelector(task === worker ? '.lineage-node' : '.version-node');
  view.setExpanded(true); view.setExpanded(false); expect(section.querySelectorAll(selector)).toEqual(cards);
  for (const listener of body.listeners.focusin) listener(); expect(view.expanded).toBe(true);
  view.setExpanded(false); expect(revealDetailPreview(marker)).toBe(true); expect(view.expanded).toBe(true);
  intercept = url => url.includes('commit?') ? json({ ...detailResult(task === worker ? node(971) : node(1000)), scope: task === worker ? 'lineage' : 'main' }) : null;
  await marker.onclick(); const detail = query('.version-node-detail'), input = query('.version-input'); if (input) input.open = true;
  const reads = requests.length;
  renderDetail(task, { events: [] }, null, null);
  expect(root()).toBe(section); expect(query('.module-body')).toBe(body); expect(section.querySelectorAll('.module-body')).toHaveLength(1);
  expect(section.classList.contains('module-expanded')).toBe(true); expect(query('.version-node-detail')).toBe(detail);
  if (input) expect(query('.version-input').open).toBe(true);
  expect(requests).toHaveLength(reads); expect(root().dataset.cachedPages).toBe('1');
  expect(query('.versions-feedback').parentNode).toBe(view.summary); expect(deepText(view.summary)).toContain('第 1 页');
  await detail.querySelector('button').onclick(); expect(detail.parentNode).toBe(view.content); expect(detail.hidden).toBe(true);
  view.setExpanded(false); limitDetailModules(panel, { taskId: task.id, from: [...panel.children].indexOf(section) }); expect(view.expanded).toBe(false);
  const fail = deferred(); intercept = () => fail.promise; const pending = click('.versions-refresh');
  expect(detail.parentNode).toBe(view.content);
  fail.resolve(Promise.reject(new Error('保留诊断'))); await pending;
  expect(query('.versions-feedback').getAttribute('role')).toBe('alert'); expect(deepText(view.summary)).toContain('保留诊断');
  expect(section.querySelectorAll(selector)).toEqual(cards); expect(query('.versions-more').disabled).toBe(true);
  const count = requests.length; await marker.onclick(); expect(requests).toHaveLength(count);
  disposeWorkerVersions(); for (const listener of body.listeners.focusin) listener(); expect(view.expanded).toBe(false);
});

test('版本吸顶测量真实Notice父容器高度，离页释放RO且迟到回调不再改旧样式', () => {
  const old = globalThis.ResizeObserver, registered = [];
  const banner = document.getElementById('notice-banner'), banners = document.createElement('div');
  banners.insertBefore(banner, null); let height = 61;
  banners.getBoundingClientRect = () => ({ height });
  globalThis.ResizeObserver = class {
    constructor(callback) { this.callback = callback; registered.push(this); }
    observe(node) { this.node = node; }
    disconnect() { this.disconnected = true; }
  };
  try {
    const section = mount(main), observer = registered.find(o => o.node === banners);
    expect(section.style.getPropertyValue('--versions-banner-height')).toBe('61px');
    height = 122; observer.callback(); expect(section.style.getPropertyValue('--versions-banner-height')).toBe('122px');
    disposeWorkerVersions(); expect(observer.disconnected).toBe(true);
    height = 180; observer.callback(); expect(section.style.getPropertyValue('--versions-banner-height')).toBe('122px');
  } finally { banner.remove(); globalThis.ResizeObserver = old; }
});

test('相同source多Event、共享landing/no-new-landing保留映射而不重复真实节点或Git边', async () => {
  await open();
  expect(root().querySelectorAll('.lineage-mapping')).toHaveLength(5);
  expect(root().querySelectorAll('.lineage-landing')).toHaveLength(2); // origin-source landing + one shared landing
  expect(root().querySelectorAll('.lineage-landing').map(n => n.dataset.landing)).toEqual([sha(3002), sha(3000)]);
  expect(root().querySelectorAll('.lineage-git-edge')).toHaveLength(29);
  const source = query(`[data-commit="${sha(998)}"]`).parentNode;
  expect(source.querySelectorAll('.lineage-mapping').map(n => n.dataset.delivery)).toEqual(['901', '902']);
  const edges = root().querySelectorAll('.lineage-delivery-edge');
  expect(edges.map(e => [e.dataset.source, e.dataset.landing, e.dataset.deliveries])).toEqual([
    [sha(1), sha(3002), '903'], [sha(998), sha(3000), '901,902'], [sha(997), sha(3000), '900'],
  ]);
  for (const edge of edges) {
    const nodes = [...root().querySelectorAll('.lineage-node'), ...root().querySelectorAll('.lineage-parent-node')];
    expect(nodes.some(n => n.id === edge.dataset.sourceNode)).toBe(true);
    expect(nodes.some(n => n.id === edge.dataset.targetNode)).toBe(true);
  }
  expect(edges[1].dataset.targetNode).toBe(edges[2].dataset.targetNode);
  expect(query('.lineage-mapping').dataset.source).toBe(sha(1)); // origin-source mapping is independent on first page
  expect(deepText(root())).toContain('持久 Event 收据映射，不是 Git parents');
  expect(query('.lineage-mapping[data-delivery="899"]').dataset.verified).toBeUndefined();
  expect(query('.lineage-mapping[data-delivery="899"] summary').textContent).toContain('对象核验失败');
  expect(query('.lineage-untraceable').hidden).toBe(false); expect(deepText(query('.lineage-untraceable'))).toContain('缺失固定源');
  expect(query('.lineage-untraceable').querySelectorAll('.lineage-receipt')).toHaveLength(1);
});

test('同source不同landing、跨source共享landing以及origin目标的每对映射均定位到唯一真实父锚点', async () => {
  intercept = () => json(lineagePage(0, { deliveries: [mapping(909, 998, 3000), mapping(908, 998, 3003),
    mapping(907, 997, 3000), mapping(906, 996, 1), mapping(905, 995, 3000, { delivery_available: false, delivery_unavailable_reason: '缺证据' })] }));
  await open(); const edges = root().querySelectorAll('.lineage-delivery-edge');
  expect(edges).toHaveLength(4); expect(root().querySelectorAll('.lineage-landing')).toHaveLength(2);
  for (const event of [906, 907, 908, 909]) expect(edges.filter(e => e.dataset.deliveries === String(event))).toHaveLength(1);
  const target = event => edges.find(e => e.dataset.deliveries === String(event)).dataset.targetNode;
  expect(target(906)).toBe(query('.lineage-origin .lineage-node').id); expect(target(907)).toBe(target(909));
  expect(target(908)).not.toBe(target(909)); expect(edges.some(e => e.dataset.deliveries === '905')).toBe(false);
});

test('映射重测几何、收据键盘高亮及RO/RAF/监听离页释放，迟到回调不复活', async () => {
  const oldRO = globalThis.ResizeObserver, queued = new Map(), cancelled = [], resize = [];
  let observer, serial = 0;
  globalThis.ResizeObserver = class {
    constructor(callback) { this.callback = callback; this.nodes = []; observer = this; }
    observe(node) { this.nodes.push(node); }
    disconnect() { this.nodes = []; }
  };
  dom.window.requestAnimationFrame = callback => { queued.set(++serial, callback); return serial; };
  dom.window.cancelAnimationFrame = id => { cancelled.push(id); queued.delete(id); };
  dom.window.addEventListener = (name, run) => { if (name === 'resize') resize.push(run); };
  dom.window.removeEventListener = (name, run) => { if (name === 'resize') resize.splice(resize.indexOf(run), 1); };
  try {
    await open(); const module = root(), canvas = query('.lineage-canvas'), edge = root().querySelectorAll('.lineage-delivery-edge')[1];
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 500, height: 4000 });
    let y = 500;
    for (const cell of root().querySelectorAll('.lineage-rail')) cell.getBoundingClientRect = () => ({ left: 0 });
    for (const marker of root().querySelectorAll('.lineage-node')) marker.getBoundingClientRect = () => ({ left: 36, top: y, width: 24, height: 48 });
    for (const marker of root().querySelectorAll('.lineage-parent-node')) marker.getBoundingClientRect = () => ({ left: 4, top: 200, width: 24, height: 48 });
    const flush = () => { const callbacks = [...queued.values()]; queued.clear(); for (const run of callbacks) run(); };
    flush(); expect(edge.dataset.sourceY).toBe('524'); expect(edge.dataset.targetY).toBe('224');
    const oldPath = edge.getAttribute('d'); y = 800; observer.callback(); flush();
    expect(edge.dataset.sourceY).toBe('824'); expect(edge.getAttribute('d')).not.toBe(oldPath);
    module.listeners.focusin[0]({ target: query('.lineage-mapping[data-delivery="901"] summary') }); expect(edge.classList.contains('is-active')).toBe(true);
    module.listeners.toggle[0](); expect(queued.size).toBe(1);
    const late = observer.callback; disposeWorkerVersions(); expect(observer.nodes).toHaveLength(0); expect(queued.size).toBe(0);
    expect(cancelled.length).toBeGreaterThan(0); expect(resize).toHaveLength(0);
    for (const name of ['focusin', 'focusout', 'pointerover', 'pointerout', 'toggle']) expect(module.listeners[name]).toHaveLength(0);
    late(); expect(queued.size).toBe(0); expect(module.querySelectorAll('.lineage-delivery-edge')).toHaveLength(0);
  } finally {
    globalThis.ResizeObserver = oldRO;
    for (const name of ['requestAnimationFrame', 'cancelAnimationFrame', 'addEventListener', 'removeEventListener']) delete dom.window[name];
  }
});

test('完全无开发仍显示引出；无交付的当前commit不会藏成空轮次', async () => {
  intercept = () => json(lineagePage(0, { commits: [], tip: sha(1), has_more: false, cursor: null, deliveries: [] }));
  await open(); expect(query('.lineage-origin')).toBeTruthy(); expect(query('.lineage-source')).toBeNull();
  expect(deepText(root())).toContain('尚无自身开发 commit');
  intercept = () => json(lineagePage(0, { commits: [{ ...node(2), parents: [sha(1)] }], tip: sha(2), has_more: false, cursor: null, deliveries: [] }));
  await click('.versions-refresh'); expect(root().querySelectorAll('.lineage-source')).toHaveLength(1);
  expect(query('.lineage-fork').dataset.child).toBe(sha(2)); expect(query('.lineage-fork').dataset.parent).toBe(sha(1));
});

test('origin来源无开发的多Event与no-new-landing不制造父侧或Worker重复节点', async () => {
  intercept = () => json(lineagePage(0, { commits: [], tip: sha(1), has_more: false, cursor: null,
    deliveries: [mapping(904, 1, 1), mapping(903, 1, 1)] }));
  await open(); expect(root().querySelectorAll('.lineage-origin')).toHaveLength(1);
  expect(root().querySelectorAll('.lineage-source')).toHaveLength(0); expect(root().querySelectorAll('.lineage-landing')).toHaveLength(0);
  expect(root().querySelectorAll('.lineage-mapping').map(n => n.dataset.delivery)).toEqual(['903', '904']);
  expect(query('.lineage-git-edge')).toBeNull();
  const edge = query('.lineage-delivery-edge'); expect(edge.dataset.deliveries).toBe('903,904');
  expect(edge.dataset.sourceNode).toBe(edge.dataset.targetNode);
  expect(detailReads()).toHaveLength(0);
});

test('同步merge保留真实第二父虚线边界，不展开父侧外部提交；未交付tip明确存在', async () => {
  const data = lineagePage(); data.commits[0].parents.push(sha(6000)); intercept = () => json(data); await open();
  const edge = query(`.lineage-git-boundary[data-parent="${sha(6000)}"]`);
  expect(edge.dataset.child).toBe(sha(1000)); expect(deepText(edge)).toContain('同步外部父边');
  expect(query(`[data-commit="${sha(6000)}"]`)).toBeNull();
  expect(query(`[data-commit="${sha(1000)}"]`).parentNode.querySelector('.lineage-mapping')).toBeNull();
  expect(query('.version-tip').textContent).toContain('不含未提交改动');
});

test('来源链内的第二父仍绘制真实实线，无额外节点', async () => {
  const data = lineagePage(); data.commits[0].parents.push(sha(998)); intercept = () => json(data); await open();
  const edges = root().querySelectorAll('.lineage-secondary-edge');
  expect(edges).toHaveLength(1); expect(edges.every(e => e.dataset.child === sha(1000) && e.dataset.parent === sha(998))).toBe(true);
  expect(root().querySelectorAll('.lineage-git-edge')).toHaveLength(30);
  expect(root().querySelectorAll('.lineage-source')).toHaveLength(30);
  expect(query(`.lineage-git-boundary[data-parent="${sha(998)}"]`)).toBeNull();
});

test('owner沿用旧graph入口，不调用不适用的lineage或轮次接口', async () => {
  await open({ ...main, task_kind: 'owner' }); expect(graphReads()).toHaveLength(1); expect(lineageReads()).toHaveLength(0);
  expect(requests.some(r => r.url.includes('version-deliveries'))).toBe(false); expect(query('.lineage-list')).toBeNull();
});

test('无Observer键盘加载；main真实parents图只保留原生子链接与兼容入口', async () => {
  globalThis.IntersectionObserver = undefined; mount(); await drain(); expect(requests).toHaveLength(0);
  expect(query('.versions-load').type).toBe('button'); await click('.versions-load'); expect(lineageReads()).toHaveLength(1);
  disposeWorkerVersions(); panel.replaceChildren(); mount(main); await click('.versions-load');
  expect(graphReads()[0].url).toBe('/api/worker/71/version-graph?limit=30');
  const link = query('.version-task-link'); expect(link.tagName).toBe('A'); expect(link.getAttribute('href')).toBe('#worker-93');
  expect(link.textContent).toBe('Worker W263-7-2'); expect(query('.version-delivery-choice')).toBeNull();
  expect(root().querySelectorAll('.agent-call')).toHaveLength(0);
  const unknown = renderVersionCommit({ ...node(2), tasks: [{ ...association, worker_number: null }] });
  expect(unknown.querySelector('.version-task-link').textContent).toBe('Worker #93');
});

test('lineage固定首屏签名、三页缓存和双向分页；淘汰页用原cursor，刷新才重新取样', async () => {
  await open(); expect(query('.versions-newer').disabled).toBe(true);
  for (let i = 1; i <= 5; i++) {
    await click('.versions-more'); expect(root().querySelectorAll('.lineage-source')).toHaveLength(30);
    expect(Number(root().dataset.cachedPages)).toBeLessThanOrEqual(3);
    expect(query('.lineage-untraceable').querySelectorAll('.lineage-receipt')).toHaveLength(1);
  }
  expect(query('.versions-more').disabled).toBe(true); expect(query('.lineage-fork')).toBeTruthy();
  const before = lineageReads().length; await click('.versions-newer'); expect(lineageReads()).toHaveLength(before);
  await click('.versions-newer'); expect(lineageReads()).toHaveLength(before + 1);
  await click('.versions-newer'); expect(lineageReads().at(-1).url).toContain('cursor=cursor+%2B%2F2');
  await click('.versions-newer'); const count = lineageReads().length;
  intercept = () => json(lineagePage(0, { tip: sha(9999), snapshot: 'advanced', commits: [{ ...node(9999), parents: [sha(1)] }], has_more: false, deliveries: [] }));
  await click('.versions-newer'); expect(lineageReads()).toHaveLength(count); expect(query(`[data-commit="${sha(1000)}"]`)).toBeTruthy();
  await click('.versions-refresh'); expect(query(`[data-commit="${sha(9999)}"]`)).toBeTruthy();
  expect(lineageReads().at(-1).url).toBe('/api/worker/71/version-lineage?limit=30');
});

test('main30节点/三页缓存/固定首屏以及真实边界parents继续保留', async () => {
  await open(main); expect(query('.versions-newer').disabled).toBe(true);
  for (let i = 1; i <= 5; i++) { await click('.versions-more'); expect(root().querySelectorAll('.version-commit')).toHaveLength(30); expect(Number(root().dataset.cachedPages)).toBeLessThanOrEqual(3); }
  expect(query('.versions-more').disabled).toBe(true); const before = graphReads().length;
  await click('.versions-newer'); expect(graphReads()).toHaveLength(before);
  await click('.versions-newer'); expect(graphReads()).toHaveLength(before + 1);
  await click('.versions-newer'); expect(graphReads().at(-1).url).toContain('cursor=cursor+%2B%2F2');
  await click('.versions-newer'); const count = graphReads().length;
  intercept = () => json(graphPage(0, { tip: sha(9999), snapshot: 'advanced' })); await click('.versions-newer');
  expect(graphReads()).toHaveLength(count); expect(query('.version-tip').textContent).toContain(sha(1000));
  expect(root().querySelectorAll('.version-edge-boundary').length).toBeGreaterThan(0);
});

test('节点完整SHA+lineage snapshot按需读取，内联一次一个，安全文本/原始O折叠/关闭焦点', async () => {
  await open(); const card = query('.lineage-source'), marker = card.querySelector('.lineage-node');
  intercept = url => url.includes('version-lineage-commit') ? Promise.reject(new Error('节点不可用')) : null;
  await marker.onclick(); expect(deepText(query('.version-node-detail'))).toContain('节点读取失败');
  const result = detailResult(); result.commit.tasks[0].task_kind = 'say';
  intercept = url => url.includes('version-lineage-commit') ? json(result) : null;
  await query('.version-node-detail').querySelector('button').onclick();
  expect(detailReads().at(-1).url).toContain(`commit=${sha(971)}`); expect(detailReads().at(-1).url).toContain('snapshot=fixed-lineage');
  expect(deepText(query('.version-node-detail'))).toContain('<script>evil()</script>');
  expect(root().querySelectorAll('script')).toHaveLength(0); expect(root().querySelectorAll('img')).toHaveLength(0);
  expect(query('.version-input').open).not.toBe(true);
  expect(query('.version-input').querySelector('.record-link').getAttribute('href')).toBe('#input-input-263');
  expect(query('.version-node-detail').parentNode).toBe(card.querySelector('.lineage-body'));
  expect(document.activeElement).toBe(query('.version-node-detail')); expect(marker.getAttribute('aria-expanded')).toBe('true');
  await query('.version-node-detail').querySelector('button').onclick(); expect(document.activeElement).toBe(marker);
  intercept = url => url.includes('version-lineage-commit') ? json(detailResult(lineagePage().origin)) : null;
  await click('.lineage-origin .lineage-node'); expect(detailReads().at(-1).url).toContain(`commit=${sha(1)}`);
  expect(root().querySelectorAll('.version-node-detail')).toHaveLength(1);
  const reads = requests.length; query('.lineage-landing-receipts').open = true; expect(requests).toHaveLength(reads); // no arbitrary landing details API
});

test('lineage首读/分页/刷新失败保留成功页，重试目标正确；旧snapshot不能读取节点', async () => {
  intercept = () => Promise.reject(new Error('Git失败')); await open(); expect(deepText(root())).toContain('Git失败');
  intercept = null; await click('.versions-retry'); const cards = root().querySelectorAll('.lineage-source');
  intercept = () => Promise.reject(new Error('Git失败')); await click('.versions-more'); expect(root().querySelectorAll('.lineage-source')).toEqual(cards);
  await click('.versions-refresh'); const reads = requests.length; await query('.lineage-source .lineage-node').onclick();
  expect(requests).toHaveLength(reads); expect(query('.versions-more').disabled).toBe(true);
  intercept = null; await click('.versions-retry'); expect(lineageReads().at(-1).url).toBe('/api/worker/71/version-lineage?limit=30');
});

test('lineage响应格式/映射/分页签名核验，不把错图或坏证据当空状态', async () => {
  await open(); const cards = root().querySelectorAll('.lineage-source');
  intercept = () => json(lineagePage(1, { snapshot: 'changed' })); await click('.versions-more'); expect(deepText(root())).toContain('分页快照发生变化');
  const invalid = [lineagePage(0, { worker: { id: 93 } }), lineagePage(0, { commits: [node(2), node(2)] }),
    lineagePage(0, { commits: [node(2), node(3)] }), lineagePage(0, { commits: Array.from({ length: 31 }, (_, i) => node(100 - i)) }),
    lineagePage(0, { has_more: true, cursor: null }), lineagePage(0, { deliveries: [mapping(900), mapping(900)] }),
    lineagePage(0, { deliveries: [mapping(900, 998, 3000, { parent_id: 2 })] }), lineagePage(0, { origin: { ...node(1), parents: ['ref'] } })];
  for (const data of invalid) { intercept = () => json(data); await click('.versions-refresh'); expect(deepText(root())).toContain('不兼容'); expect(root().querySelectorAll('.lineage-source')).toEqual(cards); }
});

test('刷新/分页/节点迟到保护，换Worker或离页取消旧请求不覆盖新模块', async () => {
  const old = deferred(), fresh = deferred(); intercept = () => old.promise; mount(); const reading = click('.versions-load');
  intercept = () => fresh.promise; const refreshing = click('.versions-refresh'); expect(lineageReads()[0].signal.aborted).toBe(true);
  old.resolve(json(lineagePage())); await reading; expect(root().getAttribute('aria-busy')).toBe('true');
  fresh.resolve(json(lineagePage())); await refreshing;
  const gate = deferred(); intercept = () => gate.promise; const paging = click('.versions-more');
  intercept = null; await click('.versions-refresh'); gate.resolve(json(lineagePage(1))); await paging;
  expect(query('.versions-feedback').textContent).toContain('第 1 页');
  const late = deferred(); intercept = () => late.promise; const nodeRead = query('.lineage-source .lineage-node').onclick();
  intercept = null; await click('.versions-more'); late.resolve(json(detailResult())); await nodeRead; expect(query('.version-node-detail').hidden).toBe(true);
  const stale = deferred(); intercept = () => stale.promise; const loading = click('.versions-refresh'), abandoned = root();
  disposeWorkerVersions(); panel.replaceChildren(); panel.append(renderWorkerVersions({ ...worker, id: 72 }));
  stale.resolve(json(lineagePage())); await loading; expect(root().querySelectorAll('.lineage-source')).toHaveLength(0);
  expect(abandoned.querySelector('.versions-load').onclick).toBeNull();
});

test('main刷新取消/签名/错误保留/节点迟到隔离保持覆盖', async () => {
  await open(main); const cards = root().querySelectorAll('.version-commit');
  intercept = () => json(graphPage(1, { snapshot: 'bad' })); await click('.versions-more'); expect(deepText(root())).toContain('分页快照发生变化');
  const old = deferred(); intercept = () => old.promise; const reading = click('.versions-more');
  intercept = null; await click('.versions-refresh'); expect(graphReads().at(-2).signal.aborted).toBe(true);
  old.resolve(json(graphPage(1))); await reading; expect(query('.versions-feedback').textContent).toContain('第 1 页');
  const nodeLate = deferred(); intercept = () => nodeLate.promise; const readingNode = click('.version-node');
  intercept = null; await click('.versions-more'); nodeLate.resolve(json(detailResult(node(1000)))); await readingNode;
  expect(query('.version-node-detail').hidden).toBe(true);
  intercept = () => Promise.reject(new Error('main Git失败')); await click('.versions-refresh');
  expect(deepText(root())).toContain('main Git失败'); expect(root().querySelectorAll('.version-commit')).toHaveLength(cards.length);
  const count = requests.length; await click('.version-node'); expect(requests).toHaveLength(count);
});

test('同Worker首读中重绘延续来源请求，无重复挂载Observer', async () => {
  const gate = deferred(); intercept = () => gate.promise; renderDetail(worker, { events: [] }, null, null);
  observers.at(-1).enter(); const module = root(); renderDetail(worker, { events: [] }, null, null);
  expect(root()).toBe(module); expect(lineageReads()).toHaveLength(1);
  gate.resolve(json(lineagePage())); await drain(); expect(root().querySelectorAll('.lineage-source')).toHaveLength(30);
});

test('project/document/boot/view改变与离页Observer隔离来源响应', async () => {
  for (const change of ['project', 'document', 'boot', 'view']) {
    disposeWorkerVersions(); panel.replaceChildren(); dom.location.pathname = '/'; ui.view = { id: 'task' }; mount();
    const gate = deferred(); intercept = () => gate.promise; const pending = click('.versions-load'), original = root(), oldDoc = globalThis.document;
    if (change === 'project') dom.location.pathname = '/p/0123456789abcdef/';
    if (change === 'document') globalThis.document = { ...oldDoc };
    if (change === 'boot') ui.workerNumbers = new Map();
    if (change === 'view') ui.view = { id: 'overview' };
    gate.resolve(json(lineagePage())); await pending; globalThis.document = oldDoc;
    expect(original.querySelectorAll('.lineage-source')).toHaveLength(0);
  }
  dom.location.pathname = '/'; ui.view = { id: 'task' }; disposeWorkerVersions(); panel.replaceChildren(); mount();
  const before = requests.length, observer = observers.at(-1); disposeWorkerVersions(); observer.enter(); await drain();
  expect(requests).toHaveLength(before); expect(observer.disconnected).toBe(true);
});

test('同Worker常规详情重绘保留节点展开与原始Input；离页释放；Valet无Git入口', async () => {
  intercept = url => /\/api\/worker\/71$/.test(url) ? json(worker) : url.includes('version-lineage-commit') ? json(detailResult())
    : url.includes('/version-') ? json(defaultResponse(url)) : url.includes('/history') ? json({ events: [] })
    : url.endsWith('/connections') ? json({ connections: [] }) : json({});
  await loadDetail(71); const module = root(); expect(requests.some(r => r.url.includes('/version-'))).toBe(false);
  observers.at(-1).enter(); await drain(); await query('.lineage-source .lineage-node').onclick();
  const input = query('.version-input'); input.open = true; const count = requests.filter(r => r.url.includes('/version-')).length;
  await loadDetail(71); await drain(); expect(root()).toBe(module); expect(query('.version-input')).toBe(input); expect(input.open).toBe(true);
  expect(requests.filter(r => r.url.includes('/version-'))).toHaveLength(count);
  activateDetailView({ view: 'overview' }); expect(module.querySelector('.versions-load').onclick).toBeNull();
  renderDetail({ ...worker, task_kind: 'management', work_type: 'valet', management: {} }, { events: [] }, null, null);
  expect(root()).toBeNull();
});

test('main坏拓扑及重复节点拒绝；双轨窄屏主题样式和旧导航退休契约', async () => {
  await open(main); const cards = root().querySelectorAll('.version-commit');
  for (const commits of [[node(2), node(2)], [{ ...node(2), parents: [] }, { ...node(3), parents: [sha(2)] }], Array.from({ length: 31 }, (_, i) => node(100 - i))]) {
    intercept = () => json(graphPage(0, { commits })); await click('.versions-refresh'); expect(root().querySelectorAll('.version-commit')).toEqual(cards);
  }
  expect(fs.readFileSync('src/ui/web/assets/index.html', 'utf8')).not.toContain('id="versions-open"');
  const css = fs.readFileSync('src/ui/web/assets/styles-versions.css', 'utf8');
  for (const token of ['var(--panel)', 'var(--bg)', 'overflow-wrap:anywhere', 'grid-template-columns:72px minmax(0,1fr)', '@media(max-width:640px)', '.lineage-node:focus-visible', '.lineage-git-edge', '.lineage-delivery-edge', 'dashed var(--dim)']) expect(css).toContain(token);
  expect(css).not.toContain('blur(');
});
