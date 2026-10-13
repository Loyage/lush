import { test, expect, beforeEach, afterAll } from 'bun:test';
import fs from 'node:fs';
import { installDom, deepText } from '../dom-stub.js';

const sha = n => n.toString(16).padStart(40, '0');
const worker = { id: 71, worker_number: 'W263-7', task_kind: 'order', role: 'agent', status: 'running',
  integration: 'none', calls: 0, goal: '结果优先', branch: 'feature', children: [], deps: [], dependents: [],
  created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-02T00:00:00Z' };
const association = { id: 93, worker_number: 'W263-7-2', evidence: 'task.merge_integrated', delivery_id: 611, delivery_available: true };
const node = n => ({ commit: sha(n), short_commit: sha(n).slice(-7), parents: [sha(n - 1)], subject: `提交 ${n}`,
  committed_at: '2026-10-02T00:00:00Z', author: { name: '作者' }, association: 'verified', tasks: [association] });
const page = (offset = 0, extra = {}) => ({ worker: { id: 71, worker_number: worker.worker_number }, scope: 'current',
  branch: 'feature', tip: sha(1000), base: sha(1), delivery: null, snapshot: 'fixed-snapshot',
  commits: Array.from({ length: 30 }, (_, i) => node(1000 - offset * 30 - i)), cursor: `cursor +/${offset + 1}`, has_more: offset < 5, ...extra });
const json = value => ({ ok: true, json: async () => value });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const drain = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
let intercept, requests = [], observers = [];
const dom = installDom({ fetch: (url, options) => {
  requests.push({ url: String(url), signal: options?.signal });
  return intercept?.(String(url), options) ?? Promise.resolve(json(page()));
} });
dom.document.createElementNS = (_namespace, tag) => dom.document.createElement(tag);
const prototype = Object.getPrototypeOf(dom.document.createElement('div'));
Object.defineProperty(prototype, 'isConnected', { configurable: true, get() {
  for (let at = this; at; at = at.parentNode) if (at === dom.node('detail')) return true;
  return false;
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
const panel = dom.node('detail');
const root = () => panel.querySelector('.worker-versions');
const query = selector => root().querySelector(selector);
const click = selector => query(selector).onclick();
const graphReads = () => requests.filter(r => r.url.includes('/version-graph'));
const detailReads = () => requests.filter(r => r.url.includes('/version-commit'));
const mount = () => { const module = renderWorkerVersions(worker); panel.append(module); return module; };
const open = async () => { mount(); observers.at(-1).enter(); await drain(); };
const detailResult = (commit = node(1000)) => ({ worker: { id: 71 }, commit: { ...commit,
  message: '<script>evil()</script>\n完整提交消息', tasks: [{ ...association, goal: '<img onerror=evil()>', input: { id: 263, content: '<svg onload=evil()>\n原始输入' } }] } });
beforeEach(() => {
  disposeWorkerVersions(); resetUiState(); panel.replaceChildren(); delete panel.dataset.taskId;
  ui.view = { id: 'task', key: 'task-71' }; ui.selected = 71; ui.detailTask = 71;
  dom.location.pathname = '/'; requests = []; observers = []; intercept = null; globalThis.IntersectionObserver = Observer;
});
afterAll(() => { disposeWorkerVersions(); globalThis.IntersectionObserver = oldObserver; delete prototype.isConnected; dom.restore(); });

test('observer 惰性启动；详情主内容不等Git；无observer仅用户主动可访问加载', async () => {
  mount(); expect(graphReads()).toHaveLength(0); expect(query('.versions-load').hidden).toBe(false);
  observers[0].callback([{ isIntersecting: false }]); expect(graphReads()).toHaveLength(0);
  observers[0].enter(); observers[0].enter(); await drain(); expect(graphReads()).toHaveLength(1);
  expect(graphReads()[0].url).toBe('/api/worker/71/version-graph?limit=30'); expect(observers[0].disconnected).toBe(true);
  expect(query('.versions-load').hidden).toBe(true);
  disposeWorkerVersions(); panel.replaceChildren(); globalThis.IntersectionObserver = undefined; const before = graphReads().length;
  mount(); await drain(); expect(graphReads()).toHaveLength(before); expect(query('.versions-load').type).toBe('button');
  await click('.versions-load'); expect(graphReads()).toHaveLength(before + 1);
});

test('30节点有界分页/三页缓存；长图前进和返回不累计，淘汰后以轻量cursor返回', async () => {
  intercept = url => { const cursor = new URL(url, 'http://test').searchParams.get('cursor'); const offset = cursor ? Number(cursor.split('/')[1]) : 0; return json(page(offset)); };
  await open(); expect(query('.versions-newer').disabled).toBe(true);
  for (let i = 1; i <= 5; i++) {
    await click('.versions-more'); expect(root().querySelectorAll('.version-commit')).toHaveLength(30);
    expect(Number(root().dataset.cachedPages)).toBeLessThanOrEqual(3); expect(deepText(root())).toContain(`第 ${i + 1} 页`);
  }
  expect(query('.versions-more').disabled).toBe(true); const before = graphReads().length;
  await click('.versions-newer'); expect(graphReads()).toHaveLength(before);
  await click('.versions-newer'); expect(graphReads()).toHaveLength(before + 1);
  await click('.versions-newer'); expect(graphReads()).toHaveLength(before + 2);
  expect(graphReads().at(-1).url).toContain('cursor=cursor+%2B%2F2'); expect(root().querySelectorAll('.version-commit')).toHaveLength(30);
  await click('.versions-newer'); const returnReads = graphReads().length;
  // A mutable ref advanced while browsing: page zero must use the pinned snapshot,
  // not a cursor-less new graph request which would take the changed ref.
  intercept = () => json(page(0, { tip: sha(9999), snapshot: 'advanced-current' }));
  await click('.versions-newer'); expect(query('.versions-newer').disabled).toBe(true); expect(graphReads()).toHaveLength(returnReads);
  expect(query('.version-tip').textContent).toContain(sha(1000));
});

test('归档fallback下一页仍省略delivery；固定snapshot，父边与范围说明', async () => {
  intercept = () => json(page(0, { scope: 'delivery', delivery: 888 })); await open(); await click('.versions-more');
  expect(graphReads().at(-1).url).not.toContain('delivery='); expect(deepText(root())).toContain('分支已回收');
  expect(root().querySelectorAll('.version-edge-boundary').length).toBeGreaterThan(0);
  expect(deepText(root())).toContain('真实 Git parents'); expect(query('.version-tip').textContent).toContain(sha(1));
  const oldCards = root().querySelectorAll('.version-commit');
  intercept = () => json(page(2, { snapshot: 'changed-snapshot' })); await click('.versions-more');
  expect(deepText(root())).toContain('分页快照发生变化'); expect(root().querySelectorAll('.version-commit')).toEqual(oldCards);
});

test('节点按需完整消息/安全文本/原始Input折叠；失败重试，不在首屏加载目标', async () => {
  await open(); expect(detailReads()).toHaveLength(0); expect(query('.version-input')).toBeNull();
  intercept = url => url.includes('/version-commit') ? Promise.reject(new Error('节点不可用')) : null;
  await click('.version-node'); expect(deepText(query('.version-node-detail'))).toContain('节点读取失败');
  intercept = url => url.includes('/version-commit') ? json(detailResult()) : null;
  await query('.version-node-detail').querySelector('button').onclick();
  expect(detailReads().at(-1).url).toContain('snapshot=fixed-snapshot'); expect(detailReads().at(-1).url).toContain(`commit=${sha(1000)}`);
  expect(deepText(query('.version-node-detail'))).toContain('<script>evil()</script>'); expect(root().querySelectorAll('script')).toHaveLength(0);
  expect(root().querySelectorAll('img')).toHaveLength(0); expect(query('.version-input').open).not.toBe(true);
  expect(query('.version-input').querySelector('.record-link').getAttribute('href')).toBe('#input-input-263');
  expect(deepText(root())).toContain('<svg onload=evil()>');
});

test('历史say节点按需详情保留原始指令正文和真实O链接，不改写历史类型', async () => {
  const input = Object.freeze({ id: 9, content: 'say was the original request\n<script>historical()</script>' });
  const task = Object.freeze({ ...association, task_kind: 'say', goal: '历史指令', input });
  intercept = url => url.includes('/version-commit')
    ? json({ worker: { id: 71 }, commit: { ...node(1000), message: '保留历史提交', tasks: [task] } })
    : json(page(0, { commits: [{ ...node(1000), tasks: [{ ...association, task_kind: 'say' }] }] }));
  await open();
  expect(query('.version-order')).toBeNull(); expect(detailReads()).toHaveLength(0);
  await click('.version-node');
  expect(query('.version-order').textContent).toBe(input.content);
  expect(query('.version-input').querySelector('.record-link').getAttribute('href')).toBe('#input-input-9');
  expect(root().querySelectorAll('script')).toHaveLength(0);
  expect(task.task_kind).toBe('say'); expect(task.input).toBe(input);
});

test('真实子Worker href与持久编号，未知#id；仅delivery_available+Event证据下钻，普通源不可递归', async () => {
  await open(); const link = query('.version-task-link'); expect(link.tagName).toBe('A'); expect(link.getAttribute('href')).toBe('#worker-93');
  expect(link.textContent).toBe('Worker W263-7-2'); expect(root().querySelectorAll('.agent-call')).toHaveLength(0);
  const ordinary = renderVersionCommit({ ...node(2), tasks: [{ ...association, worker_number: null, evidence: 'worker.source' }] });
  expect(ordinary.querySelector('.version-task-link').textContent).toBe('Worker #93'); expect(ordinary.querySelector('.version-delivery-choice')).toBeNull();
  const noEvidence = renderVersionCommit({ ...node(2), tasks: [{ ...association, evidence: null }] }); expect(noEvidence.querySelector('.version-delivery-choice')).toBeNull();
  intercept = url => url.includes('/worker/93/') ? json(page(0, { worker: association, scope: 'delivery', delivery: 611, snapshot: 'child', commits: [node(9)], has_more: false, cursor: null })) : null;
  await click('.version-delivery-choice'); expect(graphReads().at(-1).url).toBe('/api/worker/93/version-graph?limit=30&delivery=611');
  expect(deepText(root())).toContain('固定交付 Event 611'); expect(root().querySelectorAll('.version-commit')).toHaveLength(1);
  const reads = graphReads().length; await click('.versions-back'); expect(graphReads()).toHaveLength(reads);
  expect(root().querySelectorAll('.version-commit')).toHaveLength(30); expect(query('.versions-back').hidden).toBe(true);
});

test('轮次只展开时有界读取；分页不累计，失败保留与重试，刷新从最新开始', async () => {
  await open(); expect(requests.some(r => r.url.includes('/version-deliveries'))).toBe(false);
  const rounds = query('.version-rounds'); rounds.open = true;
  intercept = url => url.includes('/version-deliveries') ? json({ deliveries: Array.from({ length: 30 }, (_, i) => ({ ...association, id: 71, delivery_id: 900 - i, delivered_at: '2026-10-01' })), before: 871, has_more: true }) : null;
  await rounds.ontoggle(); expect(root().querySelectorAll('.version-round')).toHaveLength(30);
  const buttons = rounds.querySelectorAll('button'), older = buttons.find(b => b.textContent === '较早轮次');
  intercept = () => Promise.reject(new Error('轮次失败')); await older.onclick(); expect(deepText(rounds)).toContain('轮次失败'); expect(root().querySelectorAll('.version-round')).toHaveLength(30);
  intercept = () => json({ deliveries: [{ ...association, id: 71, delivery_id: 600 }], before: null, has_more: false });
  await buttons.find(b => b.textContent === '重试交付轮次').onclick(); expect(requests.at(-1).url).toContain('before=871');
  expect(root().querySelectorAll('.version-round')).toHaveLength(1); expect(older.disabled).toBe(true);
  await buttons.find(b => b.textContent === '刷新轮次').onclick(); expect(requests.at(-1).url).not.toContain('before=');
});

test('首读/分页/刷新失败保留成功页；刷新丢弃snapshot，节点不能用旧图读', async () => {
  const failure = () => Promise.reject(new Error('Git失败')); intercept = failure;
  mount(); await click('.versions-load'); expect(deepText(root())).toContain('Git失败');
  intercept = null; await click('.versions-retry'); const cards = root().querySelectorAll('.version-commit');
  intercept = failure; await click('.versions-more'); expect(root().querySelectorAll('.version-commit')).toEqual(cards);
  expect(query('.versions-retry').hidden).toBe(false); expect(query('.versions-more').disabled).toBe(false);
  await click('.versions-refresh'); expect(root().querySelectorAll('.version-commit')).toEqual(cards);
  const before = requests.length; await click('.version-node'); expect(requests).toHaveLength(before);
  expect(query('.versions-more').disabled).toBe(true); intercept = null; await click('.versions-retry');
  expect(graphReads().at(-1).url).toBe('/api/worker/71/version-graph?limit=30'); expect(query('.versions-more').disabled).toBe(false);
});

test('Worker切换/刷新/图切换/离页迟到响应保护，abort旧请求且不清除新busy', async () => {
  await open(); const old = deferred(), fresh = deferred();
  intercept = url => url.includes('cursor=') ? old.promise : fresh.promise;
  const paging = click('.versions-more'), refreshing = click('.versions-refresh');
  expect(graphReads().at(-2).signal.aborted).toBe(true);
  old.resolve(json(page(1))); await paging; expect(root().getAttribute('aria-busy')).toBe('true');
  fresh.resolve(json(page(0, { snapshot: 'fresh', commits: [node(7)] }))); await refreshing;
  expect(root().querySelectorAll('.version-commit')).toHaveLength(1); expect(deepText(root())).toContain('提交 7');
  const stale = deferred(); intercept = () => stale.promise; const reading = click('.versions-refresh'); const abandoned = root();
  disposeWorkerVersions(); panel.replaceChildren(); panel.append(renderWorkerVersions({ ...worker, id: 72 }));
  stale.resolve(json(page())); await reading; expect(deepText(root())).not.toContain('提交 1000');
  expect(abandoned.querySelector('.versions-more').onclick).toBeNull();
});

test('节点与轮次迟到保护覆盖刷新、切图、项目/document/boot变更', async () => {
  await open(); const lateNode = deferred(); intercept = url => url.includes('/version-commit') ? lateNode.promise : null;
  const reading = click('.version-node'); await click('.versions-refresh'); lateNode.resolve(json(detailResult())); await reading;
  expect(query('.version-node-detail').hidden).toBe(true);
  const late = deferred(); intercept = () => late.promise; const rounds = query('.version-rounds'); rounds.open = true;
  const listing = rounds.ontoggle(); intercept = null; await click('.versions-refresh'); late.resolve(json({ deliveries: [association], before: null, has_more: false })); await listing;
  expect(root().querySelectorAll('.version-round')).toHaveLength(0);
  for (const change of ['project', 'document', 'boot', 'view']) {
    disposeWorkerVersions(); panel.replaceChildren(); dom.location.pathname = '/'; ui.view = { id: 'task' }; mount();
    const gate = deferred(); intercept = () => gate.promise; const pending = click('.versions-load'), original = root(), oldDoc = globalThis.document;
    if (change === 'project') dom.location.pathname = '/p/0123456789abcdef/';
    if (change === 'document') globalThis.document = { ...oldDoc };
    if (change === 'boot') ui.workerNumbers = new Map();
    if (change === 'view') ui.view = { id: 'overview' };
    gate.resolve(json(page())); await pending; globalThis.document = oldDoc;
    expect(original.querySelectorAll('.version-commit')).toHaveLength(0);
  }
});

test('同Worker详情重绘保持模块/节点/observer，轮询不重读；离页释放；Valet没有Git或配置入口', async () => {
  intercept = url => /\/api\/worker\/71$/.test(url) ? json(worker) : url.includes('/version-graph') ? json(page())
    : url.includes('/history') ? json({ events: [] }) : url.endsWith('/connections') ? json({ connections: [] }) : json({});
  await loadDetail(71); const module = root(); expect(graphReads()).toHaveLength(0); observers.at(-1).enter(); await drain();
  const cards = root().querySelectorAll('.version-commit'); const reads = graphReads().length;
  const previousIntercept = intercept; intercept = url => url.includes('/version-commit') ? json(detailResult()) : previousIntercept(url);
  await click('.version-node'); const input = query('.version-input'); input.open = true;
  await loadDetail(71); await drain(); expect(root()).toBe(module); expect(root().querySelectorAll('.version-commit')).toEqual(cards); expect(graphReads()).toHaveLength(reads);
  expect(query('.version-input')).toBe(input); expect(input.open).toBe(true); expect(detailReads()).toHaveLength(1);
  activateDetailView({ view: 'overview' }); expect(module.querySelector('.versions-load').onclick).toBeNull();
  expect(observers.every(o => o.disconnected)).toBe(true);
  renderDetail({ ...worker, task_kind: 'management', work_type: 'valet', management: {} }, { events: [] }, null, null);
  expect(root()).toBeNull(); expect(panel.querySelector('.management-settings-link')).toBeNull();
});

test('同Worker读取中重绘可继续，换Worker重绘旧响应不可覆盖；全新模块只观察不预取', async () => {
  const gate = deferred(); intercept = () => gate.promise; renderDetail(worker, { events: [] }, null, null);
  observers.at(-1).enter(); const module = root(); renderDetail(worker, { events: [] }, null, null); expect(root()).toBe(module);
  gate.resolve(json(page())); await drain(); expect(root().querySelectorAll('.version-commit')).toHaveLength(30);
  const late = deferred(); intercept = () => late.promise; const pending = click('.versions-refresh');
  renderDetail({ ...worker, id: 72 }, { events: [] }, null, null); late.resolve(json(page())); await pending;
  expect(root().querySelectorAll('.version-commit')).toHaveLength(0); expect(observers.at(-1).disconnected).toBe(false);
});

test('main Worker读同一入口；图身份变化/超过30/重复与非拓扑响应不污染成功页', async () => {
  disposeWorkerVersions(); panel.append(renderWorkerVersions({ ...worker, branch: 'main' }));
  expect(query('.versions-scope').textContent).toBe('main 提交图');
  intercept = () => json(page(0, { scope: 'main', branch: 'main', base: null })); await click('.versions-load');
  const cards = root().querySelectorAll('.version-commit');
  intercept = () => json(page(1, { scope: 'main', branch: 'main', base: null, tip: sha(9999) })); await click('.versions-more');
  expect(deepText(root())).toContain('分页快照发生变化'); expect(root().querySelectorAll('.version-commit')).toEqual(cards);
  for (const commits of [[node(2), node(2)], [{ ...node(2), parents: [] }, { ...node(3), parents: [sha(2)] }], Array.from({ length: 31 }, (_, i) => node(100 - i))]) {
    intercept = () => json(page(0, { commits })); await click('.versions-refresh'); expect(root().querySelectorAll('.version-commit')).toEqual(cards);
  }
});

test('固定交付首屏淘汰后仅可重采相同Event/tip/base，清除旧snapshot游标不混用', async () => {
  await open(); let offset = 0, signature = 'child-old';
  intercept = url => {
    const parsed = new URL(url, 'http://test'); offset = parsed.searchParams.has('cursor') ? Number(parsed.searchParams.get('cursor').split('/')[1]) : 0;
    return json(page(offset, { worker: association, scope: 'delivery', delivery: 611, snapshot: signature }));
  };
  await click('.version-delivery-choice'); for (let i = 0; i < 4; i++) await click('.versions-more');
  for (let i = 0; i < 3; i++) await click('.versions-newer'); signature = 'child-new';
  await click('.versions-newer'); expect(query('.versions-feedback').textContent).toContain('第 1 页');
  expect(root().querySelectorAll('.version-commit')).toHaveLength(30);
  intercept = url => url.includes('/version-commit') ? json({ ...detailResult(), worker: association }) : null;
  await click('.version-node'); expect(detailReads().at(-1).url).toContain('snapshot=child-new');
});

test('切图取消迟到节点/轮次；子交付失败可重试或返回父成功页，不回退当前分支', async () => {
  await open(); const cards = root().querySelectorAll('.version-commit'), gate = deferred();
  intercept = url => url.includes('/version-commit') ? gate.promise : Promise.reject(new Error('子源对象缺失'));
  const pending = click('.version-node'); await click('.version-delivery-choice');
  gate.resolve(json(detailResult())); await pending;
  expect(deepText(root())).toContain('子源对象缺失'); expect(query('.version-node-detail').hidden).toBe(true);
  expect(root().querySelectorAll('.version-commit')).toHaveLength(0);
  await click('.versions-back'); expect(root().querySelectorAll('.version-commit').map(c => c.dataset.commit)).toEqual(cards.map(c => c.dataset.commit));
  expect(graphReads().at(-1).url).toContain('/worker/93/version-graph?limit=30&delivery=611');
});

test('返回父缓存后迟到子图不可覆盖；页内节点键盘区域和关闭焦点', async () => {
  await open(); const late = deferred(); intercept = () => late.promise;
  const opening = click('.version-delivery-choice'); await click('.versions-back');
  late.resolve(json(page(0, { worker: association, scope: 'delivery', delivery: 611, snapshot: 'child', commits: [node(2)] }))); await opening;
  expect(root().querySelectorAll('.version-commit')).toHaveLength(30); expect(query('.versions-scope').textContent).toContain('当前已提交开发');
  const marker = query('.version-node'); marker.focus(); intercept = url => url.includes('/version-commit') ? json(detailResult()) : null;
  await marker.onclick(); const nodeDetail = query('.version-node-detail');
  expect(nodeDetail.parentNode).toBe(root().querySelectorAll('.version-commit')[0].querySelector('.version-body'));
  expect(marker.getAttribute('aria-expanded')).toBe('true'); expect(document.activeElement).toBe(nodeDetail);
  await nodeDetail.querySelector('button').onclick(); expect(document.activeElement).toBe(marker); expect(marker.getAttribute('aria-expanded')).toBe('false');
});

test('离页前observer不再触发；inspect后按实际Valet身份选导航，缺失tasks/valets容器安全', async () => {
  mount(); const observer = observers.at(-1); disposeWorkerVersions(); observer.enter(); await drain();
  expect(graphReads()).toHaveLength(0); expect(observer.disconnected).toBe(true);
  const tasksNav = dom.document.createElement('button'), valetsNav = dom.document.createElement('button');
  ui.navButtons = new Map([['tasks', tasksNav], ['valets', valetsNav]]);
  const getter = dom.document.getElementById;
  dom.document.getElementById = id => ['tasks', 'valets'].includes(id) ? null : getter(id);
  intercept = url => /\/api\/worker\/71$/.test(url) ? json({ ...worker, task_kind: 'management' })
    : url.includes('/history') ? json({ events: [] }) : url.endsWith('/connections') ? json({ connections: [] }) : json({});
  try {
    await loadDetail(71); expect(ui.detailTask).toBe(71); expect(valetsNav.getAttribute('aria-current')).toBe('page');
    expect(tasksNav.getAttribute('aria-current')).toBe('false'); expect(root()).toBeNull();
  } finally { dom.document.getElementById = getter; }
});

test('独立版本页导航已退休，专用图布局不套普通裁切并保留主题/窄屏样式', () => {
  const html = fs.readFileSync('src/ui/web/assets/index.html', 'utf8');
  expect(html).not.toContain('id="versions-open"'); expect(html).toContain('href="/styles-versions.css"');
  const css = fs.readFileSync('src/ui/web/assets/styles-versions.css', 'utf8');
  for (const token of ['var(--panel)', 'var(--bg)', 'overflow-wrap:anywhere', 'minmax(0,1fr)', '@media(max-width:640px)', '.version-node:focus-visible']) expect(css).toContain(token);
  const source = fs.readFileSync('src/ui/web/assets/render-versions.js', 'utf8');
  expect(source).not.toContain("activateDetailView({ view: 'versions'");
  expect(source).not.toContain('export async function openVersions');
  mount(); expect(root().classList.contains('block')).toBe(false); expect(query('.versions-refresh').getAttribute('data-help')).toContain('不调用 Agent');
});
