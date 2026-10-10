import { $, el } from './dom.js';
import { activateDetailView } from './sidebar-ui.js';
import { ui } from './state.js';
import { createAgentConnections } from './render-agent-connections.js';
import { settingsClient } from './settings-api.js';
import { scopeImpact } from './settings-scope.js';

/** Global source management never reads an opened project's consumers or histories. */
export function openModelSources({ connectionId = '' } = {}) {
  const id = typeof connectionId === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(connectionId) ? connectionId : '';
  const client = settingsClient();
  const view = activateDetailView({ view: 'model-sources', title: '模型来源', context: '设备设置',
    hint: '设备统一 API、订阅登录、模型范围与余额额度', hash: id ? `#model-source-${id}` : '#model-sources' });
  if (ui.modelSourcesPage?.view === view) {
    if (id) ui.modelSourcesPage.connections?.selectConnection(id);
    return ui.modelSourcesPage.pending || Promise.resolve();
  }
  const previous = ui.modelSourcesPage;
  previous?.connections?.dispose();
  for (const pane of previous?.panes?.values() || []) pane.connections.dispose();
  const reused = previous?.contextKey === client.key && previous.connections;
  const state = reused ? previous : { contextKey: client.key, scope: 'device', connections: null, pending: null };
  state.view = view; state.pending = null; ui.modelSourcesPage = state;
  const ownsPage = () => ui.view === state.view && ui.modelSourcesPage === state;
  const page = el('div', undefined, 'model-sources-page'), head = el('header', undefined, 'model-sources-head');
  head.append(el('h1', '模型来源'), el('p', `${scopeImpact()} 选择来源只查看详情，不改默认模型，不自动换付费账号。`, 'hint'));
  if (reused) state.connections.resume();
  else state.connections = createAgentConnections({ ownsPage, connectionId: id, client });
  if (id) state.connections.selectConnection(id);
  page.append(head, state.connections.node,
    el('p', '此页只管理设备连接及最新额度缓存；项目历史、后台采样记录和实际消费者仍在来源项目保存，不汇总成设备历史。', 'hint'));
  $('detail').replaceChildren(page);
  const pending = state.connections.load(Boolean(reused)).finally(() => { if (state.pending === pending) state.pending = null; });
  state.pending = pending; return pending;
}
