import { api } from './api.js';
import { dashboardIcon } from './dashboard-icons.js';
import { createCardSettingsGesture } from './dashboard-card-gesture.js';
import { el } from './dom.js';
import { formDialog, closeDialog } from './dialog.js';
import { show as showMessage } from './messages.js';
import { createProjectBoard } from './project-board.js';
import { readDashboardConfig, loadDashboardConnections, refreshAccountCards } from './dashboard-cards.js';
import { dashboardAggregateLayout } from './dashboard-layout-model.js';
import { loadProjectCardMessages, PROJECT_CARD_SECTIONS } from './project-dashboard-content.js';
import { WIDGET_SECTIONS, GLOBAL_LINKS, PROJECT_LINKS } from './dashboard-widget-model.js';
import { aggregateRows, aggregateProjectIds, aggregateAccountIds, aggregateLinks, aggregateSections,
  selectAggregateProject, selectAggregateAccounts, toggleAggregateSection, toggleAggregateLink } from './dashboard-widget-aggregate-model.js';
import { createAggregateRenderer, dashboardNavigation } from './dashboard-widget-aggregate-render.js';
import { DIAGNOSTICS_ID, createDiagnosticsController, renderDiagnosticsCard } from './dashboard-diagnostics.js';

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
  const edit = el('button', '编辑布局', 'ghost dashboard-layout-edit'); edit.type = 'button';
  edit.dataset.help = '开启卡片拖动和边角缩放，位置与尺寸按网格吸附并自动避让；保存后同设备浏览器共享。';
  const saveLayout = el('button', '保存布局', 'primary dashboard-layout-save'), cancelLayout = el('button', '取消布局', 'ghost dashboard-layout-cancel');
  saveLayout.type = cancelLayout.type = 'button'; saveLayout.hidden = cancelLayout.hidden = true;
  const navigation = el('button', '常用入口', 'ghost dashboard-navigation-open'); navigation.type = 'button'; navigation.hidden = true;
  navigation.dataset.help = '展开已选择的全局导航入口，原生新标签打开，不启动后台或调用 Agent。';
  const directNavigation = el('nav', undefined, 'dashboard-global-direct-links');
  directNavigation.setAttribute('aria-label', '常用入口'); toolbar.append(directNavigation);
  const actionHosts = new Map();
  for (const control of [refresh, settings, navigation, edit, saveLayout, cancelLayout]) {
    const host = el('span', undefined, 'help-host'); host.append(control); actionHosts.set(control, host); toolbar.append(host);
  }
  // Status projection is stable; visible feedback belongs to the existing toast/modal, never the grid flow.
  const status = el('p', '正在读取卡片…', 'dashboard-status'); status.setAttribute('aria-hidden', 'true');
  const editor = el('section', undefined, 'dashboard-settings-panel'); editor.hidden = true;
  editor.setAttribute('aria-label', '总览设置'); editor.setAttribute('tabindex', '-1');
  const empty = el('div', undefined, 'workbench-empty'); empty.hidden = true;
  empty.append(el('strong', '还没有卡片'), el('p', '使用设置按钮选择项目或账户。'));
  let config = null, projects = [], connections = [], rows = [], messages = new Map();
  let busy = false, editing = false, layoutDirty = false, layoutDraft = [], failedWrite = false;
  let generation = 0, formSave = null, formSaveHost = null, formControls = [], currentEditor = null, editorStatus = null, editorObserver = null;
  let navigationRevision = null;
  let disposed = false;
  const active = () => !disposed && owner === globalThis.document && ownsPage() && root.parentNode != null;
  const diagnostics = createDiagnosticsController({ ownsPage: active, onChange: () => {
    if (active()) for (const card of board.root.querySelectorAll('.dashboard-diagnostics-card')) card.dashboardDiagnosticsChange?.();
  } });
  const renderer = createAggregateRenderer({ ownsPage: active, canAct: () => active() && !busy && !editing,
    messages: () => messages, refresh: id => updateInformation([id]), refreshAccounts: ids => updateInformation(ids) });
  const board = createBoard({ ownsPage: active, request: api,
    renderCard(row, options = {}) {
      const item = row.type === 'diagnostics'
        ? renderDiagnosticsCard(row, { ...options, state: diagnostics.state, refresh: diagnostics.refresh, ownsPage: active })
        : renderer.render(row, { ...options, mode: config.account_view });
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
    navigation.hidden = !config || aggregateLinks(config).length === 0;
    root.classList.toggle('dashboard-layout-editing', editing);
    if (config?.revision !== navigationRevision) {
      navigationRevision = config?.revision;
      directNavigation.replaceChildren(...(config ? [...dashboardNavigation(aggregateLinks(config)).children] : []));
    }
    for (const control of [refresh, settings, navigation, edit, saveLayout, cancelLayout]) {
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
    rows = config ? aggregateRows(config, projects, connections) : [];
    if (config?.diagnostics) rows.push({ id: DIAGNOSTICS_ID, type: 'diagnostics', name: '运行诊断' });
    diagnostics.setEnabled(!!config?.diagnostics);
    if (rows.length > 300) throw new Error('项目来源超过网格 300 张上限；配置与选择原样保留，请在设置减少展示来源');
    empty.hidden = !config || rows.length > 0;
    const layout = dashboardAggregateLayout(config, rows);
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
  function settingsPatch(next) {
    const patch = {};
    for (const key of ['cards', 'hidden_projects', 'content', 'account_view', 'widgets', 'diagnostics']) if (JSON.stringify(next[key]) !== JSON.stringify(config[key])) patch[key] = next[key];
    // An unchanged explicit save still checks the original revision; it does not materialize widgets.
    return Object.keys(patch).length ? patch : { account_view: next.account_view };
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
    const styles = el('fieldset'); styles.append(el('legend', '显示方式'));
    let mode = config.account_view;
    select(styles, '额度显示方式', [['list', '紧凑列表'], ['tiles', '账号小面板']], mode, value => { mode = value; }, 'dashboard-account-view');
    editor.insertBefore(styles, actions);
    return next => { selectAggregateAccounts(next, [...chosen], selectedSections ? [...selectedSections] : null); next.account_view = mode; };
  }
  function openSettings() {
    if (!config || busy) return;
    const { actions, save, show } = editorFrame('面板设置'); currentEditor = { kind: 'global' };
    const selected = new Set(aggregateProjectIds(config, projects)), byId = new Map(projects.map(row => [row.id, row.name || row.id]));
    for (const id of selected) if (!byId.has(id)) byId.set(id, `来源已移除：${id}`);
    const choices = el('fieldset'); choices.append(el('legend', '项目'));
    for (const [id, name] of byId) checkbox(choices, name, selected.has(id), checked => {
      if (checked) selected.add(id); else selected.delete(id);
    }, { projectId: id });
    editor.insertBefore(choices, actions);
    let diagnosticsEnabled = config.diagnostics;
    const diagnosticChoices = el('fieldset'); diagnosticChoices.append(el('legend', '运行诊断'));
    checkbox(diagnosticChoices, '显示运行诊断卡（只读，分钟级估算）', diagnosticsEnabled, checked => { diagnosticsEnabled = checked; }, { diagnostics: 'enabled' });
    editor.insertBefore(diagnosticChoices, actions);
    const applyAccounts = accountSettings(actions), navigationChanges = new Map(), navigationChoices = el('div');
    linkChoices(navigationChoices, null, navigationChanges); editor.insertBefore(navigationChoices, actions);
    save.onclick = () => {
      const next = structuredClone(config); next.diagnostics = diagnosticsEnabled;
      for (const id of byId.keys()) selectAggregateProject(next, projects, id, selected.has(id));
      applyAccounts(next);
      for (const change of navigationChanges.values()) toggleAggregateLink(next, projects, change.item, change.selected);
      return savePatch(settingsPatch(next));
    };
    show(); syncControls(); editor.focus?.();
  }
  function openCardSettings(row) {
    if (!config || busy) return;
    if (row.type === 'diagnostics') { openSettings(); return; }
    const { actions, save, show } = editorFrame(cardName(row)); currentEditor = { kind: 'card', id: row.id };
    const initial = new Set(aggregateSections(config, row.id)), selected = new Set(initial);
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
      return savePatch(settingsPatch(next));
    };
    show(); syncControls(); editor.focus?.();
  }
  function startEditing() {
    if (!config || busy || failedWrite) return;
    closeEditor(); editing = true; layoutDirty = false; layoutDraft = board.getLayout(); syncControls();
    setStatus('拖动手柄或边角调整，完成后保存布局。');
    board.root.querySelector('.project-board-handle')?.focus?.();
  }
  async function savePatch(patch, { finishLayout = false } = {}) {
    if (!active() || busy || !config || failedWrite) return false;
    busy = true; syncControls();
    try { await readDashboardConfig({ value: { ...config, ...patch, version: 5, widgets: Object.hasOwn(patch, 'widgets') ? patch.widgets : config.widgets ?? null } }); }
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
      if (acknowledgedConfig.version !== 5) throw new Error('保存响应不是完整 v5 确认');
      config = acknowledgedConfig;
      acknowledged = true;
      if (!active()) return false;
      if (finishLayout) { editing = false; layoutDirty = false; }
      failedWrite = false;
      const missing = aggregateRows(config, projects, connections).filter(row => row.type === 'project' && row.sections.includes('messages') && !messages.has(row.id));
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
  settings.onclick = () => { if (!active() || busy) return; if (editor.hidden) openSettings(); else { closeEditor(); settings.focus?.(); } };
  edit.onclick = () => startEditing();
  navigation.onclick = () => {
    if (active() && !busy && config) void formDialog({ title: '常用入口', content: dashboardNavigation(aggregateLinks(config)), confirmLabel: '关闭' });
  };
  saveLayout.onclick = () => savePatch({ layout: [...config.layout.filter(item => !rows.some(row => row.id === item.id)), ...layoutDraft] }, { finishLayout: true });
  cancelLayout.onclick = async () => {
    if (!active() || busy) return;
    editing = false; layoutDirty = false; await paint();
    setStatus(failedWrite ? '未保存布局已取消；此前保存未确认，请重新读取设置核对。' : '未保存布局已取消', failedWrite);
    edit.focus?.();
  };
  const removalObserver = typeof globalThis.MutationObserver === 'function' ? new MutationObserver(() => {
    if (!active()) dispose();
  }) : null;
  if (owner?.documentElement) removalObserver?.observe(owner.documentElement, { subtree: true, childList: true });
  function dispose() {
    if (disposed) return;
    disposed = true; ++generation; diagnostics.dispose(); removalObserver?.disconnect(); cardGesture.dispose();
    editorObserver?.disconnect(); editorObserver = null;
  }
  syncControls();
  return { root, ready: () => updateInformation(null, { initial: true }), refresh: updateInformation, dispose,
    state: () => ({ config, editing, layoutDirty, failedWrite }) };
}
