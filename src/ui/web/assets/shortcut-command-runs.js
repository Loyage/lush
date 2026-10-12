import { el, button, badge } from './dom.js';
import { api, action } from './api.js';
import { confirmDialog } from './dialog.js';
import { workerLabel } from './worker-label.js';
import { absolute } from './format.js';
import { automationAlerts } from './automation-module.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const statuses = { pending: '已提交，等待执行', running: '执行中', succeeded: '执行成功', failed: '执行失败', unknown: '结果未知' };
const active = row => ['pending', 'running'].includes(row.status);
export function commandResultText(result) {
  if (result?.kind === 'prompt') {
    const labels = { pending: '已提交，等待创建', running: '正在创建 Worker', succeeded: '已创建／提交 Agent Worker（不是 Agent 工作完成）', failed: 'Worker 创建失败', unknown: '创建结果未知，不自动重试' };
    return `提示词创建结果：${labels[result.status] || labels.unknown}。`;
  }
  const reasons = { timeout: '超时（最长 60 秒）', output_limit: '输出超限（64 KiB）', admission: '执行前安全门拒绝', not_started: '未开始执行', interrupted: '运行中断' };
  return `命令结果：${statuses[result?.status] || '结果未知'}${Number.isInteger(result?.exit_code) ? ` · 退出码 ${result.exit_code}` : ''}${reasons[result?.reason] ? ` · ${reasons[result.reason]}` : ''}；原始输出不公开。`;
}
function validRow(row) {
  return row && UUID.test(row.id) && Number.isSafeInteger(row.event_id) && row.event_id > 0
    && Object.hasOwn(statuses, row.status) && Number.isSafeInteger(row.worker_id) && row.worker_id > 0
    && (!row.kind || ['shell', 'prompt'].includes(row.kind))
    && (row.command_name === null || typeof row.command_name === 'string')
    && Number.isSafeInteger(row.command_version) && row.command_version > 0 && typeof row.created_at === 'string';
}
function validPage(page) {
  return page?.version === 1 && Array.isArray(page.items) && page.items.length <= 100 && page.items.every(validRow)
    && typeof page.has_more === 'boolean' && (page.next_before === null || Number.isSafeInteger(page.next_before) && page.next_before > 0)
    && (!page.has_more || page.next_before !== null);
}

