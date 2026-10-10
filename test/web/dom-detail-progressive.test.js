import { test, expect, afterAll, beforeEach } from 'bun:test';
import { installDom, deepText } from '../dom-stub.js';

const json = value => ({ ok: true, json: async () => value });
const fail = () => ({ ok: false, json: async () => ({ error: 'read failed' }) });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const drain = async () => { for (let i = 0; i < 18; i++) await Promise.resolve(); };
const connectionId = '44444444-4444-4444-8444-444444444444';
const task = (id = 71, extra = {}) => ({ id, worker_number: `W150-${id}`, role: 'agent', task_kind: 'order',
  status: 'running', integration: 'none', calls: 1, goal: `原始目标 ${id}`, result: `正文结果 ${id}`,
  branch: `lush/test/${id}`, workspace: `/tmp/test/${id}`, created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-02T00:00:00Z',
  deps: [], dependents: [], children: [], runs: [{ id: 8, result: `正文结果 ${id}`, ended_at: '2026-10-02T00:00:00Z' }],
  model_selection: { agent: 'pi', connection_id: connectionId, model: 'test/model', explicit: false }, ...extra });
const history = { events: [{ id: 81, task_id: 71, type: 'message', data: { sender: null, body: '历史追加输入' } },
  { id: 82, type: 'invocation.completed', data: { run_id: 7, result: '此前结果正文' }, created_at: '2026-10-01T00:00:00Z' }], cursor: 81, truncated: false };
const diff = { branch: 'lush/test/71', files_total: 1, files: [{ path: 'changed.js', added: 3, deleted: 1 }],
  committed: true, added: 3, deleted: 1, pending_total: 0 };
const usage = { files: ['session'], requests: 1, totals: { input: 23, output: 4, cache_read: 0, cost: 0.01 }, context_tokens: 27,
  model: { provider: 'test', model_id: 'model' } };
const connections = { connections: [{ id: connectionId, label: '我的来源' }] };
let intercept = null, requests = [];
const defaults = url => {
  if (url.includes('/history')) return json({ events: [], truncated: false });
  if (url.endsWith('/diff')) return json(diff);
  if (url.endsWith('/usage')) return json(usage);
  if (url.endsWith('/connections')) return json(connections);
  const match = /\/api\/worker\/(\d+)$/.exec(url);
  if (match) return json(task(Number(match[1])));
  return fail();
};
const dom = installDom({ fetch: (url, options) => { url = String(url); requests.push(url); return intercept?.(url, options) ?? defaults(url); } });
const events = new Map();
dom.document.addEventListener = (type, fn) => { const list = events.get(type) || new Set(); list.add(fn); events.set(type, list); };
dom.document.removeEventListener = (type, fn) => events.get(type)?.delete(fn);
const fire = type => { for (const fn of [...(events.get(type) || [])]) fn(); };
const { ui, resetUiState, transcriptOpen, transcriptCache } = await import('../../src/ui/web/assets/state.js');
const { loadDetail } = await import('../../src/ui/web/assets/detail.js');
const { activateDetailView } = await import('../../src/ui/web/assets/sidebar-ui.js');
const panel = dom.node('detail');
const slowExtras = () => {
  const gates = Object.fromEntries(['history', 'diff', 'usage', 'connections'].map(key => [key, deferred()]));
  intercept = url => {
    const key = url.endsWith('/history-page') ? 'history' : url.endsWith('/diff') ? 'diff' : url.endsWith('/usage') ? 'usage'
      : url.endsWith('/connections') ? 'connections' : null;
    return key ? gates[key].promise : null;
  };
  return gates;
};
const settle = gates => { gates.history.resolve(json(history)); gates.diff.resolve(json(diff)); gates.usage.resolve(json(usage)); gates.connections.resolve(json(connections)); };
const openDiff = () => { const fold = panel.querySelector('.detail-diff'); fold.open = true; return fold.ontoggle(); };
beforeEach(() => {
  resetUiState();
  panel.replaceChildren(); delete panel.dataset.taskId;
  intercept = null; requests = []; ui.view = null; ui.detailTask = null; ui.transcriptView = null;
  ui.deletedWorkerIds.clear(); ui.noticeFocus = null; ui.composerTask = null; ui.syncComposer = null;
  transcriptOpen.clear(); transcriptCache.clear(); dom.document.activeElement = null;
  dom.window.getSelection = () => ({ isCollapsed: true, toString: () => '' }); dom.location.pathname = '/';
});
afterAll(() => dom.restore());

