import { $, el } from './dom.js';
import { activateDetailView } from './sidebar-ui.js';
import { ui } from './state.js';
import { createAgentConnections } from './render-agent-connections.js';

/** Project-local source management; only local configuration/cache is read on entry. */
export function openModelSources({ connectionId = '' } = {}) {
  const id = typeof connectionId === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(connectionId) ? connectionId : '';
  const view = activateDetailView({ view: 'model-sources', title: '模型来源', context: '其他',
    hint: 'API、订阅登录、模型范围与余额额度', hash: id ? `#model-source-${id}` : '#model-sources' });
  if (ui.modelSourcesPage?.view === view) {
    if (id) ui.modelSourcesPage.connections.selectConnection(id);
    return ui.modelSourcesPage.pending || Promise.resolve();
  }
  const page = el('div', undefined, 'model-sources-page');
  const head = el('header', undefined, 'model-sources-head');
  head.append(el('h1', '模型来源'), el('p', '管理当前项目的 API 与订阅账号。选择来源只查看详情，不改变项目默认；到 Agent 配置或 Worker 运行设置中选择来源与模型。', 'hint'));
  const state = { view, pending: null, connections: null };
  ui.modelSourcesPage = state;
  const ownsPage = () => ui.view === view && ui.modelSourcesPage === state;
  state.connections = createAgentConnections({ ownsPage, connectionId: id });
  page.append(head, state.connections.node); $('detail').replaceChildren(page);
  state.pending = state.connections.load().finally(() => { state.pending = null; });
  return state.pending;
}
