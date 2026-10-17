import { el } from './dom.js';
import { formDialog, confirmDialog, closeDialog } from './dialog.js';
import { serviceRestartControls } from './service-restart.js';
import { createAutoSelectAction } from './auto-select-action.js';
import { QUICK_ACTIONS, DEFAULT_QUICK_ACTION_BUTTONS, normalizeQuickActionButtons } from '../../../shared/dashboard-quick-actions.js';

export const QUICK_ACTIONS_ID = 'widget:quick-actions';

/** Retain the foreground flow and exact controls through selection/layout redraws. */
export function createQuickActionsCard({ ownsPage, canAct, buttons = DEFAULT_QUICK_ACTION_BUTTONS, ...options }) {
  const root = el('li', undefined, 'project-item dashboard-widget dashboard-quick-actions-card');
  root.dataset.cardId = QUICK_ACTIONS_ID; root.dataset.cardType = root.dataset.widgetType = 'quick_actions';
  let disposed = false, dialog = null, detailsContent = null, auto = null, inDetails = false, geometry = { h: 12 }, selected = [];
  const active = () => !disposed && ownsPage();
  const confirm = async settings => {
    if (!active()) return false;
    const result = confirmDialog(settings), identity = document.getElementById('modal')?.firstElementChild; dialog = identity;
    try { return await result; } finally { if (dialog === identity) dialog = null; }
  };
  const controls = serviceRestartControls({ ...options, buttons: [], mode: 'quick_actions', ownsPage: active, canAct, confirm });
  const header = el('header', undefined, 'dashboard-widget-header'); header.append(el('strong', '快捷操作', 'dashboard-widget-title'));
  const body = el('div', undefined, 'dashboard-widget-body'); body.append(controls.root);
  const placeholder = el('p', '操作与进度正在详情中显示', 'hint'); placeholder.hidden = true; body.append(placeholder);
  const empty = el('p', '尚未选择快捷按钮；可在编辑模式的卡片设置中勾选。', 'dashboard-quick-actions-empty');
  const footer = el('footer', undefined, 'dashboard-widget-footer');
  const summary = el('span', '离页停止后续步骤');
  const details = el('button', '详情', 'ghost dashboard-quick-actions-details'); details.type = 'button'; footer.append(summary, details);
  root.append(header, body, footer);
  function projectSlots() {
    const capacity = Math.max(0, Math.floor(((geometry?.h || 12) * 24 - 140 - 36 + 6) / 50));
    const actions = [...controls.actions.children];
    actions.forEach((node, index) => { const hidden = !inDetails && index >= capacity; if (node.hidden !== hidden) node.hidden = hidden; });
    const more = Math.max(0, actions.length - capacity);
    details.textContent = more ? `详情 · ${more}项操作` : '详情';
    details.setAttribute('aria-label', more ? `快捷操作详情，还有${more}项可执行操作` : '快捷操作详情');
    summary.textContent = auto ? auto.status.textContent : '离页停止后续步骤';
  }
  const paintDetails = () => {
    if (!active()) return;
    summary.textContent = auto ? auto.status.textContent : '离页停止后续步骤';
    if (!detailsContent?.isConnected) return;
    detailsContent.textContent = controls.status.textContent;
    detailsContent.classList.toggle('error', controls.status.classList.contains('settings-error'));
  };
  const observer = new MutationObserver(paintDetails);
  observer.observe(controls.root, { childList: true, subtree: true, characterData: true, attributes: true });
  function setButtons(next) {
    selected = normalizeQuickActionButtons(next);
    controls.setButtons(selected);
    if (selected.includes('auto_select')) {
      auto ||= createAutoSelectAction({ ownsPage: active, canAct, confirm });
      auto.root.dataset.quickAction = 'auto_select';
    } else { auto?.dispose(); auto = null; }
    const nodes = new Map([...controls.actions.children].map(node => [node.dataset.quickAction, node]));
    if (auto) nodes.set('auto_select', auto.root);
    controls.actions.replaceChildren(...QUICK_ACTIONS.flatMap(item => nodes.has(item.id) ? [nodes.get(item.id)] : []));
    if (!selected.length) controls.root.insertBefore(empty, controls.status); else empty.remove();
    projectSlots();
  }
  details.onclick = () => {
    if (!active()) return;
    const content = el('div', undefined, 'dashboard-quick-actions-details-content');
    content.append(el('p', '下列为此卡已选操作，可原地执行；自动选择是独立的设备持续授权，不会因选择或保存卡片配置而改变。维护操作分别确认固定范围，失败停止后续步骤，不启动离线项目。'));
    content.append(el('p', '离页、移除卡片或刷新页面停止后续维护步骤；已经发出的请求仍可能生效，不能撤销。'));
    inDetails = true; projectSlots(); placeholder.hidden = false;
    content.append(controls.root);
    const status = el('p', controls.status.textContent, 'dashboard-quick-actions-result'); detailsContent = status; content.append(status);
    const result = formDialog({ title: '快捷操作详情', content, confirmLabel: '关闭', cardClass: 'dashboard-quick-actions-modal' });
    const identity = document.getElementById('modal')?.firstElementChild; dialog = identity;
    paintDetails();
    void result.finally(() => {
      inDetails = false; placeholder.hidden = true;
      if (active()) { body.prepend(controls.root); projectSlots(); }
      if (dialog === identity) dialog = null;
      if (detailsContent === status) detailsContent = null;
    });
  };
  root.dashboardGeometryChange = next => { geometry = next; projectSlots(); };
  function dispose() {
    if (disposed) return; disposed = true; controls.dispose(); auto?.dispose(); observer.disconnect();
    globalThis.removeEventListener?.('pagehide', dispose);
    if (dialog && document.getElementById('modal')?.firstElementChild === dialog) closeDialog();
    dialog = null; detailsContent = null;
  }
  globalThis.addEventListener?.('pagehide', dispose);
  setButtons(buttons);
  return { root, ready: controls.ready, updateProjects: controls.updateProjects, setButtons,
    setGeometry: root.dashboardGeometryChange,
    sync() { controls.sync(); auto?.sync(); projectSlots(); },
    dispose };
}
