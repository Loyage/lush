import { api } from './api.js';
import { dashboardIcon } from './dashboard-icons.js';
import { createCardSettingsGesture } from './dashboard-card-gesture.js';
import { el } from './dom.js';
import { formDialog, confirmDialog, closeDialog } from './dialog.js';
import { createDashboardHistory, dashboardPatch } from './dashboard-edit-model.js';
import { registerPageLeaveGuard } from './page-leave-guard.js';
import { show as showMessage } from './messages.js';
import { createProjectBoard } from './project-board.js';
import { readDashboardConfig, loadDashboardConnections, refreshAccountCards } from './dashboard-cards.js';
import { dashboardAggregateLayout } from './dashboard-layout-model.js';
import { loadProjectCardMessages, PROJECT_CARD_SECTIONS } from './project-dashboard-content.js';
import { WIDGET_SECTIONS, GLOBAL_LINKS, PROJECT_LINKS } from './dashboard-widget-model.js';
import { aggregateRows, aggregateProjectIds, aggregateAccountIds, aggregateLinks, aggregateSections,
  materializeAggregate, selectAggregateProject, selectAggregateAccounts, toggleAggregateSection, toggleAggregateLink } from './dashboard-widget-aggregate-model.js';
import { createAggregateRenderer, dashboardNavigation } from './dashboard-widget-aggregate-render.js';
import { DIAGNOSTICS_ID, createDiagnosticsController, renderDiagnosticsCard } from './dashboard-diagnostics.js';
import { QUICK_ACTIONS_ID, createQuickActionsCard } from './dashboard-quick-actions.js';

const cardName = row => row.name || '未命名项目';
const plain = value => value && typeof value === 'object' && !Array.isArray(value);

