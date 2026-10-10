// One entry, two spaces: device user workspace at root, project work at an explicit /p/<id>/ route.
import { $, el } from './dom.js';
import { api } from './api.js';
import { setProjectIdentity } from './project-identity.js';
import { initAppearance, refreshTheme } from './appearance.js';
import { show } from './messages.js';
import { docsTarget, openDocs } from './docs.js';
import { detail, overview } from './navigate.js';
import { liveInterval } from './live.js';
import { onDevicePreferences, onPrefChange, pollingIntervals, readPref, saveDevicePreference, startDevicePreferencesSync } from './prefs.js';
import { liveRefresh, refresh, applySort, applyFilters, initRefreshPolling } from './refresh.js';
import { openTaskGraph } from './render-task-graph.js';
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
import { renderAutoSelectBanner } from './auto-select-banner.js';
import { initNoticeRecords, openNotice } from './render-notices.js';
import { workerNumberTarget, resolveWorkerNumber } from './worker-links.js';
import { projectRoute, workspaceHref } from './route.js';
import { configureWorkspaceShell, renderGlobalInboxSummary, workspaceLink } from './workspace-shell.js';
import { onDeviceAutomation, startDeviceAutomationObserver } from './workspace-automation.js';

function syncSidebarSortSelect() {
  const select = $('sidebar-sort'); if (!select) return;
  select.replaceChildren(...SORT_MODES.map(mode => { const option = el('option', mode.label); option.value = mode.id; return option; }));
  select.value = ui.sidebarSortMode;
  select.removeAttribute('title');
  select.setAttribute('data-help', '设备统一的列表排序偏好；具体项目的过滤与折叠状态仍独立保存。');
}
async function onSidebarSortChange() {
  const owner = globalThis.document;
  try { await saveDevicePreference('sidebarSort', $('sidebar-sort').value); }
  catch (error) { if (owner === globalThis.document) { show(`排序偏好未保存：${error.message}`, 'error'); syncSidebarSortSelect(); } }
}
function applyReducedMotion(value) {
  const root = globalThis.document?.documentElement; if (!root?.dataset) return;
  if (value) root.dataset.reducedMotion = 'true'; else delete root.dataset.reducedMotion;
}
onPrefChange('sidebarSort', value => { ui.sidebarSortMode = value; syncSidebarSortSelect(); if (workbenchStatus().projectUsable) applySort(); });
onPrefChange('collapsed', value => { ui.collapsed = value; paintCollapsed(); });
onPrefChange('filters', value => { ui.filters = value; if (workbenchStatus().projectUsable) applyFilters({ persist: false }); });
onDevicePreferences(status => {
  if (!globalThis.document) return;
  const sort = $('sidebar-sort'); if (!sort) return;
  sort.disabled = status.saving || !status.ready || Boolean(status.error);
  const host = sort.parentElement || sort.parentNode;
  host?.setAttribute('data-help', !status.ready || status.error ? `设备偏好尚不可用，不能保存排序。${status.error || '等待权威配置读取。'}` : status.saving ? '正在保存设备偏好。' : '设备统一排序；项目的过滤、折叠与选择仍独立。');
});
onPrefChange('reduceMotion', applyReducedMotion);
onPrefChange('theme', () => refreshTheme());
onPrefChange('polling', () => { if (refreshTimer !== null || liveTimer !== null) startTimers(); });

const linked = hash => /^#worker-(\d+)$/.test(hash) ? Number(hash.slice(8)) : null;
const report = error => { show(error.message, 'error'); };
function openDocsView(id = null) { return openDocs(id).catch(report); }
let pageGeneration = 0, bootGeneration = 0;
async function openPage(load, open, view, options = {}) {
  const generation = ++pageGeneration, boot = bootGeneration, owner = globalThis.document;
  const identity = ui.view?.id === view ? ui.view : activateDetailView({ view, ...options });
  const hash = location.hash, pathname = location.pathname;
  const current = () => generation === pageGeneration && boot === bootGeneration && owner === globalThis.document
    && ui.view === identity && location.hash === hash && location.pathname === pathname;
  try { const module = await load(); if (current()) return await open(module); }
  catch (error) { if (current()) show(`${error.message}（若界面已更新，请刷新后重试）`, 'error'); }
}
const openSettings = () => openPage(() => import('./render-settings.js'), module => module.openSettings(), 'settings');
const openAgentStatus = () => openPage(() => import('./render-agent-status.js'), module => module.openAgentStatus(), 'agent-status');
const openVersions = () => openPage(() => import('./render-versions.js'), module => module.openVersions(), 'versions');
const openHooks = () => openPage(() => import('./render-hooks.js'), module => module.openHooks(), 'hooks');
const openQuickExplanationPage = () => openPage(() => import('./render-quick-explanation.js'), module => module.openQuickExplanationPage(), 'quick-explain');
const openQuickExplanationHistory = () => openPage(() => import('./render-quick-explanation.js'), module => module.openQuickExplanationHistory(), 'quick-explain-history');
const openAutomation = () => openPage(() => import('./render-workspace-automation.js'), module => module.openWorkspaceAutomation(), 'automation');
const openGlobalInbox = (options = {}) => openPage(() => import('./global-inbox.js'), module => module.openGlobalInbox(options), 'global-inbox',
  { push: options.push, hash: options.projectId && options.noticeId ? `#inbox-notice-${options.projectId}-${options.noticeId}` : options.projectId ? `#notices-project-${options.projectId}${options.status && options.status !== 'all' ? `-${options.status}` : ''}` : options.status === 'automatic' ? '#notices-automatic' : '#notices' });
