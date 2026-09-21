import { $ } from './dom.js';
import { api } from './api.js';
import { loadDetail } from './detail.js';
import { HOT } from './format.js';
import { liveTarget, liveTick } from './live.js';
import { clear, show } from './messages.js';
import { detail, registerNavigation } from './navigate.js';
import { syncComposer } from './composer.js';
import { graphFingerprint } from './graph-layout.js';
import { fetchGraph, loadGraph, openGraph } from './render-graph.js';
import { slotGauge } from './gauge.js';
import { paintUsageLast } from './render-agent.js';
import { renderDrafts } from './render-drafts.js';
import { renderIntents } from './render-intents.js';
import { renderNotices } from './render-notices.js';
import { renderOverview } from './render-overview.js';
import { renderSpecs } from './render-specs.js';
import { appendTranscriptSteps } from './render-transcript.js';
import { renderTree } from './render-tree.js';
import { activateDetailView } from './sidebar-ui.js';
import { saveFiltersPref, transcriptCache, ui } from './state.js';

/** 条件变了：存回 localStorage，再用最近一次快照就地重画三个列表（筛选条本身不重建）。
 *  `persist:false` 供「恢复默认设置」用：偏好已被删除，只把内存与页面拉回默认，不再把默认值写回存储。 */
export function applyFilters({ persist = true } = {}) {
  if (persist) saveFiltersPref();
  if (!ui.lastSnapshot) return;
  renderIntents(ui.lastSnapshot);
  renderTree(ui.lastSnapshot);
  renderSpecs(ui.lastSnapshot);
}

/**
 * 排序偏好变了：四个列表立刻就地重画，不等下一次轮询。
 * 传的是上一份快照，所以只用本地数据重排，不额外请求 daemon。
 */
export function applySort() {
  if (!ui.lastSnapshot) return;
  renderNotices(ui.lastSnapshot);
  renderIntents(ui.lastSnapshot);
  renderSpecs(ui.lastSnapshot);
  renderTree(ui.lastSnapshot);
}

/** 回到项目概览：清掉选中、分支图与地址栏 hash，再把概览重画一次。入口是左上角的 Lush 标志。 */
export async function overview() {
  ui.selected = null; ui.selectedRevision = null; ui.detailDirty = false; ui.overviewKey = null;
  ui.graphOpen = false; ui.graphRenderKey = null; ui.docsOpen = false; ui.settingsOpen = false;
  activateDetailView({ title: '项目概览', context: '工作空间', hint: '先看需要关注的分支、决定与运行状态' });
  if (location.hash) window.history.pushState(null, '', location.pathname);
  await refresh();
}

/* ---------- polling ---------- */
// 分支图不在每个 1.5s 轮询里打一遍 git：指纹变了也至少隔 3 秒才重拉一次。
const GRAPH_MIN_INTERVAL_MS = 3000;
// 指纹只覆盖任务与交付队列，不覆盖「用户在 UI 外新建的分支」，所以再加一条最长陈旧时间兜底：
// 到期无条件重拉一次，分支图 / 概览打开期间新分支最多约 10s 内出现，不用手点刷新。
const GRAPH_MAX_AGE_MS = 10000;

/** 该不该重拉 /api/graph：和「分支图」共用同一条陈旧规则（指纹变且距上次 ≥3s，或 ≥10s）——
 *  概览复用同一份 `ui.lastGraph`，两个视图不会各打一遍 git，也不会每次轮询都打。 */
function graphStale(data) {
  const fingerprint = graphFingerprint(data);
  const changed = Boolean(fingerprint) && fingerprint !== ui.graphFingerprint;
  const age = Date.now() - ui.graphFetchedAt;
  return (changed && age >= GRAPH_MIN_INTERVAL_MS) || age >= GRAPH_MAX_AGE_MS;
}

export async function refresh() {
  if (ui.busy) return; ui.busy = true;
  try {
    const data = await api('/api/snapshot');
    ui.lastSnapshot = data;
    $('project').textContent = data.status.project.split('/').filter(Boolean).at(-1) || data.status.project;
    $('project').title = data.status.project;
    $('connection').textContent = '已连接'; $('connection').classList.remove('offline');
    $('agents').replaceChildren(slotGauge(data));
    if (ui.offline) { ui.offline = false; clear(); }
    renderDrafts(data); renderIntents(data); renderTree(data); renderSpecs(data);
    const noticeBefore = ui.noticeFocus;
    renderNotices(data); syncComposer();
    // 概览、分支图、文档页共用一个右栏：谁开着，轮询就不把概览画回来。
    const overviewOpen = ui.selected === null && !ui.graphOpen && !ui.docsOpen && !ui.indexOpen && !ui.settingsOpen;
    if (overviewOpen) renderOverview(data);
    // 概览与分支图共用同一份 graph.get 读模型，也共用同一条陈旧规则：指纹变了且距上次拉图至少 3 秒
    // 才重拉，指纹没变时由最长陈旧时间兜底（分支可能在 UI 外被创建）。概览用当前轮询的快照先画，
    // 后台取图，拿到新图就地重画——不因取图阻塞首屏。
    if ((overviewOpen || ui.graphOpen) && graphStale(data)) {
      if (ui.graphOpen) await loadGraph();
      else fetchGraph().then(() => {
        if (ui.selected === null && !ui.graphOpen && !ui.docsOpen) renderOverview(ui.lastSnapshot ?? data);
      }).catch(error => { show(error.message, 'error'); });
    }
    const current = data.tasks.find(task => task.id === ui.selected);
    const editing = ui.detailDirty || [...$('detail').querySelectorAll('textarea')].some(node => node.value || node === document.activeElement);
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
  if (ui.busy || ui.liveBusy) return;
  const task = liveTarget(ui.lastSnapshot?.tasks || [], ui.selected);
  if (!task) return;
  const taskId = task.id;
  ui.liveBusy = true;
  try {
    await liveTick({
      task,
      // 只有用户已经展开、有缓存时才增量续读；没展开就不读整份会话文件。
      transcript: transcriptCache.get(taskId) ?? null,
      fetchUsage: id => api(`/api/task/${id}/usage`).catch(() => null),
      fetchTranscript: (id, after) => api(`/api/task/${id}/transcript?after=${after}`),
      publish: { usage: paintUsageLast, steps: appendTranscriptSteps },
    });
  } catch { /* 网络抖动交给主 refresh 的离线提示，live tick 不弹错 */ }
  finally { ui.liveBusy = false; }
}

// 装配：把实现注册进导航间接层，面板与 api.js 只认 navigate.js。
registerNavigation({ refresh, detail: loadDetail, overview, graph: openGraph });