test('主体一到即显示目标、状态、结果和操作并返回 true；慢 diff/usage/history/connections 不阻塞 ACK', async () => {
  const gates = slowExtras(), main = deferred(); const extras = intercept;
  intercept = url => url === '/api/worker/71' ? main.promise : extras(url);
  const opening = loadDetail(71);
  try {
    await drain(); expect(deepText(panel)).not.toContain('正文结果 71');
    main.resolve(json(task())); await drain();
    expect(await Promise.race([opening, Promise.resolve('pending')])).toBe(true);
    expect(deepText(panel)).toContain('原始目标 71'); expect(deepText(panel)).toContain('正文结果 71');
    expect(panel.querySelector('.task-actions')).toBeTruthy(); expect(panel.querySelector('.task-stats')).toBeTruthy();
    expect(ui.composerTask.id).toBe(71);
    expect(requests[0]).toBe('/api/worker/71');
    expect(requests.some(url => url.endsWith('/diff'))).toBe(false);
    openDiff();
    for (const text of ['历史加载中', '改动加载中', '用量加载中', '连接名称加载中']) expect(deepText(panel)).toContain(text);
    expect(deepText(panel)).not.toContain('未提交文件');
    expect(requests.some(url => url.includes('/transcript'))).toBe(false);
    gates.history.resolve(json(history)); gates.connections.resolve(json(connections)); await drain();
    expect(deepText(panel)).toContain('历史追加输入'); expect(deepText(panel)).toContain('此前结果正文');
    expect(deepText(panel)).toContain('我的来源'); expect(deepText(panel)).toContain('改动加载中');
    gates.diff.resolve(json(diff)); await drain(); expect(deepText(panel)).toContain('changed.js');
    expect(deepText(panel)).toContain('用量加载中');
    gates.usage.resolve(json(usage)); await drain(); expect(deepText(panel)).toContain('累计 token');
    expect(deepText(panel)).not.toContain('用量加载中');
  } finally { main.resolve(json(task())); settle(gates); await opening; await drain(); }
});

test('同 Worker 刷新保留已加载历史/用量/连接/改动，不先缩回占位再膨胀；切 Worker 隔离', async () => {
  intercept = url => url.endsWith('/history-page') ? json(history) : null;
  await loadDetail(71); openDiff(); await drain();
  expect(deepText(panel)).toContain('累计 token'); expect(deepText(panel)).toContain('此前结果正文');
  expect(deepText(panel)).toContain('我的来源'); expect(deepText(panel)).toContain('changed.js');
  const gates = slowExtras();
  try {
    await loadDetail(71);
    for (const text of ['历史加载中', '用量加载中', '连接名称加载中', '改动加载中']) expect(deepText(panel)).not.toContain(text);
    for (const text of ['累计 token', '此前结果正文', '我的来源', 'changed.js']) expect(deepText(panel)).toContain(text);
    await loadDetail(72);
    expect(deepText(panel)).toContain('用量加载中'); expect(deepText(panel)).toContain('历史加载中');
    expect(deepText(panel)).not.toContain('changed.js');
  } finally { settle(gates); await drain(); }
});

test('旧请求迟到或重复 dispose 不得释放新详情的几何观察器', async () => {
  const { renderDetail } = await import('../../src/ui/web/assets/render-detail.js');
  const original = globalThis.ResizeObserver, observers = [];
  globalThis.ResizeObserver = class {
    constructor() { observers.push(this); this.disconnected = false; }
    observe() {} unobserve() {} disconnect() { this.disconnected = true; }
  };
  let latest;
  try {
    const old = renderDetail(task(), { loading: true, events: [] }, null, null, null, { current: () => true });
    latest = renderDetail(task(), { loading: true, events: [] }, null, null, null, { current: () => true });
    const liveObserver = observers.at(-1);
    expect(liveObserver.disconnected).toBe(false);
    old.dispose(); old.dispose();
    expect(liveObserver.disconnected).toBe(false);
    latest.dispose(); expect(liveObserver.disconnected).toBe(true);
  } finally {
    latest?.dispose();
    if (original === undefined) delete globalThis.ResizeObserver; else globalThis.ResizeObserver = original;
  }
});

