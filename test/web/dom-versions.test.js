import { test, expect, afterAll } from 'bun:test';
import fs from 'node:fs';
import { installDom, deepText } from '../dom-stub.js';
import { makeWorld } from './dom-world.js';

const sha = char => char.repeat(40);
const commit = (char = 'a', tasks = []) => ({ commit: sha(char), short_commit: char.repeat(7), parents: [],
  subject: `提交 ${char}`, author: { name: '开发者' }, committed_at: '2026-10-02T09:00:00Z',
  association: tasks.length ? 'verified' : 'unassociated', tasks });
const task = { id: 12, task_kind: 'say', goal: '开发版本迭代', input: { id: 7, content: '原始 say\n保留换行' }, evidence: 'task.merge_integrated' };
const fixture = () => ({ branch: 'main', tip: sha('a'), commits: [commit('a', [task]), commit('b')], cursor: 'opaque +/cursor', has_more: true });
const json = data => ({ ok: true, json: async () => data });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const world = makeWorld(), paths = [];
let data = fixture(), intercept = null;
const dom = installDom({ fetch: (url, options) => {
  if (String(url).includes('/api/versions')) { paths.push(String(url)); return intercept?.(String(url)) ?? Promise.resolve(json(data)); }
  return world.fetchImpl(url, options);
} });
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
  expect(text()).toContain('查看 Task #12'); expect(text()).toContain('开发版本迭代'); expect(text()).toContain('原始 say #7');
  expect(text()).toContain('原始 say\n保留换行'); expect(text()).toContain('未关联 Task');
  expect(refresh().getAttribute('data-help')).toContain('不启动 Agent');
  expect(dom.node('detail').querySelectorAll('.agent-call')).toHaveLength(0);
  const content = text(), pushes = dom.pushed(); await openVersions();
  await dom.intervalFor(1500)(); await dom.intervalFor(3000)();
  expect(paths.length).toBe(before + 1); expect(text()).toBe(content); expect(dom.pushed()).toBe(pushes);
  dom.location.hash = '#tasks'; await dom.fire('hashchange'); expect(selected()).toEqual(['tasks']);
  dom.location.hash = '#versions'; await dom.fire('hashchange'); expect(selected()).toEqual(['versions']);
  expect(paths.length).toBe(before + 2);
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
  expect(paths.at(-1)).toBe('/api/versions?limit=50');
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
  reset(); data = { branch: 'main', tip: null, commits: [], cursor: null, has_more: false }; await openVersions();
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
  expect(text()).toContain('请刷新历史从最新 main 重新读取'); expect(text()).toContain('提交 a');
  expect(ui.versionsPage.tip).toBe(sha('a')); expect(ui.versionsPage.cursor).toBe('opaque +/cursor');
  intercept = null; data = { ...fixture(), tip: sha('d'), commits: [commit('d')], cursor: null, has_more: false };
  await refresh().onclick();
  expect(paths.at(-1)).toBe('/api/versions?limit=50'); expect(text()).toContain('提交 d'); expect(text()).not.toContain('提交 a');
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
  await dom.node('settings-open').onclick(); late.resolve(json({ ...fixture(), commits: [commit('c')] })); await opening;
  expect(selected()).toEqual(['settings']); expect(text()).not.toContain('提交 c');
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
  try { await openVersions(); expect(paths.at(-1)).toBe('/p/0123456789abcdef/api/versions?limit=50'); }
  finally { dom.location.pathname = '/'; }
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
  expect(deepText(unrelated)).toContain('未关联 Task'); expect(unrelated.querySelectorAll('.version-task-link')).toHaveLength(0);
});

test('HTML 工作导航和样式入口、响应式与双主题 token 静态约束', () => {
  const html = fs.readFileSync('src/ui/web/assets/index.html', 'utf8');
  expect(html).toContain('id="versions-open"'); expect(html).toContain('href="/styles-versions.css"');
  expect(html.indexOf('id="versions-open"')).toBeLessThan(html.indexOf('<span>其他</span>'));
  const css = fs.readFileSync('src/ui/web/assets/styles-versions.css', 'utf8');
  expect(css).toContain('@media(max-width:640px)'); expect(css).toContain('var(--panel)'); expect(css).toContain('overflow-wrap:anywhere');
});
