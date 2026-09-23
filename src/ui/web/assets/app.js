// 前端唯一入口：装配顶部按钮、hashchange 与两个定时器；其余职责都在同目录的模块里。
import { $, el } from './dom.js';
import { initAppearance, refreshTheme } from './appearance.js';
import { show } from './messages.js';
import { docsTarget, openDocs } from './docs.js';
import { detail, overview } from './navigate.js';
import { liveInterval } from './live.js';
import { onPrefChange, pollingIntervals, readPref, setPref } from './prefs.js';
import { liveRefresh, refresh, applySort, applyFilters } from './refresh.js';
import { openGraph } from './render-graph.js';
import { openSettings } from './render-settings.js';
import { openStatistics } from './render-statistics.js';
import { initSidebar } from './sidebar-init.js';
import { openResource, paintCollapsed } from './sidebar-ui.js';
import { resetUiState, ui } from './state.js';
import { initComposer } from './composer.js';
import { SORT_MODES } from './tree-order.js';
import { initContextReferences } from './context-references.js';
import { hideHelp, initHelp } from './help.js';
import { resetTranscriptReaders } from './transcript-reader.js';
import { closeTranscriptTerminal } from './transcript-terminal.js';
import { closeExplanationPanel } from './explanations.js';
import { ensureProject } from './project-picker.js';
import { initNoticeNotifications, resetNoticeNotifier } from './notice-notifications.js';
import { initNoticeRecords } from './render-notices.js';

/* ---------- 左栏全局排序偏好（与设置页共用 lush.sidebarSort） ---------- */
function syncSidebarSortSelect() {
  const select = $('sidebar-sort');
  select.replaceChildren(...SORT_MODES.map(mode => { const option = el('option', mode.label); option.value = mode.id; return option; }));
  select.value = ui.sidebarSortMode;
  select.title = '四个列表共用：智能排序会为任务、规划、输入与待决事项分别选择最有用的顺序；也可以统一按最近更新或编号排序。';
}
function onSidebarSortChange() { setPref('sidebarSort', $('sidebar-sort').value); }

/* ---------- 动效偏好：勾选后强制减少，覆盖系统设置 ---------- */
function applyReducedMotion(value) {
  const root = typeof document !== 'undefined' ? document.documentElement : null;
  if (!root?.dataset) return;
  if (value) root.dataset.reducedMotion = 'true';
  else delete root.dataset.reducedMotion;
}

/* ---------- 偏好变更后的重画（「变更后重画」统一由 prefs.js 通知） ---------- */
onPrefChange('sidebarSort', value => { ui.sidebarSortMode = value; syncSidebarSortSelect(); applySort(); });
// 折叠 / 筛选平时只写盘（saveCollapsedPref / saveFiltersPref），不通知；resetPrefs() 清空它们后要把内存状态一起拉回默认。
onPrefChange('collapsed', value => { ui.collapsed = value; paintCollapsed(); });
onPrefChange('filters', value => { ui.filters = value; applyFilters({ persist: false }); });
onPrefChange('reduceMotion', applyReducedMotion);
onPrefChange('theme', () => refreshTheme());
// 轮询频率变了：立刻按新间隔重建两个定时器，不必刷新页面。
onPrefChange('polling', () => { if (refreshTimer !== null || liveTimer !== null) startTimers(); });

const linked = taskId => /^#task-(\d+)$/.test(taskId) ? Number(taskId.slice(6)) : null;

/** 打开分支图：点按钮与 #graph hash 共用；失败只报错，不中断轮询。 */
function openGraphView() { return openGraph().catch(error => { show(error.message, 'error'); }); }

/** 打开文档：点左栏「文档」与 #docs / #doc-<id> 共用；同样只报错，不中断轮询。 */
function openDocsView(id = null) { return openDocs(id).catch(error => { show(error.message, 'error'); }); }