test('真实告知查看在主体成功后即 ACK 并开放下一条，不等详情补充或全局刷新', async () => {
  const { registerNavigation } = await import('../../src/ui/web/assets/navigate.js');
  const { renderNotices } = await import('../../src/ui/web/assets/render-notices.js');
  const { renderNoticeBanner } = await import('../../src/ui/web/assets/notice-banner.js');
  const gates = slowExtras(), extras = intercept, main = deferred(), refresh = deferred();
  const notice = id => ({ id, task_id: 71, kind: 'info', status: 'sent', source_event_id: id + 100,
    created_at: '2026-10-08T10:00:00Z', read_at: null, title: `渐进详情告知 ${id}` });
  const first = notice(100), second = notice(101); let refreshes = 0, acknowledgements = 0;
  ui.noticeReadRows = new Map(); ui.noticeReadPending = new Map(); ui.noticeIndex = new Map();
  ui.noticeRecords = null; ui.busy = false; ui.offline = false;
  const restore = registerNavigation({ detail: loadDetail, refresh: () => { refreshes++; return refresh.promise; } });
  intercept = (url, options) => {
    if (url === '/api/worker/71') return main.promise;
    if (url === '/api/action') {
      expect(JSON.parse(options.body)).toEqual({ method: 'notice.read', params: { id: second.id } });
      acknowledgements++; return json({ ...second, read_at: '2026-10-08T11:00:00Z' });
    }
    return extras(url);
  };
  ui.lastSnapshot = { notices: [first, second], status: { project: '/tmp/progressive-detail' } };
  renderNotices(ui.lastSnapshot); renderNoticeBanner(ui.lastSnapshot);
  const banner = dom.node('notice-banner'), opening = banner.querySelector('.notice-banner-info').onclick();
  try {
    await drain(); expect(acknowledgements).toBe(0);
    main.resolve(json(task())); await drain();
    expect(await Promise.race([opening, Promise.resolve('pending')])).toBeUndefined();
    expect(acknowledgements).toBe(1); expect(refreshes).toBe(1);
    expect(deepText(panel)).toContain('正文结果 71'); expect(deepText(panel)).toContain('打开后读取改动');
    expect(deepText(panel)).toContain('用量加载中');
    expect(deepText(banner)).toContain(first.title); expect(deepText(banner)).not.toContain(second.title);
    expect(banner.querySelector('.notice-banner-info').disabled).toBe(false);
    expect(banner.querySelector('.notice-banner-known').disabled).toBe(false);
  } finally {
    main.resolve(json(task())); settle(gates); refresh.resolve(); await opening; await drain(); restore();
    ui.lastSnapshot = null; ui.noticeRecords = null; ui.refreshNoticeBanner = null;
  }
});

test('未产出结果的 Worker 也能先打开，历史状态不会冒充已读空结果', async () => {
  const gates = slowExtras(), extras = intercept;
  intercept = url => url === '/api/worker/71' ? json(task(71, { result: undefined, runs: [], calls: 0 })) : extras(url);
  try {
    expect(await loadDetail(71)).toBe(true);
    expect(deepText(panel.querySelector('.result-panel'))).toContain('历史加载中');
    gates.history.resolve(json(history)); await drain();
    expect(deepText(panel.querySelector('.result-panel'))).toContain('此前结果正文');
  } finally { settle(gates); await drain(); }
});

test('补充失败明确不可用而非零消耗/零改动；主体失败不返回成功', async () => {
  intercept = url => /history|diff|usage|connections/.test(url) ? fail() : null;
  expect(await loadDetail(71)).toBe(true); openDiff(); await drain();
  for (const text of ['历史不可用', '改动不可用', '用量不可用', '连接名称不可用']) expect(deepText(panel)).toContain(text);
  expect(deepText(panel)).not.toContain('累计 token'); expect(deepText(panel)).not.toContain('提交文件');
  expect(deepText(panel)).toContain('正文结果 71');
  intercept = () => fail();
  await expect(loadDetail(72)).rejects.toThrow('read failed');
  expect(deepText(panel)).toContain('无法打开'); expect(ui.composerTask).toBeNull();
});

test('历史、用量、改动和连接名补齐不替换正文、折叠、输入、焦点或滚动；详情选区期间暂缓', async () => {
  const gates = slowExtras();
  try {
    expect(await loadDetail(71)).toBe(true); openDiff();
    const goal = panel.querySelector('.goal-panel'), result = panel.querySelector('.result-panel');
    const body = goal.querySelector('.goal-text');
    const goalFold = panel.querySelector('.goal-history'), resultFold = panel.querySelector('.result-history');
    goalFold.open = true; resultFold.open = false;
    const input = document.createElement('input'); input.value = '未提交草稿'; panel.querySelector('.task-actions').append(input);
    input.focus(); panel.scrollTop = 435;
    dom.window.getSelection = () => ({ isCollapsed: false, anchorNode: body, focusNode: body });
    settle(gates); await drain();
    expect(deepText(panel)).toContain('历史加载中'); expect(panel.scrollTop).toBe(435);
    expect(document.activeElement).toBe(input); expect(input.value).toBe('未提交草稿');
    input.blur(); fire('selectionchange'); expect(deepText(panel)).toContain('用量加载中');
    dom.window.getSelection = () => ({ isCollapsed: true }); fire('selectionchange'); await drain();
    expect(deepText(panel)).toContain('changed.js'); expect(deepText(panel)).toContain('历史追加输入');
    expect(panel.querySelector('.goal-panel')).toBe(goal); expect(panel.querySelector('.result-panel')).toBe(result);
    expect(goal.querySelector('.goal-text')).toBe(body); expect(goalFold.open).toBe(true); expect(resultFold.open).toBe(false);
    expect(input.parentNode).toBe(panel.querySelector('.task-actions')); expect(input.value).toBe('未提交草稿');
    expect(panel.scrollTop).toBe(435); expect(events.get('selectionchange')?.size || 0).toBe(0);
  } finally { settle(gates); await drain(); }
});

