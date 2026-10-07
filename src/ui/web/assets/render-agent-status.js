import { $, block, button, el, kv } from './dom.js';
import { api } from './api.js';
import { activateDetailView } from './sidebar-ui.js';
import { ui } from './state.js';
import { renderAgentSettings } from './render-settings.js';

const REFRESH_HELP = '只检查项目执行机器上 Pi / Codex 软件的命令、安装路径、版本与可用性；不联网、不读取账号或凭证、不启动 Agent 或模型调用。';
const list = value => Array.isArray(value) ? value : [];
const text = (value, fallback = '未知') => typeof value === 'string' && value ? value : fallback;
const COMPATIBILITY_ERROR = '软件诊断数据格式不兼容，请更新项目后台与界面服务。';

function note(parent, value, warning = false) {
  if (value) parent.append(el('p', String(value), warning ? 'agent-status-warning' : 'hint'));
}

function softwareSection(software) {
  const section = block(`${software.agent === 'pi' ? 'Pi' : 'Codex'} 软件`);
  const grid = el('div', undefined, 'grid');
  for (const [label, value] of [
    ['命令', software.command], ['可执行文件', software.executable], ['实际安装路径', software.real_path],
    ['版本', software.version], ['可用性', software.status === 'available' ? '可用' : '不可用'],
  ]) grid.append(kv(label, text(value)));
  section.append(grid);
  note(section, software.warning, true);
  return section;
}

function compatible(data) {
  return data?.version === 2 && Array.isArray(data.software) && data.software.length === 2
    && ['pi', 'codex'].every(agent => data.software.filter(item => item?.agent === agent && ['available', 'unavailable'].includes(item.status)).length === 1);
}

/** Software facts only, rendered as text; never display legacy account diagnostics. */
export function renderAgentStatus(data) {
  const root = el('div', undefined, 'agent-status-results');
  if (!compatible(data)) { note(root, COMPATIBILITY_ERROR, true); return root; }
  note(root, `检查时间：${text(data.checked_at)}`);
  note(root, `执行项目：${text(data.scope?.project)}`);
  note(root, data.scope?.note || '来自项目执行机器的软件安装检查，不是浏览器本机、Pi 配置目录或某个运行中调用的快照。');
  note(root, '安装路径可能是全局目录；软件可用不代表账号已认证或模型可调用。');
  for (const warning of list(data.warnings)) note(root, warning, true);
  for (const agent of ['pi', 'codex']) root.append(softwareSection(data.software.find(item => item.agent === agent)));
  return root;
}

