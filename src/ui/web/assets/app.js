// 前端唯一入口：装配顶部按钮、hashchange 与两个定时器；其余职责都在同目录的模块里。
import { $, el } from './dom.js';
import { LIVE_INTERVAL } from './live.js';
import { docsTarget, openDocs } from './docs.js';
import { detail, overview } from './navigate.js';
import { liveRefresh, refresh, applySort } from './refresh.js';
import { openGraph } from './render-graph.js';
import { initSidebar } from './sidebar-init.js';
import { SIDEBAR_SORT_KEY, SORT_IDS, resetUiState, ui } from './state.js';
import { syncMarkdownToggle, toggleMarkdown } from './text.js';
import { initComposer } from './composer.js';
import { SORT_MODES } from './tree-order.js';

/* ---------- 左栏全局排序偏好 ---------- */
function syncSidebarSortSelect() {
  const select = $('sidebar-sort');
  select.replaceChildren(...SORT_MODES.map(mode => { const option = el('option', mode.label); option.value = mode.id; return option; }));
  select.value = ui.sidebarSortMode;
  select.title = '左栏四个列表共用：智能排序＝每个列表用自己最有用的顺序（行动任务先看未答复问题与运行状态，规划任务保持批次分组，历史输入与待定事项保持时间线顺序）；按最近更新＝最近动过的排最前；按编号＝新在前。';
}
function onSidebarSortChange() {
  const value = $('sidebar-sort').value;
  ui.sidebarSortMode = SORT_IDS.has(value) ? value : 'smart';
  try { localStorage.setItem(SIDEBAR_SORT_KEY, ui.sidebarSortMode); } catch { /* 隐私模式里忽略 */ }
  applySort();
}

const linked = taskId => /^#task-(\d+)$/.test(taskId) ? Number(taskId.slice(6)) : null;

/** 打开分支图：点按钮与 #graph hash 共用；失败只报错，不中断轮询。 */
function openGraphView() { return openGraph().catch(error => { $('error').textContent = error.message; }); }

/** 打开文档：点左栏「文档」与 #docs / #doc-<id> 共用；同样只报错，不中断轮询。 */
function openDocsView(id = null) { return openDocs(id).catch(error => { $('error').textContent = error.message; }); }

// 地址栏是唯一的路由源：`#graph` / `#docs` / `#doc-ID` / `#task-ID`，其余回概览。
// 每个分支都把 promise 返回出去：浏览器不看返回值，但测试能 await 到「画完」为止。
function onHashChange() {
  const report = error => { $('error').textContent = error.message; };
  if (location.hash === '#graph') return ui.graphOpen ? undefined : openGraphView();
  const doc = docsTarget(location.hash);
  if (doc) return openDocsView(doc.id);
  const next = linked(location.hash);
  // 后退到没有 hash 的地址＝用户想回概览：只画详情不换面板会让合并按钮彻底消失。
  if (!next) return (ui.selected !== null || ui.graphOpen || ui.docsOpen) ? overview().catch(report) : undefined;
  return next === ui.selected ? undefined : detail(next).catch(report);
}

// 上一次注册的定时器与监听器；重复 boot() 前必须先清掉（bun test 在文件之间复用模块注册表）。
let refreshTimer = null, liveTimer = null, hashListener = null;

/**
 * 装配页面：先清掉上一次的定时器 / window 监听器，再按当前全局 DOM 重新接一遍。
 * 浏览器里只跑一次；DOM 测试会重复调用它来换上自己的 stub。
 */
export async function boot() {
  if (refreshTimer !== null && typeof clearInterval === 'function') clearInterval(refreshTimer);
  if (liveTimer !== null && typeof clearInterval === 'function') clearInterval(liveTimer);
  if (hashListener !== null && typeof removeEventListener === 'function') removeEventListener('hashchange', hashListener);
  refreshTimer = null; liveTimer = null; hashListener = null;
  resetUiState();
  $('md-toggle').onclick = toggleMarkdown;
  syncMarkdownToggle();
  syncSidebarSortSelect();
  $('sidebar-sort').addEventListener('change', onSidebarSortChange);
  initComposer();
  // 这三个入口都返回 promise：浏览器不看返回值，但测试能 await 到「画完」为止。
  const goHome = () => overview().catch(error => { $('error').textContent = error.message; });
  $('home').onclick = goHome;
  $('overview-open').onclick = goHome;
  $('sidebar-toggle').onclick = () => {
    const open = $('sidebar').classList.toggle('mobile-open');
    $('sidebar-toggle').setAttribute('aria-expanded', String(open));
    $('sidebar-toggle').textContent = open ? '收起索引' : '浏览任务';
  };
  $('graph-open').onclick = () => { location.hash = '#graph'; return openGraphView(); };
  $('docs-open').onclick = () => { location.hash = '#docs'; return openDocsView(); };
  initSidebar();
  await refresh();
  if (location.hash === '#graph') await openGraphView();
  else {
    const doc = docsTarget(location.hash);
    const initial = doc ? null : linked(location.hash);
    if (doc) await openDocsView(doc.id);
    else if (initial) { try { await detail(initial); } catch (error) { $('error').textContent = error.message; } }
  }
  hashListener = onHashChange;
  addEventListener('hashchange', hashListener);
  refreshTimer = setInterval(refresh, 1500);
  liveTimer = setInterval(liveRefresh, LIVE_INTERVAL);
}

await boot();
