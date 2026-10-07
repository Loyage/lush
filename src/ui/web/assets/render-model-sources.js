import { $, button, el } from './dom.js';
import { activateDetailView } from './sidebar-ui.js';
import { ui } from './state.js';
import { createAgentConnections } from './render-agent-connections.js';
import { createLegacyUsageHistory } from './render-agent-usage.js';

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
  // Retain this project's public drafts only in memory; panel teardown clears secrets.
  const reused = Boolean(ui.modelSourcesPage?.connections);
  const state = ui.modelSourcesPage || { view, pending: null, connections: null };
  if (reused) state.connections.dispose();
  state.view = view; ui.modelSourcesPage = state;
  const ownsPage = () => ui.view === state.view && ui.modelSourcesPage === state;
  if (!state.connections) state.connections = createAgentConnections({ ownsPage, connectionId: id });
  else { state.connections.resume(); if (id) state.connections.selectConnection(id); }
  // A fresh archive owner per view prevents responses from a previous visit being adopted.
  const archive = el('section', undefined, 'model-sources-legacy-history');
  const historyHost = el('div', undefined, 'legacy-usage-history'); historyHost.id = 'legacy-usage-history'; historyHost.hidden = true;
  const history = createLegacyUsageHistory({ ownsPage: () => ui.view === view && ui.modelSourcesPage === state && !historyHost.hidden });
  const toggle = button('查看旧余额历史存档', () => {
    if (ui.view !== view || ui.modelSourcesPage !== state) return Promise.resolve();
    historyHost.hidden = !historyHost.hidden;
    toggle.setAttribute('aria-expanded', String(!historyHost.hidden));
    toggle.textContent = historyHost.hidden ? '查看旧余额历史存档' : '收起旧余额历史存档';
    if (historyHost.hidden) { history.invalidate(); return Promise.resolve(); }
    return history.loadHistory();
  }, 'ghost', { help: '按需读取项目本地的旧余额历史，只读存档不归到任何连接；不联网、不读取旧凭证、不调用 Agent，也不编辑旧查询设置。' });
  toggle.setAttribute('aria-expanded', 'false'); toggle.setAttribute('aria-controls', historyHost.id);
  historyHost.append(history.node); archive.append(toggle, historyHost);
  page.append(head, state.connections.node, archive); $('detail').replaceChildren(page);
  const pending = state.connections.load(reused).finally(() => { if (state.pending === pending) state.pending = null; });
  state.pending = pending;
  return pending;
}
