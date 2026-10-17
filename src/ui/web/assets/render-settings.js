/** Device settings navigation; dedicated editors own their state and caches. */
import { $, el } from './dom.js';
import { pageBlocks, replacePageContent } from './page-modules.js';
import { ui } from './state.js';
import { createInterfaceSettings } from './settings-interface.js';
import { createSystemSettings } from './settings-system.js';

// Keep the existing Agent management entry point without a dependency back to this page.
export { renderAgentSettings } from './settings-agent.js';

const TABS = [
  { id: 'interface', label: '界面', note: '阅读、外观与行为' },
  { id: 'system', label: '系统', note: '运行参数与路径' },
];
let activeTab = 'interface';
const interfaceSettings = createInterfaceSettings({ renderSettings, isInterface: () => activeTab === 'interface' });
const systemSettings = createSystemSettings({ isActive: () => activeTab === 'system' });

export function openSettings(options = {}) {
  return interfaceSettings.open(options);
}

function tabBar() {
  const nav = el('div', undefined, 'settings-tabs'); nav.setAttribute('role', 'tablist');
  for (const tab of TABS) {
    const node = el('button', undefined, `settings-tab${activeTab === tab.id ? ' active' : ''}`); node.type = 'button'; node.dataset.settingsTab = tab.id;
    node.setAttribute('role', 'tab'); node.setAttribute('aria-selected', String(activeTab === tab.id));
    node.append(el('strong', tab.label), el('span', tab.note));
    node.onclick = () => { activeTab = tab.id; return renderSettings(); };
    nav.append(node);
  }
  return nav;
}

export function renderSettings() {
  if (!ui.settingsOpen) return; // 保存或读取配置的迟到回调不能抢回其他页面。
  if (activeTab !== 'system') ui.clearSettingsSecrets?.();
  const panel = $('detail'); panel.dataset.view = 'settings';
  const view = el('div', undefined, 'settings-view');
  const head = el('div', undefined, 'settings-head');
  const intro = el('div'); intro.append(el('span', 'SYSTEM SETTINGS', 'eyebrow'), el('h1', '设备设置'),
    el('p', '界面偏好与运行配置统一保存在执行机器的同一用户设备设置中，项目不再单独覆盖。项目辨识配色在工作台的项目管理页调整。Agent 配置、模型来源与快捷解释各有独立设备页面。', 'hint'));
  head.append(intro); view.append(head, tabBar());
  view.append(activeTab === 'interface' ? interfaceSettings.render() : systemSettings.render());
  if (activeTab === 'interface') pageBlocks(view.querySelector('.settings-tab-panel'), 'settings-interface', 'fold');
  replacePageContent(panel, view);
  return activeTab === 'system' ? systemSettings.pending : undefined;
}
