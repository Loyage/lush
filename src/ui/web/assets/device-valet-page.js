import { $, el, button } from './dom.js';
import { api } from './api.js';
import { agentHelp } from './help.js';
import { activateDetailView } from './sidebar-ui.js';
import { projectRoute } from './route.js';
import { ui } from './state.js';
import { DEVICE_VALET_API, DEVICE_VALET_ROUTES, DEVICE_VALET_MODE, DEVICE_VALET_SCOPE, DEVICE_VALET_LIMITS,
  normalizeDeviceValetDefinition, normalizeDeviceValetProfile } from '../../../device-valet/protocol.js';
import { confirmDeviceValet, syncDeviceValetSecrets, pendingDeviceValet, deviceValetReceipts } from './device-valet-input.js';

const text = value => typeof value === 'string' ? value : '';
const label = worker => text(worker?.worker_number) || `#${worker?.id ?? '未知'}`;
const stateLabel = value => ({ queued: '等待执行', running: '执行中', stopping: '停止中，尚未确认退出', stopped: '已停止', ready: '可追加新指令',
  succeeded: '已返回', completed: '已返回', failed: '失败', unknown: '结果未知', cancelled: '已取消' })[value] || '状态未知';
const reading = value => el('pre', typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value, null, 2), 'device-valet-reading');
const endpoint = kind => `${DEVICE_VALET_API}/${DEVICE_VALET_ROUTES[kind]}`;
function option(value, title) { const node = el('option', title); node.value = value; return node; }
function disabled(control, reason) {
  control.disabled = Boolean(reason);
  const host = control.parentNode;
  if (!host?.classList?.contains('help-host')) return;
  if (reason) { host.dataset.help = reason; host.setAttribute('tabindex', '0'); }
  else { delete host.dataset.help; host.removeAttribute('tabindex'); }
}
function helpHost(control) { const host = el('span', undefined, 'help-host'); host.append(control); return host; }
function modelEditor(change) {
  const root = el('details', undefined, 'device-valet-model-settings'), source = el('select', undefined, 'device-valet-source'), model = el('input', undefined, 'device-valet-model');
  const registered = el('select', undefined, 'device-valet-registered'), thinking = el('select', undefined, 'device-valet-thinking');
  root.append(el('summary', '模型与高级设置'));
  source.setAttribute('aria-label', '本条模型来源'); model.setAttribute('aria-label', '本条模型'); model.maxLength = 256;
  registered.setAttribute('aria-label', '已登记模型'); thinking.setAttribute('aria-label', '思考深度');
  for (const value of ['', 'off','minimal','low','medium','high','xhigh']) thinking.append(option(value, value || '默认'));
  const fields = el('div', undefined, 'device-valet-model-fields');
  for (const [name, input] of [['已登记模型', registered], ['来源', source], ['模型', model], ['思考深度', thinking]]) {
    const row = el('label', name); row.append(input); fields.append(row);
  }
  const hint = el('p', '本条来源和模型将在验密前明确核对，不读取私有 Prompt 或环境变量。', 'hint');
  const configure = el('a', '管理模型来源', 'nav-link'); configure.href = '/#model-sources'; configure.target = '_blank'; configure.rel = 'noopener';
  root.append(fields, hint, configure);
  let models = [], connections = [], touched = false;
  const value = () => normalizeDeviceValetProfile({ agent: 'pi', config_mode: 'lush', connection_id: source.value, model: model.value, thinking: thinking.value });
  function set(profile) {
    try {
      const selected = normalizeDeviceValetProfile(profile);
      if (!connections.some(row => row.id === selected.connection_id)) source.append(option(selected.connection_id, `来源 ${selected.connection_id}`));
      source.value = selected.connection_id; model.value = selected.model; thinking.value = selected.thinking;
    } catch { source.value = ''; model.value = ''; thinking.value = ''; }
  }
  const notify = () => { touched = true; change(); };
  source.onchange = () => { registered.value = ''; model.value = ''; notify(); };
  model.oninput = notify; thinking.onchange = notify;
  registered.onchange = () => { const found = models.find(row => row.id === registered.value); if (found) set({ agent: 'pi', config_mode: 'lush', connection_id: found.connection_id, model: found.model, thinking: thinking.value }); notify(); };
  return { root, value, set,
    sourceLabel: () => connections.find(row => row.id === source.value)?.label || source.value,
    fingerprint: () => JSON.stringify([source.value, model.value, thinking.value]),
    load(options, preferred = null) {
      const old = touched ? { connection_id: source.value, model: model.value, thinking: thinking.value } : null;
      connections = Array.isArray(options.connections) ? options.connections : [];
      hint.textContent = connections.length ? '本条来源和模型将在验密前明确核对，不读取私有 Prompt 或环境变量。'
        : '尚无可用托管来源；请先在模型来源页配置托管 Pi 来源，再返回选择来源与模型。不会继承机器 Pi 认证。';
      if (options.truncated === true) hint.textContent += ' 候选目录已裁剪，当前展示不是完整清单；未显示不代表没有该来源或模型。';
      models = Array.isArray(options.registered_models) ? options.registered_models : [];
      source.replaceChildren(option('', '请选择托管来源'), ...connections.map(row => option(row.id, row.label || row.id)));
      registered.replaceChildren(option('', '手动选择来源与模型'), ...models.filter(row => row.selectable !== false).map(row => option(row.id, row.name || row.id)));
      if (old) {
        if (old.connection_id && !connections.some(row => row.id === old.connection_id)) source.append(option(old.connection_id, `来源 ${old.connection_id}`));
        source.value = old.connection_id; model.value = old.model; thinking.value = old.thinking;
      } else set(preferred || options.default_profile);
      if (!source.value || !model.value) root.open = true;
    } };
}

