import { test, expect, afterAll } from 'bun:test';
import fs from 'node:fs';
import { installDom, deepText } from './project-dom.js';
import { makeWorld } from './dom-world.js';
import { until } from '../helpers.js';

const sha = char => char.repeat(40);
const commit = (char = 'a', tasks = []) => ({ commit: sha(char), short_commit: char.repeat(7), parents: [],
  subject: `提交 ${char}`, author: { name: '开发者' }, committed_at: '2026-10-02T09:00:00Z',
  association: tasks.length ? 'verified' : 'unassociated', tasks });
const task = { id: 12, worker_number: null, task_kind: 'order', goal: '开发版本迭代', input: { id: 7, content: '原始指令\n保留换行' }, evidence: 'task.merge_integrated', delivery_id: 71, delivery_available: true, delivery_unavailable_reason: null };
const fixture = () => ({ scope: 'main', branch: 'main', base: null, worker: null, delivery: null, tip: sha('a'), commits: [commit('a', [task]), commit('b')], cursor: 'opaque +/cursor', has_more: true });
const json = data => ({ ok: true, json: async () => data });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const world = makeWorld(), paths = [];
let data = fixture(), intercept = null;
const dom = installDom({ fetch: (url, options) => {
  if (String(url).includes('/api/version-graph')) { paths.push(String(url)); return intercept?.(String(url)) ?? Promise.resolve(json(data)); }
  return world.fetchImpl(url, options);
} });
dom.document.createElementNS = (_namespace, tag) => dom.document.createElement(tag);
const { ui, resetUiState } = await import('../../src/ui/web/assets/state.js');
const { openVersions, renderVersionCommit } = await import('../../src/ui/web/assets/render-versions.js');
const { activateDetailView } = await import('../../src/ui/web/assets/sidebar-ui.js');
const { registerNavigation } = await import('../../src/ui/web/assets/navigate.js');
const { boot } = await import('../../src/ui/web/assets/app.js');
await boot();
afterAll(() => dom.restore());
const text = () => deepText(dom.node('detail'));
const refresh = () => dom.node('detail').querySelector('.versions-refresh');
const more = () => dom.node('detail').querySelector('.versions-more');
const mode = () => dom.node('detail').querySelector('.versions-mode').querySelector('input');
const toggleMode = detailed => { mode().checked = detailed; mode().onchange(); };
const details = () => dom.node('detail').querySelectorAll('.version-detail');
const reset = () => { intercept = null; data = fixture(); activateDetailView({ view: 'overview' }); };
const selected = () => [...['overview', 'task-graph', 'versions', 'agent-status', 'settings', 'docs'].map(key => [key, dom.node(`${key}-open`)]), ...ui.navButtons]
  .filter(([, node]) => node.classList.contains('selected')).map(([key]) => key);

test('版本迭代平级导航、hash、页面身份、移动端与只读轮询隔离', async () => {
  reset(); dom.node('sidebar').classList.add('mobile-open'); const before = paths.length;
  await dom.node('versions-open').onclick();
  expect(selected()).toEqual(['versions']); expect(dom.location.hash).toBe('#versions');
  expect(dom.node('versions-open').getAttribute('aria-current')).toBe('page');
  expect(dom.node('view-title').textContent).toBe('版本迭代'); expect(dom.node('view-context').textContent).toBe('工作');
  expect(dom.node('resource-panels').hidden).toBe(true); expect(dom.node('detail').hidden).toBe(false);
  expect(dom.node('sidebar').classList.contains('mobile-open')).toBe(false);
  expect(text()).toContain(sha('a')); expect(text()).toContain('2026-10-02T09:00:00Z'); expect(text()).toContain('开发者');
  expect(text()).toContain('查看 Worker #12'); expect(text()).toContain('开发版本迭代'); expect(text()).toMatch(/原始指令\s+O7/); expect(dom.node('detail').querySelector('.record-link').getAttribute('href')).toBe('#input-input-7');
  expect(text()).toContain('原始指令\n保留换行'); expect(text()).toContain('未关联 Worker');
  expect(refresh().getAttribute('data-help')).toContain('不启动 Agent');
  expect(dom.node('detail').querySelectorAll('.agent-call')).toHaveLength(0);
  const content = text(), pushes = dom.pushed(); await openVersions();
  await dom.intervalFor(1500)(); await dom.intervalFor(3000)();
  expect(paths.length).toBe(before + 1); expect(text()).toBe(content); expect(dom.pushed()).toBe(pushes);
  dom.location.hash = '#workers'; await dom.fire('hashchange'); expect(selected()).toEqual(['tasks']);
  dom.location.hash = '#versions'; await dom.fire('hashchange'); expect(selected()).toEqual(['versions']);
  expect(paths.length).toBe(before + 2);
});

