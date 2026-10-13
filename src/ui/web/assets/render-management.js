import { $, el, button, syncChildren } from './dom.js';
import { api, projectApi } from './api.js';
import { ui } from './state.js';
import { activateDetailView } from './sidebar-ui.js';
import { confirmDialog } from './dialog.js';
import { show } from './messages.js';
import { pageSubnav } from './page-subnav.js';
import { renderSignalManagement } from './hook-signals.js';

function sameProject(project) {
  try { return projectApi('/api/hooks') === project; } catch { return false; }
}

/** Project-local management authorizations; separate from development automation. */
export async function openManagement({ subpage = 'settings', push = true } = {}) {
  subpage = subpage === 'history' ? 'history' : 'settings';
  const owner = globalThis.document;
  const view = activateDetailView({ view: 'management', title: 'Valet 设置', context: '工作',
    hint: '时间信号 · Valet 绑定 · 设置运行快照', push, hash: subpage === 'history' ? '#management-history' : '#management' });
  const project = projectApi('/api/hooks');
  const previous = ui.managementPage;
  if (previous?.view === view && previous.project === project && previous.owner === owner) {
    previous.switchSubpage(subpage); return previous.pending;
  }
  const state = { view, project, owner, subpage, pending: null, catalogue: null, busy: false,
    signalsEditing: false, managementEditing: false, folds: new Map(), historyFolds: new Map([['management-history-signals', true], ['management-history-workers', true]]) };
  ui.managementPage = state;
  const owns = () => owner === globalThis.document && ui.view === view && ui.managementPage === state && sameProject(project);
  const root = el('div', undefined, 'management-page hooks-page'); $('detail').replaceChildren(root);
  const subnav = pageSubnav('Valet 设置子页面', [
    { id: 'settings', label: '设置', href: '#management' },
    { id: 'history', label: '绑定运行快照', href: '#management-history' },
  ], subpage, next => owns() ? openManagement({ subpage: next }) : undefined);
  state.switchSubpage = next => {
    state.subpage = next;
    for (const link of subnav.children) {
      const selected = link.dataset.subpage === next;
      link.classList.toggle('active', selected); link.setAttribute('aria-current', selected ? 'page' : 'false');
    }
    if (state.settingsNode) state.settingsNode.hidden = next !== 'settings';
    if (state.historyNode) state.historyNode.hidden = next !== 'history';
    if (next === 'history' && state.catalogue) paintHistory();
  };
  const signalEditor = el('div', undefined, 'hook-editor'), managerEditor = el('div', undefined, 'hook-editor');
  const header = el('div', undefined, 'hooks-page-header'); header.append(el('h1', 'Valet 设置'));
  const help = el('a', '使用帮助', 'hook-help-link'); help.href = '/#doc-docs-engineering-hook-signals-management';
  help.target = '_blank'; help.rel = 'noopener'; header.append(help);
  const workLink = el('a', '查看全部工作与 Valet 记录', 'management-work-link'); workLink.setAttribute('href', '#workers'); header.append(workLink);
  root.append(subnav, header);

  async function load() {
    try {
      const catalogue = await api('/api/hooks'); if (!owns()) return;
      state.catalogue = catalogue; paint();
    } catch (issue) {
      if (!owns()) return;
      if (state.catalogue) show(`读取失败：${issue.message}；已加载记录与未保存编辑保留。`, 'error');
      else root.replaceChildren(subnav, header, el('p', `读取失败：${issue.message}`, 'error'), button('重新读取', load, 'ghost'));
    }
  }
  async function refresh() {
    if (!owns() || state.busy) return;
    if ((state.signalsEditing || state.managementEditing) && !await confirmDialog({ title: '放弃未保存编辑并刷新？',
      message: '刷新会读取后台最新管理绑定和信号目录，当前未保存编辑会丢失。已发出的请求不会撤回；结果不明请先检查「工作」中的已有 Valet。',
      confirmLabel: '放弃并刷新' })) return;
    if (!owns()) return;
    state.signalsEditing = false; state.managementEditing = false;
    signalEditor.replaceChildren(); managerEditor.replaceChildren(); state.paintedCatalogue = null; await load();
  }
  function paintHistory() {
    if (!owns() || state.historyPaintedCatalogue === state.catalogue) return;
    state.historyNode.replaceChildren(el('h2', '绑定运行快照'),
      el('p', '仅展示时间信号与绑定的设置运行快照，不是完整调用历史。日常 Valet 工作（含即时输入）、目标、结果与调用请从统一「工作」列表查看；未知副作用不自动重放。', 'hint'),
      button('刷新记录', refresh, 'ghost'),
      ...renderSignalManagement({ catalogue: state.catalogue, ownsPage: owns, history: true, folds: state.historyFolds }));
    state.historyPaintedCatalogue = state.catalogue;
  }
  function paint() {
    if (!owns()) return;
    // A busy gate is enough while requests run. Do not replace the active form.
    if (state.paintedCatalogue === state.catalogue && (state.busy || state.paintedBusy === state.busy)) return;
    const focused = owner.activeElement;
    const selection = focused && typeof focused.selectionStart === 'number'
      ? [focused.selectionStart, focused.selectionEnd, focused.selectionDirection] : null;
    const shared = { catalogue: state.catalogue, ownsPage: owns, busy: () => state.busy,
      setBusy(value) { state.busy = value; if (owns()) paint(); },
      setEditing(value, key) { state[`${key}Editing`] = value; },
      onCatalogue(result) { if (owns()) { state.catalogue = result; paint(); } },
      onManagement(result) {
        if (!owns()) return;
        const task = result.task || result, existing = state.catalogue.management_workers || [];
        state.catalogue = { ...state.catalogue, management_workers: existing.some(item => item.id === task.id)
          ? existing.map(item => item.id === task.id ? task : item) : [task, ...existing].slice(0, 100) };
        paint();
      },
    };
    const settings = el('section', undefined, 'management-settings');
    settings.append(button('刷新目录', refresh, 'ghost', { help: '读取当前项目管理绑定和时间信号；有未保存编辑时先确认，不执行管理指令。' }),
      ...renderSignalManagement({ ...shared, editor: signalEditor, managerEditor, folds: state.folds,
        canEdit: key => !state[`${key}Editing`] }));
    const history = el('section', undefined, 'management-history automation-history');
    state.settingsNode = settings; state.historyNode = history; state.historyPaintedCatalogue = null;
    syncChildren(root, [subnav, header, settings, history]); state.switchSubpage(state.subpage);
    let ancestor = focused;
    while (ancestor && ancestor !== root) ancestor = ancestor.parentNode;
    if (ancestor === root && owner.activeElement !== focused) {
      focused.focus({ preventScroll: true });
      if (selection && focused.setSelectionRange) focused.setSelectionRange(...selection);
    }
    state.paintedCatalogue = state.catalogue; state.paintedBusy = state.busy;
  }
  state.pending = load(); return state.pending;
}