/** Device-only canvas. Its reads never start a service; only a password-confirmed submission can do that. */
export function createDeviceValetPage({ container, request = api, send, isCurrent = () => true } = {}) {
  if (!container) throw new Error('device Valet container required');
  const owner = document, pathname = location.pathname, hash = location.hash, root = el('div', undefined, 'device-valet-page'); container.replaceChildren(root);
  let disposed = false, selected = null, worker = null, detailPage = null, options = null, generation = 0, detailGeneration = 0, editGeneration = 0;
  let workers = [], before = null, hasMore = false, creating = false, appending = false, appendOpen = false, listLoading = false;
  const reads = new Set(), stopping = new Set(), uncertainStops = new Set(), appendDrafts = new Map(), appendSettings = new Map();
  const owns = () => !disposed && owner === globalThis.document && pathname === globalThis.location?.pathname && hash === globalThis.location?.hash && root.parentNode === container && isCurrent();
  const header = el('header', undefined, 'device-valet-header'), status = el('p', '正在只读核对设备管家状态…', 'device-valet-status'); status.setAttribute('role', 'status');
  header.append(el('h1', '设备管家'), el('p', '管理此设备用户共享的 Lush 模型与来源；每条指令重新验证 Web 密码。', 'hint'), status,
    button('只读刷新状态与记录', () => load(), 'ghost', { busyLabel: '读取中…' }));
  const notice = el('p', '', 'device-valet-notice'); notice.setAttribute('role', 'status');
  const create = el('section', undefined, 'device-valet-card device-valet-create'), input = el('textarea', undefined, 'device-valet-instruction');
  input.setAttribute('aria-label', '新建设备管家指令'); input.placeholder = '例如：查看可用模型，并整理指定来源的模型登记'; input.maxLength = DEVICE_VALET_LIMITS.instruction;
  const model = modelEditor(edited);
  const execute = button('核对并执行', () => submit('create'), undefined, { agent: true, busyLabel: '核对中…', help: agentHelp('核对完整指令、来源与设备影响范围并重新验证 Web 密码，创建设备管家执行这条指令。') });
  input.oninput = edited;
  input.onkeydown = event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing && event.keyCode !== 229) { event.preventDefault?.(); if (!execute.disabled) return submit('create'); } };
  create.append(el('h2', '新建指令'), input, model.root, helpHost(execute));
  const rows = el('div', undefined, 'device-valet-rows'), list = el('section', undefined, 'device-valet-card device-valet-list');
  const more = button('读取更早的管家', () => load(true), 'ghost', { busyLabel: '读取中…' }); more.hidden = true;
  list.append(el('h2', '最近的设备管家'), rows, more);
  const detail = el('div', undefined, 'device-valet-detail');
  const receipts = deviceValetReceipts({ request: read, current: owns, changed: syncControls, resolved: result => {
    if (!owns()) return;
    const original = result.definition;
    if (original.kind === 'create' && input.value === original.instruction) input.value = '';
    if (original.kind === 'append' && appendDrafts.get(original.id) === original.instruction) appendDrafts.set(original.id, '');
    report('原提交已确认存在；不代表执行已成功。'); void select(result.worker.id); void load();
  } });
  root.append(header, notice, create, receipts.root, list, detail);
  const report = (message, error = false) => { if (owns()) { notice.textContent = message; notice.classList.toggle('error', error); } };
  function edited() { ++editGeneration; syncDeviceValetSecrets(); syncControls(); }
  function modelValid(editor) { try { editor.value(); return true; } catch { return false; } }
  function syncControls() {
    if (!owns()) return;
    disabled(execute, creating ? '本条指令正在核对或提交，不重复发送。' : pendingDeviceValet('create').length ? '存在未知的新建提交，请先只读核对原收据。'
      : !input.value.trim() ? '请输入设备管家指令。' : !modelValid(model) ? '请在模型与高级设置中选择明确的托管来源和模型。' : null);
    const append = detail.querySelector('.device-valet-append-submit');
    if (append) disabled(append, appending ? '本条追加正在核对或提交。' : pendingDeviceValet('append', selected).length ? '该目标存在未知追加，请先只读核对。'
      : !worker?.can_append ? worker?.append_reason || '该设备管家暂不能追加。' : !appendDrafts.get(selected)?.trim() ? '请输入本条追加指令。'
      : !modelValid(appendSettings.get(selected)) ? '请为本条追加选择明确的托管来源和模型。' : null);
    receipts.refresh();
  }
  async function read(kind, params = {}) {
    const controller = new AbortController(); reads.add(controller);
    const query = new URLSearchParams(Object.entries(params).filter(([, value]) => value != null).map(([key, value]) => [key, String(value)]));
    try { return await request(`${endpoint(kind)}${query.size ? `?${query}` : ''}`, { signal: controller.signal }); }
    finally { reads.delete(controller); }
  }
  function paintList() {
    rows.replaceChildren();
    for (const item of workers) {
      const row = button(`${label(item)} · ${text(item.name || item.title) || '设备资源指令'} · ${stateLabel(item.status)}`, () => select(item.id), 'ghost device-valet-row');
      row.setAttribute('aria-pressed', String(selected === item.id)); rows.append(row);
    }
    if (!workers.length) rows.append(el('p', '当前读取范围没有设备管家记录。', 'hint'));
    more.hidden = !hasMore; more.disabled = listLoading;
  }
  function paintDetail() {
    const oldAudit = detail.querySelector('.device-valet-audit')?.open, oldModelInfo = detail.querySelector('.device-valet-model-info')?.open;
    detail.replaceChildren(); if (!worker) return;
    const summary = el('section', undefined, 'device-valet-card');
    summary.append(el('h2', `${label(worker)} · 设备管家`), el('p', stateLabel(worker.status), 'device-valet-worker-status'));
    if (worker.error) summary.append(el('p', text(worker.error), 'error'));
    if (worker.append_reason && !worker.can_append) summary.append(el('p', text(worker.append_reason), 'hint'));
    const actions = el('div', undefined, 'device-valet-actions');
    const append = button('追加指令', () => { appendOpen = !appendOpen; ++editGeneration; syncDeviceValetSecrets(); paintDetail(); }, 'ghost');
    actions.append(helpHost(append)); disabled(append, !worker.can_append ? worker.append_reason || '当前不能追加。' : null);
    const stop = button('停止设备管家', () => stopWorker(worker.id), 'danger control-primary', { busyLabel: '请求中…', help: '停止此设备管家并撤销未开始执行；保留历史与未知副作用，停止中不代表实际退出。' });
    actions.append(helpHost(stop)); disabled(stop, uncertainStops.has(worker.id) ? '停止结果未知，请只读核对，不重复请求。'
      : stopping.has(worker.id) ? '停止请求处理中。' : !worker.can_stop ? '当前没有可请求停止的执行。' : null);
    summary.append(actions); detail.append(summary);
    if (appendOpen) {
      const id = worker.id, box = el('section', undefined, 'device-valet-card device-valet-append'), draft = el('textarea', undefined, 'device-valet-instruction');
      draft.setAttribute('aria-label', `追加到 ${label(worker)}`); draft.maxLength = DEVICE_VALET_LIMITS.instruction; draft.value = appendDrafts.get(id) || '';
      let editor = appendSettings.get(id);
      if (!editor) { editor = modelEditor(edited); editor.load(options || {}, worker.model_selection); appendSettings.set(id, editor); }
      const confirm = button('核对追加指令', () => submit('append', id, editor), 'device-valet-append-submit', { agent: true, busyLabel: '核对中…', help: agentHelp('为同一设备管家提交新一条指令；重新核对内容、模型与范围，并输入 Web 登录密码。') });
      draft.oninput = () => { appendDrafts.set(id, draft.value); edited(); };
      draft.onkeydown = event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing && event.keyCode !== 229) { event.preventDefault?.(); if (!confirm.disabled) return submit('append', id, editor); } };
      box.append(el('h3', `追加到 ${label(worker)}`), draft, editor.root, helpHost(confirm)); detail.append(box);
    }
    const instructions = el('section', undefined, 'device-valet-card'); instructions.append(el('h3', '已读取的指令'));
    for (const item of detailPage.instructions) instructions.append(el('p', `${item.id || '指令'} · ${stateLabel(item.status)}`, 'hint'), reading(item.instruction));
    if (!detailPage.instructions.length) instructions.append(el('p', '本页未返回指令；不代表从未提交。', 'hint'));
    detail.append(instructions);
    const result = el('section', undefined, 'device-valet-card'); result.append(el('h3', '结果'), reading(worker.result || '尚未获得已返回结果；请只读刷新核对。'));
    if (worker.result_truncated === true) result.append(el('p', '结果已裁剪；当前展示并非完整结果。', 'hint device-valet-result-truncated'));
    detail.append(result);
    const modelInfo = el('details', undefined, 'device-valet-card device-valet-model-info'); modelInfo.open = oldModelInfo === true; modelInfo.append(el('summary', '模型信息（按需展开）'), reading(worker.model_selection)); detail.append(modelInfo);
    const audit = el('details', undefined, 'device-valet-card device-valet-audit'); audit.open = oldAudit === true; audit.append(el('summary', '审计（按需展开）'));
    for (const item of detailPage.events) audit.append(el('p', `${item.id} · ${text(item.type)} · ${text(item.created_at)}`, 'mono'));
    audit.append(el('p', '仅显示已读取范围，不证明历史完整。', 'hint')); detail.append(audit);
    if (detailPage.truncated || detailPage.coverage) detail.append(el('p', `读取覆盖：${text(detailPage.coverage) || '本页有裁剪'}${detailPage.truncated ? ' · 已裁剪' : ''}`, 'hint'));
    if (detailPage.has_more) detail.append(button('读取更早的详情', () => loadDetail(true), 'ghost', { busyLabel: '读取中…' }));
    syncControls();
  }
  async function select(id) {
    if (!owns()) return;
    ++editGeneration; selected = id; worker = null; detailPage = null; appendOpen = false; syncDeviceValetSecrets(); paintList(); paintDetail(); return loadDetail();
  }
  async function loadDetail(append = false) {
    const id = selected, current = ++detailGeneration; if (!id || !owns()) return;
    try {
      const page = await read('detail', { id, before: append ? detailPage?.next_cursor : null, limit: DEVICE_VALET_LIMITS.page });
      if (!owns() || id !== selected || current !== detailGeneration) return;
      if (page?.version !== 1 || page.worker?.id !== id || !Array.isArray(page.instructions) || !Array.isArray(page.events)
        || typeof page.has_more !== 'boolean' || page.has_more && (typeof page.next_cursor !== 'string' || !page.next_cursor || append && page.next_cursor === detailPage?.next_cursor)) throw new Error('incomplete');
      if (append) { page.instructions = [...new Map([...detailPage.instructions, ...page.instructions].map(item => [item.id, item])).values()]; page.events = [...new Map([...detailPage.events, ...page.events].map(item => [item.id, item])).values()]; }
      worker = page.worker; detailPage = page;
      if (['stopping','stopped','cancelled'].includes(worker.status)) uncertainStops.delete(id);
      syncDeviceValetSecrets(); paintDetail();
    } catch { if (owns() && selected === id && current === detailGeneration) report('设备管家详情读取未确认；保留原阅读与草稿，不推断已停止或执行成功。', true); }
  }
  async function load(append = false) {
    const current = ++generation; listLoading = true; more.disabled = true;
    try {
      const service = await read('status'); if (!owns() || current !== generation) return;
      if (service?.version !== 1 || typeof service.online !== 'boolean') throw new Error('incomplete');
      status.textContent = service.online ? `设备管家服务在线 · 活动执行 ${Number.isSafeInteger(service.active) ? service.active : '未知'}`
        : '设备管家服务未运行；查看不会启动它，也不代表没有历史。提交并验证密码后才可启动执行。';
      if (!service.online) return;
      const page = await read('list', { before: append ? before : null, limit: DEVICE_VALET_LIMITS.page });
      if (!owns() || current !== generation) return;
      if (page?.version !== 1 || !Array.isArray(page.items) || typeof page.has_more !== 'boolean'
        || page.has_more && (typeof page.next_cursor !== 'string' || !page.next_cursor || append && page.next_cursor === before)) throw new Error('incomplete');
      workers = append ? [...new Map([...workers, ...page.items].map(item => [item.id, item])).values()] : page.items;
      before = page.next_cursor; hasMore = page.has_more; paintList();
      if (page.truncated) report('列表只显示有界裁剪范围，请继续读取更早记录。');
      if (selected && !append) await loadDetail();
    } catch { if (owns() && current === generation) report('设备管家状态或列表读取失败；不能当作空历史，不自动启动或重试。', true); }
    finally { if (owns() && current === generation) { listLoading = false; more.disabled = false; } }
  }
  async function submit(kind, id = null, editor = model) {
    if (!owns() || (kind === 'create' ? creating : appending) || pendingDeviceValet(kind, id).length) return;
    const original = kind === 'create' ? input.value : appendDrafts.get(id) || '', target = worker;
    let definition;
    try {
      definition = normalizeDeviceValetDefinition({ kind, mode: DEVICE_VALET_MODE, scope: DEVICE_VALET_SCOPE, instruction: original,
        client_request_id: crypto.randomUUID(), profile: editor.value(), ...(kind === 'append' ? { id, expected_revision: target?.revision } : {}) });
    } catch { report('请输入完整指令，并在模型与高级设置中选择明确的托管来源和模型。', true); return; }
    const generation = editGeneration, fingerprint = editor.fingerprint();
    const current = () => owns() && generation === editGeneration && editor.fingerprint() === fingerprint
      && (kind === 'create' ? input.value === original : selected === id && worker?.id === id && worker.revision === definition.expected_revision && appendDrafts.get(id) === original);
    if (kind === 'create') creating = true; else appending = true; syncControls();
    try {
      const receipt = await confirmDeviceValet(definition, { current, send, changed: syncControls, sourceLabel: editor.sourceLabel(), targetLabel: kind === 'append' ? label(target) : '' });
      if (!receipt || !current()) return;
      if (kind === 'create') input.value = ''; else appendDrafts.set(id, '');
      report('本条设备指令已提交；提交收据不代表执行已完成。');
      await select(receipt.worker.id); await load();
    } finally { if (kind === 'create') creating = false; else appending = false; if (owns()) syncControls(); }
  }
  async function stopWorker(id) {
    if (!owns() || selected !== id || !worker?.can_stop || stopping.has(id) || uncertainStops.has(id)) return;
    stopping.add(id); paintDetail();
    try {
      const result = await request(endpoint('stop'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
      if (!owns() || selected !== id) return;
      if (result?.version !== 1 || result.worker?.id !== id) throw new Error('unconfirmed');
      worker = result.worker; report(worker.status === 'stopping' ? '已请求停止，仍等待真实退出；已开始操作的副作用保留。' : '停止请求已返回；未知副作用未回滚。'); await loadDetail();
    } catch { uncertainStops.add(id); if (owns() && selected === id) report('停止请求结果未知；请只读刷新核对，不重复发送停止。', true); }
    finally { stopping.delete(id); if (owns() && selected === id) paintDetail(); }
  }
  async function loadOptions() {
    try {
      const result = await read('options'); if (!owns()) return;
      if (result?.version !== 1 || !Array.isArray(result.connections) || !Array.isArray(result.registered_models)) throw new Error('incomplete');
      options = result; model.load(result); syncControls();
    } catch { if (owns()) report('可用来源和默认模型读取失败；不能猜测来源，请只读重新打开页面。', true); }
  }
  const pagehide = () => dispose(); globalThis.addEventListener?.('pagehide', pagehide);
  function dispose() { disposed = true; ++editGeneration; for (const controller of reads) controller.abort(); reads.clear(); syncDeviceValetSecrets(); globalThis.removeEventListener?.('pagehide', pagehide); }
  syncControls(); const ready = Promise.all([loadOptions(), load()]);
  return { root, ready, refresh: () => load(), select, dispose };
}
let page = null, pageView = null, pageOwner = null;
export function disposeDeviceValetPage() { page?.dispose(); page = pageView = pageOwner = null; }
export function openDeviceValet({ push = true, request = api } = {}) {
  if (projectRoute()) throw new Error('设备管家在独立用户工作台打开');
  const view = activateDetailView({ view: 'device-valet', hash: '#device-valet', title: '设备管家', context: '用户工作台', hint: '共享模型与来源 · 每条指令重新验证密码', push });
  if (page && pageView === view && pageOwner === document && page.root.parentNode === $('detail')) return page.refresh();
  disposeDeviceValetPage(); page = createDeviceValetPage({ container: $('detail'), request, isCurrent: () => ui.view === view }); pageView = view; pageOwner = document;
  return page.ready;
}