test('默认简易模式只留摘要、时间和追溯入口；详情切换不发请求、不重建卡片', async () => {
  reset(); await openVersions(); const before = paths.length;
  const page = dom.node('detail').querySelector('.versions-page');
  const cards = dom.node('detail').querySelectorAll('.version-commit');
  expect(mode().type).toBe('checkbox'); expect(mode().checked).toBe(false);
  expect(page.classList.contains('versions-detailed')).toBe(false);
  expect(details().every(node => node.hidden)).toBe(true);
  expect(cards[0].querySelector('h2').hidden).toBe(false);
  expect(cards[0].querySelector('time').hidden).toBe(false);
  expect(cards[0].querySelector('.version-task-link').hidden).toBe(false);
  expect(cards[1].querySelector('.version-unassociated').hidden).toBe(false);
  toggleMode(true);
  expect(page.classList.contains('versions-detailed')).toBe(true);
  expect(details().every(node => !node.hidden)).toBe(true);
  const input = cards[0].querySelector('.version-input'); input.open = true;
  toggleMode(false); expect(input.hidden).toBe(true);
  toggleMode(true); expect(input.open).toBe(true); expect(input.hidden).toBe(false);
  expect(dom.node('detail').querySelectorAll('.version-commit')).toEqual(cards);
  expect(paths.length).toBe(before); expect(ui.versionsPage.count).toBe(2);
});

test('分页、刷新和失败保留当前模式；离页重新进入默认简易模式', async () => {
  reset(); await openVersions(); toggleMode(true);
  data = { ...fixture(), commits: [commit('c', [task])], cursor: null, has_more: false };
  await more().onclick(); expect(details().every(node => !node.hidden)).toBe(true);
  await refresh().onclick(); expect(mode().checked).toBe(true);
  expect(details().every(node => !node.hidden)).toBe(true);
  intercept = () => Promise.reject(new Error('测试模式读取失败'));
  await refresh().onclick(); expect(mode().checked).toBe(true);
  toggleMode(false); expect(details().every(node => node.hidden)).toBe(true);
  expect(text()).toContain('读取失败');
  reset(); await openVersions(); expect(mode().checked).toBe(false);
});

test('读取期间切换按响应到达时的模式展示，不改变请求身份与游标', async () => {
  reset(); const first = deferred(); intercept = () => first.promise;
  const opening = openVersions(); toggleMode(true);
  first.resolve(json(fixture())); await opening;
  expect(details().every(node => !node.hidden)).toBe(true);
  const pending = deferred(); intercept = () => pending.promise;
  const cursor = ui.versionsPage.cursor, before = paths.length;
  const paging = more().onclick(); toggleMode(false);
  pending.resolve(json({ ...fixture(), commits: [commit('c', [task])], cursor: null, has_more: false }));
  await paging;
  expect(paths.length).toBe(before + 1); expect(paths.at(-1)).toContain(encodeURIComponent(cursor));
  expect(details().every(node => node.hidden)).toBe(true);
  expect(dom.node('detail').querySelectorAll('.version-commit')).toHaveLength(3);
});

test('输入框创建或立即开始后留在版本页，保留模式、历史卡片和指令展开状态', async () => {
  reset(); await openVersions(); const before = paths.length;
  const view = ui.view, state = ui.versionsPage, cards = dom.node('detail').querySelectorAll('.version-commit');
  const order = cards[0].querySelector('.version-input'); order.open = true;
  for (const detailed of [false, true]) for (const ctrl of [false, true]) {
    toggleMode(detailed);
    const input = dom.node('input'); input.value = '从版本页发射，不打断历史阅读'; input.oninput(); input.focus();
    await input.onkeydown({ key: 'Enter', ctrlKey: ctrl, metaKey: !ctrl, preventDefault() {} });
    await until(() => !ui.busy); await Promise.resolve();
    expect(world.state.actions.at(-1)).toMatchObject({ method: 'input.emit', params: { content: '从版本页发射，不打断历史阅读' } });
    expect(ui.view).toBe(view); expect(dom.location.hash).toBe('#versions');
    expect(ui.versionsPage).toBe(state); expect(mode().checked).toBe(detailed);
    expect(dom.node('detail').querySelectorAll('.version-commit')).toEqual(cards);
    expect(order.open).toBe(true); expect(order.hidden).toBe(!detailed);
    expect(input.value).toBe(''); expect(document.activeElement).toBe(input);
    expect(paths.length).toBe(before);
  }
});

