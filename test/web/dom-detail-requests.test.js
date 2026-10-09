import { test, expect, beforeEach, afterAll } from 'bun:test';
import { installDom, deepText } from '../dom-stub.js';
const json = value => ({ ok: true, json: async () => value });
const bad = () => ({ ok: false, json: async () => ({ error: 'offline' }) });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const drain = async () => { for (let i = 0; i < 24; i++) await Promise.resolve(); };
const task = id => ({ id, worker_number: `W159-${id}`, task_kind: 'order', role: 'agent', status: 'running', calls: 1,
  goal: `目标 ${id}`, result: `结果 ${id}`, deps: [], dependents: [], children: [], runs: [],
  created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-02T00:00:00Z' });
const diff = { files: [{ path: 'new.js', added: 1, deleted: 0 }], files_total: 1, committed: true };
let handler = null, requests = [];
const dom = installDom({ fetch: (url, options = {}) => {
  const row = { url: String(url), options }; requests.push(row);
  return handler?.(row) ?? json(/\/worker\/\d+$/.test(row.url) ? task(Number(row.url.match(/\d+$/)[0]))
    : row.url.endsWith('/connections') ? { connections: [{ id: 'public', label: '名称', credential: { api_key: 'NOT-CACHED' } }] }
    : row.url.endsWith('/diff') ? diff : row.url.endsWith('/usage') ? { files: [] } : { events: [] });
} });
const { ui, resetUiState, transcriptOpen, transcriptCache } = await import('../../src/ui/web/assets/state.js');
const { loadDetail, disposeDetailRequests } = await import('../../src/ui/web/assets/detail.js');
const { loadConnectionNames, loadHistory, api, action, withReadSignal } = await import('../../src/ui/web/assets/api.js');
const { registerNavigation } = await import('../../src/ui/web/assets/navigate.js');
const { activateDetailView, openResource } = await import('../../src/ui/web/assets/sidebar-ui.js');
const panel = dom.node('detail');
const openDiff = () => { const fold = panel.querySelector('.detail-diff'); fold.open = true; fold.ontoggle(); return fold; };
beforeEach(() => {
  disposeDetailRequests(); resetUiState(); panel.replaceChildren(); delete panel.dataset.taskId;
  dom.document.activeElement = null; dom.location.pathname = '/'; handler = null; requests = [];
});
afterAll(() => { disposeDetailRequests(); dom.restore(); });

test('核心 inspect 独占首个读取，失败/取消前不发附加请求；无 calls 不读用量', async () => {
  const core = deferred(); handler = ({ url }) => url === '/api/worker/7' ? core.promise : null;
  const loading = loadDetail(7); await drain(); expect(requests.map(row => row.url)).toEqual(['/api/worker/7']);
  core.resolve(json(task(7))); expect(await loading).toBe(true); await drain();
  expect(requests.some(row => row.url.endsWith('/diff'))).toBe(false);
  expect(deepText(panel)).toContain('打开后读取改动'); openDiff(); await drain();
  expect(requests.filter(row => row.url.endsWith('/diff'))).toHaveLength(1); expect(deepText(panel)).toContain('new.js');
  requests = []; handler = ({ url }) => url === '/api/worker/8' ? bad() : null;
  await expect(loadDetail(8)).rejects.toThrow('offline'); expect(requests.map(row => row.url)).toEqual(['/api/worker/8']);
  requests = []; handler = ({ url }) => url === '/api/worker/9' ? json({ ...task(9), calls: 0 }) : null;
  expect(await loadDetail(9)).toBe(true); await drain(); expect(requests.some(row => row.url.endsWith('/usage'))).toBe(false);
});

test('统一导航在更换 view 前释放详情；同页面 activate 不取消，openResource 和 boot 接缝会取消', async () => {
  await loadDetail(7); await drain();
  const signal = requests.find(row => row.url === '/api/worker/7').options.signal, view = ui.view;
  const dispose = ui.disposeDetailRequests; let disposals = 0;
  ui.disposeDetailRequests = () => { expect(ui.view).toBe(view); disposals++; dispose(); };
  try {
    expect(activateDetailView({ view: 'task', key: 'task-7' })).toBe(view);
    expect(disposals).toBe(0); expect(signal.aborted).toBe(false);
    expect(openResource('tasks')).toBe(true); expect(disposals).toBe(1); expect(signal.aborted).toBe(true);
    expect(ui.view.id).toBe('tasks');
  } finally { ui.disposeDetailRequests = dispose; }
  await loadDetail(7); const active = requests.findLast(row => row.url === '/api/worker/7').options.signal;
  disposeDetailRequests(); resetUiState(); expect(active.aborted).toBe(true);
});

test('diff 显式打开单飞/失败重试；同 Worker 刷新保留展开与文件明细，其他 Worker 不继承', async () => {
  let gate = deferred(); handler = ({ url }) => url.endsWith('/diff') ? gate.promise : null;
  await loadDetail(7); const fold = openDiff(); fold.ontoggle(); await drain();
  expect(requests.filter(row => row.url.endsWith('/diff'))).toHaveLength(1);
  gate.resolve(bad()); await drain(); expect(deepText(panel)).toContain('改动不可用');
  gate = deferred(); const retry = panel.querySelector('.detail-diff-retry').onclick();
  gate.resolve(json(diff)); await retry; await drain();
  const files = panel.querySelector('.diff-files'); files.open = true; panel.scrollTop = 172;
  handler = null; await loadDetail(7); await drain();
  expect(panel.querySelector('.detail-diff')).toBe(fold); expect(fold.open).toBe(true);
  expect(panel.querySelector('.diff-files')).toBe(files); expect(files.open).toBe(true); expect(panel.scrollTop).toBe(172);
  const before = requests.filter(row => row.url.endsWith('/diff')).length;
  await loadDetail(8); await drain(); expect(panel.querySelector('.detail-diff').open).not.toBe(true);
  expect(requests.filter(row => row.url.endsWith('/diff'))).toHaveLength(before);
});

test('切 Worker/离页/boot 时中止核心及附加 HTTP；忽略取消仍迟到的 fetch 不 ACK/不复活正文', async () => {
  const core = deferred(); handler = ({ url }) => url === '/api/worker/7' ? core.promise : null;
  const loading = loadDetail(7); const first = requests[0]; activateDetailView({ view: 'settings' });
  expect(first.options.signal.aborted).toBe(true); core.resolve(json(task(7))); expect(await loading).toBe(false);
  expect(panel.dataset.view).toBe('settings'); expect(deepText(panel)).not.toContain('结果 7');
  const history = deferred(), usage = deferred(), changes = deferred();
  handler = ({ url }) => url.includes('/history') ? history.promise : url.endsWith('/usage') ? usage.promise : url.endsWith('/diff') ? changes.promise : null;
  await loadDetail(7); openDiff(); await drain(); const obsolete = [...requests].filter(row => /history|usage|diff/.test(row.url));
  handler = null; await loadDetail(8); await drain();
  expect(obsolete.every(row => row.options.signal.aborted)).toBe(true);
  history.resolve(json({ events: [{ id: 1, type: 'message', data: { body: '过期输入' } }] })); usage.resolve(json({ files: [] })); changes.resolve(json(diff));
  await drain(); expect(panel.dataset.taskId).toBe('8'); expect(deepText(panel)).not.toContain('过期输入'); expect(deepText(panel)).not.toContain('new.js');
  const last = requests.findLast(row => row.url === '/api/worker/8'); disposeDetailRequests(); resetUiState(); expect(last.options.signal.aborted).toBe(true);
  expect(dom.node('error').textContent).toBe('');
});

test('连接名称仅内存公开投影；项目/boot 隔离、成功 action 失效早于 refresh；失败不伪造新鲜事实', async () => {
  expect(await loadConnectionNames()).toEqual([{ id: 'public', label: '名称' }]);
  await loadConnectionNames(); expect(requests.filter(row => row.url.endsWith('/connections'))).toHaveLength(1);
  const restore = registerNavigation({ refresh: () => Promise.reject(new Error('refresh failed')) });
  try {
    await expect(action('agent.connections.save', { connection: { label: '新名称' } })).rejects.toThrow('refresh failed');
    await loadConnectionNames(); expect(requests.filter(row => row.url.endsWith('/connections'))).toHaveLength(2);
    handler = ({ url }) => url === '/api/action' ? bad() : null;
    await expect(action('agent.connections.remove', { id: 'public' })).rejects.toThrow('offline');
    await loadConnectionNames(); expect(requests.filter(row => row.url.endsWith('/connections'))).toHaveLength(2);
    handler = null; await api('/api/host/settings/action', { method: 'POST', body: JSON.stringify({ method: 'agent.configure', params: {} }) });
    handler = ({ url }) => url.endsWith('/connections') ? bad() : null;
    await expect(loadConnectionNames()).rejects.toThrow('offline'); await expect(loadConnectionNames()).rejects.toThrow('offline');
    handler = null; dom.location.pathname = '/p/abcdef0123456789/'; await loadConnectionNames();
    expect(requests.at(-1).url).toBe('/p/abcdef0123456789/api/agent/connections');
    resetUiState(); await loadConnectionNames(); expect(requests.at(-1).url).toBe('/p/abcdef0123456789/api/agent/connections');
    dom.location.pathname = '/'; await loadConnectionNames(); expect(requests.at(-1).url).toBe('/api/agent/connections');
    for (const method of ['settings.clear_override', 'settings.migration.apply']) {
      const count = requests.filter(row => row.url.endsWith('/connections')).length;
      await action(method, {}, { refresh: false }); await loadConnectionNames();
      expect(requests.filter(row => row.url.endsWith('/connections'))).toHaveLength(count + 1);
    }
  } finally { restore(); }
});

test('显式历史分页沿用当前详情取消信号，复用按钮刷新后重新绑定且取消不 toast', async () => {
  let older = deferred();
  handler = ({ url }) => url.includes('/history-page?') ? older.promise : url.endsWith('/history-page') ? json({ events: [], cursor: 10, truncated: true }) : null;
  await loadDetail(7); await drain(); const more = panel.querySelector('.result-history').querySelector('button');
  const reading = more.onclick(); await drain(); const first = requests.findLast(row => row.url.includes('/history-page?'));
  expect(first.options.signal).toBeTruthy();
  await loadDetail(7); await drain(); expect(first.options.signal.aborted).toBe(true);
  expect(panel.querySelector('.result-history').querySelector('button')).toBe(more);
  older.resolve(json({ events: [], cursor: null, truncated: false })); await reading;
  older = deferred(); const next = more.onclick(); await drain();
  const current = requests.findLast(row => row.url.includes('/history-page?')); expect(current.options.signal.aborted).toBe(false);
  activateDetailView({ view: 'settings' }); expect(current.options.signal.aborted).toBe(true);
  older.resolve(json({ events: [], cursor: null, truncated: false })); await next;
  expect(dom.node('error').textContent).toBe('');
});

test('已打开阅读器的终态尾读也继承取消，迟到不改 cache；隐式信号仅作用同步 GET 不污染写/其他读取', async () => {
  const tail = deferred();
  handler = ({ url }) => url === '/api/worker/7' ? json({ ...task(7), status: 'completed' }) : url.includes('/transcript') ? tail.promise : null;
  const cache = { steps: [], next: 1, settled: false, order: 'desc' }; transcriptCache.set(7, cache); transcriptOpen.add(7);
  await loadDetail(7); await drain(); const request = requests.find(row => row.url.includes('/transcript'));
  expect(request.options.signal).toBeTruthy(); activateDetailView({ view: 'settings' });
  expect(request.options.signal.aborted).toBe(true); tail.resolve(json({ steps: [{ seq: 2, body: 'obsolete' }], next: 2 })); await drain();
  expect(cache.steps).toEqual([]); expect(cache.next).toBe(1);
  transcriptCache.clear(); const initial = deferred();
  handler = ({ url }) => url === '/api/worker/7' ? json({ ...task(7), status: 'completed' })
    : url.endsWith('/usage') ? json({ files: ['session'] }) : url.includes('/transcript') ? initial.promise : null;
  await loadDetail(7); await drain(); const initialRead = requests.findLast(row => row.url.includes('/transcript'));
  activateDetailView({ view: 'settings' }); expect(initialRead.options.signal.aborted).toBe(true);
  initial.resolve(json({ steps: [{ seq: 1, body: 'late initial' }], next: 1 })); await drain(); expect(transcriptCache.has(7)).toBe(false);
  handler = null; requests = []; const controller = new AbortController();
  await withReadSignal(controller.signal, () => api('/api/action', { method: 'POST', body: JSON.stringify({ method: 'worker.resume' }) }));
  expect(requests[0].options.signal).toBeUndefined();
  await withReadSignal(controller.signal, () => api('/api/worker/8'));
  expect(requests[1].options.signal).toBe(controller.signal);
  await api('/api/worker/9'); expect(requests[2].options.signal).toBeUndefined();
  controller.abort();
  await expect(withReadSignal(controller.signal, () => api('/api/worker/10'))).rejects.toMatchObject({ name: 'AbortError' });
  expect(requests).toHaveLength(3);
});

test('loadHistory 兼容旧参数和旧 Host；取消不走 legacy fallback，也不重试写动作', async () => {
  handler = ({ url }) => url.endsWith('/history-page?before=12') ? bad() : null;
  expect((await loadHistory(7, 12)).has_more).toBe(false); expect(requests.map(row => row.url)).toEqual(['/api/worker/7/history-page?before=12', '/api/worker/7/history?after=0']);
  requests = []; const fallback = deferred(), controller = new AbortController();
  handler = ({ url }) => url.includes('/history-page') ? bad() : fallback.promise;
  const reading = withReadSignal(controller.signal, () => loadHistory(7)); await drain();
  expect(requests.at(-1).url).toBe('/api/worker/7/history?after=0'); expect(requests.at(-1).options.signal).toBe(controller.signal);
  controller.abort(); fallback.resolve(json([])); await expect(reading).rejects.toMatchObject({ name: 'AbortError' });
  requests = []; handler = () => Promise.reject(new DOMException('cancelled', 'AbortError'));
  await expect(loadHistory(7)).rejects.toMatchObject({ name: 'AbortError' }); expect(requests).toHaveLength(1);
  requests = []; await expect(action('worker.resume', { id: 7 })).rejects.toMatchObject({ name: 'AbortError' });
  expect(requests).toHaveLength(1); expect(requests[0].options.method).toBe('POST');
});
