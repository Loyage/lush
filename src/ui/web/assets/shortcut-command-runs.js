import { el, button, badge } from './dom.js';
import { api, action } from './api.js';
import { confirmDialog } from './dialog.js';
import { workerLabel } from './worker-label.js';
import { absolute } from './format.js';
import { COMMAND_WARNING, validCommands } from './shortcut-command-model.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const statuses = { pending: '已提交，等待执行', running: '执行中', succeeded: '执行成功', failed: '执行失败', unknown: '结果未知' };
const active = row => ['pending', 'running'].includes(row.status);
export function commandResultText(result) {
  const reasons = { timeout: '超时（最长 60 秒）', output_limit: '输出超限（64 KiB）', admission: '执行前安全门拒绝', not_started: '未开始执行', interrupted: '运行中断' };
  return `命令结果：${statuses[result?.status] || '结果未知'}${Number.isInteger(result?.exit_code) ? ` · 退出码 ${result.exit_code}` : ''}${reasons[result?.reason] ? ` · ${reasons[result.reason]}` : ''}；原始输出不公开。`;
}
function validRow(row) {
  return row && UUID.test(row.id) && Number.isSafeInteger(row.event_id) && row.event_id > 0
    && Object.hasOwn(statuses, row.status) && Number.isSafeInteger(row.worker_id) && row.worker_id > 0
    && (row.command_name === null || typeof row.command_name === 'string')
    && Number.isSafeInteger(row.command_version) && row.command_version > 0 && typeof row.created_at === 'string';
}
function validPage(page) {
  return page?.version === 1 && Array.isArray(page.items) && page.items.length <= 100 && page.items.every(validRow)
    && typeof page.has_more === 'boolean' && (page.next_before === null || Number.isSafeInteger(page.next_before) && page.next_before > 0)
    && (!page.has_more || page.next_before !== null);
}
function field(label) {
  const wrap = el('label', label, 'hook-field'), input = el('select'); input.setAttribute('aria-label', label); wrap.append(input); return { wrap, input };
}

