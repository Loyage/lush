import { el } from './dom.js';
import { formDialog, confirmDialog, closeDialog } from './dialog.js';
import { serviceRestartControls } from './service-restart.js';

export const QUICK_ACTIONS_ID = 'widget:quick-actions';

/** One retained foreground controller per visible card, not per render or geometry. */
export function createQuickActionsCard({ ownsPage, canAct, ...options }) {
  const root = el('li', undefined, 'project-item dashboard-widget dashboard-quick-actions-card');
  root.dataset.cardId = QUICK_ACTIONS_ID;
  root.dataset.cardType = root.dataset.widgetType = 'quick_actions';
  let disposed = false, dialog = null, detailsContent = null;
  const active = () => !disposed && ownsPage();
  const confirm = async settings => {
    if (!active()) return false;
    const result = confirmDialog(settings);
    const identity = document.getElementById('modal')?.firstElementChild;
    dialog = identity;
    try { return await result; }
    finally { if (dialog === identity) dialog = null; }
  };
  const controls = serviceRestartControls({ ...options, mode: 'quick_actions', ownsPage: active, canAct, confirm });
  const header = el('header', undefined, 'dashboard-widget-header');
  header.append(el('strong', '快捷操作', 'dashboard-widget-title'));
  const body = el('div', undefined, 'dashboard-widget-body'); body.append(controls.root);
  const footer = el('footer', undefined, 'dashboard-widget-footer');
  footer.append(el('span', '离页停止后续步骤'));
  const details = el('button', '详情', 'ghost dashboard-quick-actions-details'); details.type = 'button';
  const paintDetails = () => {
    if (!active() || !detailsContent?.isConnected) return;
    detailsContent.textContent = controls.status.textContent;
    detailsContent.classList.toggle('error', controls.status.classList.contains('settings-error'));
  };
  const observer = new MutationObserver(paintDetails);
  observer.observe(controls.status, { childList: true, subtree: true, characterData: true, attributes: true });
  details.onclick = () => {
    if (!active()) return;
    const content = el('div', undefined, 'dashboard-quick-actions-details-content');
    content.append(el('p', '一次确认后自动中断、等待安全退出、重启后台、继续本次新暂停的项目，最后重启界面。保留原维护暂停，不启动离线项目，失败即停止；等待最多 15 分钟。'));
    content.append(el('p', '离页、移除卡片或刷新页面停止后续步骤；已经发出的请求仍可能生效，不能撤销。请按下列结果核对来源状态，必要时在项目管理使用手动维护。'));
    const status = el('p', controls.status.textContent, 'dashboard-quick-actions-result');
    detailsContent = status; content.append(status);
    const result = formDialog({ title: '快捷操作详情', content, confirmLabel: '关闭', cardClass: 'dashboard-quick-actions-modal' });
    const identity = document.getElementById('modal')?.firstElementChild; dialog = identity;
    paintDetails();
    void result.finally(() => { if (dialog === identity) { dialog = null; detailsContent = null; } });
  };
  footer.append(details); root.append(header, body, footer);
  return { root, ready: controls.ready, updateProjects: controls.updateProjects, sync: controls.sync,
    dispose() {
      if (disposed) return;
      disposed = true; controls.dispose(); observer.disconnect();
      if (dialog && document.getElementById('modal')?.firstElementChild === dialog) closeDialog();
      dialog = null; detailsContent = null;
    } };
}
