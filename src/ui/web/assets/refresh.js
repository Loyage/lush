import { $ } from './dom.js';
import { renderSleepBanner } from './sleep-ui.js';
import { api } from './api.js';
import { loadDetail } from './detail.js';
import { HOT } from './format.js';
import { liveTarget, liveTick } from './live.js';
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
import { renderTree } from './render-tree.js';
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
  await refresh();
}

/* ---------- polling ---------- */
// Task 图 Git 诊断有节流；无 Task 变更时也定期重读外部 Git 变动。
const GRAPH_MIN_INTERVAL_MS = 3000;
const GRAPH_MAX_AGE_MS = 10000;

export async function refresh() {
  if (ui.busy) return; ui.busy = true;
  try {
    const since = ui.lastSnapshot?.revision;
    let response;
    try { response = await api(`/api/overview${since ? `?revision=${encodeURIComponent(since)}` : ''}`); }
    catch (error) {
      // Mixed-version compatibility: an old Web host/DOM fixture only knows the legacy full snapshot.
      if (since) throw error;
      response = await api('/api/snapshot');
    }
    const changed = !response.unchanged;
    const data = changed ? response : ui.lastSnapshot;
    if (!data) return;
    if (changed) {
      // Keep explicitly loaded historical pages visible across bounded polling refreshes.
      if (ui.taskHistory?.length) {
        const byId = new Map([...ui.taskHistory, ...response.tasks].map(task => [task.id, task]));
        response.tasks = [...byId.values()].filter(task => ['say','child','main','owner'].includes(task.task_kind)).sort((a, b) => a.id - b.id);
        response.task_page = ui.taskHistoryPage ?? response.task_page;
      } else ui.taskHistoryPage = response.task_page;
      ui.lastSnapshot = response;
    }
    $('project').textContent = data.status.project.split('/').filter(Boolean).at(-1) || data.status.project;
    $('project').title = data.status.project;
    $('connection').textContent = '已连接'; $('connection').classList.remove('offline');
    if (ui.offline) { ui.offline = false; clear(); }
    renderSleepBanner(data.status.sleep);
    const noticeBefore = ui.noticeFocus;
    if (changed) {
      $('agents').replaceChildren(slotGauge(data));
      renderTree(data); renderNotices(data); renderNoticeBanner(data); observeNotices(data); syncComposer();
    }
    // 页面身份决定谁拥有画布，轮询不覆盖其它页面。
    const overviewOpen = ui.view?.id === 'overview';
    if (overviewOpen) renderOverview(data);
    const taskGraphAge = Date.now() - ui.taskGraphFetchedAt;
    if (ui.view?.id === 'task-graph' && (taskGraphAge >= GRAPH_MAX_AGE_MS || (changed && taskGraphAge >= GRAPH_MIN_INTERVAL_MS))
      && ![...$('detail').querySelectorAll('textarea')].some(node => node === document.activeElement || node.value)) {
      await loadTaskGraph();
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
    $('connection').textContent = '离线 · 自动重连'; $('connection').classList.add('offline');
    ui.offline = true; show(error.message, 'error');
  } finally { ui.busy = false; }
}

/* ---------- 热任务的实时刷新：页面自己变新，不用手点 ---------- */
export async function liveRefresh() {
  refreshProgressDurations();
  if (ui.busy || ui.liveBusy) return;
  const tasks = ui.lastSnapshot?.tasks || [];
  const cached = transcriptCache.get(ui.selected);
  const hotTask = liveTarget(tasks, ui.selected);
  // A fullscreen reader stays open when the Task settles: read the final tail once as on the task page.
  const task = hotTask || (ui.transcriptView && cached && !cached.error && !cached.settled
    ? tasks.find(value => value.id === ui.selected) : null);
  if (!task) return;
  const taskId = task.id;
  const transcript = transcriptOpen.has(taskId) ? transcriptCache.get(taskId) ?? null : null;
  ui.liveBusy = true;
  try {
    await liveTick({
      task,
      // 仅显式展开时续读；收起后不继续加载正文。
      transcript,
      fetchUsage: id => api(`/api/task/${id}/usage`).catch(() => null),
      fetchTranscript: fetchTranscriptAfter,
      publish: { usage: paintUsageLast, steps: (id, steps) => {
        if (transcriptCache.get(id) === transcript) appendTranscriptSteps(id, steps);
      } },
    });
    if (transcript && transcriptCache.get(taskId) === transcript) transcript.settled = !hotTask;
  } catch { /* 网络抖动交给主 refresh 的离线提示，live tick 不弹错 */ }
  finally { ui.liveBusy = false; }
}

// 装配：把实现注册进导航间接层，面板与 api.js 只认 navigate.js。
registerNavigation({ refresh, detail: loadDetail, overview, resource: openResource });
