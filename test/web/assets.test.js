import { test, expect } from 'bun:test';
import { fetch, pageSource, setup } from './harness.js';

// asset 模块可服务、CSP 头、白名单外 404、排序下拉接线。

test('web serves the live-refresh and batch-merge modules alongside app.js', async () => {
  const f = await setup();
  try {
    for (const file of ['/live.js', '/merge-select.js', '/sidebar.js']) {
      const response = await fetch(f.url + file);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-security-policy')).toContain("script-src 'self'");
    }
    expect(await (await fetch(f.url + '/live.js')).text()).toContain('export async function liveTick');
    expect(await (await fetch(f.url + '/merge-select.js')).text()).toContain('export function mergeCandidates');
    // 左栏折叠 / 快速导航 / 筛选的纯逻辑模块也必须在白名单里，否则浏览器加载 app.js 时 import 404。
    expect(await (await fetch(f.url + '/sidebar.js')).text()).toContain('export function filterTasks');
    const app = await pageSource(f.url);
    expect(app).toContain("from './live.js'");
    expect(app).toContain("from './merge-select.js'");
    expect(app).toContain("from './sidebar.js'");
    // 白名单之外仍然 404。
    expect((await fetch(f.url + '/live.mjs')).status).toBe(404);
  } finally { await f.close(); }
});

test('studio styles provide dual themes, readable headings and reduced-motion support', async () => {
  const f = await setup();
  try {
    const css = await (await fetch(f.url + '/styles.css')).text();
    expect(css).toContain('.section-title .side-name{color:var(--muted);font-size:14px');
    expect(css).toContain('.section-title h2{color:var(--text);font-size:15px');
    expect(css).toContain(':root[data-theme="dark"]');
    expect(css).toContain('color-scheme:light');
    expect(css).toContain('@media(prefers-reduced-motion:reduce)');
    expect(css).toContain('@media(max-width:760px)');
    // 分支图的工作态标识（在跑 / 在等 / 子树）与停下来分支的降噪 class 都在样式表里。
    expect(css).toContain('.graph-work.run{');
    expect(css).toContain('.graph-work.pending{');
    expect(css).toContain('.graph-work.subtree{');
    expect(css).toContain('.graph-branch.graph-idle{');
    // 待决 notice 的决策区画在分支图的任务行里，样式必须与 render-graph.js 一起在。
    expect(css).toContain('.graph-node.graph-emphasis-awaiting{');
    expect(css).toContain('.graph-decision{flex-basis:100%');
    expect(css).toContain('.graph-decision-body{');
    const html = await (await fetch(f.url)).text();
    expect(html.indexOf('/appearance.js')).toBeLessThan(html.indexOf('/styles.css'));
    expect(html).toContain('id="theme-toggle"');
    expect((await fetch(f.url + '/appearance.js')).status).toBe(200);
    // 应用内弹窗（dialog.js）要有落点：容器在页面里，样式在样式表里，否则确认框会画不出来。
    expect(html).toContain('id="modal"');
    expect(html).toContain('class="modal-root"');
    expect(css).toContain('.modal-root{position:fixed');
    expect(css).toContain('.modal-card{');
    // 消息提示从 composer 底部搬到页头下方的固定浮层：composer 与 .app 的 grid 不再被它撑高。
    expect(css).not.toContain('.composer #error');
    expect(css).toMatch(/\.toast\{position:fixed;[^}]*z-index:15/);
    expect(css).toContain('@keyframes toast-in');
    expect(html).toMatch(/<div id="toast"[^>]*class="toast"[^>]*>[\s\S]*id="error"/);
    expect(html).toContain('id="toast-close"');
    // 结构上确认：composer 到 </form> 就收口，浮层在整个 .app 之外，不再参与 grid 行。
    expect(html).toMatch(/<div class="composer">[\s\S]*?<\/form><\/div>\s*<\/div>\s*<div id="toast"/);
    expect(html.indexOf('id="toast"')).toBeLessThan(html.indexOf('id="modal"'));
  } finally { await f.close(); }
});

test('消息提示模块可服务，浮层落点与分层在页面里', async () => {
  const f = await setup();
  try {
    const module = await fetch(f.url + '/messages.js');
    expect(module.status).toBe(200);
    const source = await module.text();
    expect(source).toContain('export function show');
    expect(source).toContain('export function clear');
    expect(source).toContain('export function setTimers');
    const css = await (await fetch(f.url + '/styles.css')).text();
    const html = await (await fetch(f.url)).text();
    // #error 是浮层里的正文落点，仍是唯一的文本入口（id 与 textContent 语义不变）。
    expect(html).toContain('<p id="error"></p>');
    expect(html).not.toContain('id="error" role="alert"');
    // 浮层级低于应用内弹窗（15 < 20），但高于页头与侧栏。
    expect(css).toMatch(/\.toast\{position:fixed;[^}]*z-index:15/);
    expect(css).toMatch(/\.modal-root\{position:fixed;inset:0;z-index:20/);
  } finally { await f.close(); }
});

test('web serves the sort module and wires the left-column sort dropdown', async () => {
  const f = await setup();
  try {
    const module = await fetch(f.url+'/tree-order.js');
    expect(module.status).toBe(200);
    const source = await module.text();
    expect(source).toContain('export function orderSiblings');
    // 四个列表共用的排序函数也在同一个模块里，浏览器加载 app.js 时 import 不会 404
    expect(source).toContain('export function orderList');
    const app = await pageSource(f.url);
    expect(app).toContain('智能排序');
    expect(app).toContain('sidebar-sort');
    const html = await (await fetch(f.url)).text();
    expect(html).toContain('id="sidebar-sort"');
    expect(html).toContain('aria-label="左栏排序方式"');
    // 排序控件已经从行动任务区块移到左栏顶部，旧的 #tree-sort 不再存在
    expect(html).not.toContain('id="tree-sort"');
  } finally { await f.close(); }
});
