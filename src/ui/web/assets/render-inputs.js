import { $, el, button } from './dom.js';
import { editableDraft, draftOptions, updateDraft, emitDraft } from './draft-editor.js';
import { draftLabel } from './draft-label.js';
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
import { registerPageLeaveGuard } from './page-leave-guard.js';
import { inputPreviewText } from './entity-preview.js';
import { createEmissionConditions, createEmissionWorkerPicker, dispatchText, emissionAcknowledgement } from './emission-form.js';

export const INPUT_STATUS = {
  draft: '草稿', created: '已创建·待开始', queued: '排队中', running: '执行中', waiting: '等待中',
  awaiting: '待处理', paused: '已暂停', awaiting_acceptance: '待验收', completed: '已完成',
  failed: '失败', cancelled: '已取消', unknown: '状态未知', waiting_conditions: '已提交 · 等待条件',
  emitted: '已提交 · 等待准入', sent: '追加指令已入箱', emission_failed: '提交后投递失败', unknown_dispatch: '投递结果待核验',
};
export const INPUT_MERGE = { merging: '合并中', blocked: '合并受阻', merged: '已合并', none: '未合并' };
const INPUT_MODES = { order: { label: '新建工作', content: '工作指令', icon: '＋', tone: 'running' }, append: { label: '追加输入', content: '追加指令', icon: '↳', tone: 'waiting' }, management: { label: '管理 Lush', content: '管理指令', icon: '⚙', tone: 'awaiting' } };
const keyOf = item => `${item.kind}:${item.id}`;
const modeOf = item => item.mode || (item.kind === 'message' ? 'append' : item.kind === 'management' ? 'management' : 'order');
function recordLabel(item) {
  if (item.kind === 'draft') return draftLabel(item);
  if (item.kind === 'message') return `追加指令 ${/^A[1-9]\d*-[1-9]\d*$/.test(item.append_number) ? item.append_number : `消息 #${item.id}`}`;
  if (item.kind === 'management') return `管理指令 ${workerLabel(item.task_id ?? item.id, item.task_worker_number)}`;
  return `原始指令 ${inputNumber(item.id)}`;
}
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
  const mode = INPUT_MODES[modeOf(item)];
  row.append(el('span', recordLabel(item)));
  if (mode) row.append(el('span', mode.content, `badge input-mode-badge b-${mode.tone}`));
  row.append(...stateBadges(item), recordTime(item));
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

/** Independent sent-history and deferred-draft pages share one protected editor. */
export function openInputs({ item = null, push = true, section = item?.kind === 'draft' ? 'drafts' : 'history' } = {}) {
  const pageId = section === 'drafts' ? 'drafts' : 'inputs', slot = section === 'drafts' ? 'draftsPage' : 'inputsPage';
  if (ui.view?.id === pageId && ui[slot]?.view === ui.view) {
    const page = ui[slot];
    return item ? page.openItem(item, { push }) : page.showList();
  }
  const hash = item ? `#input-${item.kind}-${item.id}` : `#${pageId}`;
  const view = activateDetailView({ view: pageId, hash, push });
  const page = createInputBrowser({ view, section, ownsPage: () => ui.view === view && ui[slot] === page.state });
  ui[slot] = page.state; $('detail').replaceChildren(page);
  const loaded = page.load();
  return item ? Promise.all([loaded, page.state.openItem(item, { push })]) : loaded;
}

