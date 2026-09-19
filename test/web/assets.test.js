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

test('styles.css enlarges sidebar section headings without touching detail block titles', async () => {
  const f = await setup();
  try {
    const css = await (await fetch(f.url + '/styles.css')).text();
    // 左栏区块标题放大到 14px；共享规则已拆开。
    expect(css).toContain('.section-title .side-name{color:var(--muted);font-size:14px');
    // 详情区 block 标题仍是 12px。
    expect(css).toContain('.section-title h2{color:var(--muted);font-size:12px');
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
