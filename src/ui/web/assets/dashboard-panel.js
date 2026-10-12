import { api } from './api.js';
import { dashboardIcon } from './dashboard-icons.js';
import { createCardSettingsGesture } from './dashboard-card-gesture.js';
import { el } from './dom.js';
import { formDialog, closeDialog } from './dialog.js';
import { show as showMessage } from './messages.js';
import { createProjectBoard } from './project-board.js';
import { readDashboardConfig, loadDashboardConnections, refreshAccountCards } from './dashboard-cards.js';
import { dashboardWidgetLayout } from './dashboard-layout-model.js';
import { loadProjectCardMessages } from './project-dashboard-content.js';
import { dashboardWidgets, widgetRows, placedAccountIds, newWidget, validateWidgets, WIDGET_NAMES, WIDGET_SECTIONS, GLOBAL_LINKS, PROJECT_LINKS } from './dashboard-widget-model.js';
import { createWidgetRenderer } from './dashboard-widget-render.js';

const cardName = row => row.name || WIDGET_NAMES[row.type];
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
  settings.setAttribute('aria-label', '设置总览卡片'); settings.dataset.help = '添加、移除或编辑独立信息卡片与来源；保存后同设备浏览器共享。';
  settings.setAttribute('aria-expanded', 'false'); settings.setAttribute('aria-haspopup', 'dialog');
  const edit = el('button', '编辑布局', 'ghost dashboard-layout-edit'); edit.type = 'button';
  edit.dataset.help = '开启卡片拖动和边角缩放，位置与尺寸按网格吸附并自动避让；保存后同设备浏览器共享。';
  const saveLayout = el('button', '保存布局', 'primary dashboard-layout-save'), cancelLayout = el('button', '取消布局', 'ghost dashboard-layout-cancel');
  saveLayout.type = cancelLayout.type = 'button'; saveLayout.hidden = cancelLayout.hidden = true;
  const actionHosts = new Map();
  for (const control of [refresh, settings, edit, saveLayout, cancelLayout]) {
    const host = el('span', undefined, 'help-host'); host.append(control); actionHosts.set(control, host); toolbar.append(host);
  }
  // Status projection is stable; visible feedback belongs to the existing toast/modal, never the grid flow.
  const status = el('p', '正在读取卡片…', 'dashboard-status'); status.setAttribute('aria-hidden', 'true');
  const editor = el('section', undefined, 'dashboard-settings-panel'); editor.hidden = true;
  editor.setAttribute('aria-label', '总览设置'); editor.setAttribute('tabindex', '-1');
  const empty = el('div', undefined, 'workbench-empty'); empty.hidden = true;
  empty.append(el('strong', '还没有卡片'), el('p', '使用设置按钮添加卡片。'));
  let config = null, projects = [], connections = [], rows = [], messages = new Map();
  let busy = false, editing = false, layoutDirty = false, layoutDraft = [], failedWrite = false;
  let generation = 0, formSave = null, formSaveHost = null, formControls = [], currentEditor = null, editorStatus = null, editorObserver = null;
  const active = () => owner === globalThis.document && ownsPage() && root.parentNode != null;
  const widgets = () => config ? dashboardWidgets(config, projects) : [];
  const renderer = createWidgetRenderer({ ownsPage: active, canAct: () => active() && !busy && !editing,
    messages: () => messages, refresh: id => updateInformation([id]), refreshAccounts: ids => updateInformation(ids) });
  const board = createBoard({ ownsPage: active, request: api,
    renderCard(row, options = {}) {
      const item = renderer.render(row, options);
      const control = el('button', undefined, 'ghost dashboard-card-settings'); control.type = 'button'; control.append(dashboardIcon('settings'));
      control.setAttribute('aria-label', `设置${cardName(row)}卡片`); control.setAttribute('aria-haspopup', 'dialog');
      control.dataset.help = '在弹窗选择此卡片展示的内容；排版使用页面编辑布局按钮，不修改项目或账号运行配置。';
      control.onclick = () => { if (active() && !busy) { cardGesture.hide(); openCardSettings(row); } };
      const host = el('span', undefined, 'help-host dashboard-card-settings-host'); host.hidden = true; host.append(control); item.prepend(host);
      item.setAttribute('tabindex', '0');
      item.setAttribute('aria-description', '长按卡片空白处显示设置入口；键盘可按 Shift + F10，Esc 收起。');
      return item;
    },
    onGeometryChange(row, geometry, item) {
      if (active() && item.dataset.cardId === row.id) item.dashboardGeometryChange?.(geometry);
    },
    onLayoutChange(layout) {
      if (!active() || !editing || busy) return;
      layoutDraft = layout; layoutDirty = true;
      setStatus('布局尚未保存。');
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
    for (const control of [refresh, settings, edit, saveLayout, cancelLayout]) {
      control.disabled = busy || (control !== refresh && !config) || (failedWrite && [edit, saveLayout].includes(control));
      const host = actionHosts.get(control);
      if (control.disabled) {
        host.dataset.help = busy ? '请求尚未结束，请等待，不会自动重试。' : failedWrite ? '保存未确认；编辑已保留，请先重新读取配置核对。' : '设备配置尚未确认，不能修改看板。';
        host.setAttribute('tabindex', '0');
      } else { delete host.dataset.help; host.removeAttribute('tabindex'); }
    }
    edit.hidden = editing; saveLayout.hidden = cancelLayout.hidden = !editing;
    for (const input of formControls) input.disabled = busy;
    if (formSave) {
      formSave.disabled = busy || !config || failedWrite;
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
    board.setEditing(editing && !busy && !failedWrite);
    renderer.syncActions();
  }
  async function paint() {
    if (!active()) return;
    rows = widgetRows(widgets(), projects, connections);
    if (config && config.widgets == null && !config.content.some(item => item.id === 'accounts')) {
      for (const row of rows.filter(row => row.type === 'accounts')) row.accountSections = Object.fromEntries(config.content.filter(item => item.id.startsWith('account:')).map(item => [item.id, item.sections]));
    }
    empty.hidden = !config || rows.length > 0;
    const layout = dashboardWidgetLayout(config?.layout || [], rows);
    cardGesture.hide();
    await board.update(rows, { layout: editing ? layoutDraft : layout });
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
    currentEditor = null; formControls = []; formSave = null; formSaveHost = null; editorStatus = null;
  }
  function focusEditorTrigger(previous) {
    const control = previous?.kind === 'card'
      ? board.root.querySelector(`[data-board-id="${previous.id}"]`) : null;
    if (control) control.focus?.({ preventScroll: true }); else settings.focus?.({ preventScroll: true });
  }
  function editorFrame(title) {
    cardGesture.hide();
    editorObserver?.disconnect(); editorObserver = null;
    editor.replaceChildren(); editor.hidden = false; settings.setAttribute('aria-expanded', 'true');
    formControls = [];
    editorStatus = el('p', failedWrite ? status.textContent : '', 'dashboard-settings-status');
    editorStatus.hidden = !failedWrite; editorStatus.setAttribute('role', 'status'); editor.append(editorStatus);
    const reload = el('button', '重新读取设置', 'ghost'); reload.type = 'button';
    reload.dataset.help = '丢弃当前未保存的卡片选择、内容和布局，重新读取设备配置；不会联网查询余额。';
    reload.onclick = () => reloadSettings(); formControls.push(reload);
    // Keep draft construction independent from modal submission and its request gate.
    const save = {};
    const actions = el('div', undefined, 'dashboard-settings-actions'); actions.append(reload); editor.append(actions);
    const show = () => {
      const identity = currentEditor;
      void formDialog({ title, content: editor, confirmLabel: '保存', cardClass: 'dashboard-settings-modal',
        canConfirm: () => active() && !busy && !!config && !failedWrite,
        onConfirm: () => save.onclick(),
      }).then(() => {
        if (currentEditor !== identity) return;
        closeEditor(); if (active()) focusEditorTrigger(identity);
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
    input.onchange = () => { if (busy || !active()) return; change(input.checked); };
    host.append(input, el('span', label)); parent.append(host); formControls.push(input); return input;
  }
  function select(parent, label, options, value, change, className) {
    const host = el('label'), input = el('select', undefined, className); input.setAttribute('aria-label', label);
    for (const [key, text] of options) { const option = el('option', text); option.value = key; input.append(option); }
    input.value = value; input.onchange = () => { if (!busy && active()) change(input.value); };
    host.append(el('span', label), input); parent.append(host); formControls.push(input); return input;
  }
  function editWidget(parent, widget) {
    if (widget.project_id !== null) {
      const choices = projects.map(row => [row.id, row.name || row.id]);
      if (!choices.some(([id]) => id === widget.project_id)) choices.push([widget.project_id, '来源项目不可用']);
      select(parent, '来源项目', choices, widget.project_id, id => { widget.project_id = id; }, 'dashboard-widget-project');
    }
    const choices = el('fieldset'); choices.append(el('legend', '展示内容'));
    for (const [key, label] of WIDGET_SECTIONS[widget.type]) checkbox(choices, label, widget.sections.includes(key), checked => {
      widget.sections = checked ? [...widget.sections, key] : widget.sections.filter(section => section !== key);
    }, { section: key }); parent.append(choices);
    if (widget.type === 'accounts') {
      const sources = el('fieldset'); sources.append(el('legend', '账户来源'));
      const byId = new Map(connections.map(connection => [connection.id, connection]));
      for (const id of widget.connection_ids) if (!byId.has(id)) byId.set(id, null);
      for (const [id, connection] of byId) checkbox(sources, connection?.label || `来源已删除：${id}`, widget.connection_ids.includes(id), checked => {
        widget.connection_ids = checked ? [...widget.connection_ids, id] : widget.connection_ids.filter(value => value !== id);
      }, { connectionId: id }); parent.append(sources);
    }
    if (widget.type === 'shortcuts') {
      const links = el('fieldset'); links.append(el('legend', '导航入口'));
      const byId = new Map(projects.map(row => [row.id, row.name || row.id]));
      for (const item of widget.links) if (item.scope === 'project' && !byId.has(item.project_id)) byId.set(item.project_id, '来源项目不可用');
      const available = [...GLOBAL_LINKS.map(([target, label]) => [{ scope: 'global', target, project_id: null }, label]),
        ...[...byId].flatMap(([project_id, name]) => PROJECT_LINKS.map(([target, label]) => [{ scope: 'project', target, project_id }, `${name} · ${label}`]))];
      for (const [item, label] of available) {
        const matches = value => value.scope === item.scope && value.target === item.target && value.project_id === item.project_id;
        checkbox(links, label, widget.links.some(matches), checked => { widget.links = checked ? [...widget.links, item] : widget.links.filter(value => !matches(value)); }, { linkScope: item.scope, linkTarget: item.target, projectId: item.project_id || '' });
      }
      parent.append(links);
    }
  }
  function openSettings() {
    if (!config || busy) return;
    const { actions, save, show } = editorFrame('面板设置'); currentEditor = { kind: 'global' };
    let draft = widgets();
    const list = el('div', undefined, 'dashboard-widget-settings-list'); editor.insertBefore(list, actions);
    const paintList = () => {
      list.replaceChildren();
      for (const widget of draft) {
        const entry = el('details', undefined, 'dashboard-widget-setting'); entry.dataset.widgetId = widget.id;
        const source = projects.find(row => row.id === widget.project_id);
        entry.append(el('summary', source ? `${source.name || '项目'} · ${WIDGET_NAMES[widget.type]}` : WIDGET_NAMES[widget.type]));
        editWidget(entry, widget);
        const remove = el('button', '移除卡片', 'ghost dashboard-widget-remove'); remove.type = 'button';
        remove.dataset.help = '保存后仅从共享面板移除此卡片，不删除项目、账户或历史配置。';
        remove.onclick = () => { if (!busy && active()) { draft = draft.filter(row => row.id !== widget.id); paintList(); } }; entry.append(remove); formControls.push(remove); list.append(entry);
      }
    };
    const add = el('fieldset'); add.append(el('legend', '添加卡片'));
    let type = 'status', project = projects[0]?.id || null;
    select(add, '卡片类型', Object.entries(WIDGET_NAMES), type, value => { type = value; }, 'dashboard-widget-type');
    select(add, '来源项目', projects.map(row => [row.id, row.name || row.id]), project || '', value => { project = value; }, 'dashboard-widget-add-project');
    const create = el('button', '添加卡片', 'ghost dashboard-widget-add'); create.type = 'button';
    create.onclick = () => {
      if (busy || !active()) return;
      if (draft.length >= 100) { setStatus('最多摆放 100 张卡片，请先移除不需要的卡片。', true); return; }
      if (['status', 'messages', 'workers'].includes(type) && !project) { setStatus('请选择已登记的来源项目。', true); return; }
      let sequence = 1; while (draft.some(row => row.id === `widget:${type}-${sequence}`) || config.layout.some(row => row.id === `widget:${type}-${sequence}`)) sequence++;
      draft.push(newWidget(type, `widget:${type}-${sequence}`, ['status', 'messages', 'workers'].includes(type) ? project : null)); paintList();
    };
    add.append(create); formControls.push(create); editor.insertBefore(add, actions); paintList();
    save.onclick = () => savePatch({ widgets: draft }); show(); syncControls(); editor.focus?.();
  }
  function openCardSettings(row) {
    if (!config || busy) return;
    const { actions, save, show } = editorFrame(cardName(row)); currentEditor = { kind: 'card', id: row.id };
    const draft = widgets(); const widget = draft.find(item => item.id === row.id); if (!widget) return;
    const choices = el('div'); editWidget(choices, widget); editor.insertBefore(choices, actions);
    const remove = el('button', '移除卡片', 'ghost dashboard-widget-remove'); remove.type = 'button';
    remove.dataset.help = '保存后仅从共享面板移除此卡片，不删除来源项目、账户或旧配置。';
    let removed = false; remove.onclick = () => { if (!busy && active()) { removed = true; choices.hidden = true; remove.disabled = true; } };
    actions.prepend(remove); formControls.push(remove);
    save.onclick = () => savePatch({ widgets: removed ? draft.filter(item => item.id !== row.id) : draft }); show(); syncControls(); editor.focus?.();
  }
  function startEditing() {
    if (!config || busy || failedWrite) return;
    closeEditor(); editing = true; layoutDirty = false; layoutDraft = board.getLayout(); syncControls();
    setStatus('拖动手柄或边角调整，完成后保存布局。');
    board.root.querySelector('.project-board-handle')?.focus?.();
  }
  async function savePatch(patch, { finishLayout = false } = {}) {
    if (!active() || busy || !config || failedWrite) return false;
    try { patch.widgets = validateWidgets(patch.widgets || widgets()); }
    catch (error) { setStatus(error.message, true); return false; }
    // Preserve every legacy field. Publishing widgets and their current geometry is one revision-guarded write.
    if (!patch.layout) {
      const displayed = board.getLayout();
      const seeds = dashboardWidgetLayout(config.layout, patch.widgets).filter(cell => !displayed.some(item => item.id === cell.id));
      patch.layout = [...config.layout.filter(cell => !displayed.some(item => item.id === cell.id) && !seeds.some(item => item.id === cell.id)), ...displayed, ...seeds];
    }
    busy = true; syncControls(); setStatus('正在保存…');
    let acknowledged = false;
    try {
      const next = await api('/api/host/dashboard', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...patch, expected_revision: config.revision }) });
      if (!active()) return false;
      // Reuse the same strict read validator without a second HTTP request.
      const acknowledgedConfig = await readDashboardConfig({ value: next });
      if (acknowledgedConfig.version !== 4 || acknowledgedConfig.widgets === null) throw new Error('保存响应不是完整 v4 独立卡片确认');
      config = acknowledgedConfig;
      acknowledged = true;
      if (!active()) return false;
      if (finishLayout) { editing = false; layoutDirty = false; }
      failedWrite = false;
      const sources = new Set(widgets().filter(row => row.type === 'messages' && row.sections.includes('messages')).map(row => row.project_id));
      const missing = projects.filter(row => sources.has(row.id) && !messages.has(row.id));
      const added = await loadProjectCardMessages(missing, { ownsPage: active });
      if (!active()) return true;
      for (const [id, model] of added) messages.set(id, model);
      await paint(); setStatus('已保存'); return true;
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
        if (acknowledged && finishLayout) edit.focus?.();
      }
    }
  }
  async function reloadSettings() {
    if (!active() || busy) return;
    busy = true; syncControls();
    const previousEditor = currentEditor;
    let loaded = false;
    try {
      const next = await readDashboardConfig();
      if (!active()) return;
      config = next; failedWrite = false; editing = false; layoutDirty = false; renderer.resetWorkers();
      await paint(); loaded = true;
      setStatus('已重新读取设备设置');
    } catch (error) { if (active()) setStatus(`设置读取失败：${error.message}；原编辑已保留。`, true); }
    finally {
      busy = false;
      if (active()) {
        // Build controls after releasing the request gate, retaining failed drafts otherwise.
        if (loaded && config && previousEditor && previousEditor === currentEditor && ownsDialog()) {
          if (previousEditor.kind === 'global') openSettings();
          else { const row = rows.find(row => row.id === previousEditor.id); if (row) openCardSettings(row); else closeEditor(); }
        }
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
      if (initial || (!editing && editor.hidden && !failedWrite)) {
        try { const next = await readDashboardConfig(); if (!current()) return; config = next; }
        catch (error) { errors.push(`设置：${error.message}`); }
      }
      if (!current()) return;
      const placed = placedAccountIds(widgets());
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
      const sources = new Set(widgets().filter(row => row.type === 'messages' && row.sections.includes('messages')).map(row => row.project_id));
      const messageRows = projects.filter(row => sources.has(row.id));
      messages = await loadProjectCardMessages(messageRows, { ownsPage: current });
      renderer.resetWorkers();
      if (!current()) return;
      await paint();
      if (current()) setStatus(errors.join('；'), errors.length > 0);
    } catch (error) { if (current()) setStatus(`刷新未完成：${error.message}`, true); }
    finally { busy = false; if (current()) syncControls(); }
  }
  refresh.onclick = () => updateInformation();
  settings.onclick = () => { if (!active() || busy) return; if (editor.hidden) openSettings(); else { closeEditor(); settings.focus?.(); } };
  edit.onclick = () => startEditing();
  saveLayout.onclick = () => savePatch({ widgets: widgets(), layout: [...config.layout.filter(item => !rows.some(row => row.id === item.id)), ...layoutDraft] }, { finishLayout: true });
  cancelLayout.onclick = async () => {
    if (!active() || busy) return;
    editing = false; layoutDirty = false; await paint();
    setStatus(failedWrite ? '未保存布局已取消；此前保存未确认，请重新读取设置核对。' : '未保存布局已取消', failedWrite);
    edit.focus?.();
  };
  syncControls();
  return { root, ready: () => updateInformation(null, { initial: true }), refresh: updateInformation,
    state: () => ({ config, editing, layoutDirty, failedWrite }) };
}
