import { $, button, el } from './dom.js';
import { activateDetailView } from './sidebar-ui.js';
import { ui } from './state.js';
import { createAgentConnections } from './render-agent-connections.js';
import { createRegisteredModels } from './registered-models.js';
import { settingsClient } from './settings-api.js';
import { scopeImpact } from './settings-scope.js';

/** Models are the default; old source deep links still select the source tab and detail. */
export function openModelSources({ connectionId = '', tab = '' } = {}) {
  const id = typeof connectionId === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(connectionId) ? connectionId : '';
  const client = settingsClient();
  const view = activateDetailView({ view: 'model-sources', title: '模型和来源', context: '设备设置',
    hint: '先添加来源并登录，再注册命名模型', hash: id ? `#model-source-${id}` : tab === 'sources' ? '#model-sources-connections' : '#model-sources' });
  if (ui.modelSourcesPage?.view === view) return ui.modelSourcesPage.selectTab(id || tab === 'sources' ? 'sources' : 'models', id);
  const previous = ui.modelSourcesPage;
  previous?.connections?.dispose(); previous?.models?.dispose();
  const reused = previous?.contextKey === client.key && previous.connections;
  const state = reused ? previous : { contextKey: client.key, scope: 'device', connections: null, models: null, pending: null };
  state.view = view; state.pending = null; ui.modelSourcesPage = state;
  const ownsPage = () => ui.view === state.view && ui.modelSourcesPage === state;
  const page = el('div', undefined, 'model-sources-page'), head = el('header', undefined, 'model-sources-head');
  head.append(el('h1', '模型和来源'), el('p', `${scopeImpact()} 模型是命名后的来源 + 具体模型；已有运行配置保留固定绑定。`, 'hint'));
  const tabs = el('div', undefined, 'model-source-actions'); tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', '模型和来源');
  const content = el('div');
  if (!state.connections) state.connections = createAgentConnections({ ownsPage: () => ownsPage() && state.tab === 'sources', connectionId: id, client });
  if (!state.models) state.models = createRegisteredModels({ client, ownsPage: () => ownsPage() && state.tab === 'models', openSources: id => state.selectTab('sources', id) });
  const controls = new Map();
  for (const [key, title] of [['models', '模型'], ['sources', '来源']]) {
    const control = button(title, () => state.selectTab(key), 'ghost'); control.dataset.modelSourcesTab = key;
    control.id = `model-sources-tab-${key}`; control.setAttribute('role', 'tab'); control.setAttribute('aria-controls', `model-sources-panel-${key}`);
    control.onkeydown = event => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      event.preventDefault(); const target = event.key === 'Home' ? 'models' : event.key === 'End' ? 'sources' : key === 'models' ? 'sources' : 'models';
      controls.get(target).focus(); void state.selectTab(target);
    } };
    controls.set(key, control); tabs.append(control);
  }
  for (const [key, panel] of [['models', state.models.node], ['sources', state.connections.node]]) {
    panel.id = `model-sources-panel-${key}`; panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', `model-sources-tab-${key}`); content.append(panel);
  }
  state.selectTab = (key, selectedId = '') => {
    if (!ownsPage()) return Promise.resolve();
    const changed = state.tab !== key;
    if (changed) { state.connections.dispose(); state.models.dispose(); }
    state.tab = key;
    for (const [name, control] of controls) { control.setAttribute('aria-selected', String(name === key)); control.tabIndex = name === key ? 0 : -1; }
    state.models.node.hidden = key !== 'models'; state.connections.node.hidden = key !== 'sources';
    const hash = key === 'models' ? '#model-sources' : selectedId ? `#model-source-${selectedId}` : '#model-sources-connections';
    if (globalThis.location?.hash !== hash) globalThis.history?.replaceState(null, '', hash);
    const panel = key === 'models' ? state.models : state.connections;
    panel.resume(); if (key === 'sources' && selectedId) panel.selectConnection(selectedId);
    const pending = panel.load(true).finally(() => { if (state.pending === pending) state.pending = null; });
    state.pending = pending; return pending;
  };
  page.append(head, tabs, content);
  $('detail').replaceChildren(page);
  return state.selectTab(id || tab === 'sources' ? 'sources' : 'models', id);
}
