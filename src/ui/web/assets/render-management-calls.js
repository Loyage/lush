import { block, button, el } from './dom.js';
import { api, isReadAbort, projectApi } from './api.js';
import { routeContext } from './route.js';
import { ui } from './state.js';
import { workerLabel } from './worker-label.js';
import { linkWorkerNumbers } from './worker-links.js';
import { absolute } from './format.js';
import { captureDetailReading, restoreDetailReading } from './detail-reading.js';
import { createCallsState, mergeCalls, callStatus } from './management-calls-model.js';

const inside = (root, node) => { for (let at = node; at; at = at.parentNode) if (at === root) return true; return false; };
const safeDetails = row => ({
  params: Object.fromEntries(Object.entries(row.params || {}).filter(([key, value]) =>
    (['id','parent','before','after','limit','offset','seq','days','expected_revision'].includes(key) && Number.isSafeInteger(value) && value >= 0)
    || (['enabled','start','defer','history','keep_branch','force'].includes(key) && typeof value === 'boolean')
    || ({ scope: ['all','tree','work','device','project'], access: ['read','automatic','confirmation','unavailable'],
      action: ['start','retry'], level: ['off','merge','accept','archive'] }[key]?.includes?.(value)))),
  result: summary(row.result),
});
function summary(value, nested = true) {
  const out = {};
  for (const key of ['id','receipt_id','target_id','notice_id']) if (Number.isSafeInteger(value?.[key]) && value[key] > 0) out[key] = value[key];
  if (['succeeded','waiting','skipped','unknown','pending_confirmation','approved','rejected','failed','running','cancelled'].includes(value?.status)) out.status = value.status;
  if (nested && value?.action && typeof value.action === 'object') out.action = summary(value.action, false);
  if (['start','retry'].includes(value?.action)) out.action = value.action;
  return out;
}

