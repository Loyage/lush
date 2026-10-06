import { $, el, button } from './dom.js';
import { api, action } from './api.js';
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

export const INPUT_STATUS = {
  draft: '暂存', created: '已创建·待开始', queued: '排队中', running: '执行中', waiting: '等待中',
  awaiting: '待处理', paused: '已暂停', awaiting_acceptance: '待验收', completed: '已完成',
  failed: '失败', cancelled: '已取消', unknown: '状态未知',
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
  const status = INPUT_STATUS[item.status] ?? INPUT_STATUS.unknown;
  const merge = INPUT_MERGE[item.merge_status] ?? '状态未知';
  const taskTone = Object.hasOwn(INPUT_STATUS, item.status) && !['draft', 'created', 'unknown'].includes(item.status) ? item.status : 'neutral';
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
  return row;
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
  const state = { view, request: 0, pending: null, cursor: null, detailRequest: 0, editor: null, activeItem: null, listScroll: 0, items: new Map(), query: { status: 'draft' } };
  ui.inputsPage = state;
  const ownsPage = () => ui.view === view && ui.inputsPage === state;
  const root = el('div', undefined, 'inputs-page resource-page');
  const browse = el('section', undefined, 'inputs-browse');
  const header = el('header', undefined, 'resource-hero');
  header.append(el('span', 'INPUTS', 'resource-kicker'), el('h1', '历史输入'), el('p', '查找原始输入与暂存想法，点开查看完整原文、引用或编辑草稿。Worker 追加消息请到对应 Worker 查看。'));
  const filters = el('form', undefined, 'inputs-filters resource-tools');
  const searchLabel = el('label', '搜索原文', 'input-search');
  const search = el('input'); search.type = 'search'; search.placeholder = '搜索全库输入正文'; search.setAttribute('aria-label', '搜索全库输入正文');
  searchLabel.append(search);
  const status = selectField('Worker 状态', INPUT_STATUS), merge = selectField('合并状态', INPUT_MERGE);
  status.select.value = state.query.status;
  const searchButton = el('button', '搜索'); searchButton.type = 'submit';
  const feedback = el('p', undefined, 'inputs-feedback hint'); feedback.setAttribute('role', 'status');
  const list = el('ol', undefined, 'inputs-list'); list.setAttribute('aria-label', '输入记录');
  const listCard = el('section', undefined, 'resource-card inputs-card');
  const listHead = el('div', undefined, 'section-title');
  const count = el('span', '0', 'count'); listHead.append(el('h2', '输入记录'), count);
  listCard.append(listHead, list);
  const detailView = el('section', undefined, 'input-detail-view'); detailView.hidden = true;
  const breadcrumb = el('div', undefined, 'breadcrumb');
  const back = button('← 返回历史输入', () => showList(), 'link'); breadcrumb.append(back);
  const panel = el('section', undefined, 'input-detail resource-card'); panel.hidden = true; panel.setAttribute('aria-label', '输入原文与编辑'); panel.setAttribute('tabindex', '-1');
  detailView.append(breadcrumb, panel);
  const more = controlsButton('加载更多', () => load(true), { help: '按当前搜索和筛选条件，继续读取更早的输入记录。' }); more.node.hidden = true;
  const reload = controlsButton('刷新列表', () => load(), { className: 'ghost', help: '重新读取列表的最新状态；不会覆盖尚未保存的草稿编辑，详情需单独重新读取。' });
  filters.append(searchLabel, status.field, merge.field, searchButton, reload.host);
  const pagination = el('div', undefined, 'inputs-pagination'); pagination.append(more.host);
  browse.append(header, filters, feedback, listCard, pagination);
  root.append(browse, detailView); $('detail').replaceChildren(root);

  function renderItem(item) {
    const card = el('li', undefined, 'input-record'); card.dataset.input = keyOf(item);
    const label = item.kind === 'draft' ? '编辑与发射' : '查看原文';
    const row = button('', () => openItem(item), 'input-row', { help: item.kind === 'draft'
      ? '打开完整草稿，编辑正文、引用和父 Worker；打开不会调用 Agent。' : '只读查看这条输入提交时的完整原文与引用。' });
    const preview = (item.content ?? '').replace(/\s+/g, ' ').trim() || '（无正文）';
    row.setAttribute('aria-label', `${item.kind === 'draft' ? `草稿 #${item.id}` : `输入 ${inputNumber(item.id)}`}，${preview.slice(0, 120)}，Worker 状态：${INPUT_STATUS[item.status] ?? INPUT_STATUS.unknown}，合并状态：${INPUT_MERGE[item.merge_status] ?? '状态未知'}：${label}`);
    const head = el('span', undefined, 'input-record-head');
    head.append(el('span', item.kind === 'draft' ? `草稿 #${item.id}` : `输入 ${inputNumber(item.id)}`, 'tid'), recordTime(item));
    const summary = el('span', undefined, 'input-summary');
    const openLabel = el('span', `${item.content_truncated ? '摘要已截断 · ' : ''}${label} →`, 'input-open-label');
    summary.append(...stateBadges(item, true), openLabel);
    row.append(head, el('span', preview, 'input-preview'), summary);
    card.append(row); return card;
  }
  function paintList() {
    list.replaceChildren(...[...state.items.values()].map(renderItem)); count.textContent = String(state.items.size);
  }
  function showDetail(item, push = true) {
    if (!state.activeItem) state.listScroll = $('detail').scrollTop;
    state.activeItem = item; browse.hidden = true; detailView.hidden = false; panel.hidden = false;
    activateDetailView({ view: 'inputs', title: item.kind === 'draft' ? `暂存输入 #${item.id}` : `原始输入 ${inputNumber(item.id)}`,
      hint: '完整原文与引用 · 返回列表保留搜索和已加载记录', hash: `#input-${item.kind}-${item.id}`, push });
  }
  function showList() {
    if (!ownsPage() || !state.activeItem) return state.pending ?? Promise.resolve();
    ++state.detailRequest; state.activeItem = null;
    detailView.hidden = true; panel.hidden = true; browse.hidden = false;
    activateDetailView({ view: 'inputs' }); $('detail').scrollTop = state.listScroll;
    const row = state.editor && list.querySelector(`[data-input="${state.editor.recordKey}"]`);
    (row?.querySelector('button') ?? search).focus({ preventScroll: true });
    return state.pending ?? Promise.resolve();
  }
  state.showList = showList; state.openItem = openItem;
  function load(morePage = false) {
    if (!ownsPage()) return Promise.resolve();
    if (morePage && (state.pending || !state.cursor)) return state.pending ?? Promise.resolve();
    const request = ++state.request;
    const current = () => ownsPage() && request === state.request;
    const query = new URLSearchParams({ limit: '40', ...state.query });
    if (morePage) query.set('cursor', state.cursor);
    more.node.disabled = true; feedback.textContent = '正在读取输入…'; feedback.setAttribute('role', 'status');
    const pending = (async () => {
      try {
        const data = await api(`/api/inputs?${query}`);
        if (!current()) return;
        if (!Array.isArray(data.items)) throw new Error('输入列表格式不兼容，请更新项目后台与界面服务。');
        if (!morePage) state.items.clear();
        for (const item of data.items) state.items.set(keyOf(item), item);
        state.cursor = data.next_cursor; paintList();
        feedback.textContent = state.items.size ? `已显示 ${state.items.size} 条${state.cursor ? '，可继续加载。' : '，已全部加载。'} 列表与详情只在显式操作时更新。` : '没有符合条件的输入。';
        more.node.hidden = !state.cursor;
      } catch (error) {
        if (current()) { feedback.textContent = `读取失败：${error.message}。已加载记录保留，可重试。`; feedback.setAttribute('role', 'alert'); }
      } finally { if (current()) { state.pending = null; more.node.disabled = !state.cursor; } }
    })();
    state.pending = pending; return pending;
  }
  const searchNow = () => {
    // Empty selects mean no restriction; the RPC validates enum values and must not receive ''.
    state.query = { q: search.value.trim(),
      ...(status.select.value ? { status: status.select.value } : {}),
      ...(merge.select.value ? { integration: merge.select.value } : {}) };
    return load();
  };
  filters.onsubmit = event => { event.preventDefault(); return searchNow(); };
  status.select.onchange = searchNow; merge.select.onchange = searchNow;
  state.added = () => { if (ownsPage()) void load(); };

  async function openItem(item, { push = true, reread = false } = {}) {
    if (!ownsPage()) return;
    const request = ++state.detailRequest;
    const current = () => ownsPage() && request === state.detailRequest;
    const restoreRoute = () => {
      const previous = state.activeItem;
      window.history.replaceState?.(null, '', previous ? `#input-${previous.kind}-${previous.id}` : '#inputs');
    };
    if (!reread && state.editor?.recordKey === keyOf(item)) {
      showDetail(item, push); panel.focus({ preventScroll: true }); return;
    }
    if (state.editor?.busy) { restoreRoute(); return; }
    if (state.editor?.dirty() && !await confirmDialog({ title: '放弃尚未保存的编辑？', message: '切换或重新读取会丢弃当前本地编辑；服务器上保存的草稿不变。', confirmLabel: '放弃编辑', danger: true })) {
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
      if (state.editor !== previous || previous?.busy || previous?.editKey?.() !== editKey) throw new Error('读取期间编辑发生变化，请再次打开；未覆盖当前编辑');
      if (record.kind !== item.kind || record.id !== item.id || typeof record.content !== 'string'
        || !Array.isArray(record.references) || !Array.isArray(parents.items)) throw new Error('输入详情格式不兼容');
      renderEditor(record, parents.items);
      $('detail').scrollTop = 0; panel.focus({ preventScroll: true });
    } catch (error) {
      if (current()) { loading.textContent = `读取失败：${error.message}。可再次打开重试；现有编辑保留。`; loading.setAttribute('role', 'alert'); }
    } finally { if (current() && loading.textContent === '正在读取完整原文…') loading.remove(); }
  }

  function renderEditor(record, parents) {
    let saved = record, references = [...record.references], runProfile = null;
    const mounted = record.kind === 'draft' && record.hook_mount;
    const editable = record.kind === 'draft' && !mounted;
    rememberWorkers(parents);
    const editor = { busy: false, dirty: () => false, recordKey: keyOf(record) }; state.editor = editor;
    const current = () => ownsPage() && state.editor === editor;
    if (mounted) {
      panel.replaceChildren(el('h2', `暂存输入 #${record.id} · 预约已挂载`), statusLine(record), el('pre', record.content, 'input-original'),
        el('p', `预约状态：${mounted.state || '未知'}。正文、引用和完整运行参数已被授权快照占用；现在不可编辑、删除或重复发射。等待或失败的 Hook 停用后可释放草稿；执行中不可撤销，结果未知时须先检查现场，再移除挂载释放占用。`, 'hint'));
      for (const reference of references) panel.append(el('p', reference.label || '引用', 'hint'), el('pre', reference.quote || '', 'input-quote'));
      if (!Number.isSafeInteger(mounted.parent_id) || mounted.parent_id < 1 || typeof mounted.hook_id !== 'string') {
        panel.append(el('p', '挂载身份格式不兼容；请检查服务版本，不会把草稿当作可编辑。', 'error')); return;
      }
      const row = el('div', undefined, 'input-actions'); panel.append(row);
      row.append(button(`查看父 Worker ${workerLabel(mounted.parent_id, record.parent_worker_number)} 的 Hooks`, () => detail(mounted.parent_id), 'ghost hook-button', { help: '查看实际等待条件和执行结果，不重复发射。' }));
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
          await action('worker.hook_remove', { id: mounted.parent_id, hook_id: mounted.hook_id, expected_revision: hooks.revision });
          if (!current()) return;
          editor.busy = false; state.editor = null; show('预约已取消，草稿可以重新编辑；已有成果未删除。');
          await openItem(record, { reread: true });
        } catch (error) { if (current()) { stateLine.textContent = `取消失败：${error.message}；原挂载和草稿保留。`; stateLine.setAttribute('role', 'alert'); cancel.node.disabled = false; } }
        finally { editor.busy = false; }
      }, { help: '核验后只移除等待中的挂载，释放草稿；不会丢弃已产生的 Worker 或消息。', className: 'ghost hook-button' });
      cancel.node.disabled = true; cancel.host.tabIndex = 0; row.append(cancel.host);
      row.append(button('重新读取详情', () => { if (!editor.busy) return openItem(record, { reread: true }); }, 'ghost', { help: '读取草稿与挂载的最新事实，不重试或重复发射。' }));
      void api(`/api/worker/${mounted.parent_id}/hooks`).then(hooks => {
        if (!current()) return;
        const hook = hooks.mounts?.find(item => item.id === mounted.hook_id);
        const reason = !hook ? '挂载已不在当前读面，请重新读取详情或查看父 Worker。' : hook.removable === true ? null : hook.reason;
        cancel.node.disabled = !hook || (hook.removable ?? hook.editable) !== true || hook.locked || hook.state === 'running';
        stateLine.textContent = reason || (cancel.node.disabled ? '当前挂载不能取消；请检查实际执行状态。' : '可取消等待中的挂载，取消后恢复草稿编辑。');
        cancel.host.setAttribute('data-help', `${stateLine.textContent} 仅移除等待中的一次性 Hook，不删除已创建 Worker。`);
      }).catch(error => { if (current()) stateLine.textContent = `核验失败：${error.message}；取消入口保持禁用，请重新读取。`; });
      return;
    }
    panel.replaceChildren(el('h2', editable ? `暂存输入 #${record.id}` : `原始输入 ${inputNumber(record.id)}`), statusLine(record));
    const message = el('p', editable ? '编辑只保留在本页；保存后跨设备可见。发射会先保存，再创建 Worker。' : '已发送原文只读，不随 Worker 后续追加输入或目标变化。', 'hint');
    message.setAttribute('role', 'status'); panel.append(message);
    const content = editable ? el('textarea') : el('pre', record.content, 'input-original');
    if (editable) { content.value = record.content; content.rows = 10; content.maxLength = 32000; content.setAttribute('aria-label', '草稿正文'); }
    panel.append(content);
    const parent = el('select'); parent.setAttribute('aria-label', '草稿父 Worker');
    const parentHint = el('p', undefined, 'hint');
    if (editable) {
      const placeholder = el('option', '请选择父 Worker'); placeholder.value = ''; parent.append(placeholder);
      for (const task of parents) {
        const option = el('option', `${workerLabel(task)} ${task.goal ?? ''} · ${task.branch}${task.freeze ? ' · 冻结，可预约' : ''}`); option.value = String(task.id); parent.append(option);
      }
      if (record.parent_id && !parents.some(task => task.id === record.parent_id && task.branch === record.branch)) {
        // An archived/missing/rebound parent must never silently fall back to main/current branch.
        const missing = el('option', `${workerLabel(record.parent_id, record.parent_worker_number)} · ${record.branch ?? '未知分支'}（已不可选，请重选）`);
        missing.value = `missing:${record.parent_id}`; parent.append(missing); parent.value = missing.value;
      } else parent.value = record.parent_id ? String(record.parent_id) : '';
      const label = el('label', '父 Worker', 'input-parent-label'); label.append(parent); panel.append(label, parentHint);
    } else panel.append(el('p', `父 Worker：${record.parent_id ? workerLabel(record.parent_id, record.parent_worker_number) : '未知'} · 输入分支：${record.branch ?? '未知'}`, 'hint'));
    const refs = el('div', undefined, 'input-references'); panel.append(refs);
    const mutating = [], referenceControls = [];
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
    }
    paintReferences();
    const initialParent = () => saved.parent_id ? String(saved.parent_id) : '';
    editor.editKey = () => JSON.stringify([saved.revision, content.value, parent.value, references, runProfile]);
    const contentDirty = () => editable && (content.value !== saved.content || parent.value !== initialParent() || JSON.stringify(references) !== JSON.stringify(saved.references));
    editor.dirty = () => contentDirty() || runProfile !== null;
    const selectedParent = () => parents.find(task => String(task.id) === parent.value);
    const launchControls = new Map();
    const paintParent = () => {
      const target = selectedParent(), frozen = target?.freeze;
      parentHint.textContent = target ? frozen
        ? `父分支冻结：${frozen.reason || '等待安全边界'}。发射将挂载一次性 Hook，先保存正文、引用与运行设置；首个可创建安全点才创建工作区。`
        : '发射时从这个父 Worker 的分支创建独立工作区。' : '原父 Worker 缺失或不可用，必须重新选择并保存后才能发射。';
      for (const [kind, control] of launchControls) {
        control.node.textContent = kind === 'start' ? (frozen ? '预约发射并开始' : '发射并开始') : (frozen ? '预约仅创建' : '仅创建');
        control.node.classList.toggle('hook-button', Boolean(frozen));
        const help = frozen ? `只挂载到父 Worker ${workerLabel(target)}；不立即创建或调用 Agent。通过创建准入后${kind === 'start' ? '创建并开始' : '创建待开始 Worker'}，代码基线在创建时固定。`
          : kind === 'start' ? '先保存编辑，再将这一条草稿创建为独立 Worker 并立即开始；不执行其它暂存输入。' : '先保存编辑，再创建待开始的 Worker 和工作区；不调用 Agent。';
        control.host.setAttribute('data-help', kind === 'start' ? agentHelp(help) : help);
        control.node.setAttribute('data-help', kind === 'start' ? agentHelp(help) : help);
      }
    };
    parent.onchange = paintParent; paintParent();
    const actions = el('div', undefined, 'input-actions'); panel.append(actions);
    if (editable) {
      const profile = controlsButton('运行设置：预约时冻结项目默认', async () => {
        if (!current() || editor.busy) return;
        const chosen = await chooseCreationProfile({ profile: runProfile, ownsPage: current, title: `草稿 #${saved.id} 的发射运行设置` });
        if (!current() || editor.busy || !chosen.changed) return;
        runProfile = chosen.profile;
        profile.node.textContent = runProfile ? `运行设置：${runProfile.config_mode === 'pi' ? 'Pi 默认配置' : 'Lush 配置'}` : '运行设置：预约时冻结项目默认';
        message.textContent = '运行参数只保留在本页，发射或预约时才写入；普通“保存”只保存草稿正文、父 Worker 和引用。';
      }, { className: 'ghost', help: '编辑本次发射或预约的完整运行参数，不调用 Agent，不读取既有挂载的私有参数。只在发射时随授权保存，不写入草稿。' });
      mutating.push(profile.node); actions.append(profile.host);
    }
    function setBusy(busy) {
      editor.busy = busy; if (editable) { content.disabled = busy; parent.disabled = busy; }
      for (const node of [...mutating, ...referenceControls]) node.disabled = busy;
    }
    async function persist() {
      if (!content.value.trim()) throw new Error('草稿正文不能为空。');
      const target = selectedParent();
      if (!target) throw new Error('请选择可用的父 Worker，并保存后再发射。');
      if (saved.revision !== null && !Number.isInteger(saved.revision)) throw new Error('草稿缺少版本号，请重新读取。');
      if (!contentDirty()) return;
      const updated = await action('draft.update', { id: saved.id, content: content.value, references,
        ...(target.id !== saved.parent_id || target.branch !== saved.branch ? { branch: target.branch } : {}), expected_revision: saved.revision });
      // Update the captured revision even if navigation happened; never repaint a different page.
      saved = updated;
      if (current()) { content.value = updated.content; references = [...updated.references]; parent.value = String(updated.parent_id); paintReferences(); setBusy(true); }
    }
    async function mutate(kind) {
      if (!current() || editor.busy) return;
      setBusy(true); message.setAttribute('role', 'status');
      try {
        if (kind === 'remove') {
          if (!await confirmDialog({ title: `删除暂存输入 #${saved.id}？`, message: '这条未发送草稿及其引用将被删除，无法恢复；不会删除任何已发送输入或 Worker。', confirmLabel: '删除草稿', danger: true,
            confirmHelp: '永久删除这条未发送草稿与附属引用。' })) return;
          if (!current()) return;
          await action('draft.remove', { id: saved.id, expected_revision: saved.revision });
        } else {
          await persist();
          if (!current()) return;
          if (kind === 'save') {
            message.textContent = runProfile ? '草稿已保存；运行参数仍只保留在本页，发射或预约时才写入。' : '已保存。'; state.items.set(keyOf(saved), saved); paintList(); return;
          }
          // No content/branch/references here: the server atomically consumes the saved revision.
          const result = await action('order.submit', { draft_id: saved.id, expected_revision: saved.revision, start: kind === 'start',
            ...(selectedParent()?.freeze || runProfile ? { defer: true } : {}), ...(runProfile ? { profile: runProfile } : {}) });
          if (!current()) return;
          if (result.deferred) {
            state.editor = null;
            panel.replaceChildren(el('h2', '预约已挂载'), el('p', '尚未创建 Worker、工作区或调用 Agent。正文、引用和运行设置已保存在父 Worker 的一次性 Hook 中；请到挂载区查看等待、取消和执行结果。此草稿在授权期间不能重复发射或改写。', 'hint'),
              button(`查看父 Worker ${workerLabel(result.parent_id)} 的 Hooks`, () => detail(result.parent_id), 'ghost hook-button', { help: '查看实际挂载与执行状态，不重复发射。' }));
            return;
          }
          panel.replaceChildren(el('h2', kind === 'start' ? '已发射并开始' : '已创建·待开始'),
            button(`查看 Worker ${workerLabel(result.task)}`, () => detail(result.task.id)));
        }
        if (!current()) return;
        state.editor = null; state.items.delete(keyOf(saved)); paintList();
        if (kind === 'remove') panel.replaceChildren(el('p', '草稿已删除。', 'hint'));
        await load();
      } catch (error) {
        if (current()) { message.textContent = `操作失败：${error.message}。编辑内容保留；如版本冲突，请复制编辑内容后重新读取。`; message.setAttribute('role', 'alert'); }
      } finally { if (current()) setBusy(false); }
    }
    if (editable) {
      for (const [label, kind, opts] of [
        ['发射并开始', 'start', { agent: true, help: agentHelp('先保存编辑，再将这一条草稿创建为独立 Worker 并立即开始；不执行其它暂存输入。') }],
        ['仅创建', 'create', { help: '先保存编辑，再创建待开始的 Worker 和工作区；不调用 Agent，可进入 Worker 配置后手动开始。' }],
        ['保存', 'save', {}],
        ['删除草稿', 'remove', { help: '经确认后永久删除这条未发送草稿及其引用；已发送输入不可删除。', className: 'danger' }],
      ]) {
        const control = controlsButton(label, () => mutate(kind), opts); mutating.push(control.node); actions.append(control.host);
        if (['start', 'create'].includes(kind)) launchControls.set(kind, control);
      }
      paintParent();
    }
    if (record.task_id) actions.append(button(`查看 Worker ${workerLabel(record.task_id, record.task_worker_number)}`, () => detail(record.task_id)));
    const reread = controlsButton('重新读取详情', () => openItem(record, { reread: true }), { help: '读取最新原文、版本号和父 Worker 候选；如有未保存编辑，会先确认是否放弃。' });
    mutating.push(reread.node); actions.append(reread.host);
  }
  const loaded = load();
  return item ? Promise.all([loaded, openItem(item, { push })]) : loaded;
}
