import { $ } from './dom.js';
import { api } from './api.js';
import { loadDetail } from './detail.js';
import { HOT } from './format.js';
import { liveTarget, liveTick } from './live.js';
import { detail, registerNavigation } from './navigate.js';
import { syncComposer } from './composer.js';
import { slotGauge } from './gauge.js';
import { paintUsageLast } from './render-agent.js';
import { renderDrafts } from './render-drafts.js';
import { renderIntents } from './render-intents.js';
import { renderNotices } from './render-notices.js';
import { renderOverview } from './render-overview.js';
import { renderSpecs } from './render-specs.js';
import { appendTranscriptSteps } from './render-transcript.js';
import { renderTree } from './render-tree.js';
import { saveFiltersPref, transcriptCache, ui } from './state.js';

/** 条件变了：存回 localStorage，再用最近一次快照就地重画三个列表（筛选条本身不重建）。 */
export function applyFilters() {
  saveFiltersPref();
  if (!ui.lastSnapshot) return;
  renderIntents(ui.lastSnapshot);
  renderTree(ui.lastSnapshot);
  renderSpecs(ui.lastSnapshot);
}

/** 回到项目概览：清掉选中与地址栏 hash，再把概览重画一次。入口是左上角的 Lush 标志。 */
export async function overview() {
  ui.selected = null; ui.selectedRevision = null; ui.detailDirty = false; ui.overviewKey = null;
  if (location.hash) window.history.replaceState(null, '', location.pathname);
  await refresh();
}

/* ---------- polling ---------- */
export async function refresh() {
  if (ui.busy) return; ui.busy = true;
  try {
    const data = await api('/api/snapshot');
    ui.lastSnapshot = data;
    $('project').textContent = data.status.project;
    $('project').title = data.status.project;
    $('connection').textContent = '已连接'; $('connection').classList.remove('offline');
    $('agents').replaceChildren(slotGauge(data));
    if (ui.offline) { ui.offline = false; $('error').textContent = ''; }
    renderDrafts(data); renderIntents(data); renderTree(data); renderSpecs(data);
    const noticeBefore = ui.noticeFocus;
    renderNotices(data); syncComposer();
    if (ui.selected === null) renderOverview(data);
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
    ui.offline = true; $('error').textContent = error.message;
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
registerNavigation({ refresh, detail: loadDetail, overview });
