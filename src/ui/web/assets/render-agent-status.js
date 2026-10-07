import { $, block, button, el, kv } from './dom.js';
import { activateDetailView } from './sidebar-ui.js';
import { ui } from './state.js';
import { renderAgentSettings } from './render-settings.js';
import { settingsClient } from './settings-api.js';
import { scopeSelector, scopeSummary, clearOverrideButton } from './settings-scope.js';

const REFRESH_HELP = '只检查执行机器上 Pi / Codex 软件的命令、安装路径、版本与可用性；不联网、不读取账号或凭证、不启动 Agent 或模型调用。';
const list = value => Array.isArray(value) ? value : [];
const text = (value, fallback = '未知') => typeof value === 'string' && value ? value : fallback;
const COMPATIBILITY_ERROR = '软件诊断数据格式不兼容，请更新项目后台与界面服务。';
function note(parent, value, warning = false) { if (value) parent.append(el('p', String(value), warning ? 'agent-status-warning' : 'hint')); }
function softwareSection(software) {
  const section = block(`${software.agent === 'pi' ? 'Pi' : 'Codex'} 软件`), grid = el('div', undefined, 'grid');
  for (const [label, value] of [['命令', software.command], ['可执行文件', software.executable], ['实际安装路径', software.real_path],
    ['版本', software.version], ['可用性', software.status === 'available' ? '可用' : '不可用']]) grid.append(kv(label, text(value)));
  section.append(grid); note(section, software.warning, true); return section;
}
function compatible(data) {
  return data?.version === 2 && Array.isArray(data.software) && data.software.length === 2
    && ['pi', 'codex'].every(agent => data.software.filter(item => item?.agent === agent && ['available', 'unavailable'].includes(item.status)).length === 1);
}
export function renderAgentStatus(data) {
  const root = el('div', undefined, 'agent-status-results');
  if (!compatible(data)) { note(root, COMPATIBILITY_ERROR, true); return root; }
  note(root, `检查时间：${text(data.checked_at)}`);
  if (data.scope?.project) note(root, `执行项目：${data.scope.project}`);
  note(root, data.scope?.note || '来自运行 Lush 的机器的软件安装检查，不是浏览器本机或运行中调用的快照。');
  note(root, '安装路径可能是全局目录；软件可用不代表账号已认证或模型可调用。');
  for (const warning of list(data.warnings)) note(root, warning, true);
  for (const agent of ['pi', 'codex']) root.append(softwareSection(data.software.find(item => item.agent === agent)));
  return root;
}

