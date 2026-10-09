import { $ } from './dom.js';
import { api, isReadAbort, loadConnectionNames, loadHistory, projectApi, withReadSignal } from './api.js';
import { renderDetail, renderDetailError } from './render-detail.js';
import { activateDetailView, setViewChrome } from './sidebar-ui.js';
import { transcriptCache, transcriptOpen, ui } from './state.js';
import { appendTranscriptSteps, fetchTranscriptAfter, loadTranscript } from './render-transcript.js';
import { liveTarget } from './live.js';
import { workerLabel } from './worker-label.js';
import { routeContext } from './route.js';

let detailRequest = 0, supplemental = null, lifetime = null;
export function disposeDetailRequests() {
  lifetime?.abort(); lifetime = null;
  supplemental?.dispose(); supplemental = null;
}
const read = promise => promise.then(value => ({ value, available: true }), () => ({ value: null, available: false }));

/** Only an already-open reader may fetch records, including final non-live tail pages. */
async function updateOpenTranscript(task, current, signal) {
  const taskId = task.id;
  if (!current() || !transcriptOpen.has(taskId)) return;
  // An explicitly opened reader can read independently of optional usage metadata.
  if (!transcriptCache.has(taskId)) {
    try {
      await withReadSignal(signal, () => loadTranscript(taskId));
      const loaded = transcriptCache.get(taskId);
      if (current() && loaded) loaded.settled = false;
    } catch (error) {
      if (current() && !isReadAbort(error) && !transcriptCache.has(taskId)) {
        transcriptCache.set(taskId, { steps: [], error: error.message });
      }
    }
    if (!current() || !transcriptOpen.has(taskId)) return;
  }
  const cached = transcriptCache.get(taskId);
  if (!cached || cached.error) return;
  // Match the actual live reader targets, not HOT's broader detail-refresh states.
  if (liveTarget([task], taskId)) { cached.settled = false; return; }
  if (cached.settled) return;
  const after = cached.next ?? 0, order = cached.order;
  try {
    const page = await withReadSignal(signal, () => fetchTranscriptAfter(taskId, after));
    if (current() && transcriptOpen.has(taskId) && (cached.next ?? 0) === after
      && cached.order === order && transcriptCache.get(taskId) === cached) {
      // Match the parent's liveTick incremental contract: reject overlapping server rows
      // and keep the shared cache cursor monotonic even when page.next lags its records.
      const known = new Set(cached.steps.map(step => step.seq)), steps = [];
      for (const step of page.steps || []) {
        if (!(step.seq > after) || known.has(step.seq)) continue;
        known.add(step.seq); steps.push(step);
      }
      if (steps.length) {
        cached.steps.push(...steps);
        cached.next = Math.max(after, page.next ?? 0, ...steps.map(step => step.seq));
      }
      if (cached.order !== 'desc') cached.has_more = page.has_more ?? false;
      cached.truncated = Boolean(cached.truncated || page.truncated);
      // Only an accepted, successful final page may close terminal tail polling.
      cached.settled = !page.has_more;
      if (steps.length) appendTranscriptSteps(taskId, steps);
    }
  } catch { /* Keep readable history; the next detail refresh can retry. */ }
}

/** Show the Worker first; slow supplementary reads must not delay navigation/notice ACK. */
export async function loadDetail(taskId) {
  if (ui.deletedWorkerIds.has(taskId)) return false;
  ui.disposeDetailRequests = disposeDetailRequests;
  disposeDetailRequests();
  ui.selected = taskId;
  const project = projectApi('/api/');
  const view = activateDetailView({ view: 'task', key: `task-${taskId}`, hash: `#worker-${taskId}`,
    title: `Worker ${workerLabel(taskId)}`, context: 'Worker 列表', hint: '结果优先，过程与运行信息随后' });
  const request = ++detailRequest;
  const boot = ui.workerNumbers, ownerDocument = globalThis.document;
  const reads = new AbortController();
  const current = () => globalThis.document === ownerDocument && !reads.signal.aborted && ui.workerNumbers === boot && !routeContext().invalid
    && projectApi('/api/') === project && ui.view === view && ui.selected === taskId
    && request === detailRequest && !ui.deletedWorkerIds.has(taskId);
  lifetime = reads;
  const options = { signal: reads.signal };
  const navigated = ui.detailTask !== taskId;
  let task;
  // The first read is always the core inspect. No Git/history/usage competes with it.
  try { task = await api(`/api/worker/${taskId}`, options); }
  catch (error) {
    if (!current() || isReadAbort(error)) return false;
    reads.abort();
    renderDetailError(taskId, error.message);
    ui.composerTask = null; ui.composerError = 'Worker 读取失败；请重新打开详情。'; ui.syncComposer?.();
    throw error;
  }
  if (!current()) return false;
  // A fullscreen reader still needs its terminal tail, without repainting the hidden detail.
  if (transcriptOpen.has(taskId)) void updateOpenTranscript(task, current, reads.signal);
  if (ui.transcriptView) return false;
  setViewChrome(`Worker ${workerLabel(task)}`, 'Worker 列表', '结果优先，过程与运行信息随后');
  ui.selectedRevision = task.updated_at; ui.detailTask = taskId; ui.detailRenderedAt = Date.now(); ui.detailDirty = false;
  let diffPending = null;
  const requestDiff = () => {
    if (!current() || diffPending) return diffPending;
    diffPending = read(api(`/api/worker/${taskId}/diff`, options)).then(({ value, available }) => {
      if (current()) patches.update('diff', value, available);
    }).finally(() => { diffPending = null; });
    return diffPending;
  };
  const patches = renderDetail(task, { loading: true, events: [] }, null, null, null, { current, requestDiff, signal: reads.signal });
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
  const extra = {
    history: read(loadHistory(taskId, null, options)),
    ...(task.calls ? { usage: read(api(`/api/worker/${taskId}/usage`, options)) } : {}),
    ...(['order', 'child', 'say'].includes(task.task_kind) ? { connections: read(loadConnectionNames(options)) } : {}),
  };
  for (const [kind, promise] of Object.entries(extra)) {
    void promise.then(({ value, available }) => {
      if (!current()) { patches.dispose(); return; }
      if (kind !== 'diff' && value == null) available = false;
      if (kind === 'history' && available) value.onMore = before => loadHistory(taskId, before, options);
      patches.update(kind, value, available);
    });
  }
  return current();
}
