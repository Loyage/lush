import { $, button, el } from './dom.js';
import { activateDetailView } from './sidebar-ui.js';
import { ui } from './state.js';
import { createAgentConnections } from './render-agent-connections.js';
import { createLegacyUsageHistory } from './render-agent-usage.js';
import { settingsClient } from './settings-api.js';
import { scopeSelector, scopeImpact } from './settings-scope.js';
import { workbenchStatus } from './project-picker.js';

/** Shared credentials, but histories and current consumers remain attached to the opened project. */
export function openModelSources({ connectionId = '' } = {}) {
  const id = typeof connectionId === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(connectionId) ? connectionId : '';
  const contextKey = settingsClient('device').key;
  const view = activateDetailView({ view: 'model-sources', title: '模型来源', context: '其他',
    hint: '设备共享 API、订阅登录、模型范围与余额额度', hash: id ? `#model-source-${id}` : '#model-sources' });
  if (ui.modelSourcesPage?.view === view && ui.modelSourcesPage.contextKey === contextKey) {
    if (id) ui.modelSourcesPage.connections?.selectConnection(id);
    return ui.modelSourcesPage.pending || Promise.resolve();
  }
  const previous = ui.modelSourcesPage;
  for (const pane of previous?.panes?.values() || []) pane.connections.dispose();
  const state = previous?.contextKey === contextKey ? previous : { view, contextKey, pending: null, panes: new Map(), connections: null };
  state.view = view; state.scope = 'device'; ui.modelSourcesPage = state;
  const ownsPage = () => ui.view === state.view && ui.modelSourcesPage === state;
  const page = el('div', undefined, 'model-sources-page'), head = el('header', undefined, 'model-sources-head'), host = el('div');
  head.append(el('h1', '模型来源'), el('p', '默认管理设备共享账号与 API。项目视图保留旧来源及其存储范围；选择来源只查看详情，不改默认模型，不自动换付费账号。历史与实际消费者只属于当前项目。', 'hint'));
  function changeScope(scope) {
    if (!ownsPage()) return Promise.resolve();
    state.connections?.dispose(); state.scope = scope;
    let pane = state.panes.get(scope), reused = Boolean(pane);
    if (!pane) {
      const client = settingsClient(scope), active = () => ownsPage() && state.scope === scope && client.isCurrent();
      pane = { connections: createAgentConnections({ ownsPage: active, connectionId: id, client,
        onProjectSampling: () => active() ? state.openProjectSampling() : undefined }) }; state.panes.set(scope, pane);
    } else pane.connections.resume();
    state.connections = pane.connections;
    if (id) pane.connections.selectConnection(id);
    host.replaceChildren(pane.connections.node);
    const pending = pane.connections.load(reused).finally(() => { if (state.pending === pending) state.pending = null; });
    state.pending = pending; return pending;
  }
  const scopeControl = scopeSelector(state.scope, changeScope, { projectLabel: '本项目来源',
    impact: scope => scope === 'project' ? '显示本项目有效来源，包括共享来源与项目独立来源；连接操作按其标注的实际存储位置生效。' : scopeImpact(scope),
    help: '选择设备共享来源或本项目有效来源视图；来源身份由后台范围标识确定，不按名称合并账号，不调用 Agent。' });
  // Reused panes must call the current page's scope control/host, not a detached old page.
  state.openProjectSampling = async () => {
    if (!ownsPage()) return;
    const control = scopeControl.querySelector('select'); control.value = 'project';
    await control.onchange();
    if (ownsPage() && state.scope === 'project') state.connections.openSampling();
  };
  page.append(head, scopeControl, host);
  if (workbenchStatus().projectUsable) {
    const archive = el('section', undefined, 'model-sources-legacy-history'), historyHost = el('div', undefined, 'legacy-usage-history');
    historyHost.id = 'legacy-usage-history'; historyHost.hidden = true;
    const history = createLegacyUsageHistory({ ownsPage: () => ui.view === view && ui.modelSourcesPage === state && !historyHost.hidden });
    const toggle = button('查看旧余额历史存档', () => {
      if (ui.view !== view || ui.modelSourcesPage !== state) return Promise.resolve();
      historyHost.hidden = !historyHost.hidden; toggle.setAttribute('aria-expanded', String(!historyHost.hidden));
      toggle.textContent = historyHost.hidden ? '查看旧余额历史存档' : '收起旧余额历史存档';
      if (historyHost.hidden) { history.invalidate(); return Promise.resolve(); } return history.loadHistory();
    }, 'ghost', { help: '按需读取当前项目的旧余额历史，只读存档不归到任何连接、不合并其他项目；不联网、不读取旧凭证、不调用 Agent。' });
    toggle.setAttribute('aria-expanded', 'false'); historyHost.append(history.node);
    archive.append(el('p', '旧余额历史存档已停止接收新数据。现在刷新得到的余额、额度请查看上方“余额与额度趋势”；旧存档仅保留旧查询留下的记录。', 'hint'), toggle, historyHost); page.append(archive);
  } else page.append(el('p', '未打开项目；不显示项目历史、后台采样或实际消费者。共享连接管理无需启动项目后台。', 'hint'));
  $('detail').replaceChildren(page); return changeScope('device');
}
