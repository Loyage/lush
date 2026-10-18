import { button, el } from './dom.js';
import { api, isReadAbort, projectApi } from './api.js';
import { copyText } from './clipboard.js';
import { callDiagnosticReport, diagnosticSummaryLines, diagnosticCopyText, positiveDiagnosticId as positive, safeDiagnosticEvent } from './management-diagnostic-model.js';

const inside = (root, node) => { for (let at = node; at; at = at.parentNode) if (at === root) return true; return false; };
const setText = (node, value) => { if (node.textContent !== value) node.textContent = value; };

/** Renderer-local, read-only receipt viewer. Its lifetime is the existing call reader's. */
export function createCallDiagnostic(context, budget) {
  const root = el('div', undefined, 'management-call-diagnostic');
  const visible = el('div', undefined, 'management-call-failure'); visible.setAttribute('role', 'note');
  const lines = Array.from({ length: 6 }, () => el('p')); visible.append(...lines);
  const controls = el('div', undefined, 'management-diagnostic-controls');
  const copyStatus = el('span', undefined, 'hint management-diagnostic-copy-status'); copyStatus.setAttribute('role', 'status');
  const links = el('span', undefined, 'management-diagnostic-links');
  const fold = el('details', undefined, 'management-diagnostic-details'), title = el('summary', '关联身份与安全时间线');
  const identity = el('pre'), status = el('p', '尚未读取关联事件；不代表没有历史。', 'hint management-diagnostic-timeline-status');
  const list = el('ol', undefined, 'management-diagnostic-timeline');
  const timeline = { items: [], next: null, has_more: false, loaded: false, limited: false };
  let report = null, row = null, task = null, busy = false, failed = false, ticket = 0, pendingReceipt = null;
  let linkKey = '';
  const read = button('读取关联时间线', () => load(), 'ghost');
  const copy = button('复制脱敏诊断', async () => {
    const lifetime = context();
    if (!report || !lifetime.current()) return;
    const value = diagnosticCopyText(report, timeline);
    const ok = await copyText(value);
    if (lifetime.current()) setText(copyStatus, ok ? '已复制脱敏诊断' : '复制失败，请手动选择诊断正文；未重做操作。');
  }, 'ghost', { help: '只复制当前显示的白名单诊断与已读取安全事件；不含原始参数、异常正文或凭证，不调用 Agent。' });
  controls.append(copy, links, copyStatus);
  fold.append(title, identity, status, read, list); root.append(visible, controls, fold);
  function paint() {
    if (!report) return;
    const summary = diagnosticSummaryLines(report);
    visible.hidden = !report.failed;
    summary.forEach((line, index) => { lines[index].hidden = false; setText(lines[index], line); });
    for (let index = summary.length; index < lines.length; index++) lines[index].hidden = true;
    // Success diagnostics remain readable on explicit expansion, without emphasizing them.
    setText(identity, `${report.failed ? '' : summary.join('\n') + '\n'}关联身份（仅白名单）：\n${JSON.stringify({ ...report.diagnostic.correlation,
      capability_receipt_id: report.capability_receipt_id, action_receipt_id: report.action_receipt_id }, null, 2)}${report.action ? `\n关联动作（独立收据）：\n${JSON.stringify(report.action, null, 2)}` : ''}${report.input_emit ? `\n发射持久事实：\n${JSON.stringify(report.input_emit, null, 2)}` : ''}`);
    const id = report.receipt_id ?? report.call_id;
    const f = report.input_emit;
    const specs = [
      ...(positive(id) ? [['收据 / 请求 Event #' + id, projectApi('/api/management/receipt?receipt_id=' + id)]] : []),
      ...(positive(report.call_id) && report.call_id !== id ? [['请求 Event #' + report.call_id, projectApi('/api/management/receipt?receipt_id=' + report.call_id)]] : []),
      ...(positive(report.capability_receipt_id) && report.capability_receipt_id !== id ? [['能力收据 #' + report.capability_receipt_id, projectApi('/api/management/receipt?receipt_id=' + report.capability_receipt_id)]] : []),
      ...(positive(report.action_receipt_id) && report.action_receipt_id !== id ? [['动作收据 #' + report.action_receipt_id, projectApi('/api/management/receipt?receipt_id=' + report.action_receipt_id)]] : []),
      ...(positive(f?.draft_id) ? [['草稿记录 #' + f.draft_id, '#input-draft-' + f.draft_id]] : []),
      ...(positive(f?.input_id) ? [['O' + f.input_id, '#input-input-' + f.input_id]] : []),
      ...(positive(f?.message_id) ? [['追加消息 #' + f.message_id, '#input-message-' + f.message_id]] : []),
      ...(positive(f?.worker_id) ? [['关联 ' + (f.worker_number ?? 'Worker #' + f.worker_id), '#worker-' + f.worker_id]] : []),
      ...(positive(report.diagnostic.correlation.target_id) && report.diagnostic.correlation.target_id !== f?.worker_id
        ? [['目标 ' + (report.diagnostic.correlation.target_worker_number ?? '#' + report.diagnostic.correlation.target_id), '#worker-' + report.diagnostic.correlation.target_id]] : []),
    ];
    const key = JSON.stringify(specs);
    if (key !== linkKey) {
      linkKey = key; links.replaceChildren();
      for (const [label, href] of specs) {
        const a = el('a', label, 'nav-link'); a.setAttribute('href', href); a.setAttribute('target', '_blank'); a.setAttribute('rel', 'noopener'); links.append(a);
      }
    }
    setText(status, `${busy ? '读取关联安全事件中…' : failed ? '关联读取失败或不可用；保留已读内容，可重试；未重做操作。' : timeline.loaded ? `已读取 ${timeline.items.length} 个关联事件；${timeline.has_more ? '仍有后页，继续读取。' : '已到本次关联范围末尾，不代表完整历史。'}` : '尚未读取关联事件；不代表没有历史。'} coverage=linked_safe_management_events_only${timeline.limited ? '；已达 500 事件／512 KiB 模块预算，范围未完成。' : ''}`);
    read.disabled = busy || timeline.limited || !positive(id);
    read.hidden = timeline.limited || timeline.loaded && !timeline.has_more && !failed;
    read.textContent = failed ? '重试关联读取' : timeline.loaded ? '继续读取关联事件' : '读取关联时间线';
  }
  const editing = () => {
    const doc = globalThis.document, selection = globalThis.window?.getSelection?.();
    // A focused fold/read button is stable and does not block its own requested read.
    return inside(identity, doc.activeElement) || (selection && !selection.isCollapsed && (inside(root, selection.anchorNode) || inside(root, selection.focusNode)));
  };
  function commitReceipt(page) {
    const selected = []; let bytes = 0;
    for (const item of page.timeline.items) {
      if (timeline.items.some(old => old.seq === item.seq)) continue;
      const safe = safeDiagnosticEvent(item), size = new TextEncoder().encode(JSON.stringify(safe)).length;
      if (budget.events + selected.length >= 500 || budget.bytes + bytes + size > 512 * 1024) { timeline.limited = true; break; }
      selected.push(safe); bytes += size;
    }
    budget.events += selected.length; budget.bytes += bytes;
    timeline.items.push(...selected); timeline.loaded = true;
    timeline.next = timeline.items.at(-1)?.seq ?? timeline.next;
    timeline.has_more = page.timeline.has_more === true || selected.length < page.timeline.items.length;
    if (timeline.limited) timeline.has_more = true;
    for (const item of selected) {
      const li = el('li'); li.append(el('pre', JSON.stringify(item, null, 2))); list.append(li);
    }
    report = callDiagnosticReport(row, task, page); paint();
  }
  async function load() {
    const lifetime = context(), id = report?.receipt_id ?? report?.call_id;
    if (!lifetime.current() || busy || timeline.limited || !positive(id)) return;
    if (budget.events >= 500 || budget.bytes >= 512 * 1024) { timeline.limited = true; paint(); return; }
    const version = ++ticket;
    busy = true; failed = false; paint();
    try {
      const after = timeline.next ?? 0;
      const page = await api(`/api/management/receipt?${new URLSearchParams({ receipt_id: String(id), after: String(after), limit: '30' })}`, { signal: lifetime.signal });
      if (ticket !== version || !lifetime.current()) return;
      if (page.coverage !== 'structured_management_diagnostic_only' || page.scope !== 'current_project' || page.receipt_id !== id
        || page.diagnostic?.correlation?.actor_id !== task.id || page.method !== report.method || page.timeline?.coverage !== 'linked_safe_management_events_only'
        || typeof page.timeline.has_more !== 'boolean'
        || !Array.isArray(page.timeline.items) || page.timeline.items.length > 100
        || page.timeline.items.some((item, index, items) => !positive(item.seq) || item.seq <= (index ? items[index - 1].seq : after))
        || page.timeline.next_cursor !== (page.timeline.items.at(-1)?.seq ?? null)
        || page.timeline.has_more && !page.timeline.items.length) throw new Error('invalid_safe_receipt');
      if (editing()) pendingReceipt = page;
      else commitReceipt(page);
    } catch (error) { if (ticket === version && lifetime.current() && !isReadAbort(error)) failed = true; }
    finally { if (ticket === version && lifetime.current()) { busy = false; paint(); } }
  }
  fold.ontoggle = () => { if (fold.open && !timeline.loaded && !busy) void load(); };
  return { root,
    update(nextRow, nextTask) { row = nextRow; task = nextTask; report = callDiagnosticReport(row, task); paint(); return report.failed; },
    flush() { if (pendingReceipt && !editing()) { const page = pendingReceipt; pendingReceipt = null; commitReceipt(page); } },
    resetRead() { ++ticket; busy = false; pendingReceipt = null; if (report) paint(); },
  };
}