test('焦点保护在 focusout 后补齐且不失去已展开预览', async () => {
  const gates = slowExtras();
  try {
    await loadDetail(71); openDiff();
    const goal = panel.querySelector('.goal-panel');
    const toggle = goal.querySelector('.detail-preview-toggle'); toggle.onclick();
    const input = document.createElement('input'); panel.querySelector('.task-actions').append(input); input.focus();
    settle(gates); await drain(); expect(deepText(panel)).toContain('改动加载中');
    for (const fn of panel.listeners.focusout || []) fn(); input.blur(); await drain();
    expect(deepText(panel)).toContain('changed.js'); expect(goal.classList.contains('detail-preview-expanded')).toBe(true);
  } finally { settle(gates); await drain(); }
});

test('迟到补充不能覆盖新页面、新项目、已删除 Worker 或同 Worker 更新请求', async () => {
  for (const scenario of ['page', 'project', 'invalid-project', 'delete', 'request', 'worker']) {
    const gates = slowExtras(); await loadDetail(71);
    if (scenario === 'page') activateDetailView({ view: 'settings' });
    if (scenario === 'project') dom.location.pathname = '/p/abcdef0123456789/';
    if (scenario === 'invalid-project') dom.location.pathname = '/p/invalid/';
    if (scenario === 'delete') ui.deletedWorkerIds.add(71);
    if (scenario === 'request' || scenario === 'worker') {
      intercept = url => url.endsWith('/connections') ? json({ connections: [] }) : url.includes('/history') ? json({ events: [] })
        : url.endsWith('/diff') || url.endsWith('/usage') ? json(null) : null;
      await loadDetail(scenario === 'worker' ? 72 : 71); await drain();
    }
    settle(gates); await drain();
    expect(deepText(panel)).not.toContain('changed.js'); expect(deepText(panel)).not.toContain('历史追加输入');
    if (scenario === 'page') expect(panel.dataset.view).toBe('settings');
    if (scenario === 'worker') expect(panel.dataset.taskId).toBe('72');
    ui.deletedWorkerIds.clear(); dom.location.pathname = '/';
  }
});

test('主体迟到或 Worker 已删除不返回 true，不允许 ACK；补充响应早到也不冒充成功', async () => {
  const main = deferred(); intercept = url => url === '/api/worker/71' ? main.promise : null;
  const opening = loadDetail(71); await drain(); activateDetailView({ view: 'settings' });
  main.resolve(json(task())); expect(await opening).toBe(false); await drain();
  expect(panel.dataset.view).toBe('settings'); expect(ui.composerTask).toBeNull();
  ui.deletedWorkerIds.add(71); const count = requests.length;
  expect(await loadDetail(71)).toBe(false); expect(requests.length).toBe(count);
});

test('已打开执行记录的终态尾读独立且只读取一次；关闭记录不主动读正文', async () => {
  const gates = slowExtras(), extras = intercept, tail = deferred();
  intercept = url => url === '/api/worker/71' ? json(task(71, { status: 'completed' }))
    : url.includes('/transcript') ? tail.promise : extras(url);
  transcriptOpen.add(71); const cache = { next: 1, steps: [], files: ['session'], order: 'desc', settled: false };
  transcriptCache.set(71, cache);
  try {
    expect(await loadDetail(71)).toBe(true); await drain();
    expect(requests.filter(url => url.includes('/transcript')).length).toBe(1);
    tail.resolve(json({ steps: [{ seq: 2, kind: 'text', body: '最后记录' }], next: 2 })); await drain();
    expect(cache.next).toBe(2); expect(cache.settled).toBe(true);
    settle(gates); await drain();
    await loadDetail(71); await drain(); expect(requests.filter(url => url.includes('/transcript')).length).toBe(1);
    transcriptOpen.clear(); transcriptCache.clear(); await loadDetail(71); await drain();
    expect(requests.filter(url => url.includes('/transcript')).length).toBe(1);
  } finally { tail.resolve(json({ steps: [], next: 1 })); settle(gates); await drain(); }
});

