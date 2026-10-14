import { test, expect, beforeEach, afterAll } from 'bun:test';
import fs from 'node:fs';
import { installDom, deepText } from '../dom-stub.js';

const sha = n => n.toString(16).padStart(40, '0');
const worker = { id: 71, worker_number: 'W263-7', task_kind: 'order', role: 'agent', status: 'running',
  integration: 'none', calls: 0, goal: '结果优先', branch: 'feature', children: [], deps: [], dependents: [],
  created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-02T00:00:00Z' };
const main = { ...worker, task_kind: 'main', branch: 'main' };
const association = { id: 93, worker_number: 'W263-7-2', evidence: 'task.merge_integrated', delivery_id: 611, delivery_available: true };
const round = n => ({ ...association, id: 71, worker_number: worker.worker_number, delivery_id: n,
  delivered_at: '2026-10-01', source_commit: sha(n), commit: sha(n + 1) });
const rounds = (items = [round(900), round(800)], extra = {}) => ({ id: 71, deliveries: items, before: null, has_more: false, ...extra });
const node = n => ({ commit: sha(n), short_commit: sha(n).slice(-7), parents: [sha(n - 1)], subject: `提交 ${n}`,
  committed_at: '2026-10-02T00:00:00Z', author: { name: '作者' }, association: 'verified', tasks: [association] });
const page = (offset = 0, extra = {}) => ({ worker: { id: 71, worker_number: worker.worker_number }, scope: 'main',
  branch: 'main', tip: sha(1000), base: null, delivery: null, snapshot: 'fixed-snapshot',
  commits: Array.from({ length: 30 }, (_, i) => node(1000 - offset * 30 - i)), cursor: `cursor +/${offset + 1}`, has_more: offset < 5, ...extra });
const json = value => ({ ok: true, json: async () => value });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const drain = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
let intercept, requests = [], observers = [];
const defaultResponse = url => {
  if (url.includes('/version-deliveries')) return rounds();
  const params = new URL(url, 'http://test').searchParams;
  const delivery = Number(params.get('delivery')) || null;
  const offset = params.has('cursor') ? Number(params.get('cursor').split('/')[1]) : 0;
  return page(offset, delivery ? { scope: 'delivery', branch: 'feature', base: sha(1), delivery } : {});
};
const dom = installDom({ fetch: (url, options) => {
  requests.push({ url: String(url), signal: options?.signal });
  return intercept?.(String(url), options) ?? Promise.resolve(json(defaultResponse(String(url))));
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
const deliveryReads = () => requests.filter(r => r.url.includes('/version-deliveries'));
const detailReads = () => requests.filter(r => r.url.includes('/version-commit'));
const mount = (task = worker) => { const module = renderWorkerVersions(task); panel.append(module); return module; };
const open = async (task = worker) => { mount(task); observers.at(-1).enter(); await drain(); };
const openRound = async () => { await open(); await click('.version-round-choice'); };
const detailResult = (commit = node(1000)) => ({ worker: { id: 71 }, commit: { ...commit,
  message: '<script>evil()</script>\n完整提交消息', tasks: [{ ...association, goal: '<img onerror=evil()>', input: { id: 263, content: '<svg onload=evil()>\n原始输入' } }] } });
beforeEach(() => {
  disposeWorkerVersions(); resetUiState(); panel.replaceChildren(); delete panel.dataset.taskId;
  ui.view = { id: 'task', key: 'task-71' }; ui.selected = 71; ui.detailTask = 71;
  dom.location.pathname = '/'; requests = []; observers = []; intercept = null; globalThis.IntersectionObserver = Observer;
});
afterAll(() => { disposeWorkerVersions(); globalThis.IntersectionObserver = oldObserver; delete prototype.isConnected; dom.restore(); });

test('滚入即展示真实轮次图，无切换/展开/当前分支读取；每个节点使用Event身份和持久编号', async () => {
  mount(); expect(requests).toHaveLength(0);
  observers[0].callback([{ isIntersecting: false }]); expect(requests).toHaveLength(0);
  observers[0].enter(); observers[0].enter(); await drain();
  expect(deliveryReads()).toHaveLength(1); expect(deliveryReads()[0].url).toBe('/api/worker/71/version-deliveries?limit=30');
  expect(graphReads()).toHaveLength(0); expect(detailReads()).toHaveLength(0);
  expect(query('.version-rounds').tagName).toBe('SECTION'); expect(query('.version-rounds').hidden).toBe(false);
  expect(query('.version-round-detail').hidden).toBe(true); expect(query('.versions-load').hidden).toBe(true);
  const nodes = root().querySelectorAll('.version-round'); expect(nodes).toHaveLength(2);
  expect(nodes[0].dataset.delivery).toBe('900'); expect(nodes[0].dataset.previousDelivery).toBe('800');
  expect(nodes[1].dataset.previousDelivery).toBeUndefined(); expect(deepText(root())).toContain('不是 Git 父边');
  expect(deepText(root())).toContain(worker.worker_number); expect(observers[0].disconnected).toBe(true);
});

test('同一源SHA多次持久交付仍分成独立轮次；点击才展示源与父侧落点', async () => {
  intercept = url => url.includes('/version-deliveries') ? json(rounds([{ ...round(900), source_commit: sha(800), commit: sha(801) }, round(800)])) : null;
  await open(); expect(root().querySelectorAll('.version-round')).toHaveLength(2); expect(graphReads()).toHaveLength(0);
  expect(query('.version-round-detail').hidden).toBe(true);
  await click('.version-round-choice'); expect(query('.version-receipt').textContent).toContain(sha(800));
  expect(query('.version-receipt').textContent).toContain(`父侧落点：${sha(801)}`);
  expect(graphReads()[0].url).toContain('delivery=900');
});

test('没有成功交付或缺固定证据，不回退当前分支，也不隐藏历史成功Event', async () => {
  intercept = () => json(rounds([])); await open(); expect(deepText(root())).toContain('暂无成功交付轮次');
  expect(graphReads()).toHaveLength(0); expect(root().querySelectorAll('.version-round')).toHaveLength(0);
  intercept = () => json(rounds([{ ...round(500), evidence: 'merged', delivery_available: false, delivery_unavailable_reason: '历史证据不足' }]));
  await click('.version-round-refresh'); expect(query('.version-round-choice')).toBeNull();
  expect(deepText(root())).toContain('交付 Event 500'); expect(deepText(root())).toContain('历史证据不足'); expect(graphReads()).toHaveLength(0);
});

test('无observer保留键盘可达加载；main只读取main图及原生子Worker链接，不内联子图', async () => {
  globalThis.IntersectionObserver = undefined; mount(); await drain(); expect(requests).toHaveLength(0);
  expect(query('.versions-load').type).toBe('button'); await click('.versions-load'); expect(deliveryReads()).toHaveLength(1);
  disposeWorkerVersions(); panel.replaceChildren(); mount(main); await click('.versions-load');
  expect(graphReads()[0].url).toBe('/api/worker/71/version-graph?limit=30');
  expect(query('.version-rounds').hidden).toBe(true); expect(query('.version-round-detail').hidden).toBe(false);
  const link = query('.version-task-link'); expect(link.tagName).toBe('A'); expect(link.getAttribute('href')).toBe('#worker-93');
  expect(link.textContent).toBe('Worker W263-7-2'); expect(query('.version-delivery-choice')).toBeNull();
  expect(root().querySelectorAll('.agent-call')).toHaveLength(0);
});

test('轮次30节点有界分页，失败保留/重试，刷新从最新开始，不累计正文', async () => {
  intercept = () => json(rounds(Array.from({ length: 30 }, (_, i) => round(900 - i)), { before: 871, has_more: true }));
  await open(); expect(root().querySelectorAll('.version-round')).toHaveLength(30);
  expect(query('.version-round-newer').disabled).toBe(true);
  intercept = () => Promise.reject(new Error('轮次失败')); await click('.version-round-older');
  expect(root().querySelectorAll('.version-round')).toHaveLength(30); expect(deepText(root())).toContain('轮次失败');
  intercept = () => json(rounds([round(600)]));
  await query('.version-rounds').querySelectorAll('button').find(b => b.textContent === '重试交付轮次').onclick();
  expect(deliveryReads().at(-1).url).toContain('before=871'); expect(root().querySelectorAll('.version-round')).toHaveLength(1);
  expect(query('.version-round-older').disabled).toBe(true);
  await click('.version-round-refresh'); expect(deliveryReads().at(-1).url).not.toContain('before=');
  expect(graphReads()).toHaveLength(0);
});

test('轮次身份/顺序/页界限校验，不把坏响应当作历史或空状态', async () => {
  await open(); const nodes = root().querySelectorAll('.version-round');
  for (const data of [rounds([round(900), round(900)]), rounds([round(500), round(900)]), rounds([{ ...round(900), id: 93 }]),
    rounds([round(900)], { id: 93 }), rounds(Array.from({ length: 31 }, (_, i) => round(900 - i))),
    rounds([round(900)], { before: 123, has_more: true }), rounds([{ ...round(900), evidence: 'delivery.source' }])]) {
    intercept = () => json(data); await click('.version-round-refresh');
    expect(deepText(root())).toContain('数据格式不兼容'); expect(root().querySelectorAll('.version-round')).toEqual(nodes);
  }
  expect(graphReads()).toHaveLength(0);
});

test('轮次节点一次点击内联固定Event图；返回仍是轮次图，无当前分支读取', async () => {
  await openRound(); expect(graphReads()).toHaveLength(1);
  expect(graphReads()[0].url).toBe('/api/worker/71/version-graph?limit=30&delivery=900');
  expect(query('.version-round-detail').hidden).toBe(false); expect(query('.versions-scope').textContent).toContain('Event 900');
  expect(query('.version-rounds').hidden).toBe(false); expect(detailReads()).toHaveLength(0);
  await click('.versions-back'); expect(query('.version-round-detail').hidden).toBe(true);
  expect(graphReads()).toHaveLength(1); expect(root().querySelectorAll('.version-round')).toHaveLength(2);
  const unknown = renderVersionCommit({ ...node(2), tasks: [{ ...association, worker_number: null, evidence: 'worker.source' }] });
  expect(unknown.querySelector('.version-task-link').textContent).toBe('Worker #93'); expect(unknown.querySelector('.version-delivery-choice')).toBeNull();
});

test('main30节点/三页缓存/固定首屏；长图双向切页不累计，淘汰后cursor读取', async () => {
  await open(main); expect(query('.versions-newer').disabled).toBe(true);
  for (let i = 1; i <= 5; i++) {
    await click('.versions-more'); expect(root().querySelectorAll('.version-commit')).toHaveLength(30);
    expect(Number(root().dataset.cachedPages)).toBeLessThanOrEqual(3);
  }
  expect(query('.versions-more').disabled).toBe(true); const before = graphReads().length;
  await click('.versions-newer'); expect(graphReads()).toHaveLength(before);
  await click('.versions-newer'); expect(graphReads()).toHaveLength(before + 1);
  await click('.versions-newer'); expect(graphReads().at(-1).url).toContain('cursor=cursor+%2B%2F2');
  await click('.versions-newer'); const count = graphReads().length;
  intercept = () => json(page(0, { tip: sha(9999), snapshot: 'advanced' }));
  await click('.versions-newer'); expect(graphReads()).toHaveLength(count); expect(query('.version-tip').textContent).toContain(sha(1000));
});

test('固定交付分页始终带Event；淘汰的第一页只可重采相同范围并清旧snapshot游标', async () => {
  await openRound(); for (let i = 0; i < 4; i++) await click('.versions-more');
  expect(graphReads().every(r => r.url.includes('delivery=900'))).toBe(true);
  for (let i = 0; i < 3; i++) await click('.versions-newer');
  intercept = url => json({ ...defaultResponse(url), snapshot: 'new-fixed' }); await click('.versions-newer');
  expect(query('.versions-feedback').textContent).toContain('第 1 页');
  intercept = url => url.includes('/version-commit') ? json(detailResult()) : null;
  await click('.version-node'); expect(detailReads().at(-1).url).toContain('snapshot=new-fixed');
  expect(deepText(root())).toContain('真实 Git parents'); expect(root().querySelectorAll('.version-edge-boundary').length).toBeGreaterThan(0);
});

test('节点按需完整消息/安全文本/O链接/历史say；失败可重试，关闭返回焦点', async () => {
  await openRound(); expect(query('.version-input')).toBeNull(); expect(detailReads()).toHaveLength(0);
  intercept = url => url.includes('/version-commit') ? Promise.reject(new Error('节点不可用')) : null;
  const marker = query('.version-node'); await marker.onclick(); expect(deepText(query('.version-node-detail'))).toContain('节点读取失败');
  const result = detailResult(); result.commit.tasks[0].task_kind = 'say';
  intercept = url => url.includes('/version-commit') ? json(result) : null;
  await query('.version-node-detail').querySelector('button').onclick();
  expect(detailReads().at(-1).url).toContain(`commit=${sha(1000)}`); expect(detailReads().at(-1).url).toContain('snapshot=fixed-snapshot');
  expect(deepText(query('.version-node-detail'))).toContain('<script>evil()</script>');
  expect(root().querySelectorAll('script')).toHaveLength(0); expect(root().querySelectorAll('img')).toHaveLength(0);
  expect(query('.version-input').open).not.toBe(true); expect(query('.version-input').querySelector('.record-link').getAttribute('href')).toBe('#input-input-263');
  expect(result.commit.tasks[0].task_kind).toBe('say');
  expect(query('.version-node-detail').parentNode).toBe(query('.version-commit').querySelector('.version-body'));
  expect(marker.getAttribute('aria-expanded')).toBe('true'); expect(document.activeElement).toBe(query('.version-node-detail'));
  await query('.version-node-detail').querySelector('button').onclick(); expect(document.activeElement).toBe(marker);
});

test('子交付可按需固定读取/返回，失败不回退当前分支；main没有此下钻', async () => {
  await openRound(); const cards = root().querySelectorAll('.version-commit'), late = deferred();
  intercept = url => url.includes('/version-commit') ? late.promise : Promise.reject(new Error('子源对象缺失'));
  const pending = click('.version-node'); await click('.version-delivery-choice'); late.resolve(json(detailResult())); await pending;
  expect(deepText(root())).toContain('子源对象缺失'); expect(query('.version-node-detail').hidden).toBe(true);
  expect(graphReads().at(-1).url).toBe('/api/worker/93/version-graph?limit=30&delivery=611');
  await click('.versions-back'); expect(root().querySelectorAll('.version-commit').map(c => c.dataset.commit)).toEqual(cards.map(c => c.dataset.commit));
  const noEvidence = renderVersionCommit({ ...node(2), tasks: [{ ...association, evidence: null }] }, { onDelivery: () => {} });
  expect(noEvidence.querySelector('.version-delivery-choice')).toBeNull();
});

test('图首读/分页/刷新失败保留成功页；刷新丢弃snapshot，节点不能使用旧图', async () => {
  await open(); intercept = () => Promise.reject(new Error('Git失败')); await click('.version-round-choice');
  expect(deepText(root())).toContain('Git失败'); intercept = null; await click('.versions-retry');
  const cards = root().querySelectorAll('.version-commit'); intercept = () => Promise.reject(new Error('Git失败'));
  await click('.versions-more'); expect(root().querySelectorAll('.version-commit')).toEqual(cards);
  await click('.versions-refresh'); const before = requests.length; await click('.version-node'); expect(requests).toHaveLength(before);
  expect(query('.versions-more').disabled).toBe(true); intercept = null; await click('.versions-retry');
  expect(graphReads().at(-1).url).toBe('/api/worker/71/version-graph?limit=30&delivery=900');
});

test('轮次/节点/分页迟到保护，刷新和换Worker取消旧请求不覆盖新页面', async () => {
  const old = deferred(), fresh = deferred(); intercept = () => old.promise; mount(); const reading = click('.versions-load');
  intercept = () => fresh.promise; const refreshing = click('.version-round-refresh'); expect(deliveryReads()[0].signal.aborted).toBe(true);
  old.resolve(json(rounds([round(500)]))); await reading; expect(root().getAttribute('aria-busy')).toBe('true');
  fresh.resolve(json(rounds())); await refreshing; expect(root().querySelectorAll('.version-round')).toHaveLength(2);
  intercept = null; await click('.version-round-choice');
  const late = deferred(); intercept = () => late.promise; const nodeRead = click('.version-node');
  await click('.versions-back'); late.resolve(json(detailResult())); await nodeRead; expect(query('.version-node-detail').hidden).toBe(true);
  const stale = deferred(); intercept = () => stale.promise; const loading = click('.version-round-refresh'), abandoned = root();
  disposeWorkerVersions(); panel.replaceChildren(); panel.append(renderWorkerVersions({ ...worker, id: 72 }));
  stale.resolve(json(rounds())); await loading; expect(root().querySelectorAll('.version-round')).toHaveLength(0);
  expect(abandoned.querySelector('.versions-load').onclick).toBeNull();
});

test('图刷新/轮次切换/返回后迟到图响应不能覆盖新图或重开提交详情', async () => {
  await openRound(); const old = deferred(), fresh = deferred();
  intercept = url => url.includes('cursor=') ? old.promise : fresh.promise;
  const paging = click('.versions-more'), refreshing = click('.versions-refresh');
  expect(graphReads().at(-2).signal.aborted).toBe(true);
  old.resolve(json(page(1, { scope: 'delivery', delivery: 900 }))); await paging;
  expect(root().getAttribute('aria-busy')).toBe('true');
  fresh.resolve(json(page(0, { scope: 'delivery', delivery: 900, snapshot: 'fresh', commits: [node(7)] }))); await refreshing;
  expect(root().querySelectorAll('.version-commit')).toHaveLength(1);
  const stale = deferred(); intercept = () => stale.promise; const loading = click('.versions-refresh');
  await click('.versions-back'); stale.resolve(json(page(0, { scope: 'delivery', delivery: 900 }))); await loading;
  expect(query('.version-round-detail').hidden).toBe(true); expect(root().querySelectorAll('.version-commit')).toHaveLength(0);
  const gate = deferred(); intercept = () => gate.promise; const first = click('.version-round-choice');
  intercept = null; await root().querySelectorAll('.version-round-choice')[1].onclick();
  gate.resolve(json(page(0, { scope: 'delivery', delivery: 900 }))); await first;
  expect(query('.versions-scope').textContent).toContain('Event 800');
  expect(query('.version-round-detail').hidden).toBe(false); expect(graphReads().at(-1).url).toContain('delivery=800');
});

test('同Worker首读中重绘延续轮次请求，不重新挂载observer', async () => {
  const gate = deferred(); intercept = () => gate.promise; renderDetail(worker, { events: [] }, null, null);
  observers.at(-1).enter(); const module = root(); renderDetail(worker, { events: [] }, null, null);
  expect(root()).toBe(module); expect(deliveryReads()).toHaveLength(1);
  gate.resolve(json(rounds())); await drain(); expect(root().querySelectorAll('.version-round')).toHaveLength(2);
});

test('project/document/boot/view变更及离页observer隔离轮次响应', async () => {
  for (const change of ['project', 'document', 'boot', 'view']) {
    disposeWorkerVersions(); panel.replaceChildren(); dom.location.pathname = '/'; ui.view = { id: 'task' }; mount();
    const gate = deferred(); intercept = () => gate.promise; const pending = click('.versions-load'), original = root(), oldDoc = globalThis.document;
    if (change === 'project') dom.location.pathname = '/p/0123456789abcdef/';
    if (change === 'document') globalThis.document = { ...oldDoc };
    if (change === 'boot') ui.workerNumbers = new Map();
    if (change === 'view') ui.view = { id: 'overview' };
    gate.resolve(json(rounds())); await pending; globalThis.document = oldDoc;
    expect(original.querySelectorAll('.version-round')).toHaveLength(0);
  }
  dom.location.pathname = '/'; ui.view = { id: 'task' }; disposeWorkerVersions(); panel.replaceChildren(); mount();
  const before = requests.length, observer = observers.at(-1); disposeWorkerVersions(); observer.enter(); await drain();
  expect(requests).toHaveLength(before); expect(observer.disconnected).toBe(true);
});

test('同Worker重绘保留轮次/详情/observer不重读；离页释放；Valet没有Git入口', async () => {
  intercept = url => /\/api\/worker\/71$/.test(url) ? json(worker) : url.includes('/version-commit') ? json(detailResult())
    : url.includes('/version-') ? json(defaultResponse(url)) : url.includes('/history') ? json({ events: [] })
    : url.endsWith('/connections') ? json({ connections: [] }) : json({});
  await loadDetail(71); const module = root(); expect(requests.some(r => r.url.includes('/version-'))).toBe(false);
  observers.at(-1).enter(); await drain(); await click('.version-round-choice'); await click('.version-node');
  const input = query('.version-input'); input.open = true; const count = requests.filter(r => r.url.includes('/version-')).length;
  await loadDetail(71); await drain(); expect(root()).toBe(module); expect(query('.version-input')).toBe(input); expect(input.open).toBe(true);
  expect(requests.filter(r => r.url.includes('/version-'))).toHaveLength(count);
  activateDetailView({ view: 'overview' }); expect(module.querySelector('.versions-load').onclick).toBeNull();
  renderDetail({ ...worker, task_kind: 'management', work_type: 'valet', management: {} }, { events: [] }, null, null);
  expect(root()).toBeNull(); expect(panel.querySelector('.management-settings-link')).toBeNull();
});

test('图格式/snapshot校验失败保留成功页，专用主题窄屏样式及旧导航退休', async () => {
  await open(main); const cards = root().querySelectorAll('.version-commit');
  intercept = () => json(page(1, { tip: sha(9999) })); await click('.versions-more'); expect(deepText(root())).toContain('分页快照发生变化');
  for (const commits of [[node(2), node(2)], [{ ...node(2), parents: [] }, { ...node(3), parents: [sha(2)] }], Array.from({ length: 31 }, (_, i) => node(100 - i))]) {
    intercept = () => json(page(0, { commits })); await click('.versions-refresh'); expect(root().querySelectorAll('.version-commit')).toEqual(cards);
  }
  const html = fs.readFileSync('src/ui/web/assets/index.html', 'utf8'); expect(html).not.toContain('id="versions-open"');
  const css = fs.readFileSync('src/ui/web/assets/styles-versions.css', 'utf8');
  for (const token of ['var(--panel)', 'var(--bg)', 'overflow-wrap:anywhere', 'minmax(0,1fr)', '@media(max-width:640px)', '.version-node:focus-visible', '.version-round[data-previous-delivery]']) expect(css).toContain(token);
});