// 地址栏是唯一的路由源：`#settings` / `#graph` / `#docs` / `#doc-ID` / `#task-ID`，其余回概览。
// 每个分支都把 promise 返回出去：浏览器不看返回值，但测试能 await 到「画完」为止。
function onHashChange() {
  hideHelp(); // 换页前先把上一页的按钮提示收掉，避免固定浮层跨页残留。
  const report = error => { show(error.message, 'error'); };
  if (location.hash === '#statistics') return ui.statisticsOpen ? undefined : openStatistics();
  if (location.hash === '#settings') return ui.settingsOpen ? undefined : openSettings();
  if (location.hash === '#graph') return ui.graphOpen ? undefined : openGraphView();
  const resource = /^#(notices|tasks|intents|specs)$/.exec(location.hash)?.[1];
  if (resource) return openResource(resource, { push: false });
  const doc = docsTarget(location.hash);
  if (doc) return openDocsView(doc.id);
  const next = linked(location.hash);
  // 没有 hash 是项目概览；分支图使用显式 #graph，因此浏览器前进 / 后退不会含糊。
  if (!next) return overview().catch(report);
  return next === ui.selected ? undefined : detail(next).catch(report);
}

// 上一次注册的定时器与监听器；重复 boot() 前必须先清掉（bun test 在文件之间复用模块注册表）。
let refreshTimer = null, liveTimer = null, hashListener = null;

/** 按当前「轮询频率」偏好重建两个定时器；标准档＝快照 1500ms + 实时 3000ms。 */
function startTimers() {
  if (refreshTimer !== null && typeof clearInterval === 'function') clearInterval(refreshTimer);
  if (liveTimer !== null && typeof clearInterval === 'function') clearInterval(liveTimer);
  refreshTimer = setInterval(refresh, pollingIntervals().snapshot);
  liveTimer = setInterval(liveRefresh, liveInterval());
}

/**
 * 装配页面：先清掉上一次的定时器 / window 监听器，再按当前全局 DOM 重新接一遍。
 * 浏览器里只跑一次；DOM 测试会重复调用它来换上自己的 stub。
 */
export async function boot() {
  if (refreshTimer !== null && typeof clearInterval === 'function') clearInterval(refreshTimer);
  if (liveTimer !== null && typeof clearInterval === 'function') clearInterval(liveTimer);
  if (hashListener !== null && typeof removeEventListener === 'function') removeEventListener('hashchange', hashListener);
  refreshTimer = null; liveTimer = null; hashListener = null;
  closeTranscriptTerminal();
  resetUiState();
  resetTranscriptReaders();
  closeExplanationPanel();
  resetNoticeNotifier();
  await initNoticeNotifications();
  initAppearance();                              // 按当前 DOM 重新绑定主题与头部按钮
  applyReducedMotion(readPref('reduceMotion'));
  if (!await ensureProject()) return;
  syncSidebarSortSelect();
  $('sidebar-sort').addEventListener('change', onSidebarSortChange);
  initContextReferences();
  initHelp();                                    // 统一按钮帮助提示（document 级委托，可重复装配）
  initComposer();
  // 平级页面共享切换接缝；品牌回概览。入口返回 promise，测试可等到画完。
  const goGraph = () => openGraphView();
  const goOverview = () => overview().catch(error => { show(error.message, 'error'); });
  $('home').onclick = goOverview;
  $('overview-open').onclick = goOverview;
  $('settings-open').onclick = () => openSettings();
  $('statistics-open').onclick = () => openStatistics();
  $('sidebar-toggle').onclick = () => {
    const open = $('sidebar').classList.toggle('mobile-open');
    $('sidebar-toggle').setAttribute('aria-expanded', String(open));
    $('sidebar-toggle').textContent = open ? '收起菜单' : '导航菜单';
  };
  $('graph-open').onclick = goGraph;
  $('docs-open').onclick = () => openDocsView();
  $('view-back').onclick = () => {
    if ($('view-back').disabled) return;
    if (typeof window.history.back === 'function') return window.history.back();
    return goOverview();
  };
  initSidebar();
  initNoticeRecords();
  hashListener = onHashChange;
  addEventListener('hashchange', hashListener);
  // 先确定页面归属，再开始取数；首次加载期间的导航也不会被启动逻辑抢回。
  const initialView = onHashChange();
  await refresh();
  await initialView;
  // 深链接设置页可能先于概览摘要到达；摘要就绪后补画配置与系统信息。
  if (ui.settingsOpen) openSettings();
  startTimers();
}

await boot();
