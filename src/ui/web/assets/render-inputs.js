import { $, el, button } from './dom.js';
import { api, action, projectApi } from './api.js';
import { detail } from './navigate.js';
import { activateDetailView } from './sidebar-ui.js';
import { absolute, inputNumber } from './format.js';
import { workerLabel, rememberWorkers } from './worker-label.js';
import { confirmDialog } from './dialog.js';
import { agentHelp } from './help.js';
import { locatable, locateReference } from './context-references.js';
import { ui } from './state.js';
import { chooseCreationProfile } from './creation-profile-dialog.js';
import { show } from './messages.js';
import { linkWorkerNumbers } from './worker-links.js';
import { attachTextEditor } from './text-editor.js';
import { searchField } from './search-field.js';
import { listEntry, listSurface } from './list-surface.js';
import { inputPreviewText } from './entity-preview.js';
import { createEmissionConditions, createEmissionWorkerPicker, dispatchText, emissionAcknowledgement, emissionRequestId } from './emission-form.js';

export const INPUT_STATUS = {
  draft: '暂存', created: '已创建·待开始', queued: '排队中', running: '执行中', waiting: '等待中',
  awaiting: '待处理', paused: '已暂停', awaiting_acceptance: '待验收', completed: '已完成',
  failed: '失败', cancelled: '已取消', unknown: '状态未知', waiting_conditions: '等待条件',
  emitted: '已发射', sent: '已追加', emission_failed: '发射失败', unknown_dispatch: '发射结果待核验',
};
export const INPUT_MERGE = { merging: '合并中', blocked: '合并受阻', merged: '已合并', none: '未合并' };
const keyOf = item => `${item.kind}:${item.id}`;
function controlsButton(label, run, { help, agent = false, className = '' } = {}) {
  // Local handlers own disabled/single-flight state, including after asynchronous completion.
  const node = el('button', label, className); node.type = 'button'; node.onclick = run;
  const host = el('span', undefined, help ? 'help-host' : 'input-control');
  if (help) { node.setAttribute('data-help', help); host.setAttribute('data-help', help); }
  if (agent) node.classList.add('agent-call');
  host.append(node); return { node, host };
}
function stateBadges(item, compact = false) {
  if (item.kind === 'draft' && item.dispatch) return [el('span', dispatchText(item.dispatch), 'badge b-neutral')];
  const status = INPUT_STATUS[item.status] ?? INPUT_STATUS.unknown;
  const merge = INPUT_MERGE[item.merge_status] ?? '状态未知';
  const taskTone = Object.hasOwn(INPUT_STATUS, item.status) && !['draft', 'created', 'unknown', 'waiting_conditions', 'emitted', 'sent', 'emission_failed', 'unknown_dispatch'].includes(item.status) ? item.status : 'neutral';
  const taskBadge = el('span', `${compact ? '' : 'Worker 状态：'}${status}`, `badge b-${taskTone}`);
  const mergeBadge = el('span', `${compact ? '' : '合并状态：'}${merge}`, `badge ${item.merge_status === 'merged' ? 'b-completed' : item.merge_status === 'blocked' ? 'b-awaiting' : item.merge_status === 'merging' ? 'b-running' : 'b-neutral'}`);
  taskBadge.setAttribute('aria-label', `Worker 状态：${status}`); mergeBadge.setAttribute('aria-label', `合并状态：${merge}`);
  return [taskBadge, mergeBadge];
}
function recordTime(item) {
  const time = el('time', absolute(item.created_at) || '时间未知', 'input-time');
  if (item.created_at) time.setAttribute('datetime', item.created_at);
  return time;
}
function statusLine(item) {
  const row = el('div', undefined, 'input-metadata');
  row.append(el('span', item.kind === 'draft' ? `草稿 #${item.id}` : `输入 ${inputNumber(item.id)}`), ...stateBadges(item), recordTime(item));
  return linkWorkerNumbers(row);
}
function selectField(label, values) {
  const field = el('label', label, 'input-filter');
  const select = el('select'); select.setAttribute('aria-label', label);
  for (const [value, text] of Object.entries({ '': '全部', ...values })) {
    const option = el('option', text); option.value = value; select.append(option);
  }
  select.value = ''; field.append(select); return { field, select };
}

/** Full-library server search. Overview polling deliberately never touches this page or its editor. */
export function openInputs({ item = null, push = true } = {}) {
  if (ui.view?.id === 'inputs' && ui.inputsPage?.view === ui.view) {
    const page = ui.inputsPage;
    return item ? page.openItem(item, { push }) : page.showList();
  }
  const hash = item ? `#input-${item.kind}-${item.id}` : '#inputs';
  const view = activateDetailView({ view: 'inputs', hash, push });
  const page = createInputBrowser({ view, ownsPage: () => ui.view === view && ui.inputsPage === page.state });
  ui.inputsPage = page.state; $('detail').replaceChildren(page);
  const loaded = page.load();
  return item ? Promise.all([loaded, page.state.openItem(item, { push })]) : loaded;
}

