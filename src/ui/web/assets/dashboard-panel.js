import { api } from './api.js';
import { dashboardIcon } from './dashboard-icons.js';
import { createCardSettingsGesture } from './dashboard-card-gesture.js';
import { el } from './dom.js';
import { formDialog, closeDialog } from './dialog.js';
import { show as showMessage } from './messages.js';
import { createProjectBoard } from './project-board.js';
import { readDashboardConfig, loadDashboardConnections, loadAccountCards, refreshAccountCards } from './dashboard-cards.js';
import { ACCOUNT_GROUP_ID, renderAccountGroup } from './dashboard-accounts-group.js';
import { dashboardAccountLayout } from './dashboard-layout-model.js';
import { loadProjectCardMessages, PROJECT_CARD_SECTIONS, PROJECT_CARD_DEFAULTS } from './project-dashboard-content.js';

const ACCOUNT_SECTIONS = [['quota', '额度条'], ['balance', '余额'], ['reset', '额度重置时间'], ['observed', '上次刷新'],
  ['details', '指标详情'], ['history', '历史成功观测'], ['provenance', '来源信息']];
const ACCOUNT_DEFAULTS = ['quota', 'balance', 'reset', 'observed'];
const defaults = row => ['account', 'accounts'].includes(row.type) ? ACCOUNT_DEFAULTS : PROJECT_CARD_DEFAULTS;
const cardName = row => row.type === 'account' ? row.connection?.label || '账户来源不可用' : row.name || '未命名项目';
const plain = value => value && typeof value === 'object' && !Array.isArray(value);

