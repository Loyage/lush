// 前端唯一入口：装配顶部按钮、hashchange 与两个定时器；其余职责都在同目录的模块里。
import { $, el } from './dom.js';
import { initAppearance, refreshTheme } from './appearance.js';
import { show } from './messages.js';
import { docsTarget, openDocs } from './docs.js';
import { detail, overview } from './navigate.js';
import { liveInterval } from './live.js';
import { onPrefChange, pollingIntervals, readPref, setPref } from './prefs.js';
import { liveRefresh, refresh, applySort, applyFilters } from './refresh.js';
import { openTaskGraph } from './render-task-graph.js';
import { openSettings } from './render-settings.js';
import { openAgentStatus } from './render-agent-status.js';
import { openVersions } from './render-versions.js';
import { openInputs } from './render-inputs.js';
import { openHooks } from './render-hooks.js';
import { openQuickExplanationPage } from './render-quick-explanation.js';
import { closeQuickExplanationPanel } from './quick-explanation.js';
import { initSidebar } from './sidebar-init.js';
import { activateDetailView, openResource, paintCollapsed } from './sidebar-ui.js';
import { resetUiState, ui } from './state.js';
import { initComposer } from './composer.js';
import { SORT_MODES } from './tree-order.js';
import { initContextReferences } from './context-references.js';
import { hideHelp, initHelp } from './help.js';
import { resetTranscriptReaders } from './transcript-reader.js';
import { closeTranscriptView } from './transcript-view.js';
import { closeExplanationPanel } from './explanations.js';
import { ensureProject, openProjectManager, workbenchStatus } from './project-picker.js';
import { resetNoticeNotifier } from './notice-notifications.js';
import { initNoticeRecords, openNotice } from './render-notices.js';
import { workerNumberTarget, resolveWorkerNumber } from './worker-links.js';