/** Shared browser/editor. Embedded mode never mutates the global view, hash or detail root. */
export function createInputBrowser({ view = null, ownsPage: owner, embedded = false, conditional, readOnly = false } = {}) {
  const scope = projectApi('/api/'); let disposed = false;
  const ownsPage = () => !disposed && owner() && projectApi('/api/') === scope;
  const state = { view, request: 0, pending: null, cursor: null, detailRequest: 0, editor: null, activeItem: null, listScroll: 0, items: new Map(), emissionSources: new Map(), query: embedded ? {} : { status: 'draft' } };
  const root = el('div', undefined, 'inputs-page resource-page');
  const browse = el('section', undefined, 'inputs-browse');
  const header = el('header', undefined, 'resource-hero');
  header.append(el('span', 'INPUTS', 'resource-kicker'), el('h1', '历史输入'), el('p', '查找原始输入与暂存想法，点开查看完整原文、引用或编辑草稿。Worker 追加消息请到对应 Worker 查看。'));
  const filters = el('form', undefined, 'inputs-filters resource-tools');
  const searchControl = searchField({ label: '搜索原文', placeholder: '搜索全库输入正文', scope: embedded ? '范围：本项目全部条件输入，服务端分页检索' : '范围：项目全库原始输入与未提交草稿', onSubmit: () => searchNow() });
  const search = searchControl.input;
  const status = selectField('Worker 状态', INPUT_STATUS), merge = selectField('合并状态', INPUT_MERGE);
  status.select.value = state.query.status;
  const feedback = el('p', undefined, 'inputs-feedback hint'); feedback.setAttribute('role', 'status');
  const list = el('ol', undefined, 'inputs-list'); list.setAttribute('aria-label', '输入记录');
  const listCard = el('section', undefined, 'resource-card inputs-card');
  const listHead = el('div', undefined, 'section-title');
  const count = el('span', '0', 'count'); listHead.append(el('h2', '输入记录'), count);
  listCard.append(listHead, list);
  const detailView = el('section', undefined, 'input-detail-view'); detailView.hidden = true;
  const breadcrumb = el('div', undefined, 'breadcrumb');
  const back = button(embedded ? '← 返回条件输入列表' : '← 返回历史输入', () => showList(), 'link'); breadcrumb.append(back);
  const panel = el('section', undefined, 'input-detail resource-card'); panel.hidden = true; panel.setAttribute('aria-label', '输入原文与编辑'); panel.setAttribute('tabindex', '-1');
  detailView.append(breadcrumb, panel);
  const more = controlsButton('加载更多', () => load(true), { help: '按当前搜索和筛选条件，继续读取更早的输入记录。' }); more.node.hidden = true;
  const reload = controlsButton('刷新列表', () => load(), { className: 'ghost', help: '重新读取列表的最新状态，不会覆盖尚未保存的草稿编辑。' });
  filters.append(searchControl.root);
  if (!embedded) filters.append(status.field, merge.field);
  filters.append(reload.host);
  const pagination = el('div', undefined, 'inputs-pagination'); pagination.append(more.host);
  if (!embedded) browse.append(header);
  else browse.append(el('p', readOnly
    ? '运行记录来自本项目已挂载条件输入的持久收据；挂载确认不代表已创建或已投递。结果未知不会自动重放。'
    : '每条条件输入独立授权，没有项目全局规则。编辑正文、目标、条件与独占后保存或发射；挂载后锁定，可查看状态或撤销未执行授权。', 'hint'));
  browse.append(filters, feedback, listCard, pagination);
  root.append(browse, detailView);
  listSurface({ root, tools: filters, card: listCard, heading: listHead, body: list, pagination });

  function renderItem(item) {
    const card = el('li', undefined, 'input-record'); card.dataset.input = keyOf(item);
    const label = readOnly ? '查看运行收据' : item.kind === 'draft' ? '编辑与发射' : '查看原文';
    const row = item.kind === 'draft' ? button('', () => openItem(item), 'input-row', { help:
      '打开完整草稿，编辑正文、引用和父 Worker；打开不会调用 Agent。' }) : el('a', undefined, 'input-row');
    if (item.kind !== 'draft') {
      row.setAttribute('href', `#input-input-${item.id}`);
      row.setAttribute('data-preview-text', inputPreviewText(item));
      row.onclick = event => {
        if (event && (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button > 0)) return;
        event?.preventDefault(); return openItem(item);
      };
    }
    const preview = (item.content ?? '').replace(/\s+/g, ' ').trim() || '（无正文）';
    row.setAttribute('aria-label', `${item.kind === 'draft' ? `草稿 #${item.id}` : `输入 ${inputNumber(item.id)}`}，${preview.slice(0, 120)}，Worker 状态：${INPUT_STATUS[item.status] ?? INPUT_STATUS.unknown}，合并状态：${INPUT_MERGE[item.merge_status] ?? '状态未知'}：${label}`);
    const head = el('span', undefined, 'input-record-head');
    head.append(el('span', item.kind === 'draft' ? `草稿 #${item.id}` : `输入 ${inputNumber(item.id)}`, 'tid'), recordTime(item));
    const summary = el('span', undefined, 'input-summary');
    const openLabel = el('span', `${item.content_truncated ? '摘要已截断 · ' : ''}${label} →`, 'input-open-label');
    summary.append(...stateBadges(item, true), openLabel);
    row.append(head, el('span', preview, 'input-preview'), summary);
    card.append(listEntry(row)); return card;
  }
  function rememberEmissionSource(record) {
    const inputId = record.dispatch?.input_id ?? record.input_id;
    if (record.kind !== 'draft' || record.mode === 'append' || !Number.isSafeInteger(record.id) || record.id <= 0 || !Number.isSafeInteger(inputId) || inputId <= 0) return;
    // Only remember an explicit server relationship; ambiguity never guesses a source.
    const known = state.emissionSources.get(inputId);
    state.emissionSources.set(inputId, known === undefined || known === record.id ? record.id : null);
  }
  function paintList() {
    list.replaceChildren(...[...state.items.values()].map(renderItem)); count.textContent = String(state.items.size);
  }
  function showDetail(item, push = true) {
    if (!state.activeItem) state.listScroll = embedded ? root.scrollTop : $('detail').scrollTop;
    state.activeItem = item; browse.hidden = true; detailView.hidden = false; panel.hidden = false;
    if (!embedded) activateDetailView({ view: 'inputs', title: item.kind === 'draft' ? `暂存输入 #${item.id}` : `原始输入 ${inputNumber(item.id)}`,
      hint: '完整原文与引用 · 返回列表保留搜索和已加载记录', hash: `#input-${item.kind}-${item.id}`, push });
  }
  function showList() {
    if (!ownsPage() || !state.activeItem) return state.pending ?? Promise.resolve();
    ++state.detailRequest; state.activeItem = null;
    detailView.hidden = true; panel.hidden = true; browse.hidden = false;
    if (!embedded) { activateDetailView({ view: 'inputs' }); $('detail').scrollTop = state.listScroll; }
    else root.scrollTop = state.listScroll;
    const row = state.editor && list.querySelector(`[data-input="${state.editor.recordKey}"]`);
    (row?.querySelector('.input-row') ?? search).focus({ preventScroll: true });
    return state.pending ?? Promise.resolve();
  }
  state.showList = showList; state.openItem = openItem;
  function load(morePage = false) {
    if (!ownsPage()) return Promise.resolve();
    state.editor?.resume?.();
    if (morePage && (state.pending || !state.cursor)) return state.pending ?? Promise.resolve();
    const request = ++state.request;
    const current = () => ownsPage() && request === state.request;
    const query = new URLSearchParams({ limit: '40', ...state.query, ...(conditional ? { conditional } : {}) });
    if (morePage) query.set('cursor', state.cursor);
    more.node.disabled = true; feedback.textContent = '正在读取输入…'; feedback.setAttribute('role', 'status');
    const pending = (async () => {
      try {
        const data = await api(`/api/inputs?${query}`);
        if (!current()) return;
        if (!Array.isArray(data.items)) throw new Error('输入列表格式不兼容，请更新项目后台与界面服务。');
        if (!morePage) state.items.clear();
        for (const item of data.items) { state.items.set(keyOf(item), item); rememberEmissionSource(item); }
        state.cursor = data.next_cursor; paintList();
        feedback.textContent = state.items.size ? `已显示 ${state.items.size} 条${state.cursor ? '，可继续加载。' : '，已全部加载。'} 列表与详情只在显式操作时更新。` : '没有符合条件的输入。';
        more.node.hidden = !state.cursor;
      } catch (error) {
        if (current()) { feedback.textContent = `读取失败：${error.message}。已加载记录保留，可重试。`; feedback.setAttribute('role', 'alert'); }
      } finally {
        // Retained feature nodes can be inactive when a read settles; clear only this
        // request's bookkeeping so returning can read again, without repainting.
        if (request === state.request) state.pending = null;
        if (current()) more.node.disabled = !state.cursor;
      }
    })();
    state.pending = pending; return pending;
  }
  const searchNow = () => {
    // Empty selects mean no restriction; the RPC validates enum values and must not receive ''.
    state.query = { q: searchControl.applied,
      ...(status.select.value ? { status: status.select.value } : {}),
      ...(merge.select.value ? { integration: merge.select.value } : {}) };
    return load();
  };
  searchControl.bindForm(filters);
  status.select.onchange = searchNow; merge.select.onchange = searchNow;
  state.added = () => { if (ownsPage()) void load(); };

  async function openItem(item, { push = true, reread = false, allowBusyEditor = null } = {}) {
    if (!ownsPage()) return;
    const request = ++state.detailRequest;
    const current = () => ownsPage() && request === state.detailRequest;
    const restoreRoute = () => {
      if (embedded) return;
      const previous = state.activeItem;
      window.history.replaceState?.(null, '', previous ? `#input-${previous.kind}-${previous.id}` : '#inputs');
    };
    if (!reread && state.editor?.recordKey === keyOf(item)) {
      showDetail(item, push); panel.focus({ preventScroll: true }); return;
    }
    if (state.editor?.busy && state.editor !== allowBusyEditor) { restoreRoute(); return; }
    if (state.editor?.dirty() && !await confirmDialog({ title: '放弃尚未保存的编辑？', message: '切换会丢弃当前本地编辑；服务器上保存的草稿不变。', confirmLabel: '放弃编辑', danger: true })) {
      if (current()) restoreRoute(); return;
    }
    if (!current()) return;
    showDetail(item, push);
    // Keep existing editor visible until the next full record is available, including on read failure.
    const previous = state.editor, editKey = previous?.editKey?.();
    const loading = el('p', '正在读取完整原文…', 'hint'); panel.append(loading);
    try {
      const [record, parents] = await Promise.all([
        api(`/api/input/${item.kind}/${item.id}`),
        item.kind === 'draft' ? api('/api/input-parents') : Promise.resolve({ items: [] }),
      ]);
      if (!current()) return;
      if (state.editor !== previous || (previous?.busy && previous !== allowBusyEditor) || previous?.editKey?.() !== editKey) throw new Error('读取期间编辑发生变化，请再次打开；未覆盖当前编辑');
      if (item.kind === 'draft' && record.kind === 'input' && Number.isSafeInteger(record.id)) {
        showDetail(record, false); if (!embedded) window.history.replaceState?.(null, '', `#input-input-${record.id}`);
      }
      if ((record.kind !== item.kind && !(item.kind === 'draft' && record.kind === 'input')) || (record.kind === item.kind && record.id !== item.id) || typeof record.content !== 'string'
        || !Array.isArray(record.references) || !Array.isArray(parents.items)) throw new Error('输入详情格式不兼容');
      renderEditor(record, parents.items);
      if (!embedded) $('detail').scrollTop = 0;
      panel.focus({ preventScroll: true });
    } catch (error) {
      if (current()) { loading.textContent = `读取失败：${error.message}。可再次打开重试；现有编辑保留。`; loading.setAttribute('role', 'alert'); }
    } finally { if (current() && loading.textContent === '正在读取完整原文…') loading.remove(); }
  }

  function renderEditor(record, parents) {
    panel.onkeydown = null;
    rememberEmissionSource(record);
    let saved = record, references = [...record.references], runProfile = null;
    const mounted = record.kind === 'draft' && record.hook_mount;
    const dispatch = record.kind === 'draft' && record.dispatch;
    const editable = !readOnly && record.kind === 'draft' && !mounted && (!dispatch || dispatch.state === 'cancelled');
    const append = record.mode === 'append';
    rememberWorkers(parents);
    state.editor?.textEditor?.dispose();
    const editor = { busy: false, dirty: () => false, recordKey: keyOf(record) }; state.editor = editor;
    const current = () => ownsPage() && state.editor === editor;
    if (dispatch && (dispatch.state !== 'cancelled' || readOnly)) {
      panel.replaceChildren(el('h2', `${append ? '追加输入' : '输入'} #${record.id} · ${dispatchText(dispatch)}`), statusLine(record),
        el('pre', record.content, 'input-original'), el('p', dispatchText(dispatch), 'hint'),
        el('p', dispatch.state === 'cancelled'
          ? '此授权已撤销，不会继续执行。这里展示保留草稿的最新正文与最近一次发射收据；要编辑须返回设置页。'
          : '发射已可靠挂载，不代表 Worker 已创建或 Agent 已收到；正文、目标、引用与条件已锁定。结果未知时不会自动重放，请先检查现场。', 'hint'));
      if (embedded) {
        if (dispatch.created_at) panel.append(el('p', `挂载时间：${absolute(dispatch.created_at)}`, 'hint'));
        if (dispatch.finished_at) panel.append(el('p', `收据时间：${absolute(dispatch.finished_at)}`, 'hint'));
        for (const condition of dispatch.conditions || []) panel.append(el('p', `${condition.kind === 'parent_quiet' ? '目标树彻底静息'
          : `${workerLabel(condition.worker_id, condition.worker_number)} · ${condition.kind === 'worker_merged' ? '本轮成果合入 main' : '工作安全收尾'}`}：${condition.satisfied === true ? '已满足' : '等待核验'}`, 'hint'));
      }
      if (append) panel.append(el('p', `追加目标：${workerLabel(record.target_id, record.target_worker_number)}`, 'hint'));
      for (const reference of references) panel.append(el('p', reference.label || '引用', 'hint'), el('pre', reference.quote || '', 'input-quote'));
      const conditionView = createEmissionConditions({ conditions: readOnly ? dispatch.conditions ?? record.conditions ?? [] : record.conditions || [], exclusive: record.exclusive, mode: append ? 'append' : 'order', ownsPage: current });
      conditionView.setBusy(true); panel.append(conditionView.node);
      const row = el('div', undefined, 'input-actions'); panel.append(row);
      const message = el('p', undefined, 'hint'); message.setAttribute('role', 'status'); panel.append(message);
      const refresh = controlsButton('刷新发射状态', async () => {
        if (!current() || editor.busy) return;
        editor.busy = true; refresh.node.disabled = true;
        try {
          if (!embedded && dispatch.state === 'succeeded' && Number.isSafeInteger(dispatch.input_id) && !append && !record.exclusive) {
            await openItem({ kind: 'input', id: dispatch.input_id }, { push: false, reread: true, allowBusyEditor: editor });
            if (!embedded && ownsPage() && state.activeItem?.kind === 'input' && state.editor?.recordKey === `input:${dispatch.input_id}`)
              window.history.replaceState?.(null, '', `#input-input-${dispatch.input_id}`);
          } else await openItem(record, { push: false, reread: true, allowBusyEditor: editor });
        } finally { editor.busy = false; refresh.node.disabled = false; }
      }); row.append(refresh.host);
      const inputId = dispatch.input_id ?? record.input_id;
      if (!append && Number.isSafeInteger(inputId) && inputId > 0) {
        const original = controlsButton(`查看已创建原文 ${inputNumber(inputId)}`, async () => {
          if (!current() || editor.busy) return;
          editor.busy = true; original.node.disabled = true;
          try { await openItem({ kind: 'input', id: inputId }, { allowBusyEditor: editor }); }
          finally { editor.busy = false; if (current()) original.node.disabled = false; }
        }, { help: '读取真实原始输入；原文详情保留返回此发射草稿的入口，独占状态仍须读取草稿的最新安全投影。' });
        row.append(original.host);
      }
      const revisionKnown = Number.isSafeInteger(record.revision) && record.revision > 0;
      const releaseAllowed = ['succeeded', 'unknown'].includes(dispatch.state) &&
        dispatch.can_release_exclusive !== false && record.can_release_exclusive !== false &&
        (dispatch.can_release_exclusive === true || dispatch.exclusive_active === true || record.can_release_exclusive === true || record.exclusive_active === true);
      for (const [label, method, allowed, help] of [
        ['撤销条件发射', 'input.emission_cancel', ['waiting_conditions','queued','failed'].includes(dispatch.state), '仅撤销尚未执行的输入意图与条件 Hook，恢复草稿；不删除已创建 Worker，不撤回已投递消息。'],
        ['释放独占', 'input.exclusive_release', releaseAllowed, '只释放阻塞其它开发工作的独占意愿，不取消 Worker、不丢弃成果；后续可能并行开发。'],
      ]) {
        if (readOnly || (method === 'input.exclusive_release' && !record.exclusive)) continue;
        const permitted = !readOnly && allowed && revisionKnown;
        const control = controlsButton(label, async () => {
          if (!current() || editor.busy || control.node.disabled) return;
          if (!await confirmDialog({ title: `${label}？`, message: help, confirmLabel: label, confirmHelp: help })) return;
          if (!current()) return;
          editor.busy = true; control.node.disabled = refresh.node.disabled = true;
          try {
            await action(method, { draft_id: record.id, expected_revision: record.revision }, { refresh: false });
            if (!current()) return;
            message.textContent = `${label}已确认；正在读取最新状态。`; editor.busy = false;
            await openItem(record, { push: false, reread: true });
          } catch (error) { if (current()) { message.textContent = `${label}未完成：${error.message}；原始输入与挂载保留。`; message.setAttribute('role', 'alert'); } }
          finally { editor.busy = false; if (current()) { control.node.disabled = !permitted; refresh.node.disabled = false; } }
        }, { help, className: 'ghost hook-button' });
        control.node.disabled = !permitted; control.host.tabIndex = permitted ? -1 : 0;
        if (!permitted) control.host.setAttribute('data-help', revisionKnown ? '当前状态未确认可以执行此操作，请刷新状态或检查现场。' : '挂载已确认，但收据未提供最新草稿版本；请先刷新发射状态，不猜测版本执行操作。');
        row.append(control.host);
      }
      if (Number.isSafeInteger(dispatch.worker_id)) row.append(button(`查看 Worker ${workerLabel(dispatch.worker_id, dispatch.worker_number)}`, () => detail(dispatch.worker_id), 'ghost', { worker: dispatch.worker_id }));
      if (append && Number.isSafeInteger(record.target_id)) row.append(button(`查看追加目标 ${workerLabel(record.target_id, record.target_worker_number)}`, () => detail(record.target_id), 'ghost', { worker: record.target_id }));
      if (append && dispatch.message_id) panel.append(el('p', `追加消息 #${dispatch.message_id}${dispatch.append_number ? ` · ${dispatch.append_number}` : ''}；消息不是原始 Order。`, 'hint'));
      return;
    }
    if (mounted) {
      panel.replaceChildren(el('h2', `暂存输入 #${record.id} · 预约已挂载`), statusLine(record), el('pre', record.content, 'input-original'),
        el('p', `预约状态：${mounted.state || '未知'}。正文、引用和完整运行参数已被授权快照占用；现在不可编辑、删除或重复发射。等待或失败的 Hook 停用后可释放草稿；执行中不可撤销，结果未知时须先检查现场，再移除挂载释放占用。`, 'hint'));
      for (const reference of references) panel.append(el('p', reference.label || '引用', 'hint'), el('pre', reference.quote || '', 'input-quote'));
      if (!Number.isSafeInteger(mounted.parent_id) || mounted.parent_id < 1 || typeof mounted.hook_id !== 'string') {
        panel.append(el('p', '挂载身份格式不兼容；请检查服务版本，不会把草稿当作可编辑。', 'error')); return;
      }
      const row = el('div', undefined, 'input-actions'); panel.append(row);
      row.append(button(`查看父 Worker ${workerLabel(mounted.parent_id, record.parent_worker_number)} 的 Hooks`, () => detail(mounted.parent_id), 'ghost hook-button', { worker: mounted.parent_id }));
      const stateLine = el('p', '正在核验可取消状态…', 'hint'); panel.append(stateLine);
      const cancel = controlsButton('取消预约挂载', async () => {
        if (!current() || editor.busy || cancel.node.disabled) return;
        if (!await confirmDialog({ title: `取消草稿 #${record.id} 的预约？`, message: '仅移除还未执行的挂载并释放草稿编辑。不会删除已创建的 Worker；动作已开始或状态改变时由后台拒绝。', confirmLabel: '取消预约', confirmHelp: '移除等待中的一次性 Hook，恢复草稿编辑；不取消已启动 Agent。' })) return;
        if (!current()) return;
        editor.busy = true; cancel.node.disabled = true;
        try {
          // Fetch a fresh optimistic revision after confirmation; never remove a changed/running mount blindly.
          const hooks = await api(`/api/worker/${mounted.parent_id}/hooks`); if (!current()) return;
          const hook = hooks.mounts?.find(item => item.id === mounted.hook_id);
          if (!hook || (hook.removable ?? hook.editable) !== true || hook.locked || hook.state === 'running') throw new Error(hook?.reason || '挂载状态已改变，请查看父 Worker 的 Hooks。');
          await action('worker.hook_remove', { id: mounted.parent_id, hook_id: mounted.hook_id, expected_revision: hooks.revision }, { refresh: !embedded });
          if (!current()) return;
          editor.busy = false; state.editor = null; show('预约已取消，草稿可以重新编辑；已有成果未删除。');
          await openItem(record, { reread: true });
        } catch (error) { if (current()) { stateLine.textContent = `取消失败：${error.message}；原挂载和草稿保留。`; stateLine.setAttribute('role', 'alert'); cancel.node.disabled = false; } }
        finally { editor.busy = false; }
      }, { help: '核验后只移除等待中的挂载，释放草稿；不会丢弃已产生的 Worker 或消息。', className: 'ghost hook-button' });
      cancel.node.disabled = true; cancel.host.tabIndex = 0; row.append(cancel.host);
      void api(`/api/worker/${mounted.parent_id}/hooks`).then(hooks => {
        if (!current()) return;
        const hook = hooks.mounts?.find(item => item.id === mounted.hook_id);
        const reason = !hook ? '挂载已不在当前读面，请查看父 Worker 的 Hooks。' : hook.removable === true ? null : hook.reason;
        cancel.node.disabled = !hook || (hook.removable ?? hook.editable) !== true || hook.locked || hook.state === 'running';
        stateLine.textContent = reason || (cancel.node.disabled ? '当前挂载不能取消；请检查实际执行状态。' : '可取消等待中的挂载，取消后恢复草稿编辑。');
        cancel.host.setAttribute('data-help', `${stateLine.textContent} 仅移除等待中的一次性 Hook，不删除已创建 Worker。`);
      }).catch(error => { if (current()) stateLine.textContent = `核验失败：${error.message}；取消入口保持禁用，请查看父 Worker 的 Hooks。`; });
      return;
    }
    if (editable && ((record.revision !== null && (!Number.isSafeInteger(record.revision) || record.revision <= 0)) ||
        (record.status && !['draft', 'cancelled'].includes(record.status)) ||
        (record.mode && !['order', 'append'].includes(record.mode)))) {
      panel.replaceChildren(el('h2', `暂存输入 #${record.id} · 只读待核验`), el('pre', record.content, 'input-original'),
        el('p', '草稿版本、模式或发射投影不完整，不能确认仍可编辑。请返回列表重新读取或检查服务版本；不会重复发射、修改、取消或改投目标。', 'hint'));
      for (const reference of references) panel.append(el('p', reference.label || '引用', 'hint'), el('pre', reference.quote || '', 'input-quote'));
      return;
    }
    panel.replaceChildren(el('h2', editable ? `暂存输入 #${record.id}` : `原始输入 ${inputNumber(record.id)}`), statusLine(record));
    const message = el('p', editable ? '编辑只保留在本页；保存后跨设备可见。发射会先保存并可靠挂载，条件满足后等待安全准入，不保证立即创建或投递。' : '已发送原文只读，不随 Worker 后续追加输入或目标变化。', 'hint');
    message.setAttribute('role', 'status'); panel.append(message);
    const content = editable ? el('textarea') : el('pre', record.content, 'input-original');
    if (editable) { content.value = record.content; content.rows = 10; content.maxLength = 32000; content.setAttribute('aria-label', '草稿正文'); }
    panel.append(content);
    const sourceId = record.kind === 'input' ? state.emissionSources.get(record.id) : null;
    if (Number.isSafeInteger(sourceId) && sourceId > 0) {
      const source = controlsButton(`查看发射草稿 #${sourceId} · 条件与独占`, async () => {
        if (!current() || editor.busy) return;
        editor.busy = true; source.node.disabled = true;
        try { await openItem({ kind: 'draft', id: sourceId }, { reread: true, allowBusyEditor: editor }); }
        finally { editor.busy = false; if (current()) source.node.disabled = false; }
      }, { help: '按已知的真实关联重新读取发射草稿与最新版本，检查条件、独占状态及安全释放；只读，不调用 Agent。' });
      panel.append(el('p', `此原文关联发射草稿 #${sourceId}。独占是否仍有效以草稿最新状态为准，不从已创建或 Worker 状态推断。`, 'hint'), source.host);
    }
    if (editable) {
      editor.textEditor = attachTextEditor(content, { onChange: () => syncSave() });
      panel.append(editor.textEditor.controls);
      const shortcuts = el('p', 'Ctrl/⌘+S 保存 · Ctrl/⌘+Z 撤销 · Ctrl/⌘+Shift+Z 或 Ctrl+Y 重做 · Enter 换行', 'hint');
      shortcuts.id = 'draft-editor-shortcuts'; content.setAttribute('aria-describedby', shortcuts.id);
      panel.append(shortcuts);
    }
    const parent = el('select'); parent.setAttribute('aria-label', '草稿父 Worker');
    const parentHint = el('p', undefined, 'hint');
    if (editable && !append) {
      const placeholder = el('option', '请选择父 Worker'); placeholder.value = ''; parent.append(placeholder);
      for (const task of parents) {
        const option = el('option', `${workerLabel(task)} ${task.goal ?? ''} · ${task.branch}${task.freeze ? ' · 冻结，可挂载' : ''}`); option.value = String(task.id); parent.append(option);
      }
      if (record.parent_id && !parents.some(task => task.id === record.parent_id && task.branch === record.branch)) {
        // An archived/missing/rebound parent must never silently fall back to main/current branch.
        const missing = el('option', `${workerLabel(record.parent_id, record.parent_worker_number)} · ${record.branch ?? '未知分支'}（已不可选，请重选）`);
        missing.value = `missing:${record.parent_id}`; parent.append(missing); parent.value = missing.value;
      } else parent.value = record.parent_id ? String(record.parent_id) : '';
      const label = el('label', '父 Worker', 'input-parent-label'); label.append(parent); panel.append(label, parentHint);
    } else if (!append) panel.append(el('p', `父 Worker：${record.parent_id ? workerLabel(record.parent_id, record.parent_worker_number) : '未知'} · 输入分支：${record.branch ?? '未知'}`, 'hint'));
    const appendTarget = editable && append ? createEmissionWorkerPicker({ ownsPage: current, label: '追加目标 Worker',
      initial: Number.isSafeInteger(record.target_id) ? { id: record.target_id, worker_number: record.target_worker_number } : null,
      onChange: () => syncSave() }) : null;
    if (appendTarget) panel.append(appendTarget.node, el('p', '追加只投递给这个 Worker，不创建新 Worker；不可用目标必须显式重选，不会改投 main。', 'hint'));
    const conditionsForm = editable ? createEmissionConditions({ conditions: record.conditions || [], exclusive: record.exclusive,
      mode: append ? 'append' : 'order', ownsPage: current, onChange: () => syncSave() }) : null;
    if (conditionsForm) panel.append(conditionsForm.node);
    const refs = el('div', undefined, 'input-references'); panel.append(refs);
    const mutating = [], referenceControls = [];
    let saveControl = null, composing = false;
    function paintReferences() {
      referenceControls.length = 0;
      refs.replaceChildren(el('h3', `引用快照（${references.length}）`));
      references.forEach((reference, index) => {
        const row = el('div', undefined, 'input-reference');
        const label = el('strong', reference.label ?? '引用');
        row.append(label, el('p', reference.quote ?? '', 'input-quote'));
        if (locatable(reference)) row.append(button('定位来源', () => locateReference(reference), '', { help: '定位引用来源；引文是捕获时的快照，不代表当前内容。' }));
        if (editable) {
          const remove = controlsButton('移除引用', () => {
            if (!current() || editor.busy) return;
            references = references.filter((_ref, at) => at !== index); paintReferences();
          }, { help: '从本条草稿移除这个引用；保存或发射后才会写入，不改变引用来源。' });
          referenceControls.push(remove.node); row.append(remove.host);
        }
        refs.append(row);
      });
      if (editable && JSON.stringify(references) !== JSON.stringify(saved.references)) {
        const restore = controlsButton('恢复已保存引用', () => { if (!editor.busy && current()) { references = [...saved.references]; paintReferences(); } });
        referenceControls.push(restore.node); refs.append(restore.host);
      }
      syncSave();
    }
    const initialParent = () => !saved.parent_id ? '' : parents.some(task => task.id === saved.parent_id && task.branch === saved.branch)
      ? String(saved.parent_id) : `missing:${saved.parent_id}`;
    const savedOptions = () => ({ conditions: (saved.conditions || []).map(({ kind, worker_id }) => ({ kind, ...(worker_id == null ? {} : { worker_id }) })), exclusive: Boolean(saved.exclusive) });
    editor.editKey = () => JSON.stringify([saved.revision, content.value, parent.value, appendTarget?.value()?.id, references, runProfile, conditionsForm?.collect()]);
    const contentDirty = () => editable && (content.value !== saved.content || (!append && parent.value !== initialParent())
      || (append && appendTarget?.value()?.id !== saved.target_id) || JSON.stringify(conditionsForm?.collect()) !== JSON.stringify(savedOptions())
      || JSON.stringify(references) !== JSON.stringify(saved.references));
    editor.dirty = () => contentDirty() || runProfile !== null;
    function syncSave() {
      if (!saveControl) return;
      saveControl.node.disabled = editor.busy || composing || !contentDirty();
      const reason = editor.busy ? '正在处理，请稍候。' : composing ? '请先完成输入法候选确认。' : !contentDirty() ? '当前内容与已保存的草稿一致。' : '';
      saveControl.host.tabIndex = saveControl.node.disabled ? 0 : -1;
      if (reason) saveControl.host.setAttribute('data-help', reason);
      else saveControl.host.removeAttribute('data-help');
    }
    if (editable) {
      content.oninput = syncSave;
      content.oncompositionstart = () => { composing = true; syncSave(); };
      content.oncompositionend = () => { composing = false; syncSave(); };
    }
    paintReferences();
    const selectedParent = () => parents.find(task => String(task.id) === parent.value);
    const launchControls = new Map();
    const paintParent = () => {
      const target = selectedParent(), frozen = target?.freeze;
      parentHint.textContent = target ? `${frozen ? `父分支冻结：${frozen.reason || '等待安全边界'}。` : ''}发射先可靠挂载；父 runtime 空闲且通过安全准入后创建并开始，代码基线在实际创建时固定。` : '原父 Worker 缺失或不可用，必须重新选择并保存后才能发射。';
      for (const [kind, control] of launchControls) {
        control.node.textContent = kind === 'conditional' ? '条件发射' : append ? '发射追加' : '发射';
        control.node.classList.toggle('hook-button', kind === 'conditional' || Boolean(frozen));
        const help = agentHelp(kind === 'conditional' ? '保存编辑及全部条件的一次性授权，全部条件满足后发射，再等待安全准入；不保证立即创建 Worker 或投递追加。' : '可靠挂载当前输入；父 runtime 或追加目标安全准入后创建并开始或投递消息；不保证立即执行。');
        control.host.setAttribute('data-help', help); control.node.setAttribute('data-help', help);
      }
    };
    parent.onchange = () => { paintParent(); syncSave(); }; paintParent();
    const actions = el('div', undefined, 'input-actions'); panel.append(actions);
    if (editable && !append) {
      const profile = controlsButton('运行设置：发射时冻结默认', async () => {
        if (!current() || editor.busy) return;
        const chosen = await chooseCreationProfile({ profile: runProfile, ownsPage: current, title: `草稿 #${saved.id} 的发射运行设置` });
        if (!current() || editor.busy || !chosen.changed) return;
        runProfile = chosen.profile;
        profile.node.textContent = runProfile ? `运行设置：${runProfile.config_mode === 'pi' ? 'Pi 默认配置' : 'Lush 配置'}` : '运行设置：发射时冻结默认';
        message.textContent = '运行参数只保留在本页，发射时才写入；普通“保存”只保存草稿正文、明确目标、条件和引用。';
      }, { className: 'ghost', help: '编辑本次发射的完整运行参数，不调用 Agent，不读取既有挂载的私有参数。只在发射时随授权保存，不写入草稿。' });
      mutating.push(profile.node); actions.append(profile.host);
    }
    function setBusy(busy) {
      editor.busy = busy; if (editable) { content.disabled = busy; parent.disabled = busy; editor.textEditor.sync(); conditionsForm?.setBusy(busy); appendTarget?.setBusy(busy); }
      for (const node of [...mutating, ...referenceControls]) node.disabled = busy;
      syncSave();
    }
    // A feature directory can retain this editor while another feature owns the page.
    // Reconcile local controls on return, without repainting an inactive/project-stale page.
    editor.resume = () => { if (current()) setBusy(editor.busy); };
    async function persist() {
      if (!content.value.trim()) throw new Error('草稿正文不能为空。');
      const target = append ? appendTarget?.value() : selectedParent();
      if (!target) throw new Error(append ? '请显式选择可用的追加目标 Worker。' : '请选择可用的父 Worker，并保存后再发射。');
      const conditionError = conditionsForm?.validate(); if (conditionError) throw new Error(conditionError);
      if (append && references.length) throw new Error('追加输入暂不支持引用附件，原文和引用已保留；请显式移除引用再提交。');
      if (saved.revision !== null && !Number.isInteger(saved.revision)) throw new Error('草稿缺少版本号，请先复制编辑内容再刷新页面。');
      if (!contentDirty()) return;
      const updated = await action('draft.update', { id: saved.id, content: content.value, references,
        ...(append ? { mode: 'append', target_id: target.id } : target.id !== saved.parent_id || target.branch !== saved.branch ? { branch: target.branch } : {}),
        ...conditionsForm.collect(), expected_revision: saved.revision }, { refresh: !embedded });
      // Update the captured revision even if navigation happened; never repaint a different page.
      saved = updated;
      if (current()) {
        // Saving moves the server revision forward, not the local body history.
        // Only a genuinely replaced body establishes a new empty undo boundary.
        if (content.value !== updated.content) { content.value = updated.content; editor.textEditor.reset(); }
        references = [...updated.references]; parent.value = String(updated.parent_id); paintReferences(); setBusy(true);
      }
    }
    async function mutate(kind) {
      if (!current() || editor.busy || (kind === 'save' && (composing || !contentDirty()))) return;
      setBusy(true); message.setAttribute('role', 'status');
      try {
        if (kind === 'remove') {
          if (!await confirmDialog({ title: `删除暂存输入 #${saved.id}？`, message: '这条未发送草稿及其引用将被删除，无法恢复；不会删除任何已发送输入或 Worker。', confirmLabel: '删除草稿', danger: true,
            confirmHelp: '永久删除这条未发送草稿与附属引用。' })) return;
          if (!current()) return;
          await action('draft.remove', { id: saved.id, expected_revision: saved.revision }, { refresh: !embedded });
        } else {
          await persist();
          if (!current()) return;
          if (kind === 'save') {
            message.textContent = runProfile ? '草稿已保存；运行参数仍只保留在本页，发射时才写入。' : '已保存。'; state.items.set(keyOf(saved), saved); paintList(); return;
          }
          const options = conditionsForm.collect();
          if (kind === 'conditional' && !options.conditions.length && !options.exclusive) throw new Error('请先选择至少一个条件，或使用普通发射。');
          // Keep this exact retry identity while the revision/definition remains unchanged.
          const definition = JSON.stringify([saved.id, saved.revision, runProfile]);
          if (editor.requestDefinition !== definition) { editor.requestDefinition = definition; editor.requestId = emissionRequestId(); }
          const result = await action('input.emit', { draft_id: saved.id, expected_revision: saved.revision,
            client_request_id: editor.requestId, ...(runProfile ? { profile: runProfile } : {}) }, { refresh: false });
          if (!current()) return;
          if (result.emitted !== true || result.draft_id !== saved.id) throw new Error('发射响应缺少可靠草稿收据，请核验历史输入与服务版本，不会自动重试。');
          editor.textEditor.dispose();
          const acknowledged = { ...saved, revision: Number.isSafeInteger(result.revision) && result.revision > 0 ? result.revision : undefined,
            dispatch: result.dispatch || { state: 'unknown', reason: '返回中缺少发射状态，请核验服务版本。' } };
          state.items.set(keyOf(saved), acknowledged); paintList(); renderEditor(acknowledged, parents);
          show(emissionAcknowledgement(result, append)); return;
        }
        if (!current()) return;
        editor.textEditor?.dispose(); state.editor = null; state.items.delete(keyOf(saved)); paintList();
        if (kind === 'remove') panel.replaceChildren(el('p', '草稿已删除。', 'hint'));
        await load();
      } catch (error) {
        if (current()) { message.textContent = `操作失败：${error.message}。编辑内容保留；如版本冲突，请先复制编辑内容，再刷新页面读取最新版本。`; message.setAttribute('role', 'alert'); }
      } finally { editor.busy = false; if (current()) setBusy(false); }
    }
    if (editable) {
      for (const [label, kind, opts] of [
        ['发射', 'emit', { agent: true, help: agentHelp('可靠挂载当前输入，安全准入后创建并开始或投递追加；不保证立即执行。') }],
        ['条件发射', 'conditional', { agent: true, help: agentHelp('保存当前编辑及全部条件的一次性授权，条件满足后发射，再等待安全准入。') }],
        ['保存', 'save', { className: 'input-save' }],
        ['删除草稿', 'remove', { help: '经确认后永久删除这条未发送草稿及其引用；已发送输入不可删除。', className: 'danger' }],
      ]) {
        const control = controlsButton(label, () => mutate(kind), opts); mutating.push(control.node); actions.append(control.host);
        if (['emit', 'conditional'].includes(kind)) launchControls.set(kind, control);
        if (kind === 'save') {
          saveControl = control; control.host.className = 'help-host';
          control.node.setAttribute('aria-keyshortcuts', 'Control+s Meta+s');
        }
      }
      paintParent(); syncSave();
      panel.onkeydown = event => {
        if (!current() || panel.hidden || !state.activeItem || event.defaultPrevented
          || !(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.key?.toLowerCase() !== 's') return;
        event.preventDefault();
        if (event.isComposing || event.keyCode === 229 || composing) return;
        return mutate('save');
      };
    }
    if (record.task_id) actions.append(button(`查看 Worker ${workerLabel(record.task_id, record.task_worker_number)}`, () => detail(record.task_id), undefined, { worker: record.task_id }));
  }
  root.state = state; root.load = load;
  root.dispose = () => { disposed = true; ++state.request; ++state.detailRequest; state.editor?.textEditor?.dispose(); panel.onkeydown = null; };
  return root;
}
