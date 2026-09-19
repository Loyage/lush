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

test('web serves the tree sort module and wires the smart-sort dropdown', async () => {
  const f = await setup();
  try {
    const module = await fetch(f.url+'/tree-order.js');
    expect(module.status).toBe(200);
    expect(await module.text()).toContain('export function orderSiblings');
    const app = await pageSource(f.url);
    expect(app).toContain('智能排序');
    expect(app).toContain('tree-sort');
    const html = await (await fetch(f.url)).text();
    expect(html).toContain('id="tree-sort"');
  } finally { await f.close(); }
});
