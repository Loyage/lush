import { $ } from './dom.js';
import { api, loadHistory } from './api.js';
import { renderDetail, renderDetailError } from './render-detail.js';
import { activateDetailView } from './sidebar-ui.js';
import { transcriptCache, transcriptOpen, ui } from './state.js';
import { appendTranscriptSteps, fetchTranscriptAfter, loadTranscript } from './render-transcript.js';
import { HOT } from './format.js';

let detailRequest = 0;
/** 拉取并渲染一个任务详情。 */
export async function loadDetail(taskId) {
  ui.selected = taskId;
  const view = activateDetailView({ view: 'task', key: `task-${taskId}`, hash: `#task-${taskId}`,
    title: `任务 #${taskId}`, context: '任务列表', hint: '结果优先，过程与运行信息随后' });
  const request = ++detailRequest;
  const current = () => ui.view === view && request === detailRequest;
  const navigated = ui.detailTask !== taskId;
  const scrolled = navigated ? 0 : $('detail').scrollTop;
  let task, timeline, diff, usage;
  try {
    [task, timeline, diff, usage] = await Promise.all([
      api(`/api/task/${taskId}`), loadHistory(taskId).catch(() => ({ events: [], truncated: false })),
      api(`/api/task/${taskId}/diff`).catch(() => null),
      // agent 用量（模型、上下文、花费）来自 pi 会话记录：读不到会话不影响详情其余部分。
      api(`/api/task/${taskId}/usage`).catch(() => null),
    ]);
  } catch (error) {
    if (!current()) return;
    renderDetailError(taskId, error.message);
    throw error;
  }
  if (!current()) return;
  if (transcriptOpen.has(taskId) && !transcriptCache.has(taskId) && usage?.files?.length) {
    try { await loadTranscript(taskId); transcriptCache.get(taskId).settled = !HOT.has(task.status); }
    catch (error) { transcriptCache.set(taskId, { steps: [], files: usage.files, error: error.message }); }
    if (!current()) return;
  }
  const cached = transcriptCache.get(taskId);
  if (transcriptOpen.has(taskId) && cached && !cached.error) {
    if (HOT.has(task.status)) cached.settled = false;
    else if (!cached.settled) {
      // A terminal task no longer gets live ticks. Read its final tail once, without resetting the reader.
      const after = cached.next;
      try {
        const page = await fetchTranscriptAfter(taskId, after);
        if (cached.next === after && transcriptCache.get(taskId) === cached) {
          cached.steps.push(...(page.steps || [])); cached.next = page.next ?? cached.next;
          if (cached.order !== 'desc') cached.has_more = page.has_more ?? false;
          cached.truncated = Boolean(cached.truncated || page.truncated); cached.settled = true;
          appendTranscriptSteps(taskId, page.steps || []);
        }
      } catch { /* Keep readable history; the next detail refresh can retry. */ }
      if (!current()) return;
    }
  }
  if (ui.terminalOpen) return;
  timeline.onMore = before => loadHistory(taskId, before);
  ui.selectedRevision = task.updated_at; ui.detailTask = taskId; ui.detailRenderedAt = Date.now(); ui.detailDirty = false;
  renderDetail(task, timeline, diff, usage);
  $('detail').scrollTop = scrolled;
  if (navigated && window.matchMedia?.('(max-width: 760px)')?.matches) {
    $('sidebar').classList.remove('mobile-open');
    $('sidebar-toggle').setAttribute('aria-expanded', 'false');
    $('sidebar-toggle').textContent = '导航菜单';
    $('detail').scrollIntoView({ block: 'start', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }
  const tree = $('tasks').querySelector(`[data-id="${taskId}"]`);
  if (tree) for (const node of $('tasks').children) node.classList.toggle('selected', node === tree);
}