test('固定 tip 游标分页，重复 Task 的不同交付保留，刷新替换历史', async () => {
  reset(); await openVersions();
  data = { ...fixture(), commits: [commit('c', [task])], cursor: null, has_more: false };
  await more().onclick();
  expect(paths.at(-1)).toContain(`cursor=${encodeURIComponent('opaque +/cursor')}`);
  expect(dom.node('detail').querySelectorAll('.version-commit')).toHaveLength(3);
  expect(dom.node('detail').querySelectorAll('.version-task-link')).toHaveLength(2);
  expect(text()).toContain('已显示 3 条'); expect(more().hidden).toBe(true);
  data = { ...fixture(), tip: sha('d'), commits: [commit('d')], cursor: null, has_more: false };
  await refresh().onclick();
  expect(paths.at(-1)).toBe('/api/version-graph?limit=50');
  expect(dom.node('detail').querySelectorAll('.version-commit')).toHaveLength(1); expect(text()).not.toContain('提交 c');
  expect(text()).toContain(sha('d')); expect(more().hidden).toBe(true);
});

test('跳 Task 详情经过导航接缝，不启动 Agent', async () => {
  reset(); await openVersions(); let opened;
  const restore = registerNavigation({ detail: async id => { opened = id; } });
  try { await dom.node('detail').querySelector('.version-task-link').onclick(); expect(opened).toBe(12); }
  finally { restore(); }
});

test('无 main 和读取失败明确区分；首屏失败、分页失败与旧历史刷新失败可重试', async () => {
  reset(); data = { ...fixture(), tip: null, commits: [], cursor: null, has_more: false }; await openVersions();
  expect(text()).toContain('尚无 main 分支'); expect(more().hidden).toBe(true);
  reset(); intercept = () => Promise.reject(new Error('测试连接失败')); await openVersions();
  expect(text()).toContain('读取失败：测试连接失败'); expect(text()).not.toContain('尚无 main 分支');
  expect(refresh().textContent).toBe('重试读取');
  intercept = null; await refresh().onclick(); expect(text()).toContain('提交 a');
  intercept = () => Promise.reject(new Error('测试分页失败')); await more().onclick();
  expect(text()).toContain('已加载记录保留'); expect(more().textContent).toBe('重试加载更早版本'); expect(more().disabled).toBe(false);
  const failedCursor = paths.at(-1); intercept = null; data = { ...fixture(), commits: [commit('c')], cursor: null, has_more: false };
  await more().onclick(); expect(paths.at(-1)).toBe(failedCursor); expect(text()).toContain('提交 c');
  intercept = () => Promise.reject(new Error('测试刷新失败')); await refresh().onclick();
  expect(text()).toContain('旧历史'); expect(text()).toContain('提交 c');
  expect(dom.node('detail').querySelector('.versions-feedback').getAttribute('role')).toBe('alert');
  intercept = null; await refresh().onclick(); expect(text()).not.toContain('读取失败');
});

test('游标失效明确引导刷新，保留旧历史且不自动续接新快照', async () => {
  reset(); await openVersions(); const before = paths.length;
  intercept = () => Promise.resolve({ ok: false, json: async () => ({ error: '版本历史游标已失效' }) });
  await more().onclick();
  expect(paths.length).toBe(before + 1); expect(text()).toContain('游标已失效');
  expect(text()).toContain('请刷新历史从当前图第一页重新读取'); expect(text()).toContain('提交 a');
  expect(ui.versionsPage.tip).toBe(sha('a')); expect(ui.versionsPage.cursor).toBe('opaque +/cursor');
  intercept = null; data = { ...fixture(), tip: sha('d'), commits: [commit('d')], cursor: null, has_more: false };
  await refresh().onclick();
  expect(paths.at(-1)).toBe('/api/version-graph?limit=50'); expect(text()).toContain('提交 d'); expect(text()).not.toContain('提交 a');
});

