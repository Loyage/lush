import { $ } from './dom.js';
import { setProjectIdentity } from './project-identity.js';
import { renderSleepBanner } from './sleep-ui.js';
import { renderAutoSelectBanner } from './auto-select-banner.js';
import { api } from './api.js';
import { loadDetail } from './detail.js';
import { HOT } from './format.js';
import { createPollBackoff, liveTarget, liveTick } from './live.js';
import { clear, show } from './messages.js';
import { detail, registerNavigation } from './navigate.js';
import { syncComposer } from './composer.js';
import { loadTaskGraph } from './render-task-graph.js';
import { slotGauge } from './gauge.js';
import { paintUsageLast } from './render-agent.js';
import { renderNotices } from './render-notices.js';
import { renderNoticeBanner } from './notice-banner.js';
import { observeNotices } from './notice-notifications.js';
import { renderOverview } from './render-overview.js';
import { refreshProgressDurations } from './render-progress.js';
import { appendTranscriptSteps, fetchTranscriptAfter } from './render-transcript.js';
import { refreshTreeTimes, renderTree } from './render-tree.js';
import { projectBase } from './route.js';
import { readPref } from './prefs.js';
import { activateDetailView, openResource } from './sidebar-ui.js';
import { saveFiltersPref, transcriptCache, transcriptOpen, ui } from './state.js';

/** 条件变了：存回 localStorage，再用最近一次快照就地重画三个列表（筛选条本身不重建）。
 *  `persist:false` 供「恢复默认设置」用：偏好已被删除，只把内存与页面拉回默认，不再把默认值写回存储。 */
export function applyFilters({ persist = true } = {}) {
  if (persist) saveFiltersPref();
  if (!ui.lastSnapshot) return;
  renderTree(ui.lastSnapshot);
}

/**
 * 排序偏好变了：四个列表立刻就地重画，不等下一次轮询。
 * 传的是上一份快照，所以只用本地数据重排，不额外请求 daemon。
 */
export function applySort() {
  if (!ui.lastSnapshot) return;
  renderNotices(ui.lastSnapshot);
  renderTree(ui.lastSnapshot);
}

/** 回到项目概览：清掉选中与地址栏 hash，再把概览重画一次。 */
export async function overview() {
  activateDetailView({ view: 'overview' });
  ui.overviewKey = null;
  if (ui.lastSnapshot) renderOverview(ui.lastSnapshot);
  // Navigation must show cached content and return even while an automatic request is slow.
  if (ui.busy) { void refresh({ force: true }); return; }
  await refresh({ force: true });
}

/* ---------- polling ---------- */
// Task 图 Git 诊断有节流；无 Task 变更时也定期重读外部 Git 变动。
const GRAPH_MIN_INTERVAL_MS = 3000;
const GRAPH_MAX_AGE_MS = 10000;

function pollingSession() {
  return { active: true, main: null, followup: null, live: null, usage: null,
    overviewBackoff: createPollBackoff(), transcriptBackoff: createPollBackoff(), usageBackoff: createPollBackoff() };
}
let polling = pollingSession();
let disposePolling = null;
const hidden = () => globalThis.document?.hidden === true;
// A hidden tab is still open: preserve explicitly enabled system reminders without
// resuming heavy Git/detail/transcript reads or requesting notification permission.
const backgroundNotices = () => readPref('noticeNotifications') && globalThis.isSecureContext !== false
  && globalThis.Notification?.permission === 'granted';

/** app boot owns this lifecycle: disposing invalidates in-flight reads as well as the listener. */
export function initRefreshPolling() {
  disposePolling?.();
  polling.active = false;
  const session = polling = pollingSession();
  const doc = globalThis.document, base = projectBase();
  const resume = async () => {
    if (hidden() || !session.active || globalThis.document !== doc || projectBase() !== base) return;
    session.overviewBackoff.reset(); session.transcriptBackoff.reset(); session.usageBackoff.reset();
    // Forced refresh queues behind an in-flight snapshot instead of losing the visibility event.
    await Promise.all([refresh({ force: true }), liveRefresh()]);
  };
  globalThis.addEventListener?.('visibilitychange', resume);
  const dispose = () => {
    if (!session.active) return;
    session.active = false;
    globalThis.removeEventListener?.('visibilitychange', resume);
    if (disposePolling === dispose) disposePolling = null;
  };
  disposePolling = dispose;
  return dispose;
}

