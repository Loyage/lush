import { $, el, button } from './dom.js';
import { api } from './api.js';
import { formDialog, closeDialog } from './dialog.js';
import { agentHelp } from './help.js';
import { activateDetailView } from './sidebar-ui.js';
import { projectRoute } from './route.js';
import { ui } from './state.js';
import { ADMINISTRATOR_API, ADMINISTRATOR_ROUTES, ADMINISTRATOR_MODE, ADMINISTRATOR_SCOPE,
  ADMINISTRATOR_LIMITS, ADMINISTRATOR_RISK, normalizeAdministratorDefinition, administratorDefinitionText } from '../../../administrator/protocol.js';

const pendingKey = 'lush.administrator.unconfirmed.v1';
const retained = new Map();
const labels = { ready: '等待指令', idle: '等待指令', queued: '已排队', running: '执行中', stopping: '停止中，尚未确认退出', stopped: '已停止',
  succeeded: '已返回', completed: '已返回', failed: '失败', unknown: '结果未知', cancelled: '已取消' };
const statusText = status => labels[status] || '状态未知';
const text = value => typeof value === 'string' ? value : '';
const label = worker => text(worker?.worker_number) || `#${worker?.id ?? '未知'}`;
const requestKey = () => globalThis.crypto.randomUUID();
const hasIdentity = value => typeof value === 'string' && value.length > 0 || Number.isSafeInteger(value) && value > 0;
const isWorker = value => typeof value?.id === 'string' && value.id.length > 0 && value.mode === ADMINISTRATOR_MODE
  && value.scope === ADMINISTRATOR_SCOPE && typeof value.can_input === 'boolean' && typeof value.status === 'string';
const effectText = effect => ({ unknown: '副作用未知；不自动重放', not_started: '有证据表明尚未开始', applied: '已有本项操作生效证据，不代表后续业务完成',
  not_applicable: '只读操作，无写入副作用' })[effect] || '未提供副作用完成证明，不能据请求返回判定成功';

function restorePending(storage) {
  try {
    const saved = JSON.parse(storage?.getItem(pendingKey) || '[]');
    if (Array.isArray(saved)) for (const item of saved.slice(0, 16)) {
      const definition = normalizeAdministratorDefinition(item.definition);
      retained.set(definition.client_request_id, { definition, created_at: text(item.created_at) });
    }
  } catch { /* Existing in-memory evidence remains; malformed storage never grants permission. */ }
}
function persistPending(storage) {
  try { storage?.setItem(pendingKey, JSON.stringify([...retained.values()])); }
  catch { /* Do not discard the in-memory original request or turn unknown into success. */ }
}
function section(title, className = '') {
  const root = el('section', undefined, `administrator-card ${className}`); root.append(el('h2', title)); return root;
}
function reading(value, className = '') { return el('pre', text(value), `administrator-reading ${className}`); }
// The backend samples original failures before subsequent stop/recovery. Render only the
// documented safe evidence fields, never arbitrary transport bodies, stacks or parameters.
function appendOriginalFailure(parent, failure) {
  const detail = failure?.detail, sample = detail?.error;
  if (!sample || typeof sample !== 'object') return;
  const lines = [];
  for (const [label, value] of [['来源', detail.source], ['阶段', failure.stage], ['类别', sample.name], ['代码', sample.code], ['原始安全消息', sample.message]]) {
    if (typeof value === 'string' || typeof value === 'number' && Number.isFinite(value)) lines.push(`${label}：${String(value)}`);
  }
  if (lines.length) parent.append(el('h3', '最初失败安全证据'), reading(lines.join('\n'), 'error'));
}
function control(title, run, className = 'ghost', options = {}) {
  const node = button(title, () => {}, className, options), host = el('span', undefined, 'help-host');
  node.onclick = run; host.append(node);
  return { node, host, disable(disabled, reason) {
    node.disabled = disabled;
    if (disabled) { host.dataset.help = reason; host.setAttribute('tabindex', '0'); }
    else { delete host.dataset.help; host.removeAttribute('tabindex'); }
  } };
}