test('分页期间刷新作废旧响应；旧请求不清除新请求状态；多次刷新只采用最新结果', async () => {
  reset(); await openVersions(); const old = deferred(), fresh = deferred();
  intercept = url => url.includes('cursor=') ? old.promise : fresh.promise;
  const paging = more().onclick(), refreshing = refresh().onclick();
  old.resolve(json({ ...fixture(), commits: [commit('c')] })); await paging;
  expect(text()).not.toContain('提交 c'); expect(dom.node('detail').querySelector('.versions-page').getAttribute('aria-busy')).toBe('true');
  fresh.resolve(json({ ...fixture(), tip: sha('d'), commits: [commit('d')], cursor: null, has_more: false })); await refreshing;
  expect(text()).toContain('提交 d'); expect(text()).not.toContain('提交 a');
  const first = deferred(), second = deferred(); let calls = 0; intercept = () => (++calls === 1 ? first.promise : second.promise);
  const one = refresh().onclick(), two = refresh().onclick();
  second.resolve(json({ ...fixture(), commits: [commit('e')] })); await two;
  first.resolve(json({ ...fixture(), commits: [commit('f')] })); await one;
  expect(text()).toContain('提交 e'); expect(text()).not.toContain('提交 f');
});

test('离页、返回和 boot 复位后的迟到响应不覆盖当前页面', async () => {
  reset(); const late = deferred(); intercept = () => late.promise; const opening = openVersions();
  await dom.node('overview-open').onclick(); late.resolve(json({ ...fixture(), commits: [commit('c')] })); await opening;
  expect(selected()).toEqual(['overview']); expect(text()).not.toContain('提交 c');
  const stale = deferred(); intercept = () => stale.promise; const old = openVersions();
  activateDetailView({ view: 'overview' }); intercept = null; await openVersions();
  stale.resolve(json({ ...fixture(), commits: [commit('d')] })); await old;
  expect(text()).toContain('提交 a'); expect(text()).not.toContain('提交 d');
  const bootLate = deferred(); activateDetailView({ view: 'overview' }); intercept = () => bootLate.promise; const obsolete = openVersions();
  resetUiState(); activateDetailView({ view: 'settings' }); dom.node('detail').replaceChildren(document.createTextNode('新页面'));
  bootLate.resolve(json(fixture())); await obsolete; expect(text()).toBe('新页面');
});

test('请求带项目路由前缀；不信任分页 tip 变化与不兼容数据', async () => {
  reset(); dom.location.pathname = '/p/0123456789abcdef/';
  try { await openVersions(); expect(dom.requests.filter(row => row.path.includes('/api/version-graph')).at(-1).path).toBe('/p/0123456789abcdef/api/version-graph?limit=50'); }
  finally { dom.location.pathname = '/p/aaaaaaaaaaaaaaaa/'; }
  data = { ...fixture(), tip: sha('d'), commits: [commit('d')] }; await more().onclick();
  expect(text()).toContain('分页基线发生变化'); expect(text()).not.toContain('提交 d');
  data = { error: 'invalid' }; await refresh().onclick(); expect(text()).toContain('数据格式不兼容');
});

test('重复点击分页单飞；文本安全渲染、未核实关联与明确截断提示', async () => {
  reset(); await openVersions(); const pending = deferred(); intercept = () => pending.promise;
  const before = paths.length; const first = more().onclick(), second = more().onclick();
  expect(paths.length).toBe(before + 1);
  pending.resolve(json({ ...fixture(), commits: [], cursor: null, has_more: false })); await Promise.all([first, second]);
  const html = '<img src=x onerror=alert(1)>', malicious = { ...commit('c', [{ ...task, goal: html, goal_truncated: true, input: { id: 7, content: html, truncated: true } }]), subject: html, author: { name: html }, subject_truncated: true };
  const node = renderVersionCommit(malicious);
  expect(deepText(node)).toContain(html); expect(node.querySelectorAll('img')).toHaveLength(0);
  expect(deepText(node)).toContain('已截断');
  const unrelated = renderVersionCommit({ ...malicious, association: 'unassociated' });
  expect(deepText(unrelated)).toContain('未关联 Worker'); expect(unrelated.querySelectorAll('.version-task-link')).toHaveLength(0);
});