/** Shared browser/editor. Embedded mode never mutates the global view, hash or detail root. */
export function createInputBrowser({ view = null, ownsPage: owner, embedded = false, conditional, readOnly = false, section = 'history' } = {}) {
  const drafts = !embedded && section === 'drafts', pageId = drafts ? 'drafts' : 'inputs';
  const scope = projectApi('/api/'); let disposed = false;
  const ownsPage = () => !disposed && owner() && projectApi('/api/') === scope;
  const state = { view, request: 0, pending: null, cursor: null, detailRequest: 0, editor: null, activeItem: null, listScroll: 0, items: new Map(), emissionSources: new Map(), query: {}, modes: embedded ? null : new Set(drafts ? ['order'] : Object.keys(INPUT_MODES)) };
  const root = el('div', undefined, 'inputs-page resource-page');
  const browse = el('section', undefined, 'inputs-browse');
  const header = el('header', undefined, 'resource-hero');
  root.dataset.inputSection = embedded ? 'conditional' : section;
  header.append(el('span', drafts ? 'DRAFTS' : 'INPUTS', 'resource-kicker'), el('h1', drafts ? '草稿' : '历史输入'),
    el('p', drafts ? '暂缓的工作与追加输入；管理正文、去向与执行条件，实际发送后归入历史。' : '查找自己何时向项目发出了什么批示；这里只收录已创建工作、已入箱追加与已提交管理指令。'));
  const filters = el('form', undefined, 'inputs-filters resource-tools');
  const searchControl = searchField({ label: '搜索原文', placeholder: drafts ? '搜索暂存正文' : '搜索已发送原文', scope: embedded ? '范围：本项目全部条件输入，服务端分页检索' : drafts ? '范围：本项目当前分类的全部未发送草稿，含等待条件、准入、失败及未知授权' : '范围：本项目全部已发送新建、追加与管理指令；旧无来源证明消息及定时管理不收录', onSubmit: () => searchNow() });
  const search = searchControl.input;
  const draftStatuses = Object.fromEntries(Object.entries(INPUT_STATUS).filter(([key]) => ['draft','waiting_conditions','emitted','emission_failed','unknown_dispatch'].includes(key)));
  const historyStatuses = Object.fromEntries(Object.entries(INPUT_STATUS).filter(([key]) => !['draft','waiting_conditions','emitted','sent','emission_failed','unknown_dispatch'].includes(key)));
  const status = selectField(drafts ? '暂存状态' : 'Worker 状态', drafts ? draftStatuses : historyStatuses), merge = selectField('合并状态', INPUT_MERGE);
  status.select.value = '';
  const modeFilters = el('div', undefined, 'input-mode-filters');
  modeFilters.setAttribute('role', 'group'); modeFilters.setAttribute('aria-label', drafts ? '暂存分类' : '输入模式');
  modeFilters.append(el('span', drafts ? '暂存分类' : '输入模式', 'input-mode-label'));
  const modeLabel = mode => drafts ? mode === 'append' ? '追加输入暂存' : '工作暂存' : INPUT_MODES[mode].label;
  const modeButtons = new Map();
  function paintModes() {
    for (const [mode, node] of modeButtons) {
      const selected = state.modes.has(mode), info = INPUT_MODES[mode];
      node.textContent = `${selected ? '✓' : info.icon} ${modeLabel(mode)}`;
      node.setAttribute('aria-pressed', String(selected)); node.classList.toggle('is-off', !selected);
      if (drafts) node.removeAttribute('data-help');
      else node.setAttribute('data-help', `${selected ? '取消勾选，隐藏' : '勾选，显示'}「${info.label}」模式的历史输入；多选取并集，全不选不显示记录，不修改输入或 Worker。`);
    }
  }
  if (!embedded) {
    for (const [mode, info] of Object.entries(INPUT_MODES).filter(([mode]) => !drafts || mode !== 'management')) {
      const toggle = button('', () => {
        if (drafts) {
          if (state.modes.has(mode)) return;
          state.modes = new Set([mode]); state.items.clear(); state.cursor = null; paintList();
        } else if (state.modes.has(mode)) state.modes.delete(mode); else state.modes.add(mode);
        paintModes(); return searchNow();
      }, `badge input-mode-toggle b-${info.tone}`);
      toggle.dataset.mode = mode; modeButtons.set(mode, toggle); modeFilters.append(toggle);
    }
    paintModes();
  }
  const feedback = el('p', undefined, 'inputs-feedback hint'); feedback.setAttribute('role', 'status');
  const list = el('ol', undefined, 'inputs-list'); list.setAttribute('aria-label', '输入记录');
  const listCard = el('section', undefined, 'resource-card inputs-card');
  const listHead = el('div', undefined, 'section-title');
  const count = el('span', '0', 'count'); listHead.append(el('h2', '输入记录'), count);
  listCard.append(listHead, list);
  const detailView = el('section', undefined, 'input-detail-view'); detailView.hidden = true;
  const breadcrumb = el('div', undefined, 'breadcrumb');
  const back = button(embedded ? '← 返回条件输入列表' : drafts ? '← 返回草稿' : '← 返回历史输入', () => showList(), 'nav-link nav-back'); breadcrumb.append(back);
  const panel = el('section', undefined, 'input-detail resource-card'); panel.hidden = true; panel.setAttribute('aria-label', '输入原文与编辑'); panel.setAttribute('tabindex', '-1');
  detailView.append(breadcrumb, panel);
  const more = controlsButton('加载更多', () => load(true), { help: '按当前搜索和筛选条件，继续读取更早的输入记录。' }); more.node.hidden = true;
  const reload = controlsButton('刷新列表', () => load(), { className: 'ghost', help: '重新读取列表的最新状态，不会覆盖尚未保存的草稿编辑。' });
  filters.append(searchControl.root);
  if (!embedded) {
    filters.append(modeFilters);
    if (drafts) filters.append(status.field);
    else {
      const advanced = el('details', undefined, 'input-advanced-filters');
      const body = el('div', undefined, 'input-advanced-filter-body'); body.append(status.field, merge.field);
      advanced.append(el('summary', '高级筛选'), body); filters.append(advanced);
    }
  }
  filters.append(reload.host);
  const pagination = el('div', undefined, 'inputs-pagination'); pagination.append(more.host);
  if (!embedded) browse.append(header);
  else browse.append(el('p', readOnly
    ? '运行记录来自本项目已挂载条件输入的持久收据；挂载确认不代表已创建或已投递。结果未知不会自动重放。'
    : '每条条件输入独立授权，没有项目全局规则。编辑正文、目标、条件与独占后保存或提交；提交后锁定，可查看状态或撤销未执行授权。', 'hint'));
  browse.append(filters, feedback, listCard, pagination);
  root.append(browse, detailView);
  listSurface({ root, tools: filters, card: listCard, heading: listHead, body: list, pagination });

  function renderItem(item) {
    const card = el('li', undefined, 'input-record'); card.dataset.input = keyOf(item);
    const label = readOnly ? '查看运行收据' : item.kind === 'draft' ? '查看草稿与提交状态' : '查看原文';
    const row = item.kind === 'draft' ? button('', () => openItem(item), 'input-row', { help:
      '打开完整草稿，编辑正文、引用和父 Worker；打开不会调用 Agent。' }) : el('a', undefined, 'input-row');
    if (item.kind !== 'draft') {
      row.setAttribute('href', `#input-${item.kind}-${item.id}`);
      row.setAttribute('data-preview-text', item.kind === 'input' ? inputPreviewText(item) : `${recordLabel(item)}\n${(item.content ?? '').slice(0, 240)}`);
      row.onclick = event => {
        if (event && (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button > 0)) return;
        event?.preventDefault(); return openItem(item);
      };
    }
    const preview = (item.content ?? '').replace(/\s+/g, ' ').trim() || '（无正文）';
    row.setAttribute('aria-label', `${recordLabel(item)}，${preview.slice(0, 120)}，Worker 状态：${INPUT_STATUS[item.status] ?? INPUT_STATUS.unknown}，合并状态：${INPUT_MERGE[item.merge_status] ?? '状态未知'}：${label}`);
    const head = el('span', undefined, 'input-record-head');
    const mode = INPUT_MODES[modeOf(item)];
    head.append(el('span', recordLabel(item), 'tid'));
    if (mode) head.append(el('span', mode.content, `badge input-mode-badge b-${mode.tone}`));
    head.append(recordTime(item));
    const summary = el('span', undefined, 'input-summary');
    const openLabel = el('span', `${item.content_truncated ? '摘要已截断 · ' : ''}${label} →`, 'input-open-label');
    let draftHint = null;
    if (drafts) {
      const target = item.mode === 'append' ? `追加到 ${workerLabel(item.target_id, item.target_worker_number)}` : `父 ${item.branch === 'main' ? 'main' : workerLabel(item.parent_id, item.parent_worker_number)}`;
      const definitions = item.dispatch?.conditions ?? item.conditions ?? [];
      const conditions = definitions.map(condition => condition.kind === 'parent_quiet' ? '目标树静息' : `${workerLabel(condition.worker_id, condition.worker_number)} ${condition.kind === 'worker_merged' ? '本轮合入 main' : '安全收尾'}`);
      const hint = el('span', `${target} · 条件：${conditions.length ? conditions.join('、') : '未设置'}${item.exclusive ? ' · 独占' : ''}`, 'input-draft-summary');
      row.classList.add('input-draft-row'); draftHint = hint;
      summary.append(...(item.dispatch ? stateBadges(item, true) : [el('span', '未提交', 'badge b-neutral')]), openLabel);
    } else summary.append(...stateBadges(item, true), openLabel);
    row.append(head, el('span', preview, 'input-preview'));
    if (draftHint) row.append(draftHint);
    row.append(summary);
    card.append(listEntry(row)); return card;
  }
  function rememberEmissionSource(record) {
    const inputId = record.dispatch?.input_id ?? record.input_id;
    if (record.kind !== 'draft' || !Number.isSafeInteger(record.id) || record.id <= 0 || !Number.isSafeInteger(inputId) || inputId <= 0) return;
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
    if (!embedded) activateDetailView({ view: pageId, title: recordLabel(item),
      hint: '完整原文与引用 · 返回列表保留搜索和已加载记录', hash: `#input-${item.kind}-${item.id}`, push });
  }
  function showList() {
    if (!ownsPage() || !state.activeItem) return state.pending ?? Promise.resolve();
    ++state.detailRequest; state.activeItem = null;
    detailView.hidden = true; panel.hidden = true; browse.hidden = false;
    if (!embedded) { activateDetailView({ view: pageId }); $('detail').scrollTop = state.listScroll; }
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
    const query = new URLSearchParams({ limit: '40', ...state.query, ...(conditional ? { conditional } : {}),
      ...(!embedded ? { view: drafts ? 'drafts' : 'history' } : {}),
      ...(state.modes ? { modes: JSON.stringify(Object.keys(INPUT_MODES).filter(mode => state.modes.has(mode))) } : {}) });
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
        feedback.textContent = state.items.size ? `已显示 ${state.items.size} 条${state.cursor ? '，可继续加载。' : '，已全部加载。'} 列表与详情只在显式操作时更新。` : state.modes?.size === 0 ? '未勾选输入模式，请勾选要显示的模式。' : '没有符合条件的输入。';
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
      window.history.replaceState?.(null, '', previous ? `#input-${previous.kind}-${previous.id}` : `#${pageId}`);
    };
    if (!reread && state.editor?.recordKey === keyOf(item)) {
      showDetail(item, push); panel.focus({ preventScroll: true }); return;
    }
    if (state.editor?.busy && state.editor !== allowBusyEditor) { restoreRoute(); return; }
    if (state.editor?.dirty() && !await confirmDialog({ title: '放弃尚未保存的编辑？', message: '切换会丢弃当前本地编辑；服务器上保存的草稿不变。', confirmLabel: '放弃编辑', danger: true })) {
      if (current()) restoreRoute(); return;
    }
    if (!current()) return;
    if (!embedded && (item.kind === 'draft') !== drafts) {
      await openInputs({ item, push });
      const destination = item.kind === 'draft' ? ui.draftsPage : ui.inputsPage;
      if (!push && destination?.view === ui.view && destination.activeItem && keyOf(destination.activeItem) === keyOf(item))
        window.history.replaceState?.(null, '', `#input-${item.kind}-${item.id}`);
      return;
    }
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
      if (drafts && record.kind === 'draft' && ['order','append'].includes(record.mode) && !state.modes.has(record.mode)) {
        state.modes = new Set([record.mode]); state.items.clear(); paintModes(); paintList(); void load();
      }
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
    if (drafts && record.kind === 'draft' && (dispatch?.state === 'succeeded' || (Number.isSafeInteger(record.input_id) && record.input_id > 0))) {
      state.items.delete(keyOf(record)); paintList();
    }
    const editable = !readOnly && record.kind === 'draft' && !mounted && (!dispatch || dispatch.state === 'cancelled');
    const append = record.mode === 'append';
    rememberWorkers(parents);
    state.editor?.textEditor?.dispose();
    const editor = { busy: false, dirty: () => false, recordKey: keyOf(record) }; state.editor = editor;
    const current = () => ownsPage() && state.editor === editor;
    function appendSourceLink() {
      const sourceId = Object.hasOwn(record, 'source_draft_id') ? record.source_draft_id : record.kind === 'input' ? state.emissionSources.get(record.id) : null;
      if (!Number.isSafeInteger(sourceId) || sourceId <= 0) return;
      const source = controlsButton('查看提交草稿 · 条件与独占', () => {
        if (!current() || editor.busy) return;
        return embedded ? openItem({ kind: 'draft', id: sourceId }) : openInputs({ item: { kind: 'draft', id: sourceId } });
      }, { help: '按明确持久关联查看条件授权收据及最新独占状态；打开不调用 Agent，释放独占须另行确认。' });
      panel.append(el('p', '此原文关联提交草稿；条件与独占以草稿最新收据为准。', 'hint'), source.host);
    }
    if (['message', 'management'].includes(record.kind)) {
      panel.replaceChildren(el('h2', recordLabel(record)), statusLine(record), el('pre', record.content, 'input-original'),
        el('p', record.kind === 'message' ? '追加指令原文只读；不是原始工作指令，不创建 O 编号。Worker 状态与合并状态是来源 Worker 的当前投影，不代表这条消息已处理。' : '管理指令原文只读；来自主输入框的 Valet 管理需求，不创建开发 Worker 或 O 编号。', 'hint'));
      appendSourceLink();
      if (Number.isSafeInteger(record.task_id) && record.task_id > 0) panel.append(button(
        `查看来源 ${workerLabel(record.task_id, record.task_worker_number)}`, () => detail(record.task_id), 'ghost', { worker: record.task_id }));
      return;
    }
    if (dispatch && (dispatch.state !== 'cancelled' || readOnly)) {
      panel.replaceChildren(el('h2', `${draftLabel(record)} · ${Number.isSafeInteger(dispatch.input_id) ? '首条工作指令' : append ? '追加指令' : '工作指令'} · ${dispatchText(dispatch)}`), statusLine(record),
        el('pre', record.content, 'input-original'), el('p', dispatchText(dispatch), 'hint'),
        el('p', dispatch.state === 'cancelled'
          ? '此授权已撤销，不会继续执行。这里展示保留草稿的最新正文与最近一次提交收据；要编辑须返回设置页。'
          : '输入已提交并可靠保存执行授权，不代表 Worker 已创建或 Agent 已收到；正文、目标、引用与条件已锁定。结果未知时不会自动重放，请先检查现场。', 'hint'));
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
      const refresh = controlsButton('刷新提交状态', async () => {
        if (!current() || editor.busy) return;
        editor.busy = true; refresh.node.disabled = true;
        try {
          if (!embedded && dispatch.state === 'succeeded' && Number.isSafeInteger(dispatch.input_id) && !record.exclusive) {
            await openItem({ kind: 'input', id: dispatch.input_id }, { push: false, reread: true, allowBusyEditor: editor });
          } else await openItem(record, { push: false, reread: true, allowBusyEditor: editor });
        } finally { editor.busy = false; refresh.node.disabled = false; }
      }); row.append(refresh.host);
      const inputId = dispatch.input_id ?? record.input_id;
      if (Number.isSafeInteger(inputId) && inputId > 0) {
        if (append) panel.append(el('p', `首条工作指令已创建原始输入 ${inputNumber(inputId)}；不是普通追加消息。`, 'hint'));
        const original = controlsButton(`查看已创建原文 ${inputNumber(inputId)}`, async () => {
          if (!current() || editor.busy) return;
          editor.busy = true; original.node.disabled = true;
          try { await openItem({ kind: 'input', id: inputId }, { allowBusyEditor: editor }); }
          finally { editor.busy = false; if (current()) original.node.disabled = false; }
        }, { help: '读取真实原始指令；原文详情保留返回此提交草稿的入口，独占状态仍须读取草稿的最新安全投影。' });
        row.append(original.host);
      }
      const revisionKnown = Number.isSafeInteger(record.revision) && record.revision > 0;
      const releaseAllowed = ['succeeded', 'unknown'].includes(dispatch.state) &&
        dispatch.can_release_exclusive !== false && record.can_release_exclusive !== false &&
        (dispatch.can_release_exclusive === true || dispatch.exclusive_active === true || record.can_release_exclusive === true || record.exclusive_active === true);
      for (const [label, method, allowed, help] of [
        ['撤销提交', 'input.emission_cancel', ['waiting_conditions','queued','failed'].includes(dispatch.state), '仅撤销尚未执行的输入意图与条件 Hook，恢复草稿；不删除已创建 Worker，不撤回已投递消息。'],
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
        if (!permitted) control.host.setAttribute('data-help', revisionKnown ? '当前状态未确认可以执行此操作，请刷新状态或检查现场。' : '挂载已确认，但收据未提供最新草稿版本；请先刷新提交状态，不猜测版本执行操作。');
        row.append(control.host);
      }
      if (Number.isSafeInteger(dispatch.worker_id)) row.append(button(`查看 Worker ${workerLabel(dispatch.worker_id, dispatch.worker_number)}`, () => detail(dispatch.worker_id), 'ghost', { worker: dispatch.worker_id }));
      if (append && Number.isSafeInteger(record.target_id)) row.append(button(`查看追加目标 ${workerLabel(record.target_id, record.target_worker_number)}`, () => detail(record.target_id), 'ghost', { worker: record.target_id }));
      if (append && dispatch.message_id) {
        panel.append(el('p', `追加消息 #${dispatch.message_id}${dispatch.append_number ? ` · ${dispatch.append_number}` : ''}；这是追加指令的消息记录，不另占 O 编号。`, 'hint'));
        if (!embedded && dispatch.state === 'succeeded' && Number.isSafeInteger(dispatch.message_id) && dispatch.message_id > 0)
          row.append(controlsButton('查看已入箱追加原文', () => {
            if (!current() || editor.busy) return;
            return openItem({ kind: 'message', id: dispatch.message_id });
          }).host);
      }
      return;
    }
    if (mounted) {
      panel.replaceChildren(el('h2', `${draftLabel(record)} · 预约已挂载`), statusLine(record), el('pre', record.content, 'input-original'),
        el('p', `预约状态：${mounted.state || '未知'}。正文、引用和完整运行参数已被授权快照占用；现在不可编辑、删除或重复提交。等待或失败的 Hook 停用后可释放草稿；执行中不可撤销，结果未知时须先检查现场，再移除挂载释放占用。`, 'hint'));
      for (const reference of references) panel.append(el('p', reference.label || '引用', 'hint'), el('pre', reference.quote || '', 'input-quote'));
      if (!Number.isSafeInteger(mounted.parent_id) || mounted.parent_id < 1 || typeof mounted.hook_id !== 'string') {
        panel.append(el('p', '挂载身份格式不兼容；请检查服务版本，不会把草稿当作可编辑。', 'error')); return;
      }
      const row = el('div', undefined, 'input-actions'); panel.append(row);
      row.append(button(`查看父 Worker ${workerLabel(mounted.parent_id, record.parent_worker_number)} 的 Hooks`, () => detail(mounted.parent_id), 'ghost hook-button', { worker: mounted.parent_id }));
      const stateLine = el('p', '正在核验可取消状态…', 'hint'); panel.append(stateLine);
      const cancel = controlsButton('取消预约挂载', async () => {
        if (!current() || editor.busy || cancel.node.disabled) return;
        if (!await confirmDialog({ title: `取消${draftLabel(record)} 的预约？`, message: '仅移除还未执行的挂载并释放草稿编辑。不会删除已创建的 Worker；动作已开始或状态改变时由后台拒绝。', confirmLabel: '取消预约', confirmHelp: '移除等待中的一次性 Hook，恢复草稿编辑；不取消已启动 Agent。' })) return;
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
    if (editable && !editableDraft(record)) {
      panel.replaceChildren(el('h2', `${draftLabel(record)} · 只读待核验`), el('pre', record.content, 'input-original'),
        el('p', '草稿版本、模式或提交状态不完整，不能确认仍可编辑。请返回列表重新读取或检查服务版本；不会重复提交、修改、取消或改投目标。', 'hint'));
      for (const reference of references) panel.append(el('p', reference.label || '引用', 'hint'), el('pre', reference.quote || '', 'input-quote'));
      return;
    }
    panel.replaceChildren(el('h2', editable ? draftLabel(record) : `原始指令 ${inputNumber(record.id)}`), statusLine(record));
    const message = el('p', editable ? '编辑只保留在本页；保存后跨设备可见，尚未授权执行。提交会先保存并可靠挂载执行授权，等待安全准入，不保证立即创建或投递。' : '已发送原文只读，不随 Worker 后续追加输入或目标变化。', 'hint');
    message.setAttribute('role', 'status'); panel.append(message);
    const content = editable ? el('textarea') : el('pre', record.content, 'input-original');
    if (editable) { content.value = record.content; content.rows = 10; content.maxLength = 32000; content.setAttribute('aria-label', '草稿正文'); }
    panel.append(content);
    appendSourceLink();
    if (editable) {
      editor.textEditor = attachTextEditor(content, { onChange: () => syncSave() });
      panel.append(editor.textEditor.controls);
      const shortcuts = el('p', 'Enter 换行 · Ctrl/⌘+S 保存 · Ctrl/⌘+Enter 提交 · Ctrl/⌘+Z 撤销 · Ctrl/⌘+Shift+Z 或 Ctrl+Y 重做', 'hint');
      shortcuts.id = 'draft-editor-shortcuts'; content.setAttribute('aria-describedby', shortcuts.id);
      panel.append(shortcuts);
    }
    const parent = el('select'); parent.setAttribute('aria-label', '草稿父 Worker');
    const parentHint = el('p', undefined, 'hint');
    if (editable && !append) {
      const placeholder = el('option', '请选择父 Worker'); placeholder.value = ''; parent.append(placeholder);
      for (const task of parents) {
        const option = el('option', `${workerLabel(task)} ${task.goal ?? ''} · ${task.branch}${task.freeze ? ' · 冻结，可提交后等待' : ''}`); option.value = String(task.id); parent.append(option);
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
    if (conditionsForm) {
      conditionsForm.node.id = `draft-conditions-${record.id}`;
      conditionsForm.node.hidden = !drafts;
    }
    const refs = el('div', undefined, 'input-references'); panel.append(refs);
    const mutating = [], referenceControls = [];
    let saveControl = null, conditionsToggle = null, composing = false;
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
          }, { help: '从本条草稿移除这个引用；保存或提交后才会写入，不改变引用来源。' });
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
    const savedOptions = () => draftOptions(saved);
    editor.editKey = () => JSON.stringify([saved.revision, content.value, parent.value, appendTarget?.value()?.id, references, runProfile, conditionsForm?.collect()]);
    const contentDirty = () => editable && (content.value !== saved.content || (!append && parent.value !== initialParent())
      || (append && appendTarget?.value()?.id !== saved.target_id) || JSON.stringify(conditionsForm?.collect()) !== JSON.stringify(savedOptions())
      || JSON.stringify(references) !== JSON.stringify(saved.references));
    editor.dirty = () => contentDirty() || runProfile !== null;
    function syncSave() {
      if (!saveControl) return;
      paintParent();
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
      parentHint.textContent = target ? `${frozen ? `父分支冻结：${frozen.reason || '等待安全边界'}。` : ''}提交先可靠保存执行授权；条件满足且安全准入后创建并开始新 Worker，代码基线在实际创建时固定。` : '原父 Worker 缺失或不可用，必须重新选择并保存后才能提交。';
      const options = conditionsForm?.collect(), conditional = Boolean(options?.conditions.length || options?.exclusive);
      if (conditionsToggle) {
        const summary = conditional ? ` · ${options.conditions.length} 项${options.exclusive ? ' · 独占' : ''}` : '';
        conditionsToggle.node.textContent = `执行条件设置${summary}`;
      }
      for (const control of launchControls.values()) {
        control.node.textContent = conditional ? '按条件提交' : append ? '提交追加' : '提交指令';
        control.node.classList.toggle('hook-button', Boolean(frozen));
        const help = agentHelp(conditional ? '保存编辑并提交一次性执行授权，等待全部条件满足，再等待安全准入；不保证立即创建 Worker 或投递追加。' : '可靠挂载当前输入；父 runtime 或追加目标安全准入后创建并开始或投递消息；不保证立即执行。');
        control.host.setAttribute('data-help', help); control.node.setAttribute('data-help', help);
      }
    };
    parent.onchange = () => { paintParent(); syncSave(); }; paintParent();
    const actions = el('div', undefined, 'input-actions'); panel.append(actions);
    const submitActions = el('div', undefined, 'input-submit-actions');
    const secondaryActions = el('div', undefined, 'input-secondary-actions');
    if (editable) actions.append(submitActions, secondaryActions);
    if (editable && !append) {
      const profile = controlsButton('运行设置：提交时固定默认', async () => {
        if (!current() || editor.busy) return;
        const chosen = await chooseCreationProfile({ profile: runProfile, ownsPage: current, title: `${draftLabel(saved)} 的工作运行设置` });
        if (!current() || editor.busy || !chosen.changed) return;
        runProfile = chosen.profile;
        profile.node.textContent = runProfile ? `运行设置：${runProfile.config_mode === 'pi' ? 'Pi 默认配置' : 'Lush 配置'}` : '运行设置：提交时固定默认';
        message.textContent = '运行参数只保留在本页，提交时才写入；普通“保存”只保存草稿正文、明确目标、条件和引用。';
      }, { className: 'ghost', help: '编辑本次工作指令的完整运行参数，不调用 Agent，不读取既有挂载的私有参数。只在提交时随授权保存，不写入草稿。' });
      mutating.push(profile.node);
      const runtime = el('details', undefined, 'input-runtime-settings'); runtime.append(el('summary', '运行参数'), profile.host);
      secondaryActions.append(runtime);
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
      if (!target) throw new Error(append ? '请显式选择可用的追加目标 Worker。' : '请选择可用的父 Worker，并保存后再提交。');
      if (target.execution_retired === true) throw new Error('远端执行已退役，不能向此 Worker 追加输入或创建派生工作。');
      const conditionError = conditionsForm?.validate(); if (conditionError) throw new Error(conditionError);
      if (append && references.length) throw new Error('追加指令暂不支持引用附件，原文和引用已保留；请显式移除引用再提交。');
      if (saved.revision !== null && !Number.isInteger(saved.revision)) throw new Error('草稿缺少版本号，请先复制编辑内容再刷新页面。');
      if (!contentDirty()) return;
      const updated = await updateDraft(saved, { content: content.value, references,
        ...(append ? { mode: 'append', target_id: target.id } : target.id !== saved.parent_id || target.branch !== saved.branch ? { branch: target.branch } : {}),
        ...conditionsForm.collect() });
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
          if (!await confirmDialog({ title: `删除${draftLabel(saved)}？`, message: '这条未发送草稿及其引用将被删除，无法恢复；不会删除任何已发送输入或 Worker。', confirmLabel: '删除草稿', danger: true,
            confirmHelp: '永久删除这条未发送草稿与附属引用。' })) return;
          if (!current()) return;
          await action('draft.remove', { id: saved.id, expected_revision: saved.revision }, { refresh: !embedded });
        } else {
          await persist();
          if (!current()) return;
          if (kind === 'save') {
            message.textContent = runProfile ? '草稿已保存，尚未提交；运行参数仍只保留在本页，提交时才写入。' : '已保存。'; state.items.set(keyOf(saved), saved); paintList(); return;
          }
          // Keep this exact retry identity while the revision/definition remains unchanged.
          const result = await emitDraft(saved, runProfile, editor);
          if (!current()) return;
          editor.textEditor.dispose();
          const acknowledged = { ...saved, revision: Number.isSafeInteger(result.revision) && result.revision > 0 ? result.revision : undefined,
            dispatch: result.dispatch || { state: 'unknown', reason: '返回中缺少提交状态，请核验服务版本。' } };
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
        ['提交指令', 'emit', { agent: true, help: agentHelp('可靠挂载当前输入，安全准入后创建并开始或投递追加；不保证立即执行。') }],
        ['保存', 'save', { className: 'input-save' }],
        ['删除草稿', 'remove', { help: '经确认后永久删除这条未发送草稿及其引用；已发送输入不可删除。', className: 'danger' }],
      ]) {
        const control = controlsButton(label, () => mutate(kind), opts); mutating.push(control.node); (kind === 'emit' ? submitActions : secondaryActions).append(control.host);
        if (kind === 'emit') {
          launchControls.set(kind, control);
          control.node.setAttribute('aria-keyshortcuts', 'Control+Enter Meta+Enter Control+Shift+Enter Meta+Shift+Enter');
        }
        if (kind === 'save') {
          saveControl = control; control.host.className = 'help-host';
          control.node.setAttribute('aria-keyshortcuts', 'Control+s Meta+s');
        }
      }
      conditionsToggle = controlsButton('执行条件设置', () => {
        if (!current() || editor.busy) return;
        conditionsForm.node.hidden = !conditionsForm.node.hidden;
        conditionsToggle.node.setAttribute('aria-expanded', String(!conditionsForm.node.hidden));
      }, { className: 'ghost', help: '展开或收起这条草稿的执行条件与独占选项；不提交、不调用 Agent，收起保留设置。' });
      conditionsToggle.node.setAttribute('aria-expanded', String(drafts));
      conditionsToggle.node.setAttribute('aria-controls', conditionsForm.node.id);
      mutating.push(conditionsToggle.node); submitActions.append(conditionsToggle.host);
      if (drafts) panel.insertBefore(conditionsForm.node, refs);
      else panel.append(conditionsForm.node);
      paintParent(); syncSave();
      panel.onkeydown = event => {
        if (!current() || panel.hidden || !state.activeItem || event.defaultPrevented
          || !(event.ctrlKey || event.metaKey) || event.altKey) return;
        const kind = event.key === 'Enter' ? 'emit' : !event.shiftKey && event.key?.toLowerCase() === 's' ? 'save' : null;
        if (!kind) return;
        event.preventDefault();
        if (event.repeat || event.isComposing || event.keyCode === 229 || composing) return;
        return mutate(kind);
      };
    }
    if (record.task_id) actions.append(button(`查看 Worker ${workerLabel(record.task_id, record.task_worker_number)}`, () => detail(record.task_id), undefined, { worker: record.task_id }));
  }
  const leaveGuard = embedded ? null : registerPageLeaveGuard(async target => {
    if (!ownsPage()) return true;
    const samePage = drafts ? target === '#drafts' || /^#input-draft-/.test(target) : target === '#inputs' || /^#input-(input|message|management)-/.test(target);
    if (samePage) return true;
    if (state.editor?.busy) return false;
    return !state.editor?.dirty() || await confirmDialog({ title: '放弃尚未保存的编辑？', message: '离开草稿页会丢弃本地编辑；服务器上保存的草稿不变。', confirmLabel: '放弃编辑', danger: true });
  }, { stay: () => {
    if (ownsPage()) window.history.replaceState?.(null, '', state.activeItem ? `#input-${state.activeItem.kind}-${state.activeItem.id}` : `#${pageId}`);
    return false;
  } });
  root.state = state; root.load = load;
  root.dispose = () => { leaveGuard?.(); disposed = true; ++state.request; ++state.detailRequest; state.editor?.textEditor?.dispose(); panel.onkeydown = null; };
  return root;
}
