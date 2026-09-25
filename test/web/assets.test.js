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

test('全局待决提醒条模块可服务，样式与容器一起发货', async () => {
  const f = await setup();
  try {
    const module = await fetch(f.url + '/notice-banner.js');
    expect(module.status).toBe(200);
    expect(module.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(await module.text()).toContain('export function renderNoticeBanner');
    const html = await (await fetch(f.url)).text();
    expect(html).toContain('id="notice-banner"');
    const css = await (await fetch(f.url + '/styles.css')).text();
    expect(css).toContain('.notice-banner');
    expect(css).toContain('.notice-banner[hidden]{display:none}');
    // refresh.js 轮询改版后仍把提醒条接回去（沿 import 图读整张模块图）。
    const app = await pageSource(f.url);
    expect(app).toContain('renderNoticeBanner');
  } finally { await f.close(); }
});

test('studio styles provide dual themes, readable headings and reduced-motion support', async () => {
  const f = await setup();
  try {
    const css = await (await fetch(f.url + '/styles.css')).text();
    expect(css).toContain('.section-title .side-name{color:var(--muted);font-size:14px');
    expect(css).toContain('.section-title h2{color:var(--text);font-size:15px');
    expect(css).toContain(':root[data-theme="dark"]');
    expect(css).toContain('.workspace-link.selected');
    expect(css).not.toContain('.workspace-link:first-child');
    expect(css).not.toContain('.workspace-link.primary');
    expect(css).not.toMatch(/body:has\([^\n]+#(?:overview|graph|statistics|settings|docs)-open/);
    expect(css).toContain('color-scheme:light');
    expect(css).toContain('@media(prefers-reduced-motion:reduce)');
    expect(css).toContain('@media(max-width:760px)');
    // 分支图的工作态标识（在跑 / 在等 / 子树）与停下来分支的降噪 class 都在样式表里。
    expect(css).toContain('.graph-work.run{');
    expect(css).toContain('.graph-work.pending{');
    expect(css).toContain('.graph-work.subtree{');
    expect(css).toContain('.graph-branch.graph-idle{');
    // 在跑的分支行有专用动效 class：只有它带动画，且动画写在外环伪元素上（周期 2.4s，不位移不缩放）。
    expect(css).toContain('.graph-branch.graph-running{position:relative}');
    expect(css).toMatch(/\.graph-branch\.graph-running::after\{[^}]*animation:graph-running-breathe 2\.4s/);
    expect(css).toContain('@keyframes graph-running-breathe{');
    // task 计划在分支诊断里是一整条进度条；running 时有轨道扫光、填充流动与外框脉冲三层动效。
    expect(css).toContain('.graph-task-progress{flex-basis:100%');
    expect(css).toContain('.graph-task-progress.is-running .graph-task-progress-track::after{');
    expect(css).toContain('@keyframes graph-progress-sweep{');
    expect(css).toContain('@keyframes graph-progress-stripes{');
    expect(css).toContain('@keyframes graph-progress-pulse{');
    // 完成步骤与当前步骤的耗时使用明显不同的字形，不能只靠文案猜状态。
    expect(css).toMatch(/\.is-complete-duration\{[^}]*font-family:Georgia/);
    expect(css).toMatch(/\.is-running-duration\{[^}]*font-family:ui-monospace/);
    // 停下来的分支不得沾上动画；reduced-motion 的全局规则仍然把这些动画一并关掉。
    expect(css).not.toMatch(/\.graph-branch\.graph-idle\{[^}]*animation/);
    expect(css).toMatch(/@media\(prefers-reduced-motion:reduce\)\{\*,?\*::before,\*::after\{animation:none!important/);
    // 待决 notice 的决策区画在分支图的任务行里，样式必须与 render-graph.js 一起在。
    expect(css).toContain('.graph-node.graph-emphasis-awaiting{');
    expect(css).toContain('.graph-decision{flex-basis:100%');
    expect(css).toContain('.graph-decision-body{');
    // 手机端分支树不再逐层压窄卡片：.graph-tree 横向滚动，并按最大嵌套深度给出随深度增长的最小宽度。
    expect(css).toMatch(/\.graph-tree\{--graph-indent:[^}]*overflow-x:auto/);
    expect(css).toMatch(/\.graph-tree\{--graph-indent:[^}]*overscroll-behavior-x:contain/);
    expect(css).toContain('.graph-tree>.graph-group{min-width:calc(var(--graph-card-min) + (var(--graph-depth,0) * var(--graph-indent)))}');
    // 缩进只有一个来源：--graph-indent；实际 padding-left 与连接线几何都由它推导，避免两处硬编码漂移。
    expect(css).toContain('--graph-indent:16px');
    expect(css).toContain('.graph-children{padding-left:var(--graph-indent)}');
    expect(css).toContain('.graph-children>.graph-group::before,.graph-children>.graph-group::after{left:calc(-1 * (var(--graph-indent) + 2px))}');
    expect(css).toContain('.graph-children>.graph-group::after{width:calc(var(--graph-indent) + 2px)');
    // 手机端拍平嵌套卡片：子分支的 .graph-group 透明、无边框、无内边距、无圆角/阴影，只留最外层一张卡片，
    // 层级改由缩进与连接线表达（关系底色仍保留在 .graph-branch 表头上）。
    expect(css).toContain('.graph-children .graph-group{border:0;background:transparent;box-shadow:none;padding:0;border-radius:0}');
    // 执行过程每一步的 token chip：flex:none + 主题弱化色，标题截断时它和时间都不被挤掉。
    expect(css).toMatch(/\.step-tokens\{flex:none;color:var\(--dim\)/);
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

test('设置页模块与左栏入口一起发货，样式里带设置与强制减少动效', async () => {
  const f = await setup();
  try {
    for (const file of ['/prefs.js', '/render-settings.js']) {
      const response = await fetch(f.url + file);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-security-policy')).toContain("script-src 'self'");
    }
    expect(await (await fetch(f.url + '/prefs.js')).text()).toContain('lush.polling');
    const app = await pageSource(f.url);
    expect(app).toContain("from './prefs.js'");
    expect(app).toContain("from './render-settings.js'");
    const html = await (await fetch(f.url)).text();
    expect(html).toContain('id="settings-open"');
    // appearance.js 是 head 里的 module（经 prefs.js 读写主题）。
    expect(html).toMatch(/<script src="\/appearance\.js" type="module"><\/script>/);
    const css = await (await fetch(f.url + '/styles.css')).text();
    expect(css).toContain('.settings-row{');
    expect(css).toContain('.settings-row{grid-template-columns:1fr');
    expect(css).toContain(':root[data-reduced-motion="true"]');
    expect(css).toContain('.workspace-link.selected{');
  } finally { await f.close(); }
});

test('无顶栏壳：身份区在左栏，内容区不再被头部压住；输入区默认折叠', async () => {
  const f = await setup();
  try {
    const html = await (await fetch(f.url)).text();
    const css = await (await fetch(f.url + '/styles.css')).text();
    // 顶栏整条取消：页面里没有 .app-header，grid 里也没有 header 行（两处 .app 定义都不含 header）。
    expect(html).not.toContain('app-header');
    expect(css).not.toContain('.app-header');
    expect(css).not.toContain('grid-template-areas:"header header"');
    expect(css).toMatch(/\.app\{[^}]*grid-template-areas:"sidebar content" "sidebar composer"/);
    expect(css).not.toContain('grid-template-areas:"sidebar detail"');
    expect(css.match(/grid-template-areas:"sidebar content" "sidebar composer"/g)).toHaveLength(2);
    // 品牌、项目名、并发槽、连接状态、主题切换、退出登录都搬进左栏顶部（<aside> 内）。
    const rail = html.slice(html.indexOf('<aside id="sidebar"'), html.indexOf('</aside>'));
    expect(rail).toContain('rail-identity');
    for (const id of ['home', 'project', 'agents', 'connection', 'theme-toggle']) expect(rail).toContain(`id="${id}"`);
    expect(rail).toContain('action="/logout"');
    // 输入区默认折叠（服务端 HTML 就带 hidden，不依赖用户任何操作）：父分支与快捷键展开后才出现。
    expect(html).toMatch(/<div id="composer-details"[^>]*hidden/);
    expect(html).toMatch(/id="composer-shortcuts"[^>]*hidden/);
    expect(html).toMatch(/id="composer-expand"[^>]*aria-expanded="false"[^>]*aria-controls="composer-details"/);
    expect(html).toContain('id="draft-count"');
    // 一行输入：rows=1 且样式里的最小高度 ≤36px；展开不把它撑高。
    expect(html).toMatch(/<textarea id="input" rows="1"/);
    expect(css).toMatch(/\.composer textarea\{min-height:3[0-6]px/);
    // 输入区文本层保持干净：没有前缀高亮 overlay（新 say 不走快速路由，不再假装会按前缀派活）。
    expect(html).not.toContain('input-highlight');
    expect(css).not.toMatch(/\.composer-highlight/);
    expect(css).toMatch(/\.composer-input textarea\{[^}]*background:transparent/);
    expect(css).not.toMatch(/\.composer textarea\{[^}]*background:/);
    // 任务类型胶囊按 role-<role> 取色；快速路由是独立一套（徽章 + 整行底色），不覆盖状态色。
    expect(css).toMatch(/\.role-worker\{color:var\(--role-worker\)\}/);
    expect(css).toMatch(/\.role-planner\{color:var\(--role-planner\)\}/);
    expect(css).toMatch(/\.route-badge\{[^}]*color:var\(--route\)/);
    expect(css).toMatch(/\.task\.route-flagged,\.graph-node\.route-flagged\{background-image:/);
    // 浮层不再给顶栏留 80px 空档。
    expect(css).toMatch(/\.toast\{position:fixed;top:16px/);
    // 行为落点原样保留：待提交意图开关、父分支输入框、提交按钮仍在页面里。
    for (const id of ['draft-toggle', 'input-branch', 'draft-add', 'draft-commit']) expect(html).toContain(`id="${id}"`);
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
    expect(html).toContain('aria-label="列表排序方式"');
    // 排序控件已经从行动任务区块移到左栏顶部，旧的 #tree-sort 不再存在
    expect(html).not.toContain('id="tree-sort"');
  } finally { await f.close(); }
});

test('统一按钮帮助模块可服务，Agent 触发标识与提示样式一起发货', async () => {
  const f = await setup();
  try {
    // help.js 按 basename 白名单自动可服务；app.js 必须真的装配它。
    const module = await fetch(f.url + '/help.js');
    expect(module.status).toBe(200);
    expect(module.headers.get('content-security-policy')).toContain("script-src 'self'");
    const source = await module.text();
    expect(source).toContain('export function initHelp');
    expect(source).toContain('export function agentHelp');
    expect(source).toContain('export const AGENT_NOTE');
    const app = await pageSource(f.url);
    expect(app).toContain("from './help.js'");
    expect(app).toContain('initHelp()');

    // 提示浮层、help-host 约定与 agent-call 的三态样式都在样式表里。
    const css = await (await fetch(f.url + '/styles.css')).text();
    expect(css).toContain('.help-tip{position:fixed');
    expect(css).toContain('.help-tip[hidden]{display:none}');
    expect(css).toContain('.help-host{display:contents}');
    expect(css).toContain('button.agent-call{');
    expect(css).toContain('button.agent-call.ghost{');
    expect(css).toContain('button.context-action.agent-call{');
    // 两个主题都必须有 --violet-ink，深浅各一套对比色。
    const light = css.slice(0, css.indexOf(':root[data-theme="dark"]'));
    const dark = css.slice(css.indexOf(':root[data-theme="dark"]'));
    expect(light).toContain('--violet-ink:#7955b4');
    expect(dark).toContain('--violet-ink:#c1a4f3');

    // 页面入口：发送当前输入带 agent-call；提示由 JS 的 agentHelp 写入。
    const html = await (await fetch(f.url)).text();
    expect(html).toMatch(/id="draft-commit"[^>]*class="agent-call"/);
    expect(html).toContain('>发送</button>');
    expect(html).not.toContain('id="input-direct"');
    expect(html).not.toContain('直接执行');
    expect(html).not.toContain('提交并规划');
  } finally { await f.close(); }
});
