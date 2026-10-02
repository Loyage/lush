import { $, el, button } from './dom.js';
import { api, action } from './api.js';
import { detail } from './navigate.js';
import { activateDetailView } from './sidebar-ui.js';
import { absolute } from './format.js';
import { confirmDialog } from './dialog.js';
import { agentHelp } from './help.js';
import { locatable, locateReference } from './context-references.js';
import { ui } from './state.js';

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
  const taskBadge = el('span', `${compact ? '' : '任务状态：'}${status}`, `badge b-${taskTone}`);
  const mergeBadge = el('span', `${compact ? '' : '合并状态：'}${merge}`, `badge ${item.merge_status === 'merged' ? 'b-completed' : item.merge_status === 'blocked' ? 'b-awaiting' : item.merge_status === 'merging' ? 'b-running' : 'b-neutral'}`);
  taskBadge.setAttribute('aria-label', `任务状态：${status}`); mergeBadge.setAttribute('aria-label', `合并状态：${merge}`);
  return [taskBadge, mergeBadge];
}
function recordTime(item) {
  const time = el('time', absolute(item.created_at) || '时间未知', 'input-time');
  if (item.created_at) time.setAttribute('datetime', item.created_at);
  return time;
}
function statusLine(item) {
  const row = el('div', undefined, 'input-metadata');
  row.append(el('span', `${item.kind === 'draft' ? '草稿' : '输入'} #${item.id}`), ...stateBadges(item), recordTime(item));
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
  const state = { view, request: 0, pending: null, cursor: null, detailRequest: 0, editor: null, activeItem: null, listScroll: 0, items: new Map(), query: {} };
  ui.inputsPage = state;
  const ownsPage = () => ui.view === view && ui.inputsPage === state;
  const root = el('div', undefined, 'inputs-page resource-page');
  const browse = el('section', undefined, 'inputs-browse');
  const header = el('header', undefined, 'resource-hero');
  header.append(el('span', 'INPUTS', 'resource-kicker'), el('h1', '历史输入'), el('p', '查找原始输入与暂存想法，点开查看完整原文、引用或编辑草稿。任务追加消息请到对应 Task 查看。'));
  const filters = el('form', undefined, 'inputs-filters resource-tools');
  const searchLabel = el('label', '搜索原文', 'input-search');
  const search = el('input'); search.type = 'search'; search.placeholder = '搜索全库输入正文'; search.setAttribute('aria-label', '搜索全库输入正文');
  searchLabel.append(search);
  const status = selectField('任务状态', INPUT_STATUS), merge = selectField('合并状态', INPUT_MERGE);
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
      ? '打开完整草稿，编辑正文、引用和父 Task；打开不会调用 Agent。' : '只读查看这条输入提交时的完整原文与引用。' });
    const preview = (item.content ?? '').replace(/\s+/g, ' ').trim() || '（无正文）';
    row.setAttribute('aria-label', `${item.kind === 'draft' ? '草稿' : '输入'} #${item.id}，${preview.slice(0, 120)}，任务状态：${INPUT_STATUS[item.status] ?? INPUT_STATUS.unknown}，合并状态：${INPUT_MERGE[item.merge_status] ?? '状态未知'}：${label}`);
    const head = el('span', undefined, 'input-record-head');
    head.append(el('span', `${item.kind === 'draft' ? '草稿' : '输入'} #${item.id}`, 'tid'), recordTime(item));
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
    activateDetailView({ view: 'inputs', title: `${item.kind === 'draft' ? '暂存输入' : '原始输入'} #${item.id}`,
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
    let saved = record, references = [...record.references];
    const editable = record.kind === 'draft';
    const editor = { busy: false, dirty: () => false, recordKey: keyOf(record) }; state.editor = editor;
    const current = () => ownsPage() && state.editor === editor;
    panel.replaceChildren(el('h2', editable ? `暂存输入 #${record.id}` : `原始输入 #${record.id}`), statusLine(record));
    const message = el('p', editable ? '编辑只保留在本页；保存后跨设备可见。发射会先保存，再创建 Task。' : '已发送原文只读，不随 Task 后续追加输入或目标变化。', 'hint');
    message.setAttribute('role', 'status'); panel.append(message);
    const content = editable ? el('textarea') : el('pre', record.content, 'input-original');
    if (editable) { content.value = record.content; content.rows = 10; content.maxLength = 32000; content.setAttribute('aria-label', '草稿正文'); }
    panel.append(content);
    const parent = el('select'); parent.setAttribute('aria-label', '草稿父 Task');
    const parentHint = el('p', undefined, 'hint');
    if (editable) {
      const placeholder = el('option', '请选择父 Task'); placeholder.value = ''; parent.append(placeholder);
      for (const task of parents) {
        const option = el('option', `#${task.id} ${task.goal ?? ''} · ${task.branch}`); option.value = String(task.id); parent.append(option);
      }
      if (record.parent_id && !parents.some(task => task.id === record.parent_id && task.branch === record.branch)) {
        // An archived/missing/rebound parent must never silently fall back to main/current branch.
        const missing = el('option', `#${record.parent_id} · ${record.branch ?? '未知分支'}（已不可选，请重选）`);
        missing.value = `missing:${record.parent_id}`; parent.append(missing); parent.value = missing.value;
      } else parent.value = record.parent_id ? String(record.parent_id) : '';
      const label = el('label', '父 Task', 'input-parent-label'); label.append(parent); panel.append(label, parentHint);
    } else panel.append(el('p', `父 Task：${record.parent_id ? `#${record.parent_id}` : '未知'} · 输入分支：${record.branch ?? '未知'}`, 'hint'));
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
    editor.editKey = () => JSON.stringify([saved.revision, content.value, parent.value, references]);
    editor.dirty = () => editable && (content.value !== saved.content || parent.value !== initialParent() || JSON.stringify(references) !== JSON.stringify(saved.references));
    const selectedParent = () => parents.find(task => String(task.id) === parent.value);
    const paintParent = () => { parentHint.textContent = selectedParent() ? '发射时从这个父 Task 的分支创建独立工作区。' : '原父 Task 缺失或不可用，必须重新选择并保存后才能发射。'; };
    parent.onchange = paintParent; paintParent();
    const actions = el('div', undefined, 'input-actions'); panel.append(actions);
    function setBusy(busy) {
      editor.busy = busy; if (editable) { content.disabled = busy; parent.disabled = busy; }
      for (const node of [...mutating, ...referenceControls]) node.disabled = busy;
    }
    async function persist() {
      if (!content.value.trim()) throw new Error('草稿正文不能为空。');
      const target = selectedParent();
      if (!target) throw new Error('请选择可用的父 Task，并保存后再发射。');
      if (saved.revision !== null && !Number.isInteger(saved.revision)) throw new Error('草稿缺少版本号，请重新读取。');
      if (!editor.dirty()) return;
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
          if (!await confirmDialog({ title: `删除暂存输入 #${saved.id}？`, message: '这条未发送草稿及其引用将被删除，无法恢复；不会删除任何已发送输入或 Task。', confirmLabel: '删除草稿', danger: true,
            confirmHelp: '永久删除这条未发送草稿与附属引用。' })) return;
          if (!current()) return;
          await action('draft.remove', { id: saved.id, expected_revision: saved.revision });
        } else {
          await persist();
          if (!current()) return;
          if (kind === 'save') {
            message.textContent = '已保存。'; state.items.set(keyOf(saved), saved); paintList(); return;
          }
          // No content/branch/references here: the server atomically consumes the saved revision.
          const result = await action('say.submit', { draft_id: saved.id, expected_revision: saved.revision, start: kind === 'start' });
          if (!current()) return;
          panel.replaceChildren(el('h2', kind === 'start' ? '已发射并开始' : '已创建·待开始'),
            button(`查看 Task #${result.task.id}`, () => detail(result.task.id)));
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
        ['发射并开始', 'start', { agent: true, help: agentHelp('先保存编辑，再将这一条草稿创建为独立 Task 并立即开始；不执行其它暂存输入。') }],
        ['仅创建', 'create', { help: '先保存编辑，再创建待开始的 Task 和工作区；不调用 Agent，可进入任务配置后手动开始。' }],
        ['保存', 'save', {}],
        ['删除草稿', 'remove', { help: '经确认后永久删除这条未发送草稿及其引用；已发送输入不可删除。', className: 'danger' }],
      ]) {
        const control = controlsButton(label, () => mutate(kind), opts); mutating.push(control.node); actions.append(control.host);
      }
    }
    if (record.task_id) actions.append(button(`查看 Task #${record.task_id}`, () => detail(record.task_id)));
    const reread = controlsButton('重新读取详情', () => openItem(record, { reread: true }), { help: '读取最新原文、版本号和父 Task 候选；如有未保存编辑，会先确认是否放弃。' });
    mutating.push(reread.node); actions.append(reread.host);
  }
  const loaded = load();
  return item ? Promise.all([loaded, openItem(item, { push })]) : loaded;
}