/** One mounted detail only; all reads use its existing refresh/lifetime, never a timer. */
export function renderManagementCalls(task, previous, options = {}) {
  const project = projectApi('/api/'), boot = ui.workerNumbers, doc = globalThis.document;
  let section = previous;
  if (!section || section.callsIdentity?.project !== project || section.callsIdentity?.boot !== boot
    || section.callsIdentity?.doc !== doc || section.callsIdentity?.id !== task.id) {
    previous?.disposeCalls?.();
    section = block('接口调用时间线'); section.classList.add('management-calls');
    section.callsIdentity = { project, boot, doc, id: task.id };
    const state = createCallsState(), nodes = new Map();
    let binding = null, generation = 0, controller = null, busy = false, error = false;
    let pending = false, projections = [], needsProjection = false;
    const coverage = el('p', '按开始 Event ID 正序；首次仅最新 50 个事件（非全历史序号）。仅覆盖可信 RPC；不补旧历史或桥接前拒绝，不展示任意原文。', 'hint');
    const status = el('p', '调用记录加载中…', 'hint management-calls-status');
    const older = button('加载更早调用', () => read('older'), 'ghost');
    const newer = button('读取最新调用', () => read(state.loaded ? 'newer' : 'initial'), 'ghost');
    const retry = button('重试读取', () => read(failedDirection), 'ghost');
    const recheck = button('继续核对未完成调用', () => read('projection'), 'ghost');
    const controls = el('div', undefined, 'management-calls-controls'); controls.append(older, newer, retry, recheck);
    const list = el('ol', undefined, 'management-calls-list');
    section.append(coverage, status, controls, list);
    let failedDirection = 'initial';
    const current = (version = generation) => binding && generation === version && !controller?.signal.aborted
      && globalThis.document === doc && ui.workerNumbers === boot && projectApi('/api/') === project
      && !binding.signal?.aborted && !routeContext().invalid && binding.current() && inside(doc.body, section);
    const reading = () => {
      const selection = globalThis.window?.getSelection?.();
      return inside(list, doc.activeElement) || (selection && !selection.isCollapsed
        && (inside(section, selection.anchorNode) || inside(section, selection.focusNode)));
    };
    const text = (node, value) => { if (node.textContent !== value) node.textContent = value; };
    function paint() {
      if (!current()) return;
      if (reading()) { pending = true; return; }
      pending = false;
      const panel = doc.getElementById('detail'), position = panel && captureDetailReading(panel);
      const existing = [...list.children]; let at = 0;
      for (const row of [...state.calls.values()].sort((a, b) => a.call_id - b.call_id)) {
        let view = nodes.get(row.call_id);
        if (!view) {
          const item = el('li', undefined, 'management-call'); item.dataset.callId = String(row.call_id);
          const head = el('div', undefined, 'management-call-head');
          const id = el('span', `Event #${row.call_id}`, 'hint');
          const time = el('time'), method = el('code'), target = el('span'), result = el('span', undefined, 'management-call-status');
          head.append(id, time, method, target, result);
          const fold = el('details'), title = el('summary', '脱敏参数与结果摘要'), body = el('pre');
          fold.append(title, body); item.append(head, fold);
          view = { item, time, method, target, result, body }; nodes.set(row.call_id, view);
          list.insertBefore(item, existing[at] || null);
        } else at++;
        text(view.time, absolute(row.started_at));
        text(view.method, row.method || '未知接口（未记录名称）');
        text(view.target, row.target_id ? `目标 ${workerLabel(row.target_id, row.target_worker_number)}` : '无明确目标');
        text(view.result, callStatus(row, binding.task.management));
        const safe = safeDetails(row);
        text(view.body, `传输：${row.transport_method || '未知'}\nRun：${row.run_id ?? '未知'} · 完成 Event：${row.phase === 'finished' ? row.seq : '未观察到'}\n耗时：${Number.isFinite(row.duration_ms) && row.duration_ms >= 0 ? `${row.duration_ms} ms` : '未知'}\n脱敏参数：${JSON.stringify(safe.params, null, 2)}\n结果摘要（调用时）：${JSON.stringify(safe.result, null, 2)}${row.reason === 'completion_not_observed' ? '\n原 Run 已不活跃，未观察到完成；不自动重放。' : row.reason === 'invalid_parameters' ? '\n参数校验拒绝。' : row.reason === 'request_failed_or_denied' ? '\n请求失败或被拒绝；不展示原始错误。' : ''}`);
      }
      text(status, `${error ? '读取不可用或失败（旧服务可能不支持）；保留已有记录，可重试。' : busy ? '正在读取…' : !state.loaded ? '尚未读取。' : !state.calls.size ? state.limited ? '当前范围超出读取预算。' : '当前窗口无采集记录；不代表历史未调用。' : `已显示 ${state.calls.size} 次调用／${state.events.size} 个事件；最新已读 Event #${state.high}。`}${state.hasNewer ? ' 仍有新事件，继续读取最新调用。' : ''}${state.limited ? ' 已达 5000 事件／8 MiB 预算，仅显示部分范围；保留已读内容。' : ''}${!state.hasOlder && state.loaded ? ' 已到采集范围起点，不代表完整历史。' : ''}${projections.length ? ` 尚有 ${projections.length} 个未完成调用待核对。` : ''}`);
      older.hidden = !state.loaded || !state.hasOlder; retry.hidden = !error;
      recheck.hidden = !projections.length; newer.textContent = state.hasNewer ? '继续读取最新调用' : '读取最新调用';
      for (const control of [older, newer, retry, recheck]) control.disabled = busy || state.limited;
      if (state.limited) for (const control of [older, newer, retry, recheck]) control.hidden = true;
      linkWorkerNumbers(section);
      if (panel) restoreDetailReading(panel, position);
    }
    function flush() { if (pending && !reading()) paint(); }
    const focusout = () => queueMicrotask(flush);
    async function get(query, signal) {
      return api(`/api/worker/${task.id}/management-calls?${new URLSearchParams({ limit: '50', ...query })}`, { signal });
    }
    async function projectUnfinished(version, signal) {
      if (needsProjection) {
        const unresolved = [...state.calls.values()].filter(row => row.phase === 'started').map(row => row.call_id);
        // Retain the previous verification queue head across refreshes, so >50 active starts cannot starve.
        projections = [...new Set([...projections.filter(id => state.calls.get(id)?.phase === 'started'), ...unresolved])];
        needsProjection = false;
      }
      // Exact start-Event windows, not after-empty-page or current Worker-status guesses.
      // Bounded per refresh; additional verification stays explicit and visible.
      for (let count = 0; projections.length && count < 50; count++) {
        const id = projections[0];
        const page = await get({ before: String(id + 1), limit: '1' }, signal);
        if (!current(version)) return;
        if (page.items?.[0]?.seq !== id || page.items[0].call_id !== id) throw new Error('missing_start_projection');
        mergeCalls(state, page, 'projection'); projections.shift();
      }
    }
    async function read(direction) {
      if (busy || !current() || state.limited) return;
      const version = generation, signal = controller.signal;
      busy = true; error = false; paint();
      try {
        if (direction !== 'projection') {
          const query = direction === 'older' ? { before: String(state.oldest) }
            : direction === 'newer' ? { after: String(state.high) } : {};
          const page = await get(query, signal);
          if (!current(version)) return;
          mergeCalls(state, page, direction);
        }
        await projectUnfinished(version, signal);
      } catch (cause) {
        if (current(version) && !isReadAbort(cause)) { error = true; failedDirection = direction; }
      } finally { if (current(version)) { busy = false; paint(); } }
    }
    section.bindCalls = (next, lifetime) => {
      section.disposeCalls();
      binding = { task: next, signal: lifetime.signal, current: lifetime.current || (() => true) };
      controller = new AbortController();
      const abort = () => section.disposeCalls();
      lifetime.signal?.addEventListener('abort', abort, { once: true });
      const version = ++generation;
      section.disposeCalls = () => {
        if (generation !== version) return;
        ++generation; controller.abort(); busy = false; pending = false;
        doc.removeEventListener('selectionchange', flush); section.removeEventListener('focusout', focusout);
        lifetime.signal?.removeEventListener('abort', abort);
      };
      doc.addEventListener('selectionchange', flush); section.addEventListener('focusout', focusout);
      needsProjection = true;
      queueMicrotask(() => { if (current(version) && !lifetime.signal?.aborted) { paint(); void read(state.loaded ? 'newer' : 'initial'); } });
    };
    section.disposeCalls = () => {};
  }
  section.bindCalls(task, options);
  return section;
}

// The detail renderer briefly detaches retained nodes. Restore only this same synchronous reading.
export function captureCallsInteraction(section) {
  if (!section) return () => {};
  const doc = section.ownerDocument || globalThis.document, focus = inside(section, doc.activeElement) ? doc.activeElement : null;
  const selection = globalThis.window?.getSelection?.();
  const range = selection && !selection.isCollapsed && inside(section, selection.anchorNode) && inside(section, selection.focusNode)
    ? { anchor: selection.anchorNode, a: selection.anchorOffset, focus: selection.focusNode, f: selection.focusOffset } : null;
  return () => {
    if (globalThis.document !== doc || !inside(doc.body, section)) return;
    if (focus && doc.activeElement !== focus) focus.focus?.({ preventScroll: true });
    if (range && selection.setBaseAndExtent) selection.setBaseAndExtent(range.anchor, range.a, range.focus, range.f);
  };
}
