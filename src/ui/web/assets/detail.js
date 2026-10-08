import { $ } from './dom.js';
import { api, loadHistory, projectApi } from './api.js';
import { renderDetail, renderDetailError } from './render-detail.js';
import { activateDetailView, setViewChrome } from './sidebar-ui.js';
import { transcriptCache, transcriptOpen, ui } from './state.js';
import { appendTranscriptSteps, fetchTranscriptAfter, loadTranscript } from './render-transcript.js';
import { HOT } from './format.js';
import { workerLabel } from './worker-label.js';
import { routeContext } from './route.js';

let detailRequest = 0, supplemental = null;
const read = promise => promise.then(value => ({ value, available: true }), () => ({ value: null, available: false }));

/** Only an already-open reader may fetch records, including one final terminal tail. */
async function updateOpenTranscript(task, usage, current) {
  const taskId = task.id;
  if (!current() || !transcriptOpen.has(taskId)) return;
  if (!transcriptCache.has(taskId) && usage?.files?.length) {
    try {
      await loadTranscript(taskId);
      const loaded = transcriptCache.get(taskId);
      if (current() && loaded) loaded.settled = !HOT.has(task.status);
    } catch (error) {
      if (current()) transcriptCache.set(taskId, { steps: [], files: usage.files, error: error.message });
    }
    if (!current()) return;
  }
  const cached = transcriptCache.get(taskId);
  if (!cached || cached.error) return;
  if (HOT.has(task.status)) { cached.settled = false; return; }
  if (cached.settled) return;
  const after = cached.next;
  try {
    const page = await fetchTranscriptAfter(taskId, after);
    if (current() && cached.next === after && transcriptCache.get(taskId) === cached) {
      cached.steps.push(...(page.steps || [])); cached.next = page.next ?? cached.next;
      if (cached.order !== 'desc') cached.has_more = page.has_more ?? false;
      cached.truncated = Boolean(cached.truncated || page.truncated); cached.settled = true;
      appendTranscriptSteps(taskId, page.steps || []);
    }
  } catch { /* Keep readable history; the next detail refresh can retry. */ }
}

/** Show the Worker first; slow supplementary reads must not delay navigation/notice ACK. */
export async function loadDetail(taskId) {
  if (ui.deletedWorkerIds.has(taskId)) return false;
  supplemental?.dispose(); supplemental = null;
  ui.selected = taskId;
  const project = projectApi('/api/');
  const view = activateDetailView({ view: 'task', key: `task-${taskId}`, hash: `#worker-${taskId}`,
    title: `Worker ${workerLabel(taskId)}`, context: 'Worker 列表', hint: '结果优先，过程与运行信息随后' });
  const request = ++detailRequest;
  const current = () => !routeContext().invalid && projectApi('/api/') === project && ui.view === view && ui.selected === taskId
    && request === detailRequest && !ui.deletedWorkerIds.has(taskId);
  const navigated = ui.detailTask !== taskId;
  const extra = {
    history: read(loadHistory(taskId)),
    diff: read(api(`/api/worker/${taskId}/diff`)),
    usage: read(api(`/api/worker/${taskId}/usage`)),
    connections: read(api('/api/agent/connections').then(value => value?.connections ?? null)),
  };
  let task;
  try { task = await api(`/api/worker/${taskId}`); }
  catch (error) {
    if (!current()) return false;
    renderDetailError(taskId, error.message);
    ui.composerTask = null; ui.composerError = 'Worker 读取失败；请重新打开详情。'; ui.syncComposer?.();
    throw error;
  }
  if (!current()) return false;
  // A fullscreen reader still needs its terminal tail, without repainting the hidden detail.
  if (transcriptOpen.has(taskId)) {
    if (transcriptCache.has(taskId)) void updateOpenTranscript(task, null, current);
    else void extra.usage.then(({ value }) => updateOpenTranscript(task, value, current));
  }
  if (ui.transcriptView) return false;
  setViewChrome(`Worker ${workerLabel(task)}`, 'Worker 列表', '结果优先，过程与运行信息随后');
  ui.selectedRevision = task.updated_at; ui.detailTask = taskId; ui.detailRenderedAt = Date.now(); ui.detailDirty = false;
  const patches = renderDetail(task, { loading: true, events: [] }, null, null, null, { current });
  supplemental = patches;
  ui.composerTask = task; ui.composerError = null; ui.syncComposer?.();
  // Preserve reading moves made while the request was in flight, including the history renderer's anchor correction.
  if (navigated) $('detail').scrollTop = 0;
  if (navigated && window.matchMedia?.('(max-width: 760px)')?.matches) {
    $('sidebar').classList.remove('mobile-open');
    $('sidebar-toggle').setAttribute('aria-expanded', 'false');
    $('sidebar-toggle').textContent = '导航菜单';
    $('detail').scrollIntoView({ block: 'start', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }
  const tree = $('tasks').querySelector(`[data-id="${taskId}"]`);
  if (tree) for (const node of $('tasks').children) node.classList.toggle('selected', node === tree);
  for (const [kind, promise] of Object.entries(extra)) {
    void promise.then(({ value, available }) => {
      if (!current()) { patches.dispose(); return; }
      if (kind !== 'diff' && value == null) available = false;
      if (kind === 'history' && available) value.onMore = before => loadHistory(taskId, before);
      patches.update(kind, value, available);
    });
  }
  return current();
}