test('HTML 工作导航和样式入口、响应式与双主题 token 静态约束', () => {
  const html = fs.readFileSync('src/ui/web/assets/index.html', 'utf8');
  expect(html).toContain('id="versions-open"'); expect(html).toContain('href="/styles-versions.css"');
  expect(html.indexOf('id="versions-open"')).toBeLessThan(html.indexOf('<span>设备设置与帮助</span>'));
  const css = fs.readFileSync('src/ui/web/assets/styles-versions.css', 'utf8');
  expect(css).toContain('@media(max-width:640px)'); expect(css).toContain('var(--panel)'); expect(css).toContain('overflow-wrap:anywhere');
  expect(css).toContain('.version-node:focus-visible'); expect(css).toContain('minmax(0,1fr)');
});

const node = index => dom.node('detail').querySelectorAll('.version-node')[index ?? 0];
const back = () => dom.node('detail').querySelector('.versions-back');
const mainButton = () => dom.node('detail').querySelector('.versions-main');
const deliveryPage = (delivery = 71, worker = task, commits = [commit('c', [{ ...task, evidence: 'delivery.source', delivery_available: false, delivery_id: null }])]) => ({
  scope: 'delivery', branch: 'lush/worker', tip: sha('c'), base: sha('b'), worker, delivery, commits, cursor: null, has_more: false,
});

test('节点以真实父边绘制分叉汇合；短SHA可见，范围外父明确标记，分页展开边界', async () => {
  reset(); data = { ...fixture(), commits: [
    { ...commit('a', [task]), parents: [sha('b'), sha('c')] },
    { ...commit('b'), parents: [sha('d')] },
  ] };
  await openVersions();
  const firstCards = dom.node('detail').querySelectorAll('.version-commit');
  expect(firstCards[0].querySelector('.version-short-sha').textContent).toBe('aaaaaaa');
  expect(node().tagName).toBe('BUTTON'); expect(node().getAttribute('aria-label')).toContain('提交 aaaaaaa');
  expect(node().getAttribute('data-help')).toContain('不调用 Agent');
  expect(dom.node('detail').querySelectorAll('.version-edge-boundary').length).toBeGreaterThan(0);
  expect(text()).toContain('父提交尚未加载'); expect(text()).toContain(sha('c')); expect(text()).toContain(sha('d'));
  data = { ...fixture(), commits: [{ ...commit('c'), parents: [sha('d')] }, commit('d')], cursor: null, has_more: false };
  await more().onclick();
  expect(dom.node('detail').querySelectorAll('.version-commit').slice(0, 2)).toEqual(firstCards);
  expect(dom.node('detail').querySelectorAll('.version-edge-boundary')).toHaveLength(0);
  expect(dom.node('detail').querySelector('.version-boundaries').hidden).toBe(true);
  expect(dom.node('detail').querySelectorAll('.version-edge').some(edge => edge.getAttribute('d').includes(' C '))).toBe(true);
});

test('固定交付节点下钻、多级子交付，返回复用卡片/模式/原始指令展开且不重读', async () => {
  reset(); data = { ...fixture(), commits: [commit('a', [{ ...task, worker_number: 'W215' }]), commit('b')] };
  await openVersions(); toggleMode(true);
  const cards = dom.node('detail').querySelectorAll('.version-commit'), order = cards[0].querySelector('.version-input'); order.open = true;
  const child = { ...task, id: 18, worker_number: 'W215-2', delivery_id: 81, goal: '子交付' };
  data = deliveryPage(71, { ...task, worker_number: 'W215' }, [commit('c', [child])]);
  await node().onclick();
  expect(paths.at(-1)).toBe('/api/version-graph?limit=50&delivery=71');
  expect(text()).toContain('Worker W215 · 固定交付图'); expect(mode().checked).toBe(true);
  expect(back().hidden).toBe(false); expect(mainButton().hidden).toBe(false);
  expect(details().every(detail => !detail.hidden)).toBe(true);
  data = deliveryPage(81, child, [commit('d', [{ ...child, delivery_available: false }])]);
  await node().onclick(); expect(paths.at(-1)).toContain('&delivery=81'); expect(text()).toContain('Worker W215-2 · 固定交付图');
  const before = paths.length; await back().onclick(); expect(text()).toContain('子交付');
  await back().onclick(); expect(dom.node('detail').querySelectorAll('.version-commit')).toEqual(cards);
  expect(order.open).toBe(true); expect(order.hidden).toBe(false); expect(mode().checked).toBe(true);
  expect(paths.length).toBe(before); expect(back().hidden).toBe(true);
});