/** Configuration on entry; software is checked only on explicit diagnosis/refresh. */
export function openAgentStatus() {
  const view = activateDetailView({ view: 'agent-status' });
  if (ui.agentStatusPage?.view === view) return ui.agentStatusPage.configPending || ui.agentStatusPage.pending || Promise.resolve();
  const page = el('div', undefined, 'agent-status-page');
  const header = el('header', undefined, 'agent-status-head'), copy = el('div');
  copy.append(el('h1', 'Agent 配置'), el('p', '决定 Agent 如何工作、默认使用哪个模型来源。保存只影响后续调用，不改变正在运行的调用。账号、API、登录、额度和旧余额历史存档请到“模型来源”；软件诊断仅在显式点击后检查。', 'hint'));
  const sourcesLink = el('a', '管理模型来源', 'agent-sources-link'); sourcesLink.href = '#model-sources'; copy.append(sourcesLink);
  const feedback = el('p', undefined, 'hint agent-status-feedback'); feedback.setAttribute('role', 'status');
  const result = el('div');
  const state = { view, pending: null, data: null, tab: 'settings', config: ui.lastSnapshot?.status?.agent_config, configPending: null, connections: undefined }; ui.agentStatusPage = state;
  const ownsPage = () => ui.view === view && ui.agentStatusPage === state;
  const statusPanel = el('div', undefined, 'agent-management-status'); statusPanel.id = 'agent-management-status';
  const settingsPanel = el('div', undefined, 'agent-management-settings'); settingsPanel.id = 'agent-management-settings';
  for (const [panel, tab] of [[statusPanel, 'status'], [settingsPanel, 'settings']]) {
    panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', `agent-management-tab-${tab}`);
  }
  const loadConnections = () => {
    if (state.connections !== undefined) return Promise.resolve(state.connections);
    return api('/api/agent/connections').then(value => { state.connections = Array.isArray(value?.connections) ? value.connections : null; return state.connections; })
      .catch(() => { state.connections = null; return null; });
  };
  const repaintSettings = config => {
    if (!ownsPage()) return;
    if (config) state.config = config;
    settingsPanel.replaceChildren(renderAgentSettings(state.config, repaintSettings, { ownsPage, connections: state.connections }));
  };
  const loadConfig = () => {
    if (!ownsPage()) return Promise.resolve();
    if (state.configPending) return state.configPending;
    if (state.config) {
      if (state.connections !== undefined) { repaintSettings(); return Promise.resolve(); }
      // Read source names before first paint, so late metadata cannot erase configuration drafts.
      state.configPending = loadConnections().then(() => { if (ownsPage()) repaintSettings(); }).finally(() => { state.configPending = null; });
      return state.configPending;
    }
    settingsPanel.replaceChildren(el('p', '正在读取 Agent 配置…', 'hint'));
    settingsPanel.setAttribute('aria-busy', 'true');
    state.configPending = (async () => {
      try {
        const [config] = await Promise.all([api('/api/agent/config'), loadConnections()]);
        if (!ownsPage()) return;
        if (ui.lastSnapshot?.status) ui.lastSnapshot.status.agent_config = config;
        repaintSettings(config);
      } catch (error) {
        if (!ownsPage()) return;
        const message = el('p', `读取 Agent 配置失败：${error.message}`, 'settings-error'); message.setAttribute('role', 'alert');
        settingsPanel.replaceChildren(message, button('重新读取配置', loadConfig, 'ghost'));
      } finally {
        state.configPending = null;
        if (ownsPage()) settingsPanel.setAttribute('aria-busy', 'false');
      }
    })();
    return state.configPending;
  };
  const tabs = el('div', undefined, 'settings-tabs'); tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', 'Agent 配置');
  const tabButtons = new Map();
  const selectTab = id => {
    if (!ownsPage()) return Promise.resolve();
    state.tab = id;
    for (const [key, node] of tabButtons) {
      node.classList.toggle('active', key === id); node.setAttribute('aria-selected', String(key === id));
    }
    statusPanel.hidden = id !== 'status'; settingsPanel.hidden = id !== 'settings'; refreshHost.hidden = id !== 'status';
    if (id === 'status' && !state.data && !state.diagnosisLoaded) { state.diagnosisLoaded = true; return load(); }
    if (id === 'settings' && !settingsPanel.childNodes.length) return loadConfig();
    return Promise.resolve();
  };
  for (const [id, label, detail] of [['settings', '模型与工作方式', '项目默认、Prompt 与资源'], ['status', '高级与诊断', '显式检查 Pi / Codex 软件']]) {
    const node = button('', () => selectTab(id), 'settings-tab', id === 'status' ? { help: REFRESH_HELP } : {}); node.dataset.agentTab = id; node.id = `agent-management-tab-${id}`;
    node.setAttribute('role', 'tab'); node.setAttribute('aria-controls', `agent-management-${id}`);
    node.append(el('strong', label), el('span', detail)); tabButtons.set(id, node); tabs.append(node);
  }
  const load = () => {
    if (!ownsPage()) return Promise.resolve();
    if (state.pending) return state.pending;
    refresh.disabled = true; refresh.textContent = '正在检查…'; feedback.textContent = '正在检查 Pi / Codex 软件…';
    feedback.className = 'hint agent-status-feedback'; feedback.setAttribute('role', 'status'); statusPanel.setAttribute('aria-busy', 'true');
    state.pending = (async () => {
      try {
        const data = await api('/api/agent/status');
        if (!ownsPage()) return;
        if (!compatible(data)) throw new Error(COMPATIBILITY_ERROR);
        state.data = data; result.replaceChildren(renderAgentStatus(data)); feedback.textContent = '检查完成，结果已缓存；页面信息不会自动刷新。';
      } catch (error) {
        if (!ownsPage()) return;
        feedback.textContent = `检查失败：${error.message}${state.data ? '。以下保留上次检查结果，并非最新状态。' : ''}`;
        feedback.className = 'agent-status-warning agent-status-feedback'; feedback.setAttribute('role', 'alert');
      } finally {
        state.pending = null;
        if (ownsPage()) { refresh.disabled = false; refresh.textContent = state.data ? '刷新软件检查' : '重新检查'; statusPanel.setAttribute('aria-busy', 'false'); }
      }
    })();
    return state.pending;
  };
  const refreshHost = el('span', undefined, 'help-host'); refreshHost.setAttribute('data-help', REFRESH_HELP);
  const refresh = button('刷新软件检查', load, 'agent-status-refresh', { help: REFRESH_HELP });
  refreshHost.append(refresh); header.append(copy, refreshHost); statusPanel.append(feedback, result);
  statusPanel.prepend(el('p', '软件诊断：只检查项目执行机器上安装的 Pi / Codex 命令、路径、版本与可用性，不联网、不读取账号或凭证，也不是 Lush 工作配置或当前 Worker 调用快照。诊断失败不影响配置编辑。', 'hint'));
  page.append(header, tabs, settingsPanel, statusPanel); $('detail').replaceChildren(page);
  return selectTab('settings');
}
