import { $, button, el } from './dom.js';
import { activateDetailView } from './sidebar-ui.js';
import { ui } from './state.js';
import { createAgentConnections } from './render-agent-connections.js';
import { createRegisteredModels } from './registered-models.js';
import { settingsClient } from './settings-api.js';
import { scopeImpact } from './settings-scope.js';
import { createDiagnosticsPage } from './diagnostics-page.js';
import { diagnosticsHash } from './diagnostics-route.js';
import { projectRoute } from './route.js';

/** Models are the default; old source deep links still select the source tab and detail. */
export function openModelSources({ connectionId = '', tab = '', filters } = {}) {
  const id = typeof connectionId === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(connectionId) ? connectionId : '';
  const client = settingsClient(), contextKey = `${client.key}:diagnostics:${projectRoute() || 'host'}`;
  const view = activateDetailView({ view: 'model-sources', title: '模型和来源', context: '设备设置',
    hint: '命名模型、来源管理与运行诊断', hash: tab === 'diagnostics' ? diagnosticsHash(filters) : id ? `#model-source-${id}` : tab === 'sources' ? '#model-sources-connections' : '#model-sources' });
  const selectedTab = tab === 'diagnostics' ? tab : id || tab === 'sources' ? 'sources' : 'models';
  if (ui.modelSourcesPage?.view === view && ui.modelSourcesPage.contextKey === contextKey) return ui.modelSourcesPage.selectTab(selectedTab, id, filters);
  const previous = ui.modelSourcesPage;
  previous?.connections?.dispose(); previous?.models?.dispose(); previous?.diagnostics?.dispose();
  const reused = previous?.contextKey === contextKey && previous.connections;
  const state = reused ? previous : { contextKey, scope: 'device', connections: null, models: null, pending: null };
  state.view = view; state.pending = null; ui.modelSourcesPage = state;
  const ownsPage = () => ui.view === state.view && ui.modelSourcesPage === state;
  const page = el('div', undefined, 'model-sources-page'), head = el('header', undefined, 'model-sources-head');
  const description = el('p', '', 'hint');
  head.append(el('h1', '模型和来源'), description);
  const explanation = el('details', undefined, 'model-source-explanation');
  explanation.append(el('summary', '模型绑定与设备范围'), el('p', `${scopeImpact()} 模型是命名后的来源 + 具体模型；已有运行配置保留固定绑定。`, 'hint'));
  const tabs = el('div', undefined, 'model-source-actions'); tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', '模型和来源');
  const content = el('div');
  if (!state.connections) state.connections = createAgentConnections({ ownsPage: () => ownsPage() && state.tab === 'sources', connectionId: id, client });
  if (!state.models) state.models = createRegisteredModels({ client, ownsPage: () => ownsPage() && state.tab === 'models', openSources: id => state.selectTab('sources', id) });
  if (!state.diagnostics) state.diagnostics = createDiagnosticsPage({ client, ownsPage: () => ownsPage() && state.tab === 'diagnostics' });
  ui.disposeModelSources = () => { state.connections.dispose(); state.models.dispose(); state.diagnostics.dispose(); };
  const controls = new Map(), keys = ['models', 'sources', 'diagnostics'];
  for (const [key, title] of [['models', '模型'], ['sources', '来源'], ['diagnostics', '运行诊断']]) {
    const control = button(title, () => state.selectTab(key), 'ghost'); control.dataset.modelSourcesTab = key;
    control.id = `model-sources-tab-${key}`; control.setAttribute('role', 'tab'); control.setAttribute('aria-controls', `model-sources-panel-${key}`);
    control.onkeydown = event => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      event.preventDefault(); const target = event.key === 'Home' ? keys[0] : event.key === 'End' ? keys.at(-1) : keys[(keys.indexOf(key) + (event.key === 'ArrowRight' ? 1 : keys.length - 1)) % keys.length];
      controls.get(target).focus(); void state.selectTab(target);
    } };
    controls.set(key, control); tabs.append(control);
  }
  for (const [key, panel] of [['models', state.models.node], ['sources', state.connections.node], ['diagnostics', state.diagnostics.node]]) {
    panel.id = `model-sources-panel-${key}`; panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', `model-sources-tab-${key}`); panel.tabIndex = 0; content.append(panel);
  }
  state.selectTab = (key, selectedId = '', selectedFilters) => {
    if (!ownsPage()) return Promise.resolve();
    const changed = state.tab !== key;
    if (changed) { state.connections.dispose(); state.models.dispose(); state.diagnostics.dispose(); }
    state.tab = key;
    description.hidden = key !== 'diagnostics';
    description.textContent = key === 'diagnostics' ? '运行与额度观测 · 只读分析，不调用模型或启动离线后台。' : '';
    for (const [name, control] of controls) { control.setAttribute('aria-selected', String(name === key)); control.tabIndex = name === key ? 0 : -1; }
    state.models.node.hidden = key !== 'models'; state.connections.node.hidden = key !== 'sources'; state.diagnostics.node.hidden = key !== 'diagnostics';
    const hash = key === 'diagnostics' ? diagnosticsHash(selectedFilters) : key === 'models' ? '#model-sources' : selectedId ? `#model-source-${selectedId}` : '#model-sources-connections';
    if (globalThis.location?.hash !== hash) globalThis.window?.history?.replaceState(null, '', hash);
    const panel = key === 'diagnostics' ? state.diagnostics : key === 'models' ? state.models : state.connections;
    panel.resume(); if (key === 'sources' && selectedId) panel.selectConnection(selectedId);
    if (key === 'diagnostics') panel.setFilters(selectedFilters);
    const pending = panel.load(true).finally(() => { if (state.pending === pending) state.pending = null; });
    state.pending = pending; return pending;
  };
  page.append(head, tabs, content, explanation);
  $('detail').replaceChildren(page);
  return state.selectTab(selectedTab, id, filters);
}