/** Scope panes retain their own DOM drafts; inactive/old responses never repaint the current pane. */
export function openAgentStatus() {
  const view = activateDetailView({ view: 'agent-status' });
  if (ui.agentStatusPage?.view === view) return ui.agentStatusPage.pending || Promise.resolve();
  const state = { view, scope: 'device', panes: new Map(), tab: 'settings', pending: null };
  ui.agentStatusPage = state;
  const ownsPage = () => ui.view === view && ui.agentStatusPage === state;
  const page = el('div', undefined, 'agent-status-page'), header = el('header', undefined, 'agent-status-head');
  const copy = el('div'); copy.append(el('h1', 'Agent 配置'), el('p', '决定 Agent 如何工作、默认使用哪个模型来源。保存只影响后续调用，不改变正在运行的调用。账号、API、登录、额度和旧余额历史存档请到“模型来源”；软件诊断仅在显式点击后检查。', 'hint'));
  const link = el('a', '管理模型来源', 'agent-sources-link'); link.href = '#model-sources'; copy.append(link); header.append(copy);
  const host = el('div'), tabs = el('div', undefined, 'settings-tabs'), tabButtons = new Map();
  tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', 'Agent 配置');
  function paneFor(scope) {
    if (state.panes.has(scope)) return state.panes.get(scope);
    const client = settingsClient(scope), active = () => ownsPage() && state.scope === scope && client.isCurrent();
    const settings = el('div', undefined, 'agent-management-settings'); settings.id = 'agent-management-settings';
    const status = el('div', undefined, 'agent-management-status'); status.id = 'agent-management-status';
    const scopeInfo = el('div'), feedback = el('p', undefined, 'hint agent-status-feedback'), result = el('div');
    feedback.setAttribute('role', 'status');
    const pane = { client, active, settings, status, config: null, configPending: null, pending: null, data: null, rendered: false };
    const repaint = config => {
      if (!active()) return;
      if (config) pane.config = { ...config, configuration_scope: { ...config.configuration_scope, selected: scope } };
      scopeInfo.replaceChildren(scopeSummary(pane.config, scope));
      if (scope === 'project') scopeInfo.append(clearOverrideButton('agent', () => { pane.config = null; pane.rendered = false; return loadConfig(); }, { ownsPage: active, onCleared: () => { pane.config = null; pane.rendered = false; } }));
      settings.replaceChildren(scopeInfo, renderAgentSettings(pane.config, repaint, { ownsPage: active, connections: pane.connections }));
      pane.rendered = true;
    };
    function loadConfig() {
      if (!active()) return Promise.resolve();
      if (pane.rendered) return Promise.resolve();
      if (pane.configPending) return pane.configPending;
      settings.replaceChildren(el('p', '正在读取 Agent 配置…', 'hint')); settings.setAttribute('aria-busy', 'true');
      const pending = (async () => {
        try {
          const [config, sources] = await Promise.all([client.read('/api/agent/config'), client.read('/api/agent/connections').catch(() => null)]);
          if (!active()) return;
          pane.connections = sources?.connections || null; repaint(config);
        } catch (error) {
          if (active()) settings.replaceChildren(el('p', `读取 Agent 配置失败：${error.message}`, 'settings-error'), button('重新读取配置', loadConfig, 'ghost'));
        } finally { pane.configPending = null; if (active()) settings.setAttribute('aria-busy', 'false'); }
      })(); pane.configPending = pending; return pending;
    }
    async function loadStatus() {
      if (!active()) return;
      if (pane.pending) return pane.pending;
      refresh.disabled = true; feedback.textContent = '正在检查 Pi / Codex 软件…'; status.setAttribute('aria-busy', 'true');
      const pending = (async () => {
        try {
          const data = await client.read('/api/agent/status'); if (!active()) return;
          if (!compatible(data)) throw new Error(COMPATIBILITY_ERROR);
          pane.data = data; result.replaceChildren(renderAgentStatus(data)); feedback.textContent = '检查完成，结果已缓存；页面信息不会自动刷新。';
        } catch (error) {
          if (active()) { feedback.textContent = `检查失败：${error.message}${pane.data ? '。以下保留上次检查结果，并非最新状态。' : ''}`; feedback.setAttribute('role', 'alert'); }
        } finally { pane.pending = null; if (active()) { refresh.disabled = false; refresh.textContent = pane.data ? '刷新软件检查' : '重新检查'; status.setAttribute('aria-busy', 'false'); } }
      })(); pane.pending = pending; return pending;
    }
    const refreshHost = el('span', undefined, 'help-host'); refreshHost.setAttribute('data-help', REFRESH_HELP);
    const refresh = button('刷新软件检查', loadStatus, 'agent-status-refresh', { help: REFRESH_HELP }); refreshHost.append(refresh);
    status.append(el('p', '软件诊断：只检查执行机器上安装的 Pi / Codex 命令、路径、版本与可用性，不联网、不读取账号或凭证，也不是 Lush 工作配置或当前 Worker 调用快照。诊断失败不影响配置编辑。', 'hint'), refreshHost, feedback, result);
    pane.loadConfig = loadConfig; pane.loadStatus = loadStatus; pane.refreshHost = refreshHost;
    state.panes.set(scope, pane); return pane;
  }
  function selectTab(id) {
    if (!ownsPage()) return Promise.resolve(); state.tab = id;
    for (const [key, node] of tabButtons) { node.classList.toggle('active', key === id); node.setAttribute('aria-selected', String(key === id)); }
    const pane = paneFor(state.scope); pane.settings.hidden = id !== 'settings'; pane.status.hidden = id !== 'status'; pane.refreshHost.hidden = id !== 'status';
    const pending = id === 'settings' ? pane.loadConfig() : pane.data ? Promise.resolve() : pane.loadStatus();
    state.pending = pending; return pending;
  }
  function changeScope(scope) {
    if (!ownsPage()) return Promise.resolve(); state.scope = scope;
    const pane = paneFor(scope); host.replaceChildren(pane.settings, pane.status);
    for (const env of pane.settings.querySelectorAll('.agent-env-host')) env.resume?.();
    return selectTab(state.tab);
  }
  for (const [id, label, detail] of [['settings', '模型与工作方式', '共享默认、Prompt 与资源'], ['status', '高级与诊断', '显式检查 Pi / Codex 软件']]) {
    const node = button('', () => selectTab(id), 'settings-tab', id === 'status' ? { help: REFRESH_HELP } : {});
    node.dataset.agentTab = id; node.setAttribute('role', 'tab'); node.append(el('strong', label), el('span', detail)); tabButtons.set(id, node); tabs.append(node);
  }
  page.append(header, scopeSelector(state.scope, changeScope), tabs, host); $('detail').replaceChildren(page);
  return changeScope('device');
}
