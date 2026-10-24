/** Agent settings subpanel composition; each editor owns its own state and cache. */
import { block, el } from './dom.js';
import { pageBlocks, pageModules, replacePageContent } from './page-modules.js';
import { settingsClientFor } from './settings-api.js';
import { scopeLabel } from './settings-scope.js';
import { profileEditor, inheritedRole } from './settings-profile.js';
import { environmentEditor } from './settings-environment.js';
import { packagesManager } from './settings-packages.js';
import { settingsReceipt } from './settings-controls.js';
/** Shared subpanel: its owner supplies configuration and an identity-guarded repaint callback. */
export function renderAgentSettings(settings, repaint, { ownsPage = () => true, connections = null } = {}) {
  const names = new Map();
  const rows = Array.isArray(connections) ? connections : (Array.isArray(connections?.connections) ? connections.connections : []);
  for (const row of rows) {
    if (typeof row?.id === 'string' && typeof row?.label === 'string' && row.label.trim()) names.set(row.id, row.label.trim());
  }
  const content = el('div', undefined, 'settings-tab-panel agent-settings');
  if (!settings) {
    const waiting = block('Agent 配置');
    waiting.append(el('p', '正在等待 daemon 快照。连接建立后可配置 Pi、Codex、模型、思考深度与各 Worker 角色的追加 Prompt。', 'settings-placeholder'));
    content.append(waiting); return content;
  }
  const intro = el('details', undefined, 'agent-config-advanced');
  intro.append(el('summary', `${scopeLabel()}与配置模式说明`), el('p', `Lush 配置使用托管来源、模型、Prompt 与资源，不继承用户全局 Pi 设置；Pi 默认配置使用执行机器上的 Pi 目录。配置文件：${settings.file}。项目 AGENTS 与显式资源保留；保存仅影响后续调用。`, 'settings-note'));
  const summary = el('p', undefined, 'agent-default-summary'); summary.setAttribute('role', 'status');
  content.append(summary, settingsReceipt(ownsPage));
  const client = settingsClientFor(settings);
  content.append(profileEditor(settings, settings.default, 'default', '默认 Agent', '未设置独立覆盖的 Worker 继承此配置。', repaint, ownsPage, summary, names));

  const roles = block('按工作类型与行为覆盖'); roles.classList.add('agent-roles-block');
  roles.append(el('p', '只为需要不同模型、思考深度或工作方式的行为建立覆盖；其余保持继承，后续调整默认值时会一起更新。', 'settings-note settings-section-note'));
  const list = el('div', undefined, 'agent-role-list');
  for (const item of settings.options.roles.filter(item => ['agent', 'manager'].includes(item.id))) {
    if (settings.roles[item.id]) list.append(profileEditor(settings, settings.roles[item.id], item.id, item.id === 'manager' ? 'Valet' : item.label, `仅用于 ${item.id === 'manager' ? 'Valet 管理工作' : item.id + ' 角色'}。`, repaint, ownsPage, null, names));
    else list.append(inheritedRole(settings, item.id, repaint, names, ownsPage));
  }
  const advanced = el('details', undefined, 'agent-config-advanced'), environmentHost = el('div', undefined, 'agent-env-host');
  const repaintEnvironment = () => { if (ownsPage()) {
    replacePageContent(environmentHost, environmentEditor(settings, repaintEnvironment, ownsPage));
    pageBlocks(environmentHost, 'agent-environment', 'fold');
  } };
  environmentHost.resume = repaintEnvironment; repaintEnvironment();
  advanced.append(el('summary', '高级配置：Agent 环境变量'), environmentHost);
  roles.append(list); content.append(roles, packagesManager(ownsPage, client), advanced, intro);
  pageModules(content, { scope: 'agent-settings', entries: [
    ...[...content.children].filter(section => section.classList.contains('block')).map(section => ({ section, key: section.querySelector('h2').textContent, mode: 'fold' })),
    { section: content.querySelector('.agent-profile'), key: 'default-profile', mode: 'fold' },
  ] });
  return content;
}
