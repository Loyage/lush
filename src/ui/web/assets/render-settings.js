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
  const nav = el('div', undefined, 'settings-tabs'); nav.setAttribute('role', 'tablist'); nav.setAttribute('aria-label', '设备设置');
  for (const tab of TABS) {
    const node = el('button', undefined, `settings-tab${activeTab === tab.id ? ' active' : ''}`); node.type = 'button'; node.dataset.settingsTab = tab.id;
    node.id = `settings-tab-${tab.id}`; node.tabIndex = activeTab === tab.id ? 0 : -1;
    node.setAttribute('role', 'tab'); node.setAttribute('aria-selected', String(activeTab === tab.id));
    node.setAttribute('aria-controls', 'settings-active-panel');
    node.append(el('strong', tab.label), el('span', tab.note));
    node.onclick = () => { activeTab = tab.id; const pending = renderSettings(); $(`settings-tab-${tab.id}`)?.focus(); return pending; };
    node.onkeydown = event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const index = TABS.findIndex(item => item.id === tab.id);
      activeTab = TABS[event.key === 'Home' ? 0 : event.key === 'End' ? TABS.length - 1
        : (index + (event.key === 'ArrowRight' ? 1 : -1) + TABS.length) % TABS.length].id;
      renderSettings(); $(`settings-tab-${activeTab}`)?.focus();
    };
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
  const intro = el('div'); intro.append(el('h1', '设备设置'));
  head.append(intro); view.append(head, tabBar());
  const content = activeTab === 'interface' ? interfaceSettings.render() : systemSettings.render();
  content.id = 'settings-active-panel'; content.setAttribute('role', 'tabpanel');
  content.setAttribute('aria-labelledby', `settings-tab-${activeTab}`); content.tabIndex = 0;
  view.append(content);
  if (activeTab === 'interface') pageBlocks(view.querySelector('.settings-tab-panel'), 'settings-interface', 'fold');
  replacePageContent(panel, view);
  return activeTab === 'system' ? systemSettings.pending : undefined;
}