/** History-only component. Reads and safe removal cannot submit an execution. */
export function createShortcutRuns({ ownsPage, busy, setBusy, active: initiallyActive = true,
  setTimeout: setTimer = globalThis.setTimeout, clearTimeout: clearTimer = globalThis.clearTimeout }) {
  const records = el('div', undefined, 'shortcut-execution-records');
  const message = el('p', undefined, 'hint shortcut-history-status'); message.setAttribute('role', 'status');
  const history = el('section', undefined, 'shortcut-execution-history'); history.append(
    el('p', 'Hook 执行及历史手动执行的安全摘要保存在项目后台，刷新或重启后仍可回看。网络超时不等于命令失败；未知结果不自动重跑。', 'hint'), message, records);
  const controls = el('div', undefined, 'actions');
  const refresh = button('刷新运行记录', () => loadHistory(), 'ghost');
  const more = button('更早运行记录', () => loadHistory(true), 'ghost'); more.hidden = true;
  const clearHost = el('span', undefined, 'help-host');
  const clear = button('清空已结束记录', () => removeHistory({ clear: true }), 'ghost history-remove', { help: '仅持久移除成功或失败的列表记录；保留安全审计，不撤回命令副作用。等待、执行中和未知记录保留。' });
  clearHost.append(clear); controls.append(refresh, more, clearHost); history.append(controls);
  let disposed = false, enabled = initiallyActive, loaded = false, capable = false, reading = false, sequence = 0, timer = null, observer = null;
  let before = null, hasMore = false, deleting = false, deleteUncertain = false, removalReceipt = '', statusListener = () => {};
  const rows = new Map(), controllers = new Set(), deletedIds = new Set();
  const owned = () => !disposed && ownsPage();
  const current = () => owned() && enabled;
  const removable = row => ['succeeded', 'failed'].includes(row.status);
  const deleteHelp = '仅持久移除运行列表记录，保留安全审计；不撤回命令副作用。只有成功或失败记录可删除，等待、执行中和结果未知的记录必须保留。';
  function syncDelete(node, host, row = null) {
    const reason = row && !removable(row) ? '等待、执行中或结果未知的记录不可删除。' : !capable ? '请先读取历史；旧后台不可用时不能删除。'
      : deleting || busy() ? '正在确认或保存，请稍候。' : deleteUncertain ? '删除结果未确认，请显式刷新历史核对，不要盲目重发。' : null;
    node.disabled = !!reason; host.tabIndex = reason ? 0 : -1; host.setAttribute('data-help', `${reason || ''} ${deleteHelp}`);
  }
  async function removeHistory(params) {
    if (!current() || deleting || busy() || !capable || deleteUncertain) return;
    if (params.execution_id && !removable(rows.get(params.execution_id) || {})) return;
    deleting = true; sequence++; reading = false; stopPoll(); setBusy(true); paintRecords();
    let acknowledged = false, submitted = false;
    try {
      if (!await confirmDialog({ title: params.clear ? '清空所有已结束运行记录？' : '删除这条运行记录？',
        message: `${deleteHelp}${params.clear ? '范围包含尚未加载的已结束记录。' : ''}删除持久生效，刷新后不会恢复；此操作不取消命令、不删除 Worker 或成果。`,
        confirmLabel: params.clear ? '清空已结束' : '删除记录', danger: true, confirmHelp: deleteHelp }) || !current()) return;
      submitted = true;
      const result = await action('hooks.command_history_remove', params, { refresh: false });
      if (!owned()) return;
      if (!Number.isSafeInteger(result?.removed_count) || result.removed_count < 0 || params.execution_id && result.removed_count > 1) throw new Error('unconfirmed removal');
      acknowledged = true;
      if (result.removed_count > 0) for (const row of rows.values()) if (removable(row) && (params.clear || row.id === params.execution_id)) { deletedIds.add(row.id); rows.delete(row.id); }
      removalReceipt = `已持久移除 ${result.removed_count} 条列表记录；安全审计及既有副作用保留。`;
      if (current()) { message.textContent = removalReceipt; paintRecords(); }
    } catch {
      if (owned()) { deleteUncertain = submitted; if (current()) message.textContent = '删除请求未获确认；未假定删除成功。请刷新历史核对，不会自动重发或撤回副作用。'; }
    } finally {
      deleting = false; setBusy(false);
      if (current()) { paintRecords(); if (acknowledged) await loadHistory(); else if (!submitted) schedule(); }
    }
  }
  function stopPoll() { clearTimer(timer); timer = null; }
  function cancelReads() { sequence++; reading = false; stopPoll(); for (const controller of controllers) controller.abort(); controllers.clear(); }
  function dispose() {
    if (disposed) return; disposed = true; cancelReads(); observer?.disconnect(); globalThis.removeEventListener?.('pagehide', dispose);
  }
  async function read(query = '') {
    const controller = new AbortController(); controllers.add(controller);
    try { return await api('/api/hooks/commands/executions' + query, { signal: controller.signal }); }
    finally { controllers.delete(controller); }
  }
  function historyError() {
    message.textContent = removalReceipt + '运行记录暂不可用，连接中断或后台尚不支持此接口；请更新后台与界面服务后刷新。现有执行结果未确认，不表示命令失败，不会自动重跑。';
    statusListener(message.textContent);
  }
  function paintRecords() {
    records.replaceChildren();
    for (const row of [...rows.values()].sort((a, b) => b.event_id - a.event_id)) {
      const card = el('article', undefined, 'hook-mount shortcut-execution'); card.dataset.executionId = row.id;
      const head = el('div', undefined, 'hook-mount-head'); head.append(el('strong', row.command_name ?? '旧记录：名称未保存'), badge(`v${row.command_version}`), badge(row.kind === 'prompt' ? ({ pending: '等待创建', running: '正在创建', succeeded: '已创建 Worker', failed: '创建失败', unknown: '创建结果未知' })[row.status] : statuses[row.status]));
      const source = ({ manual: '历史手动运行', hook: 'Hook 触发' })[row.source] || '旧记录：来源未保存';
      card.append(head, el('p', `${workerLabel(row.worker_id, row.worker_number)} · ${source}`, 'hint'),
        el('p', `开始／提交：${absolute(row.created_at)}${row.finished_at ? ` · 结束：${absolute(row.finished_at)}` : ''}`, 'hint'),
        el('p', commandResultText({ ...row.command_result, kind: row.kind, status: row.status }), ['failed', 'unknown'].includes(row.status) ? 'error' : 'hint'),
        el('p', `运行身份：${row.id}`, 'hint shortcut-execution-id'));
      if (Number.isSafeInteger(row.created_worker_id) && row.created_worker_id > 0) {
        const link = el('a', `查看创建的 Worker ${workerLabel(row.created_worker_id, row.created_worker_number)}`, 'hook-help-link'); link.href = `#worker-${row.created_worker_id}`; card.append(link);
      }
      if (Number.isSafeInteger(row.input_id) && row.input_id > 0) card.append(el('p', `原始输入 O${row.input_id}`, 'hint'));
      const host = el('span', undefined, 'help-host');
      const remove = button('删除运行记录', () => removeHistory({ execution_id: row.id }), 'ghost history-remove', { help: deleteHelp });
      const clicked = remove.onclick; remove.onclick = async () => { await clicked(); syncDelete(remove, host, row); };
      syncDelete(remove, host, row); host.append(remove); card.append(host); records.append(card);
    }
    if (!rows.size) records.append(el('p', loaded ? '尚无运行记录。' : '运行记录尚未读取。', 'hint'));
    more.hidden = !hasMore; more.disabled = reading || deleting; refresh.disabled = reading || deleting;
    syncDelete(clear, clearHost);
    statusListener([`${rows.size} 条已加载`, automationAlerts([...rows.values()]), message.textContent].filter(Boolean).join(' · '));
  }
  function schedule() { stopPoll(); if (current() && [...rows.values()].some(active)) timer = setTimer(poll, 1000); }
  async function poll() {
    timer = null; if (!owned()) { dispose(); return; } if (!current()) return;
    const epoch = sequence, targets = [...rows.values()].filter(active).slice(0, 100);
    try {
      for (const row of targets) {
        if (!current() || epoch !== sequence) return;
        const page = await read(`?execution_id=${encodeURIComponent(row.id)}&limit=1`);
        if (!current() || epoch !== sequence) return;
        if (!validPage(page) || page.items.length !== 1 || page.items[0].id !== row.id) throw new Error('execution record unavailable');
        rows.set(row.id, page.items[0]);
      }
      if (!current() || epoch !== sequence) return;
      message.textContent = '显示后台已确认的运行状态。'; paintRecords(); schedule();
    } catch { if (current() && epoch === sequence) historyError(); }
  }
  async function loadHistory(older = false) {
    if (!current() || reading || deleting || older && !hasMore) return;
    const epoch = ++sequence; stopPoll(); reading = true; paintRecords();
    try {
      const page = await read(`?limit=30${older ? `&before=${before}` : ''}`);
      if (!current() || epoch !== sequence) return;
      if (!validPage(page) || older && (page.items.some(row => row.event_id >= before) || page.has_more && page.next_before >= before)) throw new Error('history unavailable');
      loaded = true; capable = true; deleteUncertain = false;
      if (!older) rows.clear();
      for (const row of page.items) if (!deletedIds.has(row.id)) rows.set(row.id, row);
      before = page.next_before; hasMore = page.has_more;
      message.textContent = '显示后台已确认的运行状态。'; paintRecords(); schedule();
    } catch { if (current() && epoch === sequence) { capable = false; historyError(); } }
    finally { if (current() && epoch === sequence) { reading = false; paintRecords(); } }
  }
  globalThis.addEventListener?.('pagehide', dispose);
  if (globalThis.MutationObserver) { observer = new globalThis.MutationObserver(() => { if (!owned()) dispose(); }); observer.observe(document, { childList: true, subtree: true }); }
  paintRecords(); if (enabled) void loadHistory();
  return { history, update: paintRecords, dispose, refresh: loadHistory,
    setActive(value) { if (enabled === value) return; enabled = value; cancelReads(); if (current()) { if (!loaded || deleteUncertain) void loadHistory(); else { paintRecords(); schedule(); } } },
    onHistoryStatus(listener) { statusListener = listener; paintRecords(); } };
}
