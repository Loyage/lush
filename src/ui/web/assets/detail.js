import { $ } from './dom.js';
import { api, loadHistory } from './api.js';
import { renderDetail, renderDetailError } from './render-detail.js';
import { activateDetailView } from './sidebar-ui.js';
import { transcriptCache, transcriptOpen, ui } from './state.js';
import { appendTranscriptSteps, fetchTranscriptAfter, loadTranscript } from './render-transcript.js';
import { HOT } from './format.js';

let detailRequest = 0;
/** 拉取并渲染一个 AP 详情。 */
export async function loadDetail(apId) {
  ui.selected = apId;
  const view = activateDetailView({ view: 'ap', key: `ap-${apId}`, hash: `#ap-${apId}`,
    title: `AP #${apId}`, context: 'AP 列表', hint: '结果优先，过程与运行信息随后' });
  const request = ++detailRequest;
  const current = () => ui.view === view && request === detailRequest;
  const navigated = ui.detailAP !== apId;
  const scrolled = navigated ? 0 : $('detail').scrollTop;
  let ap, timeline, diff, usage;
  try {
    [ap, timeline, diff, usage] = await Promise.all([
      api(`/api/ap/${apId}`), loadHistory(apId).catch(() => ({ events: [], truncated: false })),
      api(`/api/ap/${apId}/diff`).catch(() => null),
      // agent 用量（模型、上下文、花费）来自 pi 会话记录：读不到会话不影响详情其余部分。
      api(`/api/ap/${apId}/usage`).catch(() => null),
    ]);
  } catch (error) {
    if (!current()) return;
    renderDetailError(apId, error.message);
    throw error;
  }
  if (!current()) return;
  if (transcriptOpen.has(apId) && !transcriptCache.has(apId) && usage?.files?.length) {
    try { await loadTranscript(apId); transcriptCache.get(apId).settled = !HOT.has(ap.status); }
    catch (error) { transcriptCache.set(apId, { steps: [], files: usage.files, error: error.message }); }
    if (!current()) return;
  }
  const cached = transcriptCache.get(apId);
  if (transcriptOpen.has(apId) && cached && !cached.error) {
    if (HOT.has(ap.status)) cached.settled = false;
    else if (!cached.settled) {
      // A terminal AP no longer gets live ticks. Read its final tail once, without resetting the reader.
      const after = cached.next;
      try {
        const page = await fetchTranscriptAfter(apId, after);
        if (cached.next === after && transcriptCache.get(apId) === cached) {
          cached.steps.push(...(page.steps || [])); cached.next = page.next ?? cached.next;
          if (cached.order !== 'desc') cached.has_more = page.has_more ?? false;
          cached.truncated = Boolean(cached.truncated || page.truncated); cached.settled = true;
          appendTranscriptSteps(apId, page.steps || []);
        }
      } catch { /* Keep readable history; the next detail refresh can retry. */ }
      if (!current()) return;
    }
  }
  if (ui.terminalOpen) return;
  timeline.onMore = before => loadHistory(apId, before);
  ui.selectedRevision = ap.updated_at; ui.detailAP = apId; ui.detailRenderedAt = Date.now(); ui.detailDirty = false;
  renderDetail(ap, timeline, diff, usage);
  $('detail').scrollTop = scrolled;
  if (navigated && window.matchMedia?.('(max-width: 760px)')?.matches) {
    $('sidebar').classList.remove('mobile-open');
    $('sidebar-toggle').setAttribute('aria-expanded', 'false');
    $('sidebar-toggle').textContent = '导航菜单';
    $('detail').scrollIntoView({ block: 'start', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }
  const tree = $('aps').querySelector(`[data-id="${apId}"]`);
  if (tree) for (const node of $('aps').children) node.classList.toggle('selected', node === tree);
}