/** One revision owner for all device-shared card selection, content and layout writes. */
export function createDashboardPanel({ ownsPage = () => true, createBoard = createProjectBoard } = {}) {
  const owner = globalThis.document;
  const root = el('div', undefined, 'workbench-view project-overview');
  root.setAttribute('aria-label', '工作台卡片面板');
  const toolbar = el('div', undefined, 'dashboard-toolbar');
  const refresh = el('button', '刷新全部', 'ghost'); refresh.type = 'button';
  refresh.dataset.help = '重新读取项目状态与消息，并联网查询已摆放账户的额度；不会启动离线后台或调用模型。';
  const settings = el('button', undefined, 'ghost dashboard-settings-open'); settings.type = 'button'; settings.append(dashboardIcon('settings'));
  settings.setAttribute('aria-label', '设置总览卡片'); settings.dataset.help = '选择面板展示的项目、账户与常用入口；保存后同设备浏览器共享。';
  settings.setAttribute('aria-expanded', 'false'); settings.setAttribute('aria-haspopup', 'dialog');
  const edit = el('button', '编辑模式', 'ghost dashboard-layout-edit'); edit.type = 'button';
  edit.dataset.help = '编辑卡片、来源、内容、导航和网格布局；全部修改仅在页面保存后向同设备浏览器发布。';
  const saveLayout = el('button', '保存更改', 'primary dashboard-layout-save'), cancelLayout = el('button', '取消编辑', 'ghost dashboard-layout-cancel');
  const add = el('button', '添加卡片', 'ghost dashboard-add-card');
  const undo = el('button', '撤销', 'ghost dashboard-undo'), redo = el('button', '重做', 'ghost dashboard-redo');
  const reset = el('button', '恢复默认布局', 'ghost dashboard-layout-reset');
  const reread = el('button', '重新读取设置', 'ghost dashboard-reread');
  const editStatus = el('span', '', 'dashboard-edit-status'); editStatus.setAttribute('role', 'status');
  for (const control of [add, undo, redo, reset, reread]) control.type = 'button';
  undo.dataset.help = '撤销上一步卡片、设置或布局修改，不写入设备。';
  redo.dataset.help = '重做已撤销的修改，不写入设备。';
  reset.dataset.help = '仅重置当前卡片的位置和尺寸；不清除来源、内容、导航或历史成员布局，可撤销。';
  cancelLayout.dataset.help = '丢弃本次全部未保存修改，恢复进入编辑时的已确认设置。';
  reread.dataset.help = '明确确认后丢弃草稿并读取设备最新设置；读取失败保留草稿，不自动重试写入。';
  saveLayout.type = cancelLayout.type = 'button'; saveLayout.hidden = cancelLayout.hidden = true;
  const navigation = el('button', '常用入口', 'ghost dashboard-navigation-open'); navigation.type = 'button'; navigation.hidden = true;
  navigation.dataset.help = '展开已选择的全局导航入口，原生新标签打开，不启动后台或调用 Agent。';
  const directNavigation = el('nav', undefined, 'dashboard-global-direct-links');
  directNavigation.setAttribute('aria-label', '常用入口'); toolbar.append(directNavigation);
  const actionHosts = new Map();
  toolbar.append(editStatus);
  const controls = [refresh, settings, navigation, edit, add, undo, redo, reset, reread, saveLayout, cancelLayout];
  for (const control of controls) {
    const host = el('span', undefined, 'help-host'); host.append(control); actionHosts.set(control, host); toolbar.append(host);
  }
  // Status projection is stable; visible feedback belongs to the existing toast/modal, never the grid flow.
  const status = el('p', '正在读取卡片…', 'dashboard-status'); status.setAttribute('aria-hidden', 'true');
  const editor = el('section', undefined, 'dashboard-settings-panel'); editor.hidden = true;
  editor.setAttribute('aria-label', '总览设置'); editor.setAttribute('tabindex', '-1');
  const empty = el('div', undefined, 'workbench-empty'); empty.hidden = true;
  const emptyAdd = el('button', '添加第一张卡片', 'primary'); emptyAdd.type = 'button';
  empty.append(el('strong', '还没有卡片'), el('p', '从已登记项目、额度窗口、运行诊断或快捷操作中选择。'), emptyAdd);
  let config = null, confirmed = null, projects = [], connections = [], rows = [], messages = new Map();
  let busy = false, editing = false, layoutDirty = false, layoutDraft = [], failedWrite = false, history = null, formDirty = false;
  const snapshot = () => ({ config, layoutDraft, layoutDirty });
  const dirty = () => !!confirmed && !!config && Object.keys(dashboardPatch(confirmed, config)).length > 0;
  const remember = () => { history?.push(snapshot()); syncControls(); };
  let generation = 0, formSave = null, formSaveHost = null, formControls = [], currentEditor = null, editorStatus = null, editorObserver = null;
  let navigationRevision = null;
  let disposed = false, quickActions = null;
  const active = () => !disposed && owner === globalThis.document && ownsPage() && root.parentNode != null;
  const diagnostics = createDiagnosticsController({ ownsPage: active, onChange: () => {
    if (active()) for (const card of board.root.querySelectorAll('.dashboard-diagnostics-card')) card.dashboardDiagnosticsChange?.();
  } });
  const renderer = createAggregateRenderer({ ownsPage: active, canAct: () => active() && !busy && !editing,
    messages: () => messages, refresh: id => updateInformation([id]), refreshAccounts: ids => updateInformation(ids) });
  const board = createBoard({ ownsPage: active, request: api,
    renderCard(row, options = {}) {
      const item = row.type === 'quick_actions' ? quickActions.root : row.type === 'diagnostics'
        ? renderDiagnosticsCard(row, { ...options, state: diagnostics.state, refresh: diagnostics.refresh, ownsPage: active })
        : renderer.render(row, { ...options, mode: config.account_view });
      item.querySelector('.dashboard-card-settings-host')?.remove();
      const control = el('button', undefined, 'ghost dashboard-card-settings'); control.type = 'button'; control.append(dashboardIcon('settings'));
      control.setAttribute('aria-label', `设置${cardName(row)}卡片`); control.setAttribute('aria-haspopup', 'dialog');
      control.dataset.help = '设置卡片内容、适用来源与导航，或仅从总览移除；应用只更新草稿，页面保存后发布。';
      control.onclick = () => { if (active() && !busy) { cardGesture.hide(); if (!editing) startEditing(); openCardSettings(row); } };
      const host = el('span', undefined, 'help-host dashboard-card-settings-host'); host.hidden = !editing; host.append(control); item.prepend(host);
      item.setAttribute('tabindex', '0');
      item.setAttribute('aria-description', editing ? '编辑模式：设置按钮常显，移动和缩放手柄支持方向键。' : '页面编辑模式可设置卡片；也可长按空白处或按 Shift + F10 打开入口。');
      return item;
    },
    onGeometryChange(row, geometry, item) {
      if (active() && item.dataset.cardId === row.id) item.dashboardGeometryChange?.(geometry);
    },
    onLayoutChange(layout) {
      if (!active() || !editing || busy) return;
      layoutDraft = layout; layoutDirty = true;
      config = { ...config, layout: [...config.layout.filter(item => !rows.some(row => row.id === item.id)), ...layout] };
      remember();
    },
  });
  root.append(toolbar, status, empty, board.root);
  const cardGesture = createCardSettingsGesture(board.root, { active, canReveal: () => !!config && !busy && !editing && editor.hidden });
  function setStatus(text = '', error = false) {
    status.textContent = text; status.hidden = !text; status.classList.toggle('error', error);
    if (editorStatus) { editorStatus.textContent = text; editorStatus.hidden = !text; editorStatus.classList.toggle('error', error); }
    else showMessage(text, error ? 'error' : 'info');
  }
  function syncControls() {
    if (busy || editing) cardGesture.hide();
    navigation.hidden = !config || aggregateLinks(config).length === 0;
    root.classList.toggle('dashboard-layout-editing', editing);
    const navigationKey = JSON.stringify(config && aggregateLinks(config));
    if (navigationKey !== navigationRevision) {
      navigationRevision = navigationKey;
      directNavigation.replaceChildren(...(config ? [...dashboardNavigation(aggregateLinks(config)).children] : []));
    }
    for (const control of controls) {
      control.disabled = busy || (control !== refresh && !config) || (failedWrite && [edit, saveLayout].includes(control))
        || (control === undo && !history?.canUndo) || (control === redo && !history?.canRedo);
      const host = actionHosts.get(control);
      if (control.disabled) {
        host.dataset.help = busy ? '请求尚未结束，请等待，不会自动重试。' : [undo, redo].includes(control) ? '没有可撤销或重做的修改。' : failedWrite ? '保存未确认；编辑已保留，请先重新读取配置核对。' : '设备配置尚未确认，不能修改看板。';
        host.setAttribute('tabindex', '0');
      } else { delete host.dataset.help; host.removeAttribute('tabindex'); }
    }
    edit.hidden = editing;
    settings.hidden = add.hidden = undo.hidden = redo.hidden = reset.hidden = saveLayout.hidden = cancelLayout.hidden = !editing;
    reread.hidden = !failedWrite && !editing;
    editStatus.hidden = !editing && !failedWrite;
    editStatus.textContent = failedWrite ? '保存未确认 · 草稿已保留' : dirty() ? '编辑中 · 有未保存更改' : '编辑中 · 尚无更改';
    for (const control of controls) actionHosts.get(control).hidden = control.hidden;
    emptyAdd.disabled = busy || !config;
    for (const host of board.root.querySelectorAll('.dashboard-card-settings-host')) host.hidden = !editing;
    for (const input of formControls) input.disabled = busy;
    if (formSave) {
      formSave.disabled = busy || !config;
      if (formSave.disabled) {
        formSaveHost.dataset.help = busy ? '请求尚未完成，请等待。' : '保存未确认，编辑已保留，请先重新读取设备配置核对。';
        formSaveHost.setAttribute('tabindex', '0');
      } else { delete formSaveHost.dataset.help; formSaveHost.removeAttribute('tabindex'); }
    }
    for (const control of board.root.querySelectorAll('.dashboard-card-settings')) {
      control.disabled = busy;
      const host = control.parentNode;
      if (busy) { host.dataset.help = '正在刷新或保存，请等待响应。'; host.setAttribute('tabindex', '0'); }
      else { delete host.dataset.help; host.removeAttribute('tabindex'); }
    }
    for (const control of [...board.root.querySelectorAll('.dashboard-account-refresh'), ...board.root.querySelectorAll('.dashboard-accounts-refresh')]) {
      let card = control.parentNode;
      while (card && !card.dataset?.cardId) card = card.parentNode;
      const connection = connections.find(row => row.id === card?.dataset.connectionId);
      const blocked = control.classList.contains('dashboard-accounts-refresh')
        ? !rows.find(row => row.id === card?.dataset.cardId)?.connection_ids.some(id => connections.some(connection => connection.id === id && connection.enabled !== false))
        : !connection || connection.enabled === false;
      control.disabled = busy || editing || blocked;
      const host = control.parentNode;
      if (control.disabled) {
        host.dataset.help = busy ? '正在刷新或保存，请等待响应；不会重复查询。' : editing ? '请先保存或取消布局编辑，再刷新此账户。' : '来源已停用或不可用，请先在模型来源核对。';
        host.setAttribute('tabindex', '0');
      } else { delete host.dataset.help; host.removeAttribute('tabindex'); }
    }
    board.setEditing(editing && !busy);
    renderer.syncActions(); quickActions?.sync();
  }
  async function paint() {
    if (!active()) return;
    rows = config ? aggregateRows(config, projects, connections) : [];
    if (config?.diagnostics) rows.push({ id: DIAGNOSTICS_ID, type: 'diagnostics', name: '运行诊断' });
    if (config?.quick_actions) {
      quickActions ||= createQuickActionsCard({ ownsPage: active, canAct: () => active() && !busy && !editing });
      quickActions.updateProjects(projects);
      rows.push({ id: QUICK_ACTIONS_ID, type: 'quick_actions', name: '快捷操作' });
    } else { quickActions?.dispose(); quickActions = null; }
    diagnostics.setEnabled(!!config?.diagnostics);
    if (rows.length > 300) throw new Error('项目来源超过网格 300 张上限；配置与选择原样保留，请在设置减少展示来源');
    empty.hidden = !config || rows.length > 0;
    const layout = dashboardAggregateLayout(config, rows);
    cardGesture.hide();
    await board.update(rows, { layout: editing ? [...layoutDraft, ...layout.filter(cell => !layoutDraft.some(draft => draft.id === cell.id))] : layout });
    if (active()) {
      syncControls();
      await Promise.all([...board.root.querySelectorAll('.dashboard-widget')].map(item => item.dashboardReady?.()));
    }
  }
  const ownsDialog = () => globalThis.document?.getElementById('modal')?.querySelector('.dashboard-settings-panel') === editor;
  function closeEditor() {
    if (ownsDialog()) closeDialog();
    editorObserver?.disconnect(); editorObserver = null;
    editor.hidden = true; settings.setAttribute('aria-expanded', 'false');
    currentEditor = null; formControls = []; formSave = null; formSaveHost = null; editorStatus = null; formDirty = false;
  }
  function focusEditorTrigger(previous) {
    const control = previous?.kind === 'card'
      ? board.root.querySelector(`[data-board-id="${previous.id}"]`) : null;
    if (control) control.focus?.({ preventScroll: true }); else (previous?.kind === 'library' ? add : settings).focus?.({ preventScroll: true });
  }
  function editorFrame(title) {
    cardGesture.hide();
    editorObserver?.disconnect(); editorObserver = null;
    editor.replaceChildren(); editor.hidden = false; formDirty = false; settings.setAttribute('aria-expanded', 'true');
    formControls = [];
    editorStatus = el('p', failedWrite ? status.textContent : '', 'dashboard-settings-status');
    editorStatus.hidden = !failedWrite; editorStatus.setAttribute('role', 'status'); editor.append(editorStatus);
    editor.append(el('p', '应用仅更新页面草稿；完成全部编辑后，点击页面“保存更改”。', 'hint'));
    const save = {};
    const actions = el('div', undefined, 'dashboard-settings-actions'); editor.append(actions);
    const show = () => {
      const identity = currentEditor;
      void formDialog({ title, content: editor, confirmLabel: '应用到草稿', cardClass: 'dashboard-settings-modal',
        canConfirm: () => active() && !busy && !!config,
        onConfirm: () => save.onclick(),
      }).then(() => {
        if (currentEditor !== identity) return;
        closeEditor(); if (active() && globalThis.document.getElementById('modal')?.hidden) focusEditorTrigger(identity);
      });
      formSave = globalThis.document.getElementById('modal').querySelector('.modal-confirm'); formSaveHost = formSave.parentNode;
      if (globalThis.MutationObserver && root.parentNode) {
        editorObserver = new MutationObserver(() => { if (!active() && currentEditor === identity) closeEditor(); });
        editorObserver.observe(root.parentNode, { childList: true, attributes: true });
      }
    };
    return { actions, save, show };
  }
  function checkbox(parent, label, checked, change, data = {}) {
    const host = el('label', undefined, 'dashboard-option'), input = el('input'); input.type = 'checkbox'; input.checked = checked;
    Object.assign(input.dataset, data);
    input.onchange = () => { if (busy || !active()) return; formDirty = true; change(input.checked); };
    host.append(input, el('span', label)); parent.append(host); formControls.push(input); return input;
  }
  function linkChoices(parent, id, changes) {
    const links = el('fieldset'); links.append(el('legend', id ? '项目入口' : '常用入口'));
    const picked = aggregateLinks(config, id, { selectedOnly: id === null });
    for (const [target, label] of id ? PROJECT_LINKS : GLOBAL_LINKS) {
      const item = { scope: id ? 'project' : 'global', target, project_id: id };
      const initial = picked.some(link => link.target === target);
      checkbox(links, label, initial, selected => {
        if (selected === initial) changes.delete(target); else changes.set(target, { item, selected });
      }, { linkScope: item.scope, linkTarget: target, projectId: id || '' });
    }
    parent.append(links);
  }
  async function applyDraft(next) {
    if (!active() || busy || !editing) return false;
    config = next; remember();
    busy = true; syncControls();
    try { await loadMissingMessages(); await paint(); }
    catch (error) { if (active()) setStatus(`草稿已应用；展示更新失败：${error.message}，请刷新。`, true); }
    finally { busy = false; if (active()) syncControls(); }
    return true;
  }
  async function loadMissingMessages() {
    const missing = aggregateRows(config, projects, connections).filter(row => row.type === 'project' && row.sections.includes('messages') && !messages.has(row.id));
    const added = await loadProjectCardMessages(missing, { ownsPage: active });
    if (active()) for (const [id, model] of added) messages.set(id, model);
  }
  function accountSettings(actions, selectedSections = null) {
    const chosen = new Set(aggregateAccountIds(config));
    const choices = el('fieldset'); choices.append(el('legend', '额度来源'));
    const byId = new Map(connections.map(connection => [connection.id, connection]));
    for (const id of chosen) if (!byId.has(id)) byId.set(id, null);
    for (const [id, source] of byId) checkbox(choices, source?.label || `来源已删除：${id}`, chosen.has(id), selected => {
      if (selected) chosen.add(id); else chosen.delete(id);
    }, { connectionId: id });
    editor.insertBefore(choices, actions);
    return next => { selectAggregateAccounts(next, [...chosen], selectedSections ? [...selectedSections] : null); };
  }
  function openSettings() {
    if (!config || busy) return;
    if (!editing) startEditing();
    if (!editing) return;
    const { actions, save, show } = editorFrame('面板设置'); currentEditor = { kind: 'global' };
    const selected = new Set(aggregateProjectIds(config, projects)), byId = new Map(projects.map(row => [row.id, row.name || row.id]));
    for (const id of selected) if (!byId.has(id)) byId.set(id, `来源已移除：${id}`);
    const choices = el('fieldset'); choices.append(el('legend', '项目'));
    for (const [id, name] of byId) checkbox(choices, name, selected.has(id), checked => {
      if (checked) selected.add(id); else selected.delete(id);
    }, { projectId: id });
    editor.insertBefore(choices, actions);
    let diagnosticsEnabled = config.diagnostics, quickActionsEnabled = config.quick_actions;
    const diagnosticChoices = el('fieldset'); diagnosticChoices.append(el('legend', '运行诊断'));
    checkbox(diagnosticChoices, '显示运行诊断卡（只读，分钟级估算）', diagnosticsEnabled, checked => { diagnosticsEnabled = checked; }, { diagnostics: 'enabled' });
    editor.insertBefore(diagnosticChoices, actions);
    const quickChoices = el('fieldset'); quickChoices.append(el('legend', '快捷操作'));
    checkbox(quickChoices, '显示快捷操作卡（一键安全重启）', quickActionsEnabled, checked => { quickActionsEnabled = checked; }, { quickActions: 'enabled' });
    editor.insertBefore(quickChoices, actions);
    const applyAccounts = accountSettings(actions), navigationChanges = new Map(), navigationChoices = el('div');
    linkChoices(navigationChoices, null, navigationChanges); editor.insertBefore(navigationChoices, actions);
    save.onclick = () => {
      const next = structuredClone(config); next.diagnostics = diagnosticsEnabled; next.quick_actions = quickActionsEnabled;
      for (const id of byId.keys()) selectAggregateProject(next, projects, id, selected.has(id));
      applyAccounts(next);
      for (const change of navigationChanges.values()) toggleAggregateLink(next, projects, change.item, change.selected);
      return applyDraft(next);
    };
    show(); syncControls(); editor.focus?.();
  }
  function openCardSettings(row) {
    if (!config || busy) return;
    if (!editing) startEditing();
    if (!editing) return;
    const { actions, save, show } = editorFrame(cardName(row)); currentEditor = { kind: 'card', id: row.id };
    const initial = new Set(['diagnostics', 'quick_actions'].includes(row.type) ? [] : aggregateSections(config, row.id)), selected = new Set(initial);
    let removed = false;
    const remove = checkbox(editor, '从总览移除此卡片（不删除来源，可重新添加）', false, checked => { removed = checked; }, { removeCard: row.id });
    remove.parentNode.dataset.help = '仅在保存后移出总览，不删除项目、账号或诊断数据；本次应用也可撤销。';
    if (row.type === 'quick_actions') {
      editor.insertBefore(el('p', '仅提供一键安全重启；项目行重启、独立界面重启与手动维护仍在项目管理。移除后停止后续步骤，已发送请求仍可能生效，不能撤销。', 'hint'), actions);
      save.onclick = () => { const next = structuredClone(config); next.quick_actions = !removed; return applyDraft(next); };
      show(); syncControls(); editor.focus?.(); return;
    }
    if (row.type === 'diagnostics') {
      editor.insertBefore(el('p', '汇总所有已登记项目的运行诊断；保留 60 / 300 秒窗口、趋势和来源覆盖，不查询服务商或修改运行配置。', 'hint'), actions);
      save.onclick = () => { const next = structuredClone(config); next.diagnostics = !removed; return applyDraft(next); };
      show(); syncControls(); editor.focus?.(); return;
    }
    const choices = el('fieldset'); choices.append(el('legend', '展示内容'));
    for (const [key, label] of row.type === 'accounts' ? WIDGET_SECTIONS.accounts : PROJECT_CARD_SECTIONS) checkbox(choices, label, selected.has(key), checked => {
      if (checked) selected.add(key); else selected.delete(key);
    }, { section: key });
    editor.insertBefore(choices, actions);
    const applyAccounts = row.type === 'accounts' ? accountSettings(actions, selected) : () => {}, navigationChanges = new Map();
    if (row.type === 'project') { const links = el('div'); linkChoices(links, row.id, navigationChanges); editor.insertBefore(links, actions); }
    save.onclick = () => {
      const next = structuredClone(config); applyAccounts(next);
      for (const [key] of row.type === 'accounts' ? WIDGET_SECTIONS.accounts : PROJECT_CARD_SECTIONS) if (key !== 'shortcuts' && selected.has(key) !== initial.has(key)) toggleAggregateSection(next, row.id, key, selected.has(key));
      for (const change of navigationChanges.values()) toggleAggregateLink(next, projects, change.item, change.selected);
      if (row.type === 'project' && selected.has('shortcuts') !== initial.has('shortcuts')) toggleAggregateSection(next, row.id, 'shortcuts', selected.has('shortcuts'));
      if (removed) removeCard(next, row);
      return applyDraft(next);
    };
    show(); syncControls(); editor.focus?.();
  }
  function removeCard(next, row) {
    if (row.type === 'project') selectAggregateProject(next, projects, row.id, false);
    else if (row.type === 'diagnostics') next.diagnostics = false;
    else if (row.type === 'quick_actions') next.quick_actions = false;
    else if (Array.isArray(next.widgets)) next.widgets = next.widgets.filter(widget => widget.type !== 'accounts');
    else next.cards = [];
  }
  function openLibrary() {
    if (!active() || busy || !config) return;
    if (!editing) startEditing();
    if (!editing) return;
    const { actions, save, show } = editorFrame('添加卡片'); currentEditor = { kind: 'library' };
    const chosen = new Set(), existing = new Set(rows.map(row => row.id));
    const search = el('input', undefined, 'dashboard-library-search'); search.type = 'search';
    search.placeholder = '搜索已登记项目或卡片'; search.setAttribute('aria-label', '搜索卡片库');
    const submit = el('button', '搜索', 'ghost'), clear = el('button', '清空', 'ghost'); submit.type = clear.type = 'button';
    const searchBar = el('div', undefined, 'dashboard-library-searchbar'); searchBar.append(search, submit, clear);
    const list = el('div', undefined, 'dashboard-library-list'), result = el('p', '', 'hint'); result.setAttribute('role', 'status');
    editor.insertBefore(searchBar, actions); editor.insertBefore(result, actions); editor.insertBefore(list, actions);
    const candidates = [...projects.map(row => ({ id: row.id, name: cardName(row), detail: row.project || row.id, type: 'project' })),
      { id: 'accounts', name: '额度窗口', detail: '统一窗口，添加后在卡片设置选择已有额度来源', type: 'accounts' },
      { id: DIAGNOSTICS_ID, name: '运行诊断', detail: '只读汇总已登记项目，不启动后台', type: 'diagnostics' },
      { id: QUICK_ACTIONS_ID, name: '快捷操作', detail: '一键安全重启，沿用确认范围与安全门', type: 'quick_actions' }];
    const entries = candidates.map(row => {
      const item = el('div', undefined, 'dashboard-library-item'); item.dataset.libraryId = row.id;
      const input = checkbox(item, `${row.name}${existing.has(row.id) ? ' · 已添加' : ''}`, existing.has(row.id), checked => {
        if (existing.has(row.id)) return;
        if (checked) chosen.add(row.id); else chosen.delete(row.id);
      }, { libraryId: row.id });
      if (existing.has(row.id)) { input.disabled = true; formControls = formControls.filter(control => control !== input); }
      item.append(el('small', row.detail)); list.append(item); return { row, item };
    });
    const filter = () => {
      const term = search.value.trim().toLocaleLowerCase(); let count = 0;
      for (const { row, item } of entries) { item.hidden = !`${row.name} ${row.detail}`.toLocaleLowerCase().includes(term); if (!item.hidden) count++; }
      result.textContent = count ? `已加载卡片库 · ${count} 项；已添加来源不可重复选择` : '没有匹配的卡片；仅搜索已登记来源，不新建项目或账号。';
    };
    search.value = ''; submit.onclick = filter; clear.onclick = () => { search.value = ''; filter(); search.focus?.(); };
    search.onkeydown = event => { if (event.key === 'Enter' && !event.isComposing && event.keyCode !== 229) { event.preventDefault?.(); filter(); } };
    formControls.push(search, submit, clear); filter();
    save.onclick = () => {
      const next = structuredClone(config);
      for (const id of chosen) {
        if (id === QUICK_ACTIONS_ID) next.quick_actions = true;
        else if (id === DIAGNOSTICS_ID) next.diagnostics = true;
        else if (id === 'accounts') {
          // An intentionally empty window needs an explicit member; legacy fields are retained.
          materializeAggregate(next, projects, { check: false });
          if (!next.widgets.some(widget => widget.type === 'accounts')) {
            let id = 'widget:accounts', suffix = 1;
            while (next.widgets.some(widget => widget.id === id) || next.layout.some(cell => cell.id === id)) id = `widget:accounts-${suffix++}`;
            next.widgets.push({ id, type: 'accounts', project_id: null, connection_ids: [], links: [], sections: ['quota', 'balance', 'reset', 'observed'] });
          }
        } else selectAggregateProject(next, projects, id, true);
      }
      return applyDraft(next);
    };
    show(); syncControls(); search.focus?.();
  }
  function startEditing() {
    if (!config || busy || failedWrite || editing) return;
    closeEditor(); confirmed = structuredClone(config); config = structuredClone(config);
    editing = true; layoutDirty = false; layoutDraft = board.getLayout(); history = createDashboardHistory(snapshot()); syncControls();
    setStatus('卡片设置与布局只修改草稿，完成后统一保存。');
    board.root.querySelector('.project-board-handle')?.focus?.();
  }
  async function restoreHistory(direction) {
    if (!active() || busy || !editing || !history?.[direction === 'undo' ? 'canUndo' : 'canRedo']) return;
    const value = history[direction](); config = value.config; layoutDraft = value.layoutDraft; layoutDirty = value.layoutDirty;
    busy = true; syncControls();
    try { await loadMissingMessages(); await paint(); }
    catch (error) { if (active()) setStatus(`草稿已恢复；展示更新失败：${error.message}`, true); }
    finally { busy = false; if (active()) syncControls(); }
  }
  async function savePatch(patch) {
    if (!active() || busy || !config || failedWrite) return false;
    busy = true; syncControls();
    try { await readDashboardConfig({ value: { ...config, ...patch, version: 6, widgets: Object.hasOwn(patch, 'widgets') ? patch.widgets : config.widgets ?? null } }); }
    catch (error) {
      busy = false;
      if (active()) { setStatus(`配置未发送：${error.message}；选择原样保留，请减少来源或入口后保存。`, true); syncControls(); }
      return false;
    }
    if (!active()) { busy = false; return false; }
    setStatus('正在保存…');
    let acknowledged = false;
    try {
      const next = await api('/api/host/dashboard', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...patch, expected_revision: config.revision }) });
      if (!active()) return false;
      // Reuse the same strict read validator without a second HTTP request.
      const acknowledgedConfig = await readDashboardConfig({ value: next });
      if (acknowledgedConfig.version !== 6) throw new Error('保存响应不是完整 v6 确认');
      if (!active()) return false;
      config = acknowledgedConfig; confirmed = structuredClone(config);
      acknowledged = true;
      if (!active()) return false;
      editing = false; layoutDirty = false; history = null;
      failedWrite = false;
      const missing = aggregateRows(config, projects, connections).filter(row => row.type === 'project' && row.sections.includes('messages') && !messages.has(row.id));
      const added = await loadProjectCardMessages(missing, { ownsPage: active });
      if (!active()) return true;
      for (const [id, model] of added) messages.set(id, model);
      await paint(); if (active()) setStatus('已保存'); return true;
    } catch (error) {
      if (active()) {
        failedWrite = !acknowledged;
        setStatus(acknowledged ? `设置已保存；展示更新失败：${error.message}。请刷新，不必再次保存。`
          : `保存未确认：${error.message}；编辑已保留，请先重新读取设置核对。`, true);
      }
      return acknowledged;
    } finally {
      busy = false;
      if (active()) {
        syncControls();
        if (acknowledged) edit.focus?.();
      }
    }
  }
  async function reloadSettings() {
    if (!active() || busy) return;
    if (dirty() || failedWrite) {
      const accepted = await confirmDialog({ title: '重新读取并丢弃草稿？', message: '将读取设备最新设置以核对保存结果。读取成功后丢弃本次全部未保存修改；失败则保留。', confirmLabel: '丢弃并重新读取', danger: true });
      if (!accepted || !active() || busy) return;
    }
    busy = true; syncControls();
    let loaded = false;
    try {
      const next = await readDashboardConfig();
      if (!active()) return;
      config = next; confirmed = structuredClone(config); failedWrite = false; editing = false; layoutDirty = false; history = null; renderer.resetWorkers();
      loaded = true; closeEditor(); await loadMissingMessages(); await paint();
      if (active()) setStatus('已重新读取设备设置');
    } catch (error) { if (active()) setStatus(loaded ? `设置已重新读取；展示更新失败：${error.message}。请刷新。` : `设置读取失败：${error.message}；原编辑已保留。`, true); }
    finally {
      busy = false;
      if (active()) {
        syncControls();
      }
    }
  }
  async function updateInformation(ids = null, { initial = false } = {}) {
    if (!active() || busy) return;
    busy = true; const epoch = ++generation; syncControls(); setStatus(initial ? '正在读取卡片…' : '正在刷新…');
    const current = () => active() && generation === epoch;
    const errors = [];
    try {
      if (!editing && editor.hidden && !failedWrite) {
        try { const next = await readDashboardConfig(); if (!current()) return; config = next; confirmed = structuredClone(config); }
        catch (error) { errors.push(`设置：${error.message}`); }
      }
      if (!current()) return;
      const placed = config ? aggregateAccountIds(config) : [];
      const selectedIds = ids ? ids.filter(id => placed.includes(id)) : placed;
      const results = await Promise.allSettled([api('/api/host/projects'), initial
        ? loadDashboardConnections() : refreshAccountCards(selectedIds, { ownsPage: current })]);
      if (!current()) return;
      if (results[0].status === 'fulfilled' && Array.isArray(results[0].value?.projects)) projects = results[0].value.projects;
      else {
        errors.push('项目状态读取失败；保留上次项目入口，当前状态未确认');
        projects = projects.map(row => ({ ...row, running: false, error: '项目状态未确认', summary: null }));
      }
      if (results[1].status === 'fulfilled') {
        const value = results[1].value;
        if (initial ? Array.isArray(value) : plain(value) && Array.isArray(value.connections)) {
          connections = initial ? value : value.connections;
          if (!initial) for (const failure of value.errors || []) {
            const name = connections.find(connection => connection.id === failure.id)?.label || failure.id;
            errors.push(`${name}：${failure.error}`);
          }
        } else errors.push('账户缓存响应未确认');
      } else {
        errors.push(`账户缓存未确认：${results[1].reason.message}`);
        connections = connections.map(connection => ({ ...connection,
          last_success: connection.last_success || (['available', 'partial'].includes(connection.observation?.status)
            ? { checked_at: connection.observation.checked_at, observation: connection.observation } : null),
          observation: { status: 'error', source: 'none', resources: [], reason: '账户缓存读取失败，当前值未确认。' } }));
      }
      if (!current()) return;
      const messageRows = config ? aggregateRows(config, projects, connections).filter(row => row.type === 'project' && row.sections.includes('messages')) : [];
      messages = await loadProjectCardMessages(messageRows, { ownsPage: current });
      renderer.resetWorkers();
      if (!current()) return;
      diagnostics.setEnabled(!!config?.diagnostics);
      const diagnosticRead = config?.diagnostics ? diagnostics.refresh() : null;
      await paint();
      if (current()) await diagnosticRead;
      if (current()) setStatus(errors.join('；'), errors.length > 0);
    } catch (error) { if (current()) setStatus(`刷新未完成：${error.message}`, true); }
    finally { busy = false; if (current()) syncControls(); }
  }
  refresh.onclick = () => updateInformation();
  settings.onclick = () => { if (!active() || busy) return; if (!ownsDialog()) openSettings(); else { closeEditor(); settings.focus?.(); } };
  edit.onclick = () => startEditing();
  navigation.onclick = () => {
    if (active() && !busy && config) void formDialog({ title: '常用入口', content: dashboardNavigation(aggregateLinks(config)), confirmLabel: '关闭' });
  };
  add.onclick = emptyAdd.onclick = openLibrary;
  undo.onclick = () => restoreHistory('undo'); redo.onclick = () => restoreHistory('redo');
  reread.onclick = reloadSettings;
  reset.onclick = async () => {
    if (!active() || busy || !editing) return;
    const accepted = await confirmDialog({ title: '恢复当前卡片的默认布局？', message: '只重置当前可见卡片的位置与尺寸，按默认网格排列；来源、内容、导航和旧成员布局保留。修改只进入草稿，可撤销。', confirmLabel: '恢复布局' });
    if (!accepted || !active() || busy || !editing) return;
    const next = structuredClone(config), ids = new Set(rows.map(row => row.id));
    const sizes = { project: { w: 6, h: 24 }, accounts: { w: 6, h: 16 }, diagnostics: { w: 6, h: 18 }, quick_actions: { w: 6, h: 10 } };
    const bottom = [0, 0];
    layoutDraft = rows.map(row => {
      const column = bottom[0] <= bottom[1] ? 0 : 1;
      const cell = { id: row.id, x: column * 6, y: bottom[column], ...sizes[row.type] }; bottom[column] += cell.h; return cell;
    });
    // Board reconciles canonical twelve-column placement, never a narrow-screen projection.
    layoutDirty = true; next.layout = [...next.layout.filter(cell => !ids.has(cell.id)), ...layoutDraft];
    await applyDraft(next);
  };
  saveLayout.onclick = () => {
    if (!editing || busy || !config) return;
    const patch = dashboardPatch(confirmed, config);
    // A no-op explicit save still checks the original revision without materializing geometry/widgets.
    return savePatch(Object.keys(patch).length ? patch : { account_view: config.account_view });
  };
  cancelLayout.onclick = async () => {
    if (!active() || busy || !editing) return;
    closeEditor(); config = structuredClone(confirmed); editing = false; layoutDirty = false; history = null;
    busy = true; syncControls();
    try { await paint(); setStatus(failedWrite ? '草稿已取消；此前保存未确认，请重新读取设置核对。' : '未保存更改已取消', failedWrite); }
    catch (error) { if (active()) setStatus(`草稿已取消；展示更新失败：${error.message}`, true); }
    finally { busy = false; if (active()) { syncControls(); edit.focus?.(); } }
  };
  const unregisterLeave = registerPageLeaveGuard(target => {
    if (!active()) return true;
    if (target === '#projects' && editing) return false;
    if (busy) { setStatus('请求尚未结束，请等待后离开。'); return false; }
    if (currentEditor) { setStatus('请先应用或取消当前卡片表单，再离开总览。'); return false; }
    if (!dirty() && !failedWrite) return true;
    return confirmDialog({ title: '离开并丢弃未保存更改？', message: failedWrite ? '上次保存结果未确认，离开会丢弃本地草稿。建议先重新读取设置核对。' : '卡片与布局更改尚未保存；离开将丢弃本次草稿。', confirmLabel: '丢弃并离开', danger: true })
      .then(accepted => accepted && active());
  }, { stay: () => {
    // Hash/back may already have changed the URL before a later click is cancelled.
    // Only the latest guarded rejection may restore this page's address.
    if (active()) globalThis.window?.history?.replaceState?.(null, '', '#projects');
    return false;
  } });
  const beforeUnload = event => {
    if (!active() || (!dirty() && !formDirty && !busy && !failedWrite)) return;
    event.preventDefault?.(); event.returnValue = '';
  };
  globalThis.addEventListener?.('beforeunload', beforeUnload);
  const removalObserver = typeof globalThis.MutationObserver === 'function' ? new MutationObserver(() => {
    if (!active()) dispose();
  }) : null;
  if (owner?.documentElement) removalObserver?.observe(owner.documentElement, { subtree: true, childList: true });
  function dispose() {
    if (disposed) return;
    disposed = true; ++generation; quickActions?.dispose(); diagnostics.dispose(); removalObserver?.disconnect(); cardGesture.dispose();
    unregisterLeave(); globalThis.removeEventListener?.('beforeunload', beforeUnload); closeEditor();
  }
  syncControls();
  return { root, ready: () => updateInformation(null, { initial: true }), refresh: updateInformation, dispose,
    state: () => ({ config, confirmed, editing, layoutDirty, dirty: dirty(), failedWrite }) };
}