test('主体打开后进入全屏阅读，补充数据仍补齐隐藏详情而不触碰阅读器', async () => {
  const gates = slowExtras();
  try {
    await loadDetail(71); openDiff();
    const reader = document.createElement('input'); reader.value = '执行记录内搜索词'; document.body.append(reader); reader.focus();
    const view = { taskId: 71, panel: reader }; ui.transcriptView = view;
    settle(gates); await drain();
    expect(deepText(panel)).toContain('changed.js'); expect(deepText(panel)).not.toContain('用量加载中');
    expect(ui.transcriptView).toBe(view); expect(document.activeElement).toBe(reader); expect(reader.value).toBe('执行记录内搜索词');
    expect(requests.some(url => url.includes('/transcript'))).toBe(false);
    ui.transcriptView = null; reader.remove();
  } finally { settle(gates); await drain(); }
});

test('渐进详情先展示规划历史；迟到主体和补充保留历史分页、展开、焦点及当前阅读位置', async () => {
  const plans = (ids, more = true) => ({ items: ids.map(id => ({ id, archived_at: '2026-10-08T10:00:00Z', reason: 'replan',
    progress: { version: 1, frozen: true, items: [{ key: 'old', label: `旧计划 ${id}`, status: 'completed', work_ms: 1000 }] } })),
    cursor: ids.at(-1), has_more: more, limit: 10 });
  const enriched = ids => task(71, { progress_history: plans(ids) });
  const gates = slowExtras(), extras = intercept, main = deferred(); let refreshing = false;
  intercept = url => url === '/api/worker/71' ? (refreshing ? main.promise : json(enriched([20])))
    : url.includes('/progress-history?') ? json(plans([19], false)) : extras(url);
  try {
    expect(await loadDetail(71)).toBe(true); openDiff();
    const section = panel.querySelector('.progress-history-panel');
    expect(deepText(section)).toContain('旧计划 20'); expect(deepText(panel)).toContain('改动加载中');
    const more = section.querySelector('.progress-history-controls').querySelector('button');
    await more.onclick();
    const fold = section.querySelector('.progress-history-version'), focus = fold.querySelector('summary');
    fold.open = true; focus.focus(); panel.scrollTop = 100;
    refreshing = true; const opening = loadDetail(71); panel.scrollTop = 350;
    main.resolve(json(enriched([21, 20]))); expect(await opening).toBe(true);
    expect(panel.querySelector('.progress-history-panel')).toBe(section);
    expect(section.querySelectorAll('.progress-history-version').map(node => node.dataset.progressHistoryId)).toEqual(['21', '20', '19']);
    expect(fold.open).toBe(true); expect(document.activeElement).toBe(focus); expect(panel.scrollTop).toBe(350);
    expect(more.hidden).toBe(true);
    settle(gates); await drain(); expect(deepText(panel)).toContain('改动加载中');
    focus.blur(); fire('selectionchange'); await drain();
    expect(deepText(panel)).toContain('changed.js'); expect(deepText(panel)).toContain('历史追加输入');
    expect(panel.querySelector('.progress-history-panel')).toBe(section); expect(fold.open).toBe(true);
    expect(panel.scrollTop).toBe(350); expect(section.querySelectorAll('.progress-history-version')).toHaveLength(3);
    expect(section.querySelectorAll('.is-running-duration')).toHaveLength(0);
    expect(requests.filter(url => url.includes('/progress-history?'))).toHaveLength(1);
  } finally { main.resolve(json(enriched([21, 20]))); settle(gates); await drain(); }
});

test('执行详情已打开时仍补终态尾读，迟到导航不改缓存', async () => {
  const tail = deferred();
  intercept = url => url === '/api/worker/71' ? json(task(71, { status: 'completed' })) : url.includes('/transcript') ? tail.promise : null;
  transcriptOpen.add(71); const cache = { next: 1, steps: [], settled: false }; transcriptCache.set(71, cache);
  ui.transcriptView = { taskId: 71 };
  expect(await loadDetail(71)).toBe(false); await drain();
  expect(requests.some(url => url.includes('/transcript'))).toBe(true);
  activateDetailView({ view: 'settings' });
  tail.resolve(json({ steps: [{ seq: 2, body: 'stale' }], next: 2 })); await drain();
  expect(cache.steps).toEqual([]); expect(cache.next).toBe(1);
});