/** Timer entry. Explicit actions use the force wrapper registered with navigate.js below. */
export async function refresh({ force = false } = {}) {
  const session = polling;
  if (!session.active || (!force && ((hidden() && !backgroundNotices()) || !session.overviewBackoff.ready()))) return;
  if (session.main) {
    if (!force) return;
    // Coalesce ACK/action refreshes without swallowing them behind the automatic single flight.
    if (!session.followup) session.followup = session.main.then(() => {
      session.followup = null;
      if (session.active) return refresh({ force: true });
    });
    return session.followup;
  }
  if (ui.busy) return;
  const doc = globalThis.document, base = projectBase();
  const current = () => session.active && polling === session && globalThis.document === doc && projectBase() === base;
  ui.busy = true;
  session.main = runRefresh(session, current).finally(() => {
    session.main = null;
    if (current()) ui.busy = false;
  });
  return session.main;
}

async function runRefresh(session, currentResponse) {
  try {
    const since = ui.lastSnapshot?.revision;
    let response;
    try { response = await api(`/api/overview${since ? `?revision=${encodeURIComponent(since)}` : ''}`); }
    catch (error) {
      // Mixed-version compatibility: an old Web host/DOM fixture only knows the legacy full snapshot.
      if (since) throw error;
      response = await api('/api/snapshot');
    }
    if (!currentResponse()) return;
    session.overviewBackoff.reset();
    const changed = !response.unchanged;
    // A response begun before deletion may contain rows that no longer exist.
    if (changed && ui.deletedWorkerIds.size) {
      response.tasks = response.tasks.filter(task => !ui.deletedWorkerIds.has(task.id));
      if (response.notices) response.notices = response.notices.filter(notice => !ui.deletedWorkerIds.has(notice.task_id));
    }
    const data = changed ? response : ui.lastSnapshot;
    if (!data) return;
    if (changed) {
      // Keep explicitly loaded historical pages visible across bounded polling refreshes.
      if (ui.taskHistory?.length) {
        const byId = new Map([...ui.taskHistory, ...response.tasks].map(task => [task.id, task]));
        response.tasks = [...byId.values()].sort((a, b) => a.id - b.id);
        response.task_page = ui.taskHistoryPage ?? response.task_page;
      } else ui.taskHistoryPage = response.task_page;
      ui.lastSnapshot = response;
    }
    if (ui.transcriptView) ui.transcriptView.paintStatus?.(data.tasks?.find(task => task.id === ui.transcriptView.taskId));
    setProjectIdentity('', data.status.project);
    $('connection').textContent = '已连接'; $('connection').classList.remove('offline');
    if (ui.offline) { ui.offline = false; clear(); }
    renderSleepBanner(data.status.sleep);
    renderAutoSelectBanner(data.status.auto_select);
    refreshTreeTimes();
    const noticeBefore = ui.noticeFocus;
    if (changed) {
      $('agents').replaceChildren(slotGauge(data));
      renderTree(data); renderNotices(data); renderNoticeBanner(data); observeNotices(data); syncComposer();
    }
    // Enabled system reminders continue in hidden tabs, but heavy view reads stay paused.
    if (hidden()) return;
    // 页面身份决定谁拥有画布，轮询不覆盖其它页面。
    const overviewOpen = ui.view?.id === 'overview';
    if (overviewOpen) renderOverview(data);
    const taskGraphAge = Date.now() - ui.taskGraphFetchedAt;
    if (ui.view?.id === 'task-graph' && (taskGraphAge >= GRAPH_MAX_AGE_MS || (changed && taskGraphAge >= GRAPH_MIN_INTERVAL_MS))
      && ![...$('detail').querySelectorAll('textarea')].some(node => node === document.activeElement || node.value)) {
      // Heavy Git/session reads have their own single flight, not the global refresh lock.
      void loadTaskGraph().catch(error => {
        if (ui.view?.id === 'task-graph') show(`Worker 树更新失败：${error.message}`, 'error');
      });
    }
    const current = data.tasks.find(task => task.id === ui.selected);
    let readingFocused = false;
    for (let node = document.activeElement; node; node = node.parentNode) {
      if (node.classList?.contains('transcript')) { readingFocused = true; break; }
    }
    const selecting = Boolean(window.getSelection?.()?.toString());
    const editing = ui.transcriptView || selecting || readingFocused || ui.detailDirty || [...$('detail').querySelectorAll('textarea')].some(node => node.value || node === document.activeElement);
    if (current && !editing) {
      // Live tasks also refresh on a slow tick so elapsed time and agent pid stay honest.
      const changed = current.updated_at !== ui.selectedRevision;
      const tick = HOT.has(current.status) && Date.now() - ui.detailRenderedAt > 15000;
      if (changed || tick) await detail(ui.selected);
    }
    // 展开中的 notice 被别处答复/忽略后，右侧要收敛回普通任务详情。
    if (noticeBefore !== ui.noticeFocus && ui.selected !== null && !editing) await detail(ui.selected);
  } catch (error) {
    if (!currentResponse()) return;
    session.overviewBackoff.failed();
    $('connection').textContent = '离线 · 自动重连'; $('connection').classList.add('offline');
    ui.offline = true;
    renderAutoSelectBanner(ui.lastSnapshot?.status?.auto_select, { offline: true });
    show(error.message, 'error');
  }
}