/** One revision owner for all device-shared card selection, content and layout writes. */
export function createDashboardPanel({ ownsPage = () => true, renderProject }) {
  const root = el('div', undefined, 'workbench-view project-overview');
  root.setAttribute('aria-label', '工作台卡片面板');
  const toolbar = el('div', undefined, 'dashboard-toolbar');
  const refresh = el('button', '刷新全部', 'ghost'); refresh.type = 'button';
  refresh.dataset.help = '重新读取项目状态与消息，并联网查询已摆放账户的额度；不会启动离线后台或调用模型。';
  const settings = el('button', undefined, 'ghost dashboard-settings-open'); settings.type = 'button'; settings.append(dashboardIcon('settings'));
  settings.setAttribute('aria-label', '设置总览卡片'); settings.dataset.help = '在弹窗选择要展示的项目和账户；设置保存在此 Host 设备，不改变卡片排版。';
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
  empty.append(el('strong', '还没有卡片'), el('p', '使用设置按钮选择项目或账户。'));
  let config = null, projects = [], connections = [], rows = [], messages = new Map(), inheritedAccountLayout = null;
  let busy = false, editing = false, layoutDirty = false, layoutDraft = [], failedWrite = false;
  let generation = 0, formSave = null, formSaveHost = null, formControls = [], currentEditor = null, editorStatus = null, editorObserver = null;
  const active = () => ownsPage() && root.parentNode != null;
  const sectionsFor = row => config?.content.find(item => item.id === row.id)?.sections ?? defaults(row);
  const board = createProjectBoard({ ownsPage: active, request: api,
    renderCard(row) {
      const sections = sectionsFor(row);
      const item = row.type === 'accounts' ? renderAccountGroup(row, {
        mode: config.account_view, sections, ownsPage: () => active() && !busy,
        sectionsForAccount: account => config.content.find(item => item.id === ACCOUNT_GROUP_ID)?.sections ?? sectionsFor(account),
        refresh: id => updateInformation([id]), refreshAll: () => updateInformation(),
      }) : renderProject(row, { sections, messages: messages.get(row.id) });
      const control = el('button', undefined, 'ghost dashboard-card-settings'); control.type = 'button'; control.append(dashboardIcon('settings'));
      control.setAttribute('aria-label', `设置${cardName(row)}卡片`); control.setAttribute('aria-haspopup', 'dialog');
      control.dataset.help = '在弹窗选择此卡片展示的内容；排版使用页面编辑布局按钮，不修改项目或账号运行配置。';
      control.onclick = () => { if (active() && !busy) { cardGesture.hide(); openCardSettings(row); } };
      const host = el('span', undefined, 'help-host dashboard-card-settings-host'); host.hidden = true; host.append(control); item.prepend(host);
      item.setAttribute('tabindex', '0');
      item.setAttribute('aria-description', '长按卡片空白处显示设置入口；键盘可按 Shift + F10，Esc 收起。');
      return item;
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
      const card = control.parentNode.parentNode.parentNode;
      const connection = connections.find(row => row.id === card.dataset.connectionId);
      const blocked = control.classList.contains('dashboard-accounts-refresh')
        ? !config?.cards.some(row => connections.some(connection => connection.id === row.connection_id && connection.enabled !== false))
        : !connection || connection.enabled === false;
      control.disabled = busy || blocked;
      const host = control.parentNode;
      if (control.disabled) {
        host.dataset.help = busy ? '正在刷新或保存，请等待响应；不会重复查询。' : '来源已停用或不可用，请先在模型来源核对。';
        host.setAttribute('tabindex', '0');
      } else { delete host.dataset.help; host.removeAttribute('tabindex'); }
    }
    board.setEditing(editing && !busy && !failedWrite);
  }
  async function paint() {
    if (!active()) return;
    const selected = new Set(config?.hidden_projects || []);
    const accounts = config ? await loadAccountCards({ ownsPage: active, config, connections }) : [];
    if (!active()) return;
    rows = config ? [...projects.filter(row => !selected.has(row.id)), ...(accounts.length
      ? [{ id: ACCOUNT_GROUP_ID, type: 'accounts', name: '额度与余额', accounts }] : [])] : [];
    empty.hidden = !config || rows.length > 0;
    const layout = dashboardAccountLayout(config?.layout || [], config?.cards.map(card => card.connection_id) || [], inheritedAccountLayout);
    cardGesture.hide();
    await board.update(rows, { layout: editing ? layoutDraft : layout });
    if (active()) {
      inheritedAccountLayout = board.getLayout().find(cell => cell.id === ACCOUNT_GROUP_ID) || inheritedAccountLayout;
      syncControls();
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
      ? board.root.querySelector(`[data-project-id="${previous.id}"]`) : null;
    if (control) control.focus?.({ preventScroll: true }); else settings.focus?.();
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
  function openSettings() {
    if (!config || busy) return;
    const { actions, save, show } = editorFrame('面板设置'); currentEditor = { kind: 'global' };
    const visible = new Set(projects.filter(row => !config.hidden_projects.includes(row.id)).map(row => row.id));
    const projectChoices = el('fieldset'); projectChoices.append(el('legend', '项目'));
    for (const row of projects) checkbox(projectChoices, row.name || row.project || row.id, visible.has(row.id),
      checked => checked ? visible.add(row.id) : visible.delete(row.id), { projectId: row.id });
    if (!projects.length) projectChoices.append(el('p', '暂无已登记项目', 'hint'));
    editor.insertBefore(projectChoices, actions);
    const accountPatch = accountSettings(actions);
    save.onclick = () => savePatch({ ...accountPatch(),
      hidden_projects: [...new Set([...config.hidden_projects.filter(id => !projects.some(row => row.id === id)),
        ...projects.filter(row => !visible.has(row.id)).map(row => row.id)])] });
    show(); syncControls(); editor.focus?.();
  }
  function accountSettings(actions) {
    const accounts = new Set(config.cards.map(card => card.connection_id));
    const accountChoices = el('fieldset'); accountChoices.append(el('legend', '额度来源'));
    const byId = new Map(connections.map(connection => [connection.id, connection]));
    for (const id of accounts) if (!byId.has(id)) byId.set(id, null);
    for (const [id, connection] of byId) checkbox(accountChoices, connection?.label || `来源已删除：${id}`, accounts.has(id),
      checked => checked ? accounts.add(id) : accounts.delete(id), { connectionId: id });
    if (!byId.size) accountChoices.append(el('p', '在模型来源中添加账户', 'hint'));
    editor.insertBefore(accountChoices, actions);
    const styles = el('fieldset'); styles.append(el('legend', '显示方式'));
    const mode = el('select', undefined, 'dashboard-account-view'); mode.setAttribute('aria-label', '额度显示方式');
    for (const [value, label] of [['list', '紧凑列表'], ['tiles', '账号小面板']]) {
      const option = el('option', label); option.value = value; mode.append(option);
    }
    let selectedMode = config.account_view || 'list'; mode.value = selectedMode;
    mode.onchange = () => { if (!busy && active()) selectedMode = mode.value; };
    formControls.push(mode); styles.append(mode); editor.insertBefore(styles, actions);
    return () => ({ cards: [...accounts].map(connection_id => ({ type: 'account', connection_id })), account_view: selectedMode });
  }
  function openCardSettings(row) {
    if (!config || busy) return;
    const { actions, save, show } = editorFrame(cardName(row)); currentEditor = { kind: 'card', id: row.id };
    const selected = new Set(sectionsFor(row));
    const choices = el('fieldset'); choices.append(el('legend', '展示内容'));
    for (const [key, label] of row.type === 'accounts' ? ACCOUNT_SECTIONS : PROJECT_CARD_SECTIONS) {
      checkbox(choices, label, selected.has(key), checked => checked ? selected.add(key) : selected.delete(key), { section: key });
    }
    const accountPatch = row.type === 'accounts' ? accountSettings(actions) : () => ({});
    editor.insertBefore(choices, actions);
    save.onclick = () => savePatch({ ...accountPatch(), content: [...config.content.filter(item => item.id !== row.id), { id: row.id, sections: [...selected] }] });
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
    busy = true; syncControls(); setStatus('正在保存…');
    let acknowledged = false;
    try {
      const next = await api('/api/host/dashboard', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...patch, expected_revision: config.revision }) });
      if (!active()) return false;
      // Reuse the same strict read validator without a second HTTP request.
      config = await readDashboardConfig({ value: next });
      acknowledged = true;
      if (!active()) return false;
      if (finishLayout) { editing = false; layoutDirty = false; }
      failedWrite = false;
      const missing = projects.filter(row => !config.hidden_projects.includes(row.id)
        && sectionsFor(row).includes('messages') && !messages.has(row.id));
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
      config = next; failedWrite = false; editing = false; layoutDirty = false; inheritedAccountLayout = null;
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
      const selectedIds = ids || config?.cards.map(card => card.connection_id) || [];
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
      const messageRows = projects.filter(row => !config?.hidden_projects.includes(row.id)
        && sectionsFor(row).includes('messages'));
      messages = await loadProjectCardMessages(messageRows, { ownsPage: current });
      if (!current()) return;
      await paint();
      if (current()) setStatus(errors.join('；'), errors.length > 0);
    } catch (error) { if (current()) setStatus(`刷新未完成：${error.message}`, true); }
    finally { busy = false; if (current()) syncControls(); }
  }
  refresh.onclick = () => updateInformation();
  settings.onclick = () => { if (!active() || busy) return; if (editor.hidden) openSettings(); else { closeEditor(); settings.focus?.(); } };
  edit.onclick = () => startEditing();
  saveLayout.onclick = () => savePatch({ layout: [...config.layout.filter(item => !rows.some(row => row.id === item.id)), ...layoutDraft] }, { finishLayout: true });
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