test('返回main跳过中层缓存，main分页快照保留，不启动Agent', async () => {
  reset(); await openVersions(); data = { ...fixture(), commits: [commit('d')], cursor: null, has_more: false }; await more().onclick();
  const mainCards = dom.node('detail').querySelectorAll('.version-commit');
  data = deliveryPage(); await node().onclick(); const before = paths.length;
  await mainButton().onclick(); expect(paths.length).toBe(before);
  expect(dom.node('detail').querySelectorAll('.version-commit')).toEqual(mainCards);
  expect(ui.versionsPage.count).toBe(3); expect(more().hidden).toBe(true);
  expect(world.state.actions.filter(action => /version|graph|delivery/.test(action.method))).toHaveLength(0);
});

test('多个关联节点显示明确Worker选择，编号不从ID推导，未知编号回退#id', async () => {
  reset(); const other = { ...task, id: 99, worker_number: 'W12-8', delivery_id: 82 };
  data = { ...fixture(), commits: [commit('a', [task, other])] }; await openVersions();
  const before = paths.length; await node().onclick(); expect(paths.length).toBe(before);
  expect(node().getAttribute('aria-expanded')).toBe('true');
  expect(dom.node('detail').querySelector('.version-delivery-choices').hidden).toBe(false);
  const choices = dom.node('detail').querySelectorAll('.version-delivery-choice');
  expect(choices.map(choice => choice.textContent)).toEqual(['交付图 · #12', '交付图 · W12-8']);
  expect(document.activeElement).toBe(choices[0]);
  data = deliveryPage(82, other); await choices[1].onclick(); expect(paths.at(-1)).toContain('&delivery=82');
  expect(text()).toContain('Worker W12-8 · 固定交付图');
});

test('无证据、缺基线与固定范围普通提交只解释，不猜测或自递归', async () => {
  reset(); await openVersions(); const before = paths.length;
  await node(1).onclick(); expect(text()).toContain('无法查看 Worker 交付图'); expect(paths.length).toBe(before);
  data = { ...fixture(), commits: [commit('a', [{ ...task, delivery_available: false, delivery_unavailable_reason: '历史交付缺少固定基线' }])] };
  await refresh().onclick(); const loaded = paths.length;
  await node().onclick(); expect(paths.length).toBe(loaded); expect(text()).toContain('历史交付缺少固定基线');
  data = deliveryPage();
  reset(); await openVersions(); data = deliveryPage(); await node().onclick(); const own = paths.length;
  await node().onclick(); expect(paths.length).toBe(own); expect(text()).toContain('没有可继续下钻的独立交付记录');
});

test('普通源节点允许delivery.source和null事件ID，保留Worker详情但绝不下钻自己', async () => {
  reset(); await openVersions(); data = deliveryPage(); await node().onclick();
  const before = paths.length, cards = dom.node('detail').querySelectorAll('.version-commit');
  expect(text()).not.toContain('数据格式不兼容'); expect(cards).toHaveLength(1);
  expect(cards[0].querySelector('.version-task-link').textContent).toBe('查看 Worker #12');
  await node().onclick(); expect(paths.length).toBe(before);
  expect(text()).toContain('没有可继续下钻的独立交付记录');
  expect(ui.versionsPage.active.delivery).toBe(71);
  let opened; const restore = registerNavigation({ detail: async id => { opened = id; } });
  try { await cards[0].querySelector('.version-task-link').onclick(); expect(opened).toBe(12); }
  finally { restore(); }
});

test('精确关联的历史merged只有详情追溯，delivery_available:false覆盖有效事件ID', async () => {
  reset(); data = { ...fixture(), commits: [commit('a', [{ ...task, evidence: 'merged', delivery_id: 66,
    delivery_available: false, delivery_unavailable_reason: '历史交付没有可靠父侧基线，无法打开固定交付图' }])] };
  await openVersions(); const before = paths.length;
  expect(dom.node('detail').querySelectorAll('.version-task-link')).toHaveLength(1);
  await node().onclick(); expect(paths.length).toBe(before);
  expect(text()).toContain('历史交付没有可靠父侧基线');
  expect(ui.versionsPage.active.delivery).toBe(null);
});