/* ---------- 热任务的实时刷新：页面自己变新，不用手点 ---------- */
export async function liveRefresh() {
  const session = polling;
  if (!session.active || hidden()) return;
  refreshTreeTimes(); refreshProgressDurations();
  const tasks = ui.lastSnapshot?.tasks || [];
  const cached = transcriptCache.get(ui.selected);
  const hotTask = liveTarget(tasks, ui.selected);
  // An explicitly opened reader keeps retrying its final tail even after the Worker settles.
  const task = hotTask || (transcriptOpen.has(ui.selected) && cached && !cached.error && !cached.settled
    ? tasks.find(value => value.id === ui.selected) : null);
  if (!task) return;
  const taskId = task.id;
  const transcript = transcriptOpen.has(taskId) ? transcriptCache.get(taskId) ?? null : null;
  const view = ui.view, reader = ui.transcriptView, doc = globalThis.document, base = projectBase();
  const current = () => session.active && polling === session && globalThis.document === doc && projectBase() === base
    && ui.selected === taskId && ui.view === view && ui.transcriptView === reader && !ui.deletedWorkerIds.has(taskId)
    && (!transcript || (transcriptOpen.has(taskId) && transcriptCache.get(taskId) === transcript));
  if (session.backoffTask !== taskId) {
    session.backoffTask = taskId;
    session.transcriptBackoff.reset(); session.usageBackoff.reset();
  }
  // A slow old Worker read must not hold the next Worker's log hostage.
  if (session.live?.taskId === taskId && session.live.transcript === transcript && session.live.view === view) return;
  if (!session.transcriptBackoff.ready()) return;
  const request = session.live = { taskId, transcript, view };
  ui.liveBusy = true;
  try {
    const updated = await liveTick({
      task,
      // 仅显式展开时续读；收起后不继续加载正文。
      transcript,
      current, detachUsage: true,
      fetchUsage: async id => {
        if (!current() || session.usage?.taskId === id || !session.usageBackoff.ready()) return null;
        const usageRequest = session.usage = { taskId: id };
        try {
          const usage = await api(`/api/worker/${id}/usage`);
          if (!current() || session.usage !== usageRequest) return null;
          session.usageBackoff.reset();
          return usage;
        } catch {
          if (current()) session.usageBackoff.failed();
          return null;
        } finally { if (session.usage === usageRequest) session.usage = null; }
      },
      fetchTranscript: fetchTranscriptAfter,
      publish: { usage: paintUsageLast, steps: (id, steps) => {
        if (transcriptCache.get(id) === transcript) appendTranscriptSteps(id, steps);
      } },
    });
    if (current()) {
      session.transcriptBackoff.reset();
      if (transcript && updated.tailRead) transcript.settled = !hotTask;
    }
  } catch {
    if (current()) session.transcriptBackoff.failed();
    /* 网络抖动交给主 refresh 的离线提示，live tick 不弹错 */
  } finally {
    if (session.live === request) { session.live = null; if (session.active) ui.liveBusy = false; }
  }
}

// 装配：把实现注册进导航间接层，面板与 api.js 只认 navigate.js。
registerNavigation({ refresh: () => refresh({ force: true }), detail: loadDetail, overview, resource: openResource });
