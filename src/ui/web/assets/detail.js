import { $ } from './dom.js';
import { api, loadHistory } from './api.js';
import { renderDetail, renderDetailError } from './render-detail.js';
import { activateDetailView } from './sidebar-ui.js';
import { transcriptCache, transcriptOpen, ui } from './state.js';
import { appendTranscriptSteps, loadTranscript } from './render-transcript.js';
import { HOT } from './format.js';

/** 拉取并渲染一个任务详情。 */
export async function loadDetail(taskId) {
  ui.selected = taskId;
  // 右栏同一时刻只归一个视图：点进任务就把分支图、信息页与文档页的标志一起放掉。
  ui.graphOpen = false; ui.graphRenderKey = null; ui.docsOpen = false; ui.settingsOpen = false;
  activateDetailView({ title: `任务 #${taskId}`, context: '任务详情', hint: '结果优先，过程与运行信息随后' });
  const navigated = ui.detailTask !== taskId;
  const scrolled = navigated ? 0 : $('detail').scrollTop;
  // window.history: a local `history` binding here would shadow the global and throw a TDZ error on click.
  // pushState（而不是 replace）让浏览器后退能回到概览或上一个任务；hash 没变时不重复压栈。
  if (location.hash !== `#task-${taskId}`) window.history.pushState(null, '', `#task-${taskId}`);
  let task, timeline, diff, usage;
  try {
    [task, timeline, diff, usage] = await Promise.all([
      api(`/api/task/${taskId}`), loadHistory(taskId).catch(() => ({ events: [], truncated: false })),
      api(`/api/task/${taskId}/diff`).catch(() => null),
      // agent 用量（模型、上下文、花费）来自 pi 会话记录：读不到会话不影响详情其余部分。
      api(`/api/task/${taskId}/usage`).catch(() => null),
    ]);
  } catch (error) {
    if (ui.selected === taskId) renderDetailError(taskId, error.message);
    throw error;
  }
  if (ui.selected !== taskId) return;
  if (transcriptOpen.has(taskId) && !transcriptCache.has(taskId) && usage?.files?.length) {
    try { await loadTranscript(taskId); transcriptCache.get(taskId).settled = !HOT.has(task.status); }
    catch (error) { transcriptCache.set(taskId, { steps: [], files: usage.files, error: error.message }); }
    if (ui.selected !== taskId) return;
  }
  const cached = transcriptCache.get(taskId);
  if (transcriptOpen.has(taskId) && cached && !cached.error) {
    if (HOT.has(task.status)) cached.settled = false;
    else if (!cached.settled) {
      // A terminal task no longer gets live ticks. Read its final tail once, without resetting the reader.
      const after = cached.next;
      try {
        const page = await api(`/api/task/${taskId}/transcript?after=${after}`);
        if (cached.next === after && transcriptCache.get(taskId) === cached) {
          cached.steps.push(...page.steps); cached.next = page.next; cached.has_more = page.has_more;
          cached.truncated = Boolean(cached.truncated || page.truncated); cached.settled = true;
          appendTranscriptSteps(taskId, page.steps);
        }
      } catch { /* Keep readable history; the next detail refresh can retry. */ }
      if (ui.selected !== taskId) return;
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