/* ---------- 左栏全局排序偏好（与设置页共用 lush.sidebarSort） ---------- */
function syncSidebarSortSelect() {
  const select = $('sidebar-sort');
  select.replaceChildren(...SORT_MODES.map(mode => { const option = el('option', mode.label); option.value = mode.id; return option; }));
  select.value = ui.sidebarSortMode;
  select.title = '四个列表共用：智能排序会为 Worker、规划、输入与待决事项分别选择最有用的顺序；也可以统一按最近更新或编号排序。';
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

const linked = taskId => /^#worker-(\d+)$/.test(taskId) ? Number(taskId.slice(8)) : null;

/** 打开文档：点左栏「文档」与 #docs / #doc-<id> 共用；同样只报错，不中断轮询。 */
function openDocsView(id = null) { return openDocs(id).catch(error => { show(error.message, 'error'); }); }

// 模型来源是独立、按需加载的页面；延迟模块加载不能抢回用户已离开的视图。
async function openSources(connectionId = '') {
  const previous = ui.view;
  try {
    const { openModelSources } = await import('./render-model-sources.js');
    if (ui.view !== previous) return;
    return openModelSources({ connectionId });
  } catch (error) { if (ui.view === previous) show(error.message, 'error'); }
}

// 地址栏是唯一的路由源：设置 / Agent 状态 / Task 图 / 文档 / Task；其余回概览。
// 每个分支都把 promise 返回出去：浏览器不看返回值，但测试能 await 到「画完」为止。
function noProjectView() {
  const identity = activateDetailView({ view: 'unavailable', title: '项目不可用', context: '工作台',
    hint: '当前地址没有可用项目', push: false, hash: location.hash || undefined });
  const panel = $('detail');
  if (ui.view !== identity) return;
  const box = el('div', undefined, 'workbench-view');
  const empty = el('div', undefined, 'workbench-empty');
  empty.append(el('strong', '当前没有可用项目'),
    el('p', '项目管理、界面设置和帮助仍可使用。'));
  box.append(empty); panel.replaceChildren(box);
}

let hashGeneration = 0;
function onHashChange() {
  const generation = ++hashGeneration;
  hideHelp(); // 换页前先把上一页的按钮提示收掉，避免固定浮层跨页残留。
  const report = error => { show(error.message, 'error'); };
  if (location.hash === '#projects') return openProjectManager({ push: false });
  if (location.hash === '#settings') return ui.settingsOpen ? undefined : openSettings();
  const doc = docsTarget(location.hash);
  if (doc) return openDocsView(doc.id);
  if (location.hash === '#agent-status') return ui.view?.id === 'agent-status' ? undefined : openAgentStatus();
  if (location.hash === '#model-sources') return ui.view?.id === 'model-sources' ? undefined : openSources();
  const sourceMatch = /^#model-source-([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i.exec(location.hash);
  if (sourceMatch) return openSources(sourceMatch[1]);
  if (location.hash === '#quick-explain') return ui.view?.id === 'quick-explain' ? undefined : openQuickExplanationPage();
  if (!workbenchStatus().projectUsable) {
    if (!location.hash) return openProjectManager({ push: false });
    return noProjectView();
  }
  if (location.hash === '#hooks') return ui.view?.id === 'hooks' ? undefined : openHooks();
  if (location.hash === '#versions') return ui.view?.id === 'versions' ? undefined : openVersions();
  if (location.hash === '#inputs') return openInputs({ push: false });
  const inputMatch = /^#input-(draft|input)-([1-9]\d*)$/.exec(location.hash);
  if (inputMatch && Number.isSafeInteger(Number(inputMatch[2]))) {
    return openInputs({ item: { kind: inputMatch[1], id: Number(inputMatch[2]) }, push: false });
  }
  if (location.hash === '#worker-graph') return ui.view?.id === 'task-graph' ? undefined : openTaskGraph().catch(report);
  const noticeId = /^#notice-([1-9]\d*)$/.exec(location.hash)?.[1];
  if (noticeId && Number.isSafeInteger(Number(noticeId))) return openNotice(Number(noticeId)).catch(report);
  const resourceRoute = /^#(notices|workers)$/.exec(location.hash)?.[1];
  const resource = resourceRoute === 'workers' ? 'tasks' : resourceRoute;
  if (resource) return openResource(resource, { push: false });
  const number = workerNumberTarget(location.hash);
  if (number) {
    const hash = location.hash, path = location.pathname, view = ui.view;
    return resolveWorkerNumber(number).then(id => {
      // A late lookup must not steal a newer page, even within the same project.
      if (generation !== hashGeneration || location.hash !== hash || location.pathname !== path || ui.view !== view) return;
      if (ui.deletedWorkerIds.has(id)) throw new Error(`Worker ${number} 已删除`);
      // Canonicalize the current entry, rather than adding a second history entry
      // that would resolve/push again on Back and trap users in the Worker page.
      window.history.replaceState(null, '', `#worker-${id}`);
      return detail(id);
    }).catch(error => { if (generation === hashGeneration && location.hash === hash && location.pathname === path && ui.view === view) report(error); });
  }
  const next = linked(location.hash);
  // 未知或已移除的 hash（包括旧 #graph）回项目概览。
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
  closeTranscriptView();
  resetUiState();
  resetTranscriptReaders();
  closeExplanationPanel();
  closeQuickExplanationPanel();
  resetNoticeNotifier();
  initAppearance();                              // 按当前 DOM 重新绑定主题与头部按钮
  applyReducedMotion(readPref('reduceMotion'));
  // Global navigation does not wait for a Host probe or a project daemon.
  initHelp();
  $('projects-open').onclick = () => openProjectManager();
  $('settings-open').onclick = () => openSettings();
  $('docs-open').onclick = () => openDocsView();
  await ensureProject();
  const context = workbenchStatus();
  const projectReady = context.projectUsable;
  if ($('host-context')) $('host-context').textContent = context.project || projectReady ? '当前项目' : '工作台';
  if (!projectReady) {
    $('project').textContent = context.project ? '项目不可用' : '未打开项目';
    $('connection').textContent = context.host?.mode === 'offline' ? 'Host 离线' : '工作台已就绪';
  }
  initContextReferences();
  initHelp();                                    // 统一按钮帮助提示（document 级委托，可重复装配）
  // 工作台导航永远先可用；没有项目时不装配任何项目写入口或轮询。
  const goOverview = () => projectReady ? overview().catch(error => { show(error.message, 'error'); }) : openProjectManager();
  $('home').onclick = goOverview;
  $('overview-open').onclick = goOverview;
  $('projects-open').onclick = () => openProjectManager();
  $('settings-open').onclick = () => openSettings();
  $('docs-open').onclick = () => openDocsView();
  const projectOnly = ['overview-open','task-graph-open','inputs-open','versions-open','hooks-open'];
  for (const id of projectOnly) { const target = $(id); target.disabled = !projectReady; target.setAttribute('aria-disabled', String(!projectReady)); }
  const composerShell = $('composer-shell'); if (composerShell) composerShell.hidden = !projectReady;
  const composerReady = projectReady ? initComposer() : Promise.resolve();
  if (projectReady) {
    syncSidebarSortSelect();
    $('sidebar-sort').addEventListener('change', onSidebarSortChange);
  }
  for (const id of ['agent-status-open', 'model-sources-open', 'quick-explain-open']) { const target = $(id); if (target) { target.disabled = false; target.setAttribute('aria-disabled', 'false'); } }
  if ($('agent-status-open')) $('agent-status-open').onclick = () => openAgentStatus();
  if ($('model-sources-open')) $('model-sources-open').onclick = () => openSources();
  if ($('quick-explain-open')) $('quick-explain-open').onclick = () => openQuickExplanationPage();
  if ($('hooks-open')) $('hooks-open').onclick = () => projectReady ? openHooks() : noProjectView();
  if ($('versions-open')) $('versions-open').onclick = () => projectReady ? openVersions() : noProjectView();
  if ($('inputs-open')) $('inputs-open').onclick = () => projectReady ? openInputs() : noProjectView();
  if ($('input-history')) $('input-history').onclick = () => projectReady ? openInputs() : noProjectView();
  $('sidebar-toggle').onclick = () => {
    const open = $('sidebar').classList.toggle('mobile-open');
    $('sidebar-toggle').setAttribute('aria-expanded', String(open));
    $('sidebar-toggle').textContent = open ? '收起菜单' : '导航菜单';
  };
  $('task-graph-open').onclick = () => projectReady ? openTaskGraph().catch(error => { show(error.message, 'error'); }) : noProjectView();
  $('view-back').onclick = () => {
    if ($('view-back').disabled) return;
    if (typeof window.history.back === 'function') return window.history.back();
    return goOverview();
  };
  if (projectReady) { initSidebar(); initNoticeRecords(); }
  hashListener = onHashChange;
  addEventListener('hashchange', hashListener);
  // 先确定页面归属，再开始取数；首次加载期间的导航也不会被启动逻辑抢回。
  const initialView = onHashChange();
  if (projectReady) await refresh();
  await initialView;
  await composerReady;
  // 深链接设置页可能先于概览摘要到达；摘要就绪后补画配置与系统信息。
  if (ui.settingsOpen) openSettings();
  if (projectReady) startTimers();
}

await boot();