/** Durable server history, not browser storage; never infer a result from a POST connection error. */
export function createShortcutRuns({ model: initial, ownsPage, busy, setBusy, onCommands, setTimeout: setTimer = globalThis.setTimeout,
  clearTimeout: clearTimer = globalThis.clearTimeout }) {
  const node = el('div', undefined, 'shortcut-command-runs'), choices = el('div', undefined, 'shortcut-run-choices');
  const editor = el('div', undefined, 'shortcut-run-editor hook-editor'), records = el('div', undefined, 'shortcut-execution-records');
  const message = el('p', undefined, 'hint shortcut-history-status'); message.setAttribute('role', 'status');
  const history = el('section', undefined, 'shortcut-execution-history'); history.append(el('h3', '运行记录'),
    el('p', '每次手动和 Hook 执行的安全摘要保存在项目后台，刷新或重启后仍可回看。网络超时不等于命令失败；未知结果不自动重跑。', 'hint'), message, records);
  const controls = el('div', undefined, 'actions');
  const refresh = button('刷新运行记录', () => loadHistory(), 'ghost');
  const more = button('更早运行记录', () => loadHistory(true), 'ghost'); more.hidden = true;
  controls.append(refresh, more); history.append(controls); node.append(choices, editor, history);
  let model = initial, disposed = false, capable = false, reading = false, sequence = 0, timer = null, observer = null;
  let pendingPost = false, pickerSequence = 0, selected = null, before = null, hasMore = false;
  const rows = new Map(), controllers = new Set();
  const current = () => !disposed && ownsPage();
  function dispose() {
    if (disposed) return;
    disposed = true; sequence++; pickerSequence++; clearTimer(timer); timer = null;
    for (const controller of controllers) controller.abort(); controllers.clear();
    observer?.disconnect(); globalThis.removeEventListener?.('pagehide', dispose);
  }
  async function request(url) {
    const controller = new AbortController(); controllers.add(controller);
    try { return await api(url, { signal: controller.signal }); }
    finally { controllers.delete(controller); }
  }
  const read = (query = '') => request('/api/hooks/commands/executions' + query);
  function historyError() {
    message.textContent = '运行记录暂不可用，连接中断或后台尚不支持此接口；请更新后台与界面服务后刷新。现有执行结果未确认，不表示命令失败，不会自动重跑。';
    message.className = 'hint shortcut-history-status';
  }
  function paintRecords() {
    records.replaceChildren();
    for (const row of [...rows.values()].sort((a, b) => b.event_id - a.event_id)) {
      const card = el('article', undefined, 'hook-mount shortcut-execution'); card.dataset.executionId = row.id;
      const head = el('div', undefined, 'hook-mount-head'); head.append(el('strong', row.command_name ?? '旧记录：名称未保存'), badge(`v${row.command_version}`), badge(statuses[row.status]));
      const source = ({ manual: '手动运行', hook: 'Hook 触发' })[row.source] || '旧记录：来源未保存';
      card.append(head, el('p', `${workerLabel(row.worker_id, row.worker_number)} · ${source}`, 'hint'),
        el('p', `开始／提交：${absolute(row.created_at)}${row.finished_at ? ` · 结束：${absolute(row.finished_at)}` : ''}`, 'hint'),
        el('p', commandResultText({ ...row.command_result, status: row.status }), ['failed', 'unknown'].includes(row.status) ? 'error' : 'hint'),
        el('p', `运行身份：${row.id}`, 'hint shortcut-execution-id'));
      records.append(card);
    }
    if (!rows.size) records.append(el('p', '尚无运行记录。', 'hint'));
    more.hidden = !hasMore; more.disabled = reading; refresh.disabled = reading;
  }
  function stopPoll() { clearTimer(timer); timer = null; }
  function schedule() {
    stopPoll();
    if (current() && [...rows.values()].some(active)) timer = setTimer(poll, 1000);
  }
  async function poll() {
    timer = null;
    if (!current()) { dispose(); return; }
    const epoch = sequence, targets = [...rows.values()].filter(active).slice(0, 100);
    try {
      // An exact UUID lookup is independent of last_execution, edits, deletion and newer runs.
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
    if (!current() || reading || older && !hasMore) return;
    const epoch = ++sequence; stopPoll(); reading = true; paintRecords();
    try {
      const page = await read(`?limit=30${older ? `&before=${before}` : ''}`);
      if (!current() || epoch !== sequence) return;
      if (!validPage(page) || older && (page.items.some(row => row.event_id >= before) || page.has_more && page.next_before >= before)) throw new Error('history unavailable');
      capable = true;
      if (!older) rows.clear();
      for (const row of page.items) rows.set(row.id, row);
      before = page.next_before; hasMore = page.has_more;
      message.textContent = '显示后台已确认的运行状态。'; paintRecords(); paintChoices(); schedule();
    } catch { if (current() && epoch === sequence) { capable = false; historyError(); paintChoices(); } }
    finally { if (current() && epoch === sequence) { reading = false; paintRecords(); } }
  }
  function paintChoices() {
    choices.replaceChildren(el('p', '仅执行已授权版本；注册、编辑和授权请切换到「指令管理」。', 'hint'));
    if (!validCommands(model)) return;
    for (const command of model.items) {
      const card = el('article', undefined, 'hook-mount shortcut-run-command');
      const head = el('div', undefined, 'hook-mount-head'); head.append(el('strong', command.name), badge(`v${command.version}`), badge(command.authorized ? '已授权' : '未授权／已撤权'));
      const preview = el('pre', command.command, 'hook-action-preview'); preview.setAttribute('data-worker-links', 'off');
      const host = el('span', undefined, 'help-host');
      const reason = !command.authorized ? '此版本未授权，请先在指令管理中授权。' : !capable ? '请先成功读取运行记录；旧后台不支持异步执行时不能运行。' : pendingPost || busy() ? '正在提交或保存，请稍候。' : null;
      const execute = button('手动执行', () => { if (!reason && current()) return selectWorker(command, model.revision); }, 'ghost hook-button', {
        help: '选择 Worker 的真实目录并确认异步执行一次；安全门仍须通过，不调用 Agent。' });
      const clicked = execute.onclick;
      execute.onclick = async () => { await clicked(); execute.disabled = !!reason; };
      execute.disabled = !!reason; host.tabIndex = reason ? 0 : -1; host.setAttribute('data-help', reason || execute.getAttribute('data-help')); host.append(execute);
      card.append(head, preview, host); choices.append(card);
    }
    if (!model.items.length) choices.append(el('p', '尚未注册快捷指令，请到指令管理注册并授权。', 'hint'));
  }
  async function selectWorker(command, revision) {
    if (!current() || pendingPost || busy()) return;
    const generation = ++pickerSequence; selected = command.id;
    editor.replaceChildren(el('h3', `手动执行：${command.name} · v${command.version}`), el('p', '正在读取可选 Worker…', 'hint'));
    try {
      // Claim/start/completion advance the command-library revision. Re-read it
      // for each deliberate new run instead of reusing the previous POST's revision.
      const [parents, activity, catalogue] = await Promise.all([request('/api/input-parents'), request('/api/snapshot'), request('/api/hooks')]);
      if (!current() || generation !== pickerSequence) return;
      if (!Array.isArray(parents?.items) || !Array.isArray(activity?.tasks) || !validCommands(catalogue?.commands)) throw new Error('Worker or command list unavailable');
      const live = catalogue.commands.items.find(item => item.id === command.id && item.version === command.version && item.authorized);
      if (!live) throw new Error('selected command authorization changed');
      command = live; revision = catalogue.commands.revision;
      onCommands(catalogue.commands);
      const candidates = [...new Map([...activity.tasks.filter(item => ['main', 'owner', 'order', 'child'].includes(item.task_kind)
        && !['completed', 'failed', 'cancelled'].includes(item.status)), ...parents.items].map(item => [item.id, item])).values()];
      const worker = field('执行目录 Worker'), blank = el('option', '请选择 Worker 的真实工作目录'); blank.value = ''; worker.input.append(blank);
      for (const item of candidates) {
        if (!Number.isSafeInteger(item.id) || item.id < 1 || !item.branch) continue;
        const option = el('option', `${workerLabel(item)} · ${item.branch}${item.freeze ? ' · 冻结，暂不可执行' : ''}`);
        option.value = String(item.id); option.disabled = !!item.freeze; worker.input.append(option);
      }
      const error = el('p', undefined, 'hint'); error.setAttribute('role', 'status');
      const preview = el('pre', command.command, 'hook-action-preview'); preview.setAttribute('data-worker-links', 'off');
      let uncertain = false;
      const host = el('span', undefined, 'help-host');
      const execute = button('确认执行一次', async () => {
        if (!current() || pendingPost || busy() || uncertain || !capable || generation !== pickerSequence) return;
        const target = candidates.find(item => String(item.id) === worker.input.value);
        if (!target || target.freeze) { error.textContent = '请选择未冻结的有效 Worker。'; return; }
        pendingPost = true; setBusy(true); execute.disabled = worker.input.disabled = cancel.disabled = true; paintChoices();
        let submitted = false;
        try {
          if (!await confirmDialog({ title: '执行已授权快捷指令一次？', message: `${COMMAND_WARNING} 目标：${workerLabel(target)} · ${target.branch}`,
            detail: command.command, confirmLabel: '执行一次', danger: true, confirmHelp: '以 daemon 用户权限提交所选版本一次；可能产生不可逆副作用，不调用 Agent。' }) || !current()) return;
          submitted = true;
          const result = await action('hooks.command_start', { id: command.id, version: command.version, worker_id: target.id, expected_revision: revision }, { refresh: false });
          if (!current()) return;
          if (!UUID.test(result?.execution_id) || !validRow(result.execution) || result.execution.id !== result.execution_id || !validCommands(result.commands)) throw new Error('start response unavailable');
          // A read started before submission must not erase the newly acknowledged UUID.
          sequence++; stopPoll(); reading = false;
          rows.set(result.execution_id, result.execution); onCommands(result.commands);
          error.textContent = `已提交运行 ${result.execution_id}；${commandResultText({ ...result.execution.command_result, status: result.execution.status })}`;
          worker.input.disabled = true; execute.disabled = true; uncertain = true;
          host.setAttribute('data-help', '这次运行已提交，请查看运行记录；此按钮不重复执行同一次请求。'); host.tabIndex = 0;
          paintRecords(); schedule();
        } catch {
          if (current()) {
            uncertain = submitted;
            error.textContent = '请求未获确认，执行结果未确认；目标选择保留。请刷新运行记录核对，不要盲目重试未知结果。后台若不支持异步接口，请更新后台与界面服务。';
            host.setAttribute('data-help', '本次提交结果未确认，请先核对运行记录；不会自动重发或改用同步执行。'); host.tabIndex = 0;
          }
        } finally {
          pendingPost = false; setBusy(false);
          if (current()) { execute.disabled = uncertain; worker.input.disabled = uncertain; cancel.disabled = false; paintChoices(); }
        }
      }, 'hook-button', { help: '向后台提交明确授权版本一次；即时返回运行身份，再查询结果。不调用 Agent，不自动重试。' });
      const clicked = execute.onclick;
      execute.onclick = async () => { await clicked(); execute.disabled = uncertain || pendingPost || busy() || !capable; };
      host.append(execute);
      const cancel = button('关闭手动执行', () => { if (!pendingPost) { pickerSequence++; selected = null; editor.replaceChildren(); } }, 'ghost');
      editor.replaceChildren(el('h3', `手动执行：${command.name} · v${command.version}`), preview, worker.wrap,
        el('p', '冻结、真实调用尚未退出或其他安全门阻塞时拒绝，不自动排队或重试；离开页面不取消已提交的命令。', 'hint'), error, host, cancel);
    } catch { if (current() && generation === pickerSequence) editor.replaceChildren(el('p', '读取 Worker 失败；不会改投 main。', 'hint'),
      button('关闭手动执行', () => { pickerSequence++; selected = null; editor.replaceChildren(); }, 'ghost')); }
  }
  function update(next) { model = next; if (current()) paintChoices(); }
  // Navigation invalidates ownership before any further read. Abort in-flight GETs when the DOM changes.
  globalThis.addEventListener?.('pagehide', dispose);
  if (globalThis.MutationObserver) { observer = new globalThis.MutationObserver(() => { if (!current()) dispose(); }); observer.observe(document, { childList: true, subtree: true }); }
  paintChoices(); void loadHistory();
  return { node, update, dispose, refresh: loadHistory, pending: () => pendingPost, selecting: () => selected !== null };
}