/** Standalone, root-API-only page. Reads never start a service. No router/server dependencies. */
export function createAdministratorPage({ container, request = api, isCurrent = () => true } = {}) {
  if (!container) throw new Error('administrator page container required');
  const storage = globalThis.sessionStorage;
  restorePending(storage);
  const owner = globalThis.document, pathname = globalThis.location?.pathname;
  const root = el('div', undefined, 'administrator-page'); container.replaceChildren(root);
  const state = { disposed: false, online: null, workers: [], listCursor: null, listMore: false, selected: null,
    worker: null, detail: null, readGeneration: 0, detailGeneration: 0, selectionGeneration: 0, createBusy: false,
    stopBusy: false, stopUnknown: new Set(), receiptBusy: new Set(), verifiedReceipts: new Map(),
    createKey: requestKey(), createRevision: 0, drafts: new Map(), confirmation: null };
  const reads = new Set();
  const owns = () => !state.disposed && owner === globalThis.document && globalThis.location?.pathname === pathname
    && root.parentNode === container && isCurrent();
  const ownsDialog = content => $('modal')?.querySelector('.administrator-confirmation') === content;
  const invalidateConfirmation = () => {
    const current = state.confirmation; state.confirmation = null;
    if (current && ownsDialog(current.content)) closeDialog();
  };
  function report(message, error = false) { if (!owns()) return; notice.textContent = message; notice.classList.toggle('error', error); }
  async function read(route, params = {}) {
    const controller = new AbortController(); reads.add(controller);
    const query = new URLSearchParams(Object.entries(params).filter(([, value]) => value != null).map(([key, value]) => [key, String(value)]));
    try {
      const suffix = ADMINISTRATOR_ROUTES[route];
      if (!suffix) throw new Error('未知管理员只读路由');
      return await request(`${ADMINISTRATOR_API}/${suffix}${query.size ? `?${query}` : ''}`, { signal: controller.signal });
    }
    finally { reads.delete(controller); }
  }
  const post = (route, body) => request(`${ADMINISTRATOR_API}/${ADMINISTRATOR_ROUTES[route]}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const hero = el('header', undefined, 'administrator-hero');
  hero.append(el('span', '独立管理员身份 · 跨项目高权限', 'administrator-identity'), el('h1', '管理员管家'), el('p', ADMINISTRATOR_RISK, 'administrator-risk'));
  const service = el('p', '正在只读核对管理员服务…', 'administrator-service'); service.setAttribute('role', 'status');
  const refresh = control('刷新服务与记录', () => load()); hero.append(service, refresh.host);
  const notice = el('p', '', 'administrator-notice'); notice.setAttribute('role', 'status'); notice.setAttribute('aria-live', 'polite');
  const evidence = section('待核对的提交', 'administrator-uncertain'); evidence.setAttribute('role', 'alert');
  const creation = section('创建管理员管家', 'administrator-create');
  const nameLabel = el('label', '管理员名称'), name = el('input', undefined, 'administrator-name');
  name.id = 'administrator-name'; name.maxLength = ADMINISTRATOR_LIMITS.name; nameLabel.setAttribute('for', name.id);
  const create = control('核对权限范围并创建', () => confirmDefinition('create'), '', {
    help: '由你确认跨项目高权限范围后仅建立独立管理员身份；创建不调用 Agent，首条指令仍须单独确认。',
  });
  name.oninput = () => { state.createRevision += 1; if (!hasPending('create')) state.createKey = requestKey(); invalidateConfirmation(); sync(); };
  creation.append(nameLabel, name, create.host, el('p', '创建只建立身份，不调用 Agent；成功后再核对并确认首条完整指令。', 'hint'));
  const list = section('管理员管家列表', 'administrator-list'), rows = el('div', undefined, 'administrator-rows');
  const more = control('读取更早的管家', () => load(true)); list.append(rows, more.host);
  const detail = el('div', undefined, 'administrator-detail');
  root.append(hero, notice, evidence, creation, list, detail);

  function hasPending(kind, id) { return [...retained.values()].some(item => item.definition.kind === kind && (kind === 'create' || item.definition.id === id)); }
  function draft(id) {
    if (!state.drafts.has(id)) {
      const unresolved = [...retained.values()].find(item => item.definition.kind === 'input' && item.definition.id === id);
      state.drafts.set(id, { text: unresolved?.definition.instruction ?? '', key: unresolved?.definition.client_request_id ?? requestKey(), revision: 0, busy: false });
    }
    return state.drafts.get(id);
  }
  function showEvidence() {
    evidence.hidden = !retained.size && !state.verifiedReceipts.size;
    evidence.replaceChildren(el('h2', '提交核对记录'));
    if (retained.size) evidence.append(el('p', '以下请求已经尝试提交，但未获得完整结果证明。仅可只读核对，不会自动重发、换请求身份或当作未执行。刷新读面成功也不证明本次提交成功。'));
    for (const item of retained.values()) {
      const definition = item.definition, key = definition.client_request_id;
      const check = control('只读核对本次提交', () => checkReceipt(item), 'ghost', {
        help: '仅按原请求身份读取收据，完整内容必须与原稿一致才解除提交未知；未找到或读取失败不证明未执行，不会重发。',
      });
      check.node.dataset.requestId = key;
      check.disable(state.receiptBusy.has(key), '正在只读核对本次提交，不重复读取或重发写请求。');
      evidence.append(el('h3', definition.kind === 'create' ? `创建：${definition.name}` : `输入目标：${definition.id}`),
        el('p', `请求身份：${key} · ${item.created_at}`, 'mono'),
        reading(definition.kind === 'input' ? definition.instruction : definition.name), check.host);
    }
    for (const [key, receipt] of state.verifiedReceipts) {
      evidence.append(el('h3', '原提交已确认存在 · 不等于执行成功'), el('p', `请求身份：${key}`, 'mono'),
        el('p', `${label(receipt.worker)} · 当前状态：${statusText(receipt.instruction?.status ?? receipt.worker.status)}`),
        el('p', effectText(receipt.instruction?.effect), receipt.instruction?.effect === 'unknown' ? 'error' : 'hint'));
      if (receipt.instruction?.error || receipt.worker.error) evidence.append(reading(receipt.instruction?.error || receipt.worker.error, 'error'));
      appendOriginalFailure(evidence, receipt.instruction?.original_failure ?? receipt.worker.original_failure);
      evidence.append(button('查看该管理员当前记录', () => select(receipt.worker.id), 'ghost'));
    }
  }
  async function checkReceipt(item) {
    const definition = item.definition, key = definition.client_request_id;
    if (!owns() || state.receiptBusy.has(key) || retained.get(key) !== item) return;
    state.receiptBusy.add(key); showEvidence();
    try {
      const receipt = await read('receipt', { client_request_id: key });
      if (!owns() || retained.get(key) !== item) return;
      if (receipt?.version !== 1 || typeof receipt.found !== 'boolean') throw new Error('收据读面不完整');
      if (!receipt.found) { report('尚未找到原提交收据；原请求可能仍在并发提交，继续保留未知锁定，不重发。', true); return; }
      if (administratorDefinitionText(receipt.definition) !== administratorDefinitionText(definition) || !isWorker(receipt.worker)
        || definition.kind === 'input' && (receipt.worker.id !== definition.id || receipt.instruction?.instruction !== definition.instruction
          || typeof receipt.instruction?.status !== 'string' || !hasIdentity(receipt.instruction?.id))) {
        throw new Error('收据与原目标、权限模式或精确完整内容不一致');
      }
      retained.delete(key); persistPending(storage); state.verifiedReceipts.set(key, receipt);
      if (definition.kind === 'create' && state.createKey === key) {
        if (name.value === definition.name) { name.value = ''; state.createRevision += 1; }
        state.createKey = requestKey();
      }
      if (definition.kind === 'input') {
        const current = draft(definition.id);
        if (current.key === key) {
          if (current.text === definition.instruction) { current.text = ''; current.revision += 1; }
          current.key = requestKey(); // A future edited draft is new work; the proved original is never resubmitted.
        }
      }
      if (state.selected === receipt.worker.id && state.detail) {
        state.worker = receipt.worker;
        if (receipt.instruction) state.detail.instructions = [...new Map([...state.detail.instructions, receipt.instruction].map(value => [value.id, value])).values()];
        paintDetail();
      }
      report(`已找到与原稿完全一致的提交收据；仅确认原提交存在，当前状态：${statusText(receipt.instruction?.status ?? receipt.worker.status)}。不代表执行成功，不会重发。`);
    } catch (error) { if (owns()) report(`只读收据核对未完成：${error.message}；保留原请求、完整正文和未知锁定，不重发。`, true); }
    finally { state.receiptBusy.delete(key); if (owns()) sync(); }
  }
  function sync() {
    if (!owns()) return;
    const pending = hasPending('create');
    create.disable(state.createBusy || pending || !name.value.trim(), pending ? '创建结果未知，请先只读核对原请求，不能重复创建或换请求身份。' : state.createBusy ? '正在核对或提交创建请求，不会重复发送。' : '填写管理员名称后才能核对高权限范围。');
    more.host.hidden = !state.listMore; more.disable(false, '');
    showEvidence();
    const editor = detail.querySelector('.administrator-instruction');
    if (editor && state.selected) {
      const current = draft(state.selected), submit = detail.querySelector('.administrator-submit');
      const host = detail.querySelector('.administrator-submit-host');
      const reason = hasPending('input', state.selected) ? '本条输入提交结果未知；保留正文与请求身份，只读核对，不重复发送。'
        : current.busy ? '正在核对或提交本条指令，不会重复发送。'
        : state.online !== true ? '管理员服务状态未确认在线；请只读刷新，不能把离线当作没有历史。'
        : state.worker?.can_input !== true ? text(state.worker?.reason) || '后台当前不允许新输入，请核对运行、停止或未知副作用状态。'
        : !editor.value.trim() ? '填写完整指令后才能核对并确认。' : '';
      submit.disabled = Boolean(reason);
      if (reason) { host.dataset.help = reason; host.setAttribute('tabindex', '0'); }
      else { delete host.dataset.help; host.removeAttribute('tabindex'); }
    }
  }
  function paintList() {
    rows.replaceChildren();
    if (!state.workers.length) rows.append(el('p', state.online === true ? '本次读取范围内没有管理员管家。' : '服务未确认在线，不能据此判断没有管理员历史。', 'hint'));
    for (const worker of state.workers) {
      const row = button('', () => {}, 'ghost administrator-row'); row.onclick = () => select(worker.id);
      row.dataset.administratorId = worker.id;
      row.append(el('strong', `${label(worker)} · ${text(worker.name)}`), el('span', `管理员 · 跨项目 · ${statusText(worker.status)}`));
      row.setAttribute('aria-pressed', String(state.selected === worker.id)); rows.append(row);
    }
  }
  function paintDetail() {
    detail.replaceChildren();
    if (!state.selected) { detail.append(el('p', '选择管理员查看详情；普通 Valet 和开发 Worker 不会获得管理员身份。', 'hint')); return; }
    if (!state.worker) { detail.append(el('p', '正在读取管理员详情；尚未确认当前状态。', 'hint')); return; }
    const worker = state.worker, current = draft(worker.id);
    const summary = section(`${label(worker)} · ${text(worker.name)}`, 'administrator-summary');
    summary.append(el('p', '管理员身份 · 跨项目高权限', 'administrator-identity'), el('p', `当前状态：${statusText(worker.status)}`, 'administrator-worker-status'));
    if (worker.reason) summary.append(el('p', text(worker.reason), 'warn administrator-blocker'));
    if (worker.error) summary.append(el('h3', '原始失败'), reading(worker.error, 'error'));
    appendOriginalFailure(summary, worker.original_failure);
    if (worker.status === 'unknown' || state.detail?.instructions.some(item => item.effect === 'unknown' || item.status === 'unknown')) {
      summary.append(el('p', '存在未知结果或未知副作用；停止不撤销已发生的操作，不自动重放。', 'error administrator-unknown'));
    }
    const stop = control('紧急停止并撤销未执行授权', () => stopWorker(worker.id), 'danger', {
      help: '立即请求停止这个管理员并撤销尚未执行的授权，不再弹逐项授权确认；已发生的副作用不撤销，stopping 不代表已退出。',
    });
    const stopped = ['stopping', 'stopped', 'cancelled'].includes(worker.status);
    stop.disable(state.stopBusy || state.stopUnknown.has(worker.id) || stopped, state.stopUnknown.has(worker.id)
      ? '停止结果未知，请只读核对，不重复发送停止请求。' : stopped ? '已请求停止或已停止；请只读核对真实退出与未知副作用。' : '停止请求正在处理，不重复提交。'); summary.append(stop.host);
    const editor = section('新指令', 'administrator-editor'), instruction = el('textarea', undefined, 'administrator-instruction');
    instruction.id = 'administrator-instruction'; instruction.value = current.text; instruction.maxLength = ADMINISTRATOR_LIMITS.instruction;
    instruction.rows = 6; instruction.setAttribute('aria-label', `${label(worker)} 的完整新指令`);
    instruction.oninput = () => { current.text = instruction.value; current.revision += 1; if (!hasPending('input', worker.id)) current.key = requestKey(); invalidateConfirmation(); sync(); };
    const submit = control('核对本条指令并确认执行', () => confirmDefinition('input'), '', {
      agent: true, help: agentHelp('核对本条完整正文、目标管理员及高权限模式后，仅提交这一条新指令；执行中不再逐项询问。'),
    });
    submit.node.classList.add('administrator-submit'); submit.host.classList.add('administrator-submit-host');
    editor.append(instruction, submit.host, el('p', '首条与后续输入使用同一精确确认；修改正文后必须重新确认。不会重放旧操作。', 'hint'));
    const result = section('结果', 'administrator-result');
    result.append(worker.result ? reading(worker.result) : el('p', '尚无已返回的结果；排队、停止中和 unknown 均不表示业务完成。', 'hint'));
    const execution = section('执行记录', 'administrator-execution');
    for (const item of state.detail?.instructions ?? []) {
      const record = el('article', undefined, 'administrator-record');
      record.append(el('h3', `指令 ${item.id} · ${statusText(item.status)}`), el('p', effectText(item.effect), item.effect === 'unknown' ? 'error' : 'hint'), reading(item.instruction));
      if (item.error) record.append(el('h3', '首次失败'), reading(item.error, 'error'));
      appendOriginalFailure(record, item.original_failure);
      if (item.result) record.append(reading(item.result));
      execution.append(record);
    }
    if (!state.detail?.instructions.length) execution.append(el('p', '本页未读取到执行记录，不代表从未执行。', 'hint'));
    const audit = el('details', undefined, 'administrator-audit'); audit.append(el('summary', '授权审计与操作收据（按需展开）'));
    for (const event of state.detail?.events ?? []) {
      const row = el('article', undefined, 'administrator-event');
      row.append(el('p', `${event.id} · ${text(event.type)} · ${text(event.created_at)}`, 'mono'));
      // Render the safe summary only; never stringify arbitrary tool parameters or private payloads.
      for (const key of ['status', 'method', 'operation', 'effect', 'code']) if (typeof event.data?.[key] === 'string') row.append(el('p', `${key}：${event.data[key]}`));
      appendOriginalFailure(row, event.data?.original_failure);
      audit.append(row);
    }
    if (!state.detail?.events.length) audit.append(el('p', '本页没有已读取的审计项，不证明历史为空。', 'hint'));
    if (state.detail?.coverage) audit.append(el('p', text(state.detail.coverage), 'hint'));
    const model = el('details', undefined, 'administrator-model'); model.append(el('summary', '模型与运行设置（按需展开）'));
    const selection = worker.model_selection;
    if (selection && ['agent', 'model', 'thinking', 'connection_label'].some(key => typeof selection[key] === 'string')) {
      for (const key of ['agent', 'model', 'thinking', 'connection_label']) if (typeof selection[key] === 'string') model.append(el('p', `${key}：${selection[key]}`));
    } else model.append(el('p', '后台未提供安全模型配置摘要；此页不读取凭证或私有提示词，也不假造设置接口。', 'hint'));
    detail.append(summary, editor, result, execution, audit, model);
    if (state.detail?.has_more) detail.append(button('读取更早的详情记录', () => loadDetail(true), 'ghost'));
    sync();
  }
  async function load(append = false) {
    if (!owns()) return;
    const generation = ++state.readGeneration;
    try {
      const status = await read('status'); if (!owns() || state.readGeneration !== generation) return;
      if (status?.version !== 1 || typeof status.online !== 'boolean') throw new Error('管理员服务状态读面不兼容');
      state.online = status.online;
      service.textContent = status.online ? '独立管理员服务在线；当前读取不会创建身份或调用 Agent。'
        : '独立管理员服务未运行；读取不会启动它，也不能据此判断没有历史。显式创建预检可启动服务。';
      if (!status.online) { paintList(); sync(); return true; }
      const page = await read('list', { before: append ? state.listCursor : null, limit: 30 });
      if (!owns() || state.readGeneration !== generation) return;
      if (page?.version !== 1 || !Array.isArray(page.items) || page.items.some(item => !isWorker(item)) || typeof page.has_more !== 'boolean'
        || page.has_more && (page.next_cursor == null || page.next_cursor === state.listCursor && append)) throw new Error('管理员列表不完整，未采用该读取');
      state.workers = append ? [...new Map([...state.workers, ...page.items].map(item => [item.id, item])).values()] : page.items;
      state.listMore = page.has_more; state.listCursor = page.next_cursor;
      paintList(); sync();
      if (!append && state.selected && await loadDetail() === false) return false;
      return true;
    } catch (error) {
      if (owns() && state.readGeneration === generation) {
        state.online = null; service.textContent = '管理员服务当前状态未确认；保留旧读取，不能当作在线或没有历史。';
        report(`只读刷新失败：${error.message}。保留现有记录与输入，不重发任何写请求。`, true); sync();
      }
      return false;
    }
  }
  async function select(id) {
    if (!owns()) return;
    invalidateConfirmation(); state.selectionGeneration += 1; state.detailGeneration += 1;
    state.selected = id; state.worker = null; state.detail = null; paintList(); paintDetail(); await loadDetail();
  }
  async function loadDetail(append = false) {
    const id = state.selected, generation = ++state.detailGeneration;
    if (!id || !owns()) return;
    try {
      const page = await read('detail', { id, before: append ? state.detail?.next_cursor : null, limit: 30 });
      if (!owns() || state.selected !== id || state.detailGeneration !== generation) return;
      if (page?.version !== 1 || !isWorker(page.worker) || page.worker.id !== id || !Array.isArray(page.instructions)
        || !Array.isArray(page.events) || typeof page.has_more !== 'boolean' || page.has_more && page.next_cursor == null) throw new Error('管理员详情不完整，未采用该读取');
      if (append) page.instructions = [...new Map([...state.detail.instructions, ...page.instructions].map(item => [item.id, item])).values()];
      if (append) page.events = [...new Map([...state.detail.events, ...page.events].map(item => [item.id, item])).values()];
      state.worker = page.worker; state.detail = page;
      if (['stopping', 'stopped', 'cancelled'].includes(page.worker.status)) state.stopUnknown.delete(id);
      paintDetail(); return true;
    } catch (error) {
      if (owns() && state.selected === id && state.detailGeneration === generation) {
        if (state.worker) state.worker = { ...state.worker, can_input: false, reason: '详情读取失败，当前目标准入尚未确认；请只读刷新。' };
        report(`详情读取失败：${error.message}；不能据此判断目标已停止或请求未执行。`, true); sync();
      }
      return false;
    }
  }
  async function confirmDefinition(kind) {
    if (!owns()) return;
    const id = state.selected, current = kind === 'input' ? draft(id) : null;
    if (kind === 'create' ? state.createBusy || hasPending(kind) : !id || current.busy || hasPending(kind, id) || state.online !== true || state.worker?.can_input !== true) return;
    let definition;
    try { definition = normalizeAdministratorDefinition({ kind, mode: ADMINISTRATOR_MODE, scope: ADMINISTRATOR_SCOPE,
      client_request_id: current?.key ?? state.createKey, ...(kind === 'create' ? { name: name.value } : { id, instruction: current.text }) }); }
    catch (error) { report(error.message, true); return; }
    const revision = current?.revision ?? state.createRevision, selection = state.selectionGeneration;
    const unchanged = () => owns() && (kind === 'create' ? state.createRevision === revision && name.value === definition.name
      : state.selected === id && state.selectionGeneration === selection && current.revision === revision && current.text === definition.instruction);
    if (current) current.busy = true; else state.createBusy = true; sync();
    let content;
    try {
      const preview = await post('preview', { definition });
      if (!unchanged()) return;
      if (preview?.version !== 1 || typeof preview.confirmation_id !== 'string' || !preview.confirmation_id
        || !Number.isFinite(Date.parse(preview.expires_at)) || Date.parse(preview.expires_at) <= Date.now()
        || administratorDefinitionText(preview.definition) !== administratorDefinitionText(definition)) throw new Error('确认预检与当前精确内容不匹配，请重新核对');
      content = el('div', undefined, 'administrator-confirmation');
      content.append(el('p', ADMINISTRATOR_RISK, 'administrator-risk'), el('p', `模式：${definition.mode} · 范围：${definition.scope}`),
        el('p', kind === 'create' ? '仅建立管理员身份，不包含任何执行指令。' : `目标：${label(state.worker)} · ${id}`),
        reading(kind === 'create' ? definition.name : definition.instruction, 'administrator-confirmed-content'),
        el('p', `本次确认到期：${preview.expires_at}；修改内容后旧确认失效。`, 'hint'));
      const outcome = el('p', '', 'administrator-confirm-outcome'); outcome.setAttribute('role', 'status'); content.append(outcome);
      const confirmation = { content, revision, id }; state.confirmation = confirmation;
      let attempted = false;
      await formDialog({ title: kind === 'create' ? '确认创建跨项目管理员管家' : '确认这条管理员指令', content,
        danger: true, cardClass: 'administrator-modal', confirmLabel: kind === 'create' ? '确认高权限范围并创建' : '确认本条指令并执行',
        agent: kind === 'input', confirmHelp: kind === 'input' ? agentHelp('以已展示的管理员身份执行这条完整指令；执行中不再逐项询问。') : '仅建立高权限管理员身份，不调用 Agent；首条指令仍须另外核对并确认。',
        canConfirm: () => unchanged() && state.confirmation === confirmation && !attempted && Date.now() < Date.parse(preview.expires_at),
        onConfirm: async () => {
          if (!unchanged() || attempted || state.confirmation !== confirmation || Date.now() >= Date.parse(preview.expires_at)) return false;
          attempted = true;
          retained.set(definition.client_request_id, { definition, created_at: new Date().toISOString() }); persistPending(storage); showEvidence();
          let result;
          try {
            result = await post('commit', { confirmation_id: preview.confirmation_id, definition: preview.definition, confirm: true });
            if (result?.version !== 1 || !isWorker(result.worker) || kind === 'input' && result.worker.id !== id
              || kind === 'input' && !hasIdentity(result.instruction?.id)) throw new Error('未获得完整提交凭据');
          } catch (error) {
            if (owns()) {
              const message = `提交结果未确认：${error.message}。原请求身份与完整内容已保留；只读核对，不自动重试或换 key。`;
              report(message, true); if (ownsDialog(content)) outcome.textContent = message;
            }
            return false;
          }
          retained.delete(definition.client_request_id); persistPending(storage);
          if (!owns()) return true;
          state.online = true;
          report(kind === 'create' ? '管理员身份已创建，尚未调用 Agent；请单独输入并确认首条指令。' : '本条指令已提交；这不证明业务或副作用已经完成。');
          if (kind === 'create' && unchanged()) { name.value = ''; state.createRevision += 1; state.createKey = requestKey(); }
          if (kind === 'input' && unchanged()) {
            current.text = ''; current.revision += 1; current.key = requestKey();
            const editor = detail.querySelector('.administrator-instruction'); if (editor) editor.value = '';
            state.worker = result.worker;
          }
          // A successful write and a failed refresh are separate outcomes; never resubmit the write.
          try {
            if (kind === 'create' && state.selectionGeneration === selection) await select(result.worker.id);
            if (await load() === false && owns()) report('提交已保存，但后续刷新失败；请只读刷新，不要重发。', true);
          } catch { if (owns()) report('提交已保存，但后续刷新失败；请只读刷新，不要重发。', true); }
          return true;
        } });
      if (state.confirmation === confirmation) state.confirmation = null;
    } catch (error) { if (unchanged()) report(`确认预检失败：${error.message}；尚未提交创建或执行。`, true); }
    finally { if (current) current.busy = false; else state.createBusy = false; if (owns()) sync(); }
  }
  async function stopWorker(id) {
    if (!owns() || state.stopBusy || state.stopUnknown.has(id) || ['stopping', 'stopped', 'cancelled'].includes(state.worker?.status)) return;
    invalidateConfirmation(); state.stopBusy = true; paintDetail();
    try {
      const result = await post('stop', { id });
      if (!owns() || state.selected !== id) return;
      if (result?.version !== 1 || !isWorker(result.worker) || result.worker.id !== id) throw new Error('停止结果读面不完整');
      state.worker = result.worker;
      report(result.worker.status === 'stopping' ? '停止请求已保存，仍等待真实退出；已发生副作用不撤销。' : '停止请求已返回；请核对实际状态、原始失败与未知副作用，不会重放。');
      await loadDetail();
    } catch (error) { state.stopUnknown.add(id); if (owns()) report(`停止结果未确认：${error.message}；请只读核对，不自动重发停止请求。`, true); }
    finally { state.stopBusy = false; if (owns()) paintDetail(); }
  }
  sync(); paintList(); paintDetail();
  const ready = load();
  return { root, ready, refresh: () => load(), select, dispose() {
    if (state.disposed) return;
    invalidateConfirmation(); state.disposed = true;
    for (const controller of reads) controller.abort(); reads.clear();
  } };
}

let page = null, pageView = null, pageOwner = null;
export function disposeAdministratorPage() { page?.dispose(); page = null; pageView = null; pageOwner = null; }
export function refreshAdministratorPage() { return page?.refresh() ?? Promise.resolve(); }

/** Router-facing entry. Project pages must navigate to the global page in a new tab. */
export function openAdministrator({ push = true, request = api } = {}) {
  if (projectRoute()) throw new Error('管理员管家必须在独立全局工作台打开');
  const view = activateDetailView({ view: 'administrator', title: '管理员管家', context: '用户工作台',
    hint: '独立管理员身份 · 跨项目高权限', hash: '#administrator', push });
  if (page && pageView === view && pageOwner === document && page.root.parentNode === $('detail')) return page.refresh();
  disposeAdministratorPage();
  page = createAdministratorPage({ container: $('detail'), request, isCurrent: () => ui.view === view });
  pageView = view; pageOwner = document;
  const current = page, owner = document;
  const observer = typeof MutationObserver === 'function' ? new MutationObserver(() => {
    if (ui.view !== view || owner !== globalThis.document || current.root.parentNode !== $('detail')) { current.dispose(); observer.disconnect(); }
  }) : null;
  observer?.observe(owner.documentElement, { subtree: true, childList: true });
  const dispose = current.dispose; current.dispose = () => { observer?.disconnect(); dispose(); };
  return current.ready;
}