const openInputs = (options = {}) => openPage(() => import('./render-inputs.js'), module => module.openInputs(options), 'inputs',
  { push: options.push, hash: options.item ? `#input-${options.item.kind}-${options.item.id}` : '#inputs' });
const openSources = (connectionId = '') => openPage(() => import('./render-model-sources.js'), module => module.openModelSources({ connectionId }),
  'model-sources', { hash: connectionId ? `#model-source-${connectionId}` : '#model-sources' });

function noProjectView() {
  const identity = activateDetailView({ view: 'unavailable', title: '项目不可用', context: '用户工作台',
    hint: '项目工作需要明确、有效的项目地址', push: false, hash: location.hash || undefined });
  if (ui.view !== identity) return;
  const box = el('div', undefined, 'workbench-view');
  box.append(el('h1', '当前地址没有可用项目'), el('p', '设备设置、全局收件箱、项目入口与帮助仍可使用。', 'hint'));
  const link = el('a', '打开项目入口', 'ghost'); link.href = '/#projects'; link.target = '_blank'; link.rel = 'noopener'; box.append(link);
  $('detail').replaceChildren(box);
}
/** Old in-project setting bookmarks lead to the real global page; never silently replace the project tab. */
function globalPageRedirect(hash) {
  const identity = activateDetailView({ view: 'workspace-link', title: '此页面已移至用户工作台', context: '项目工作',
    hint: '设备配置和全局事项在独立页面管理', push: false, hash });
  if (ui.view !== identity) return;
  const box = el('div', undefined, 'workbench-view');
  box.append(el('h1', '在独立用户工作台打开'), el('p', '设备设置与全局事项不再属于当前项目。新标签打开后，当前项目的输入和现场保留。', 'hint'));
  const link = el('a', '打开用户工作台页面', 'primary'); link.href = workspaceHref(hash); link.target = '_blank'; link.rel = 'noopener'; box.append(link);
  const back = el('a', '返回项目概览', 'ghost'); back.href = `\u0023`; box.append(back); $('detail').replaceChildren(box);
}
const deviceHash = hash => /^#(?:settings|agent-status|model-sources|model-source-[a-f0-9-]+|quick-explain|automation|notices-(?:all|open|unread|automatic|failed)|notices-project-[a-f0-9]{16}(?:-(?:all|open|unread|automatic|failed))?|inbox-notice-[a-f0-9]{16}-[1-9]\d*)$/.test(hash);
let hashGeneration = 0;
function onHashChange() {
  const generation = ++hashGeneration; hideHelp();
  const hash = location.hash, project = projectRoute(), doc = docsTarget(hash);
  if (project && (deviceHash(hash) || hash === '#projects' || doc)) return globalPageRedirect(hash);
  if (!project) {
    if (!hash || hash === '#projects') return openProjectManager({ push: false });
    if (hash === '#settings') return ui.settingsOpen ? undefined : openSettings();
    if (hash === '#agent-status') return ui.view?.id === 'agent-status' ? undefined : openAgentStatus();
    if (hash === '#model-sources') return ui.view?.id === 'model-sources' ? undefined : openSources();
    const source = /^#model-source-([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i.exec(hash);
    if (source) return openSources(source[1]);
    if (hash === '#quick-explain') return ui.view?.id === 'quick-explain' ? undefined : openQuickExplanationPage();
    if (hash === '#automation' || hash === '#hooks') return ui.view?.id === 'automation' ? undefined : openAutomation();
    if (doc) return openDocsView(doc.id);
    const notice = /^#inbox-notice-([a-f0-9]{16})-([1-9]\d*)$/.exec(hash);
    if (notice && Number.isSafeInteger(Number(notice[2]))) return openGlobalInbox({ projectId: notice[1], noticeId: Number(notice[2]), push: false });
    const sourceNotices = /^#notices-project-([a-f0-9]{16})(?:-(all|open|unread|automatic|failed))?$/.exec(hash);
    if (sourceNotices) return openGlobalInbox({ projectId: sourceNotices[1], status: sourceNotices[2] || 'all', push: false });
    const filter = /^#notices(?:-(all|open|unread|automatic|failed))?$/.exec(hash);
    if (filter) return openGlobalInbox({ status: filter[1] || 'all', push: false });
    return noProjectView();
  }
  if (!workbenchStatus().projectUsable) return noProjectView();
  if (hash === '#hooks') return ui.view?.id === 'hooks' ? undefined : openHooks();
  if (hash === '#versions') return ui.view?.id === 'versions' ? undefined : openVersions();
  if (hash === '#quick-explain-history') return ui.view?.id === 'quick-explain-history' ? undefined : openQuickExplanationHistory();
  if (hash === '#inputs') return openInputs({ push: false });
  const input = /^#input-(draft|input)-([1-9]\d*)$/.exec(hash);
  if (input && Number.isSafeInteger(Number(input[2]))) return openInputs({ item: { kind: input[1], id: Number(input[2]) }, push: false });
  if (hash === '#worker-graph') return ui.view?.id === 'task-graph' ? undefined : openTaskGraph().catch(report);
  const noticeId = /^#notice-([1-9]\d*)$/.exec(hash)?.[1];
  if (noticeId && Number.isSafeInteger(Number(noticeId))) return openNotice(Number(noticeId)).catch(report);
  const resourceRoute = /^#(notices|workers)$/.exec(hash)?.[1];
  if (resourceRoute) return openResource(resourceRoute === 'workers' ? 'tasks' : resourceRoute, { push: false });
  const number = workerNumberTarget(hash);
  if (number) {
    const path = location.pathname, view = ui.view;
    return resolveWorkerNumber(number).then(id => {
      if (generation !== hashGeneration || location.hash !== hash || location.pathname !== path || ui.view !== view) return;
      if (ui.deletedWorkerIds.has(id)) throw new Error(`Worker ${number} 已删除`);
      window.history.replaceState(null, '', `#worker-${id}`); return detail(id);
    }).catch(error => { if (generation === hashGeneration && location.hash === hash && location.pathname === path && ui.view === view) report(error); });
  }
  const next = linked(hash);
  if (!next) return overview().catch(report);
  return next === ui.selected ? undefined : detail(next).catch(report);
}
let refreshTimer = null, liveTimer = null, hashListener = null, disposeRefreshPolling = null;
let disposePreferences = null, disposeAutomation = null, disposeAutomationView = null, disposeInbox = null, disposeInboxReady = null;
function startTimers() {
  if (refreshTimer !== null) clearInterval(refreshTimer); if (liveTimer !== null) clearInterval(liveTimer);
  refreshTimer = setInterval(refresh, pollingIntervals().snapshot); liveTimer = setInterval(liveRefresh, liveInterval());
}
function initGlobalNavigation() {
  workspaceLink('projects-open', '#projects', () => openProjectManager());
  workspaceLink('global-inbox-open', '#notices', () => openGlobalInbox());
  workspaceLink('automation-open', '#automation', openAutomation);
  workspaceLink('settings-open', '#settings', openSettings);
  workspaceLink('agent-status-open', '#agent-status', openAgentStatus);
  workspaceLink('model-sources-open', '#model-sources', () => openSources());
  workspaceLink('quick-explain-open', '#quick-explain', openQuickExplanationPage);
  workspaceLink('docs-open', '#docs', () => openDocsView());
}
/** Repeated boot must dispose global and project polling separately; late imports cannot bind an older DOM. */
export async function boot() {
  const boot = ++bootGeneration, owner = globalThis.document;
  const active = () => boot === bootGeneration && owner === globalThis.document;
  ++pageGeneration; ++hashGeneration;
  disposeRefreshPolling?.(); disposeRefreshPolling = null;
  disposePreferences?.(); disposeAutomation?.(); disposeAutomationView?.(); disposeInbox?.(); disposeInboxReady?.();
  disposePreferences = disposeAutomation = disposeAutomationView = disposeInbox = disposeInboxReady = null;
  ui.disposeDetailRequests?.();
  if (refreshTimer !== null) clearInterval(refreshTimer); if (liveTimer !== null) clearInterval(liveTimer);
  if (hashListener !== null) globalThis.removeEventListener?.('hashchange', hashListener);
  refreshTimer = liveTimer = hashListener = null;
  closeTranscriptView(); resetUiState(); resetTranscriptReaders(); closeExplanationPanel(); closeQuickExplanationPanel();
  initAppearance(); setProjectIdentity(); applyReducedMotion(readPref('reduceMotion')); configureWorkspaceShell(); initHelp(); initGlobalNavigation();
  renderAutoSelectBanner(null); renderGlobalInboxSummary(null);
  disposePreferences = startDevicePreferencesSync();
  disposeAutomationView = onDeviceAutomation(status => {
    if (active()) renderAutoSelectBanner(status.model, { offline: status.offline });
  });
  disposeAutomation = startDeviceAutomationObserver();
  let inboxStarted = false, localInbox = null;
  disposeInboxReady = onDevicePreferences(status => {
    if (!active() || inboxStarted || !status.ready || status.error) return;
    // Do not let an old browser cache authorize a notification before the first authoritative preference read.
    inboxStarted = true;
    void import('./global-notice-notifications.js').then(module => {
      if (!active()) return;
      localInbox = module.startGlobalNoticeObserver({
        onSummary: summary => { if (active()) renderGlobalInboxSummary(summary); },
        enabled: () => active() && readPref('noticeNotifications'),
        read: (url, options) => {
          if (!active()) { localInbox?.(); return Promise.reject(new DOMException('工作台已离开', 'AbortError')); }
          return api(url, options);
        },
      });
      disposeInbox = localInbox;
    }).catch(error => { if (active()) show(`全局提醒暂不可用：${error.message}`, 'error'); });
  });
  await ensureProject(); if (!active()) return;
  const context = workbenchStatus(), projectReady = context.projectUsable;
  configureWorkspaceShell();
  const currentProject = (context.host?.projects || []).find(row => row.id === projectRoute());
  if (projectRoute()) {
    if (currentProject) setProjectIdentity(currentProject.name, currentProject.project);
    const appearance = initAppearance({ projectId: projectRoute(), request: api });
    await appearance.load(true); if (!active()) return;
  }
  if (projectRoute() && !projectReady) { if (!currentProject) $('project').textContent = '项目不可用'; $('connection').textContent = context.host?.mode === 'offline' ? 'Host 离线' : '项目身份不可用'; }
  else if (!projectRoute() && context.host?.mode === 'offline') $('connection').textContent = 'Host 离线';
  initContextReferences(); initHelp();
  const goOverview = () => projectReady ? overview().catch(report) : projectRoute() ? noProjectView() : openProjectManager();
  workspaceLink('home', '#projects', () => openProjectManager());
  $('overview-open').onclick = goOverview;
  if ($('home')) {
    $('home').setAttribute('aria-label', 'Lush · 用户工作台');
    if (projectRoute()) $('home').setAttribute('data-help', '在新标签打开上级用户工作台，当前项目的输入与阅读位置保留。');
    else $('home').removeAttribute('data-help');
  }
  const projectOnly = ['overview-open', 'task-graph-open', 'inputs-open', 'versions-open', 'hooks-open', 'quick-explain-history-open'];
  for (const id of projectOnly) { const target = $(id); if (target) { target.disabled = !projectReady; target.setAttribute('aria-disabled', String(!projectReady)); } }
  if ($('composer-shell')) $('composer-shell').hidden = !projectReady;

  const composerReady = projectReady ? initComposer() : Promise.resolve();
  if (projectReady) { syncSidebarSortSelect(); $('sidebar-sort').addEventListener('change', onSidebarSortChange); }
  if ($('hooks-open')) $('hooks-open').onclick = () => projectReady ? openHooks() : noProjectView();
  if ($('versions-open')) $('versions-open').onclick = () => projectReady ? openVersions() : noProjectView();
  if ($('inputs-open')) $('inputs-open').onclick = () => projectReady ? openInputs() : noProjectView();
  if ($('input-history')) $('input-history').onclick = () => projectReady ? openInputs() : noProjectView();
  if ($('quick-explain-history-open')) $('quick-explain-history-open').onclick = () => projectReady ? openQuickExplanationHistory() : noProjectView();
  $('sidebar-toggle').onclick = () => {
    const open = $('sidebar').classList.toggle('mobile-open'); $('sidebar-toggle').setAttribute('aria-expanded', String(open));
    $('sidebar-toggle').textContent = open ? '收起菜单' : '导航菜单';
  };
  $('task-graph-open').onclick = () => projectReady ? openTaskGraph().catch(report) : noProjectView();
  $('view-back').onclick = () => { if ($('view-back').disabled) return; if (typeof window.history.back === 'function') return window.history.back(); return goOverview(); };
  if (projectReady) { initSidebar(); initNoticeRecords(); disposeRefreshPolling = initRefreshPolling(); }
  hashListener = onHashChange; globalThis.addEventListener?.('hashchange', hashListener);
  const initialView = onHashChange();
  if (projectReady) await refresh(); await initialView; await composerReady;
  if (!active()) return;
  if (projectReady) startTimers();
}
await boot();
