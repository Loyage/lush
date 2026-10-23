import { el, syncChildren } from './dom.js';
import { workerNumber } from './format.js';
import { formDialog, closeDialog } from './dialog.js';
import { agentHelp } from './help.js';

const present = value => typeof value === 'string' && value.trim().length > 0;
const errorText = error => error?.message || String(error);

/** Standalone UI: the adapter owns the fixed Worker id and authenticated user API.
 * No cwd, environment, credentials, shell or backend imports belong in this module.
 * Reuse update() for page refresh; call dispose() before removing the node.
 */
export function renderWorkerCli(initialTask, { preview, execute, loadHistory, clearHistory } = {}) {
  const root = el('section', undefined, 'worker-cli');
  root.setAttribute('aria-label', 'CLI 交互');
  const body = el('div', undefined, 'worker-cli-body'); root.append(body);
  const identity = el('div', undefined, 'worker-cli-identity');
  const worker = el('strong'), workspace = el('code', undefined, 'worker-cli-workspace');
  identity.append(worker, workspace);
  body.append(identity, el('p', '以当前登录用户身份真实执行，不是沙箱，也不借用 Worker 的 Agent token。', 'worker-cli-warning'));
  const unavailable = el('p', undefined, 'worker-cli-unavailable'); unavailable.setAttribute('role', 'status');
  body.append(unavailable);
  const historyTools = el('div', undefined, 'worker-cli-history-tools');
  const older = el('button', '加载更早命令', 'ghost'); older.type = 'button';
  const clearHost = el('span', undefined, 'help-host');
  const clear = el('button', '清除命令历史', 'danger'); clear.type = 'button';
  clear.dataset.help = '永久删除当前用户在此 Worker 的命令与输出历史，不撤销已执行命令；执行在途时不能清除。';
  clearHost.append(clear); historyTools.append(older, clearHost);
  const historyStatus = el('p', '', 'worker-cli-history-status'); historyStatus.setAttribute('role', 'status');
  const history = el('div', undefined, 'worker-cli-history'); history.setAttribute('aria-label', '命令历史（时间正序）');
  const discovery = el('section', undefined, 'worker-cli-discovery');
  const searchLabel = el('label', '功能搜索（固定命令文档，不调用模型）');
  const search = el('input'); search.type = 'search'; search.placeholder = '例如：合并、追加消息、查看状态'; search.setAttribute('aria-label', '搜索 CLI 功能'); searchLabel.append(search);
  const searchButton = el('button', '搜索'); searchButton.type = 'button';
  const clearSearch = el('button', '清空', 'ghost'); clearSearch.type = 'button';
  const catalogStatus = el('p', '正在加载静态命令目录…'); catalogStatus.setAttribute('role', 'status');
  const candidates = el('div', undefined, 'worker-cli-candidates');
  discovery.append(searchLabel, searchButton, clearSearch, catalogStatus, candidates); body.append(discovery);
  const row = el('div', undefined, 'worker-cli-controls');
  const label = el('label', undefined, 'worker-cli-field'); label.append(el('span', '单次 Lush 命令'));
  const input = el('textarea', undefined, 'worker-cli-input'); input.rows = 2; input.placeholder = 'lush status';
  input.setAttribute('aria-label', '单次 Lush 命令'); input.spellcheck = false;
  input.setAttribute('aria-keyshortcuts', 'Enter');
  const shortcut = el('span', '↑↓ 选择提示 · Tab 补全 · Esc 关闭 · 选中提示时 Enter 只填入；否则 Enter 执行 · Shift+Enter 换行', 'worker-cli-shortcut');
  const suggestions = el('div', undefined, 'worker-cli-suggestions');
  const guide = el('div', undefined, 'worker-cli-guide'); guide.setAttribute('aria-live', 'polite');
  label.append(input, shortcut, suggestions, guide);
  const runHost = el('span', undefined, 'help-host');
  const run = el('button', '执行', 'worker-cli-run'); run.type = 'button';
  run.dataset.help = '先预览命令与真实工作目录；有副作用或调用 Agent 时确认后才执行，不会自动重试。';
  runHost.append(run); row.append(label, runHost); body.append(row);
  const status = el('p', '', 'worker-cli-status'); status.setAttribute('role', 'status'); body.append(status);

  const advanced = el('details', undefined, 'worker-cli-advanced');
  advanced.append(el('summary', '示例、限制与选项'));
  const examples = el('div', undefined, 'worker-cli-examples'); advanced.append(examples);
  advanced.append(el('p', '示例只填入命令，不执行。仅支持 lush 和 lushw 单次合法单行命令，由服务端校验；不是 shell，不支持任意程序、管道或重定向。目录、环境与身份由服务端固定，不能在此选择。'));
  advanced.append(el('p', typeof loadHistory === 'function'
    ? '服务器保存全量加密命令与输出，登录后自动解锁；密文和密钥一起泄露时无法保护内容。每页默认 10 条，本页最多保留最近 100 条。'
    : '历史接口尚未连接：仅在当前阅读页会话保留最近 100 条，离页即释放，不写入浏览器存储。'));
  advanced.append(el('p', '输出、耗时和执行上限以服务端返回为准。超时、信号、截断或连接中断不代表命令没有产生副作用；结果未知时请先核查，勿盲目再次执行。'));
  body.append(advanced, historyTools, historyStatus, history);

  let task, disposed = false, busy = false, generation = 0, draftVersion = 0, confirmation = null, visible = true;
  let discoveryApi = null;
  let catalogCommands = [], suggestionItems = [], selectedSuggestion = -1, suggestionsClosed = false;
  function fillCommand(item) {
    if (disposed || reason()) return;
    input.value = item.path + (item.directory ? ' ' : ''); edited(); input.focus();
  }
  function paintSuggestions() {
    suggestions.replaceChildren();
    suggestionItems = suggestionsClosed ? [] : (discoveryApi?.pathSuggestions(catalogCommands, input.value) || []);
    suggestionItems.forEach((item, index) => {
      const node = el('button', `${item.path} — ${item.description}`, 'ghost'); node.type = 'button';
      node.classList.toggle('selected', index === selectedSuggestion);
      node.setAttribute('aria-pressed', String(index === selectedSuggestion));
      node.onclick = () => fillCommand(item); suggestions.append(node);
    });
    guide.replaceChildren();
    const item = suggestionItems[selectedSuggestion] || discoveryApi?.currentCommand(catalogCommands, input.value);
    if (item) guide.append(discoveryApi.commandGuide(item));
  }
  function searchCatalog(event) {
    if (disposed || event?.isComposing || event?.keyCode === 229) return;
    candidates.replaceChildren();
    const matches = discoveryApi?.searchCommands(catalogCommands, search.value) || [];
    catalogStatus.textContent = `静态匹配 ${matches.length} 项，显示前 30 项；填入不执行，权限仍须服务端预检。`;
    for (const item of matches.slice(0, 30)) {
      const node = el('button', `${item.path} · ${discoveryApi.commandType(item, catalogCommands)} — ${item.description}`, 'ghost'); node.type = 'button';
      node.onclick = () => fillCommand(item); candidates.append(node);
    }
  }
  searchButton.onclick = searchCatalog;
  search.onkeydown = event => { if (event.key === 'Enter' && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); searchCatalog(event); } };
  clearSearch.onclick = () => { search.value = ''; searchCatalog(); };
  const catalogReady = import('./cli-catalog.js').then(module => {
    if (disposed) return null;
    discoveryApi = module; return module.loadCliCatalog();
  }).then(catalog => {
    if (disposed) return;
    // lushw discovery is restricted to the same declared user-context mapping as preview.
    const leaves = catalog.commands.filter(item => !item.directory && (item.executable === 'lush' || item.user_context_rpc || item.command_path === 'help'));
    catalogCommands = catalog.commands.filter(item => leaves.includes(item) || item.directory && leaves.some(leaf => leaf.path.startsWith(`${item.path} `)));
    catalogStatus.textContent = `目录 ${catalog.catalog_version} · 输入命令路径可查看用途；搜索仅查固定文档。`;
    fillExamples(); paintSuggestions();
  }).catch(error => { if (!disposed) catalogStatus.textContent = `目录加载失败：${errorText(error)}。仍可手动输入，执行必须经过预检；重新打开页面可重试。`; });
  root.catalogReady = catalogReady;
  let entries = [], before = null, hasMore = false, historyLoaded = false, reading = false, historyGeneration = 0;
  function summary(value, pending = false) {
    if (pending) return '正在真实执行，等待输出…';
    if (!['succeeded', 'failed'].includes(value.status)) return '结果未知，请先核查真实状态；不会自动重试。';
    return value.status === 'succeeded' && value.exit_code === 0 && !value.signal && !value.timed_out ? '执行成功。' : '执行失败，不是成功。';
  }
  function paintEntry(entry) {
    const value = entry.value;
    if (entry.node && entry.painted === value) return entry.node;
    entry.painted = value;
    const diagnostics = [`退出码：${value.exit_code ?? '未知'}`, `耗时：${value.duration_ms ?? '未知'} ms`];
    if (value.signal) diagnostics.push(`信号：${value.signal}`);
    if (value.timed_out) diagnostics.push('已超时，可能已有副作用');
    if (value.truncated) diagnostics.push('输出已截断，并非完整输出');
    if (!entry.node) {
      entry.node = el('section', undefined, 'worker-cli-result'); entry.node.setAttribute('aria-label', 'CLI 执行结果');
      entry.command = el('pre', undefined, 'worker-cli-result-command');
      entry.stdout = el('pre', undefined, 'worker-cli-output'); entry.stdout.setAttribute('aria-label', 'stdout');
      entry.stderr = el('pre', undefined, 'worker-cli-output'); entry.stderr.setAttribute('aria-label', 'stderr');
      entry.meta = el('p', undefined, 'worker-cli-result-meta');
      entry.node.append(entry.command, el('h4', 'stdout'), entry.stdout, el('h4', 'stderr'), entry.stderr, entry.meta);
    }
    entry.command.textContent = `${value.created_at || '时间未知'}\n$ ${value.command}\n目录：${value.workspace || '未知'}`;
    entry.stdout.textContent = String(value.stdout ?? ''); entry.stderr.textContent = String(value.stderr ?? '');
    entry.meta.textContent = `${summary(value, entry.pending)} ${diagnostics.join(' · ')}${value.history_error ? ' · 历史保存失败；执行 ACK 仍有效，不会重发。' : ''}${value.error ? ` ${value.error}` : ''}`;
    return entry.node;
  }
  function paintHistory() {
    entries = entries.slice(-100);
    // Reuse entry nodes so completing an execution never destroys older selections.
    syncChildren(history, entries.map(paintEntry));
    sync();
  }
  async function readHistory() {
    if (disposed || reading || busy || typeof loadHistory !== 'function' || entries.length >= 100 || (historyLoaded && !hasMore)) return;
    const token = ++historyGeneration, id = task.id;
    reading = true; sync(); historyStatus.textContent = '正在读取命令历史…';
    try {
      const page = await loadHistory({ ...(before === null ? {} : { before }), limit: 10 });
      if (disposed || token !== historyGeneration || task.id !== id) return;
      if (!Array.isArray(page?.entries) || typeof page.has_more !== 'boolean'
        || (page.before !== null && (!Number.isSafeInteger(page.before) || page.before <= 0))
        || (page.has_more && (page.before === null || (before !== null && page.before >= before)))) throw Error('历史响应或分页游标无效');
      const ids = new Set(entries.map(entry => entry.value.id).filter(id => id != null));
      const loaded = [];
      for (const value of page.entries) {
        if (value?.id == null || ids.has(value.id)) continue;
        ids.add(value.id); loaded.push({ value: { ...value } });
      }
      // Existing executions win over a delayed/stale history snapshot with the same id.
      entries = [...loaded, ...entries]; before = page.before; hasMore = page.has_more; historyLoaded = true;
      paintHistory(); historyStatus.textContent = entries.length >= 100 ? '已达本页最近 100 条上限。' : hasMore ? '可手动加载更早命令。' : entries.length ? '已读完可用命令历史。' : '暂无命令历史。';
    } catch (error) {
      if (!disposed && token === historyGeneration) historyStatus.textContent = `历史读取失败，可重试；保留当前记录。${errorText(error)}`;
    } finally { if (!disposed && token === historyGeneration) { reading = false; sync(); } }
  }
  async function clearEntries() {
    if (disposed || busy || !entries.length || (typeof loadHistory === 'function' && typeof clearHistory !== 'function')) return;
    const turn = generation, id = task.id;
    const current = () => !disposed && generation === turn && task.id === id;
    busy = true; sync();
    const content = el('div', undefined, 'worker-cli-confirm'); confirmation = content;
    content.append(el('p', '永久删除当前用户在此 Worker 的命令与输出历史，无法恢复；不撤销已执行命令，也不取消已派发命令。'));
    try {
      const accepted = await formDialog({ title: '清除命令历史', content, danger: true, confirmLabel: '永久清除',
        confirmHelp: clear.dataset.help, canConfirm: current });
      if (confirmation === content) confirmation = null;
      if (!accepted || !current()) return;
      // Invalidate reads before dispatch, including reads that return during clear.
      historyGeneration++; reading = false;
      if (typeof clearHistory === 'function') await clearHistory();
      if (!current()) return;
      entries = []; before = null; hasMore = false; historyLoaded = true; history.replaceChildren();
      historyStatus.textContent = '命令历史已清除；已执行操作不受影响。';
    } catch (error) {
      if (current()) historyStatus.textContent = `清除失败，保留当前历史。${errorText(error)}`;
    } finally { if (current()) { busy = false; sync(); } }
  }
  const exampleHandlers = [];
  function reason() {
    if (disposed) return '页面已离开，请重新打开 CLI 交互。';
    if (!visible) return 'CLI 标签当前未显示。';
    if (!['order', 'child'].includes(task?.task_kind) || task?.execution_retired === true) return '仅本机开发指令或子 Worker 可以使用 CLI 交互。';
    if (!Number.isSafeInteger(task?.id) || task.id <= 0) return 'Worker 身份不可用。';
    if (!present(task?.workspace)) return 'Worker 工作区不存在或不可用；不会回落到项目目录。';
    if (typeof preview !== 'function' || typeof execute !== 'function') return 'CLI 执行接口尚未连接。';
    return '';
  }
  function sync() {
    const disabledReason = reason();
    unavailable.textContent = disabledReason; unavailable.hidden = !disabledReason;
    input.disabled = Boolean(disabledReason);
    run.disabled = Boolean(disabledReason) || busy || !input.value.trim();
    const help = disabledReason || (busy ? '命令请求在途，不会重复提交；仍可编辑下一条命令草稿。' : !input.value.trim() ? '请先输入一条 Lush 命令。' : '');
    if (run.disabled) { runHost.dataset.help = help; runHost.setAttribute('tabindex', '0'); }
    else { delete runHost.dataset.help; runHost.removeAttribute('tabindex'); }
    older.hidden = typeof loadHistory !== 'function';
    older.disabled = disposed || reading || busy || entries.length >= 100 || (historyLoaded && !hasMore);
    const clearUnavailable = typeof loadHistory === 'function' && typeof clearHistory !== 'function';
    clear.disabled = disposed || busy || !entries.length || clearUnavailable;
    if (clear.disabled) { clearHost.dataset.help = clearUnavailable ? '服务器历史清除接口尚未连接，不能清除持久历史。' : busy ? '执行或确认在途，不能同时清除命令历史。' : '暂无可清除的命令历史。'; clearHost.setAttribute('tabindex', '0'); }
    else { delete clearHost.dataset.help; clearHost.removeAttribute('tabindex'); }
  }
  function dismissConfirmation() {
    // Never close a replacement dialog owned by another feature.
    if (confirmation && document.getElementById('modal')?.querySelector('.worker-cli-confirm') === confirmation) closeDialog();
    confirmation = null;
  }
  function edited() {
    draftVersion++;
    if (confirmation) { dismissConfirmation(); status.textContent = '命令已修改，旧预览未执行；请重新执行以预览新命令。'; }
    selectedSuggestion = -1; suggestionsClosed = false; paintSuggestions(); sync();
  }
  function fillExamples() {
    for (const [node, handler] of exampleHandlers.splice(0)) node.removeEventListener('click', handler);
    examples.replaceChildren();
    // Starter paths are also projected from the catalog, never a parallel command list.
    for (const item of catalogCommands.filter(item => !item.directory && item.executable === 'lush' && item.operation === 'read').slice(0, 3)) {
      const command = item.path;
      const node = el('button', `填入 ${command}`, 'ghost'); node.type = 'button';
      const handler = () => { if (disposed || reason()) return; input.value = command; edited(); input.focus(); };
      node.addEventListener('click', handler); exampleHandlers.push([node, handler]); examples.append(node);
    }
  }
  async function submit() {
    if (busy || reason() || !input.value.trim()) return;
    const command = input.value, id = task.id, version = draftVersion, turn = ++generation;
    const current = () => !disposed && generation === turn && task.id === id;
    const unchanged = () => current() && draftVersion === version && input.value === command && !reason();
    busy = true; sync(); status.textContent = '正在预览，尚未执行…';
    let started = false, executionEntry = null;
    try {
      const plan = await preview(command);
      if (!current()) return;
      if (!unchanged()) { status.textContent = '命令已修改，旧预览未执行；请重新执行。'; return; }
      if (plan?.id !== id || plan.command !== command || !present(plan.workspace) || !present(plan.revision)
        || typeof plan.requires_confirmation !== 'boolean' || !present(plan.kind)
        || !Array.isArray(plan.argv) || plan.argv.some(arg => typeof arg !== 'string') || !present(plan.executable) || !present(plan.path)) {
        throw Error('预览返回的 Worker、命令或执行信息无效。');
      }
      workspace.textContent = plan.workspace;
      const agent = plan.kind === 'agent';
      const needsConfirmation = plan.requires_confirmation || agent;
      if (needsConfirmation) {
        const content = el('div', undefined, 'worker-cli-confirm'); confirmation = content;
        content.append(el('p', `${workerNumber(task)} · 当前登录用户 · 真实执行，不是沙箱。`));
        const consequence = agent ? '将提交或唤醒 Agent 工作，并可能修改项目与持久状态。'
          : '将执行有副作用的 Lush 操作，可能修改文件、项目状态、Worker 或资源；这不是只读预览。';
        content.append(el('p', consequence));
        content.append(el('pre', `命令：${plan.command}\n目录：${plan.workspace}\n执行程序：${plan.executable}\n命令路径：${plan.path}\n参数：${JSON.stringify(plan.argv)}\n分类：${plan.kind}`, 'worker-cli-confirm-detail'));
        status.textContent = '等待确认，尚未执行；修改草稿会取消本次执行。';
        const accepted = await formDialog({ title: '确认真实 CLI 执行', content, confirmLabel: agent ? '确认并调用 Agent' : '确认执行',
          agent, confirmHelp: agent ? agentHelp(consequence) : consequence, canConfirm: unchanged });
        if (confirmation === content) confirmation = null;
        if (!current()) return;
        if (!unchanged()) { status.textContent = '命令或工作区已变化，旧预览未执行；请重新预览。'; return; }
        if (!accepted) { status.textContent = '已取消，未执行。'; return; }
      }
      if (!unchanged()) return;
      started = true;
      executionEntry = { pending: true, value: { command, workspace: plan.workspace, created_at: new Date().toISOString(), status: 'unknown' } };
      entries.push(executionEntry); paintHistory();
      // Clear only the submitted draft at dispatch. Later typing belongs to the next command.
      input.value = ''; draftVersion++; suggestionsClosed = true; paintSuggestions(); sync();
      status.textContent = '正在真实执行，请勿重复提交…';
      const outcome = await execute({ command, revision: plan.revision, confirm: needsConfirmation });
      if (!current()) return;
      executionEntry.pending = false;
      executionEntry.value = { ...executionEntry.value, ...outcome, status: outcome?.status || 'unknown',
        id: outcome?.history_id ?? null, command, workspace: outcome?.workspace || plan.workspace };
      if (executionEntry.value.id != null) entries = entries.filter(entry => entry === executionEntry || entry.value.id !== executionEntry.value.id);
      paintHistory(); status.textContent = summary(executionEntry.value);
    } catch (error) {
      if (!current()) return;
      status.textContent = started ? `结果未知：执行请求失败，命令可能已执行；请先核查，不会自动重试。${errorText(error)}`
        : `预览失败，未执行。${errorText(error)}`;
      if (started) {
        executionEntry.pending = false;
        executionEntry.value = { ...executionEntry.value, status: 'unknown', error: status.textContent }; paintHistory();
      }
    } finally {
      if (current()) { busy = false; sync(); }
    }
  }
  function keydown(event) {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Escape') { suggestionsClosed = true; selectedSuggestion = -1; paintSuggestions(); return; }
    if (suggestionItems.length && ['ArrowDown', 'ArrowUp', 'Tab', 'Enter'].includes(event.key) && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault(); selectedSuggestion = (selectedSuggestion + (event.key === 'ArrowDown' ? 1 : suggestionItems.length - 1)) % suggestionItems.length; paintSuggestions(); return;
      }
      if (event.key === 'Tab' || selectedSuggestion >= 0) {
        event.preventDefault(); if (!event.repeat) fillCommand(suggestionItems[Math.max(0, selectedSuggestion)]); return;
      }
    }
    if (event.key !== 'Enter' || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey
      || event.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    if (!event.repeat) return submit();
  }
  input.addEventListener('input', edited); input.addEventListener('keydown', keydown); run.addEventListener('click', submit);
  older.addEventListener('click', readHistory); clear.addEventListener('click', clearEntries);
  root.setActive = active => { visible = active; root.hidden = !active; if (!active) dismissConfirmation(); sync(); };
  root.update = next => {
    if (disposed) return root;
    const changed = !task || task.id !== next?.id;
    const contextChanged = changed || task.workspace !== next?.workspace || task.task_kind !== next?.task_kind || task.execution_retired !== next?.execution_retired;
    if (contextChanged) { generation++; historyGeneration++; reading = false; busy = false; dismissConfirmation(); }
    task = { ...next };
    if (contextChanged) { entries = []; before = null; hasMore = false; historyLoaded = false; history.replaceChildren(); historyStatus.textContent = ''; }
    if (changed) { input.value = ''; draftVersion++; status.textContent = ''; advanced.open = false; }
    else if (contextChanged) status.textContent = '工作区或 Worker 类型已变化，旧请求不再更新此面板；已发出的命令仍可能执行，请先核查。';
    worker.textContent = workerNumber(task);
    if (contextChanged) workspace.textContent = present(task.workspace) ? task.workspace : '工作区不可用';
    if (contextChanged) { selectedSuggestion = -1; suggestionsClosed = false; paintSuggestions(); }
    fillExamples(); sync();
    if (contextChanged && Number.isSafeInteger(task.id) && task.id > 0 && ['order', 'child'].includes(task.task_kind)
      && task.execution_retired !== true) root.ready = readHistory();
    return root;
  };
  root.dispose = () => {
    if (disposed) return;
    disposed = true; generation++; historyGeneration++; busy = false; dismissConfirmation();
    older.removeEventListener('click', readHistory); clear.removeEventListener('click', clearEntries);
    input.removeEventListener('input', edited); input.removeEventListener('keydown', keydown); run.removeEventListener('click', submit);
    for (const [node, handler] of exampleHandlers.splice(0)) node.removeEventListener('click', handler);
    sync();
  };
  return root.update(initialTask);
}