test('交付图分页、刷新固定Event；tip/base/branch变更拒绝，失败保留旧图', async () => {
  reset(); await openVersions(); data = { ...deliveryPage(), has_more: true, cursor: 'delivery +/page' };
  await node().onclick(); const cards = dom.node('detail').querySelectorAll('.version-commit');
  data = { ...deliveryPage(), commits: [commit('d')], cursor: null, has_more: false };
  await more().onclick(); expect(paths.at(-1)).toBe(`/api/version-graph?limit=50&delivery=71&cursor=${encodeURIComponent('delivery +/page')}`);
  data = { ...deliveryPage(), has_more: true, cursor: 'delivery +/page' }; await refresh().onclick();
  expect(paths.at(-1)).toBe('/api/version-graph?limit=50&delivery=71');
  const refreshed = dom.node('detail').querySelectorAll('.version-commit');
  data = { ...deliveryPage(), base: sha('e'), commits: [commit('d')], cursor: null, has_more: false };
  await more().onclick(); expect(text()).toContain('分页基线发生变化'); expect(dom.node('detail').querySelectorAll('.version-commit')).toEqual(refreshed);
  intercept = () => Promise.reject(new Error('Git对象已回收')); await refresh().onclick();
  expect(text()).toContain('Git对象已回收'); expect(text()).toContain('旧历史'); expect(text()).toContain('提交 c');
  expect(cards).toHaveLength(1);
});

test('下钻首屏失败可以返回父图；不自动请求当前Worker分支', async () => {
  reset(); await openVersions(); const cards = dom.node('detail').querySelectorAll('.version-commit');
  intercept = () => Promise.reject(new Error('交付源对象不可用'));
  await node().onclick(); expect(text()).toContain('无法追溯此次交付'); expect(text()).toContain('不会改看 Worker 当前分支');
  expect(dom.node('detail').querySelectorAll('.version-commit')).toHaveLength(0);
  const before = paths.length; await back().onclick(); expect(paths.length).toBe(before);
  expect(dom.node('detail').querySelectorAll('.version-commit')).toEqual(cards);
});

test('返回main后迟到下钻不覆盖缓存图；回到同一个Frame旧分页仍被身份作废', async () => {
  reset(); await openVersions(); const delayed = deferred(); intercept = () => delayed.promise;
  const opening = node().onclick(); const before = paths.length;
  await mainButton().onclick(); delayed.resolve(json(deliveryPage())); await opening;
  expect(paths.length).toBe(before); expect(text()).toContain('main 提交图'); expect(text()).not.toContain('提交 c');
  const old = deferred(); intercept = () => old.promise; const paging = more().onclick();
  intercept = null; data = deliveryPage(); await node().onclick(); await back().onclick();
  old.resolve(json({ ...fixture(), commits: [commit('f')], cursor: null, has_more: false })); await paging;
  expect(text()).not.toContain('提交 f'); expect(ui.versionsPage.cursor).toBe('opaque +/cursor'); expect(more().disabled).toBe(false);
});

test('图间往返保留桌面/页面滚动位置和节点焦点', async () => {
  reset(); await openVersions();
  dom.document.scrollingElement = dom.document.body;
  const marker = node(); marker.focus(); dom.node('detail').scrollTop = 860; dom.document.body.scrollTop = 430;
  data = deliveryPage(); await marker.onclick();
  expect(dom.node('detail').scrollTop).toBe(0); expect(dom.document.body.scrollTop).toBe(0);
  expect(document.activeElement).toBe(dom.node('detail').querySelector('.versions-scope'));
  dom.node('detail').scrollTop = 120; await back().onclick();
  expect(dom.node('detail').scrollTop).toBe(860); expect(dom.document.body.scrollTop).toBe(430);
  expect(document.activeElement).toBe(marker); delete dom.document.scrollingElement;
});

test('交付响应范围不符、重复节点与非拓扑顺序不污染已读图', async () => {
  reset(); await openVersions(); const before = dom.node('detail').querySelectorAll('.version-commit');
  data = deliveryPage(); await refresh().onclick(); expect(text()).toContain('数据格式不兼容');
  data = { ...fixture(), commits: [commit('a'), commit('a')] }; await refresh().onclick(); expect(text()).toContain('重复提交');
  data = { ...fixture(), commits: [commit('a'), { ...commit('b'), parents: [sha('a')] }] }; await refresh().onclick(); expect(text()).toContain('拓扑顺序');
  expect(dom.node('detail').querySelectorAll('.version-commit')).toEqual(before);
});
