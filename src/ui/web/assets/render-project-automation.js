import { $, el, button, badge } from './dom.js';
import { api, projectApi } from './api.js';
import { ui } from './state.js';
import { activateDetailView } from './sidebar-ui.js';
import { listEntry, listSurface } from './list-surface.js';
import { searchField } from './search-field.js';
import { pageSubnav } from './page-subnav.js';
import { AUTOMATION_FEATURES, automationFeature, automationHash } from './automation-features.js';

/** One retained shell and module contract, no scheduling or authorization in the directory. */
export async function openProjectAutomation({ feature = null, subpage = 'settings', push = true } = {}) {
  if (!automationFeature(feature)) feature = null;
  subpage = subpage === 'history' ? 'history' : 'settings';
  const view = activateDetailView({ view: 'hooks', title: automationFeature(feature)?.name || '项目自动化',
    hint: feature ? '功能设置与运行记录' : '选择一项自动化功能', hash: automationHash(feature, subpage), push });
  const project = projectApi('/api/hooks'), owner = globalThis.document;
  const existing = ui.automationPage;
  if (existing?.view === view && existing.project === project && existing.owner === owner) return existing.select(feature, subpage);
  ui.disposeProjectAutomation?.();
  const state = { view, project, owner, feature: null, subpage: 'settings', nodes: new Map(), request: 0, pending: null };
  ui.automationPage = state;
  const owns = () => owner === globalThis.document && ui.view === view && ui.automationPage === state && projectApi('/api/hooks') === project;
  const root = el('div', undefined, 'hooks-page project-automation resource-page');
  const browse = el('section', undefined, 'automation-browse');
  const hero = el('header', undefined, 'resource-hero');
  hero.append(el('span', 'AUTOMATION', 'resource-kicker'), el('h1', '项目自动化'), el('p', '选择功能，设置其授权并查看运行记录。'));
  const entries = [], empty = el('p', '没有匹配的自动化功能。', 'hint'); empty.hidden = true;
  const search = searchField({ label: '查找自动化功能', placeholder: '按功能名称或用途查找', scope: '范围：当前四项自动化功能', onSubmit: value => {
    let count = 0;
    for (const entry of entries) { entry.node.hidden = !entry.text.includes(value.toLowerCase()); if (!entry.node.hidden) count++; }
    empty.hidden = count !== 0;
  } });
  const card = el('section', undefined, 'resource-card automation-directory'), heading = el('div', undefined, 'section-title');
  heading.append(el('h2', '自动化功能'), el('span', String(AUTOMATION_FEATURES.length), 'count'));
  const list = el('ol', undefined, 'automation-feature-list'); list.setAttribute('aria-label', '自动化功能');
  for (const item of AUTOMATION_FEATURES) {
    const row = el('li', undefined, 'automation-feature'); row.dataset.feature = item.id;
    const link = el('a', undefined, 'automation-feature-link'); link.setAttribute('href', automationHash(item.id));
    const head = el('span', undefined, 'automation-feature-head'); head.append(el('strong', item.name), badge(item.scope));
    link.append(head, el('span', item.description, 'automation-feature-description'), el('span', '设置与运行记录 →', 'automation-feature-open'));
    link.onclick = event => {
      if (event?.button > 0 || event?.metaKey || event?.ctrlKey || event?.shiftKey || event?.altKey) return;
      event?.preventDefault?.(); return openProjectAutomation({ feature: item.id });
    };
    row.append(listEntry(link)); list.append(row); entries.push({ node: row, text: `${item.name} ${item.description} ${item.scope}`.toLowerCase() });
  }
  card.append(heading, list, empty); browse.append(hero, search.root, card);
  listSurface({ root: browse, tools: search.root, card, heading, body: list });
  const panel = el('section', undefined, 'automation-feature-page'); panel.hidden = true;
  root.append(browse, panel); $('detail').replaceChildren(root);
  state.dispose = () => { ++state.request; for (const node of state.nodes.values()) node.dispose?.(); state.nodes.clear(); };
  ui.disposeProjectAutomation = state.dispose;
  state.select = async (id, tab) => {
    if (!owns()) return;
    const request = ++state.request;
    state.feature = id; state.subpage = tab;
    for (const [key, node] of state.nodes) { node.hidden = key !== id; node.setActive?.(key === id); }
    browse.hidden = Boolean(id); panel.hidden = !id;
    if (!id) { panel.replaceChildren(); return; }
    const item = automationFeature(id), content = el('div', undefined, 'automation-feature-content');
    const header = el('header', undefined, 'hooks-page-header'); header.append(el('h1', item.name), badge(item.scope));
    const back = button('← 返回自动化功能列表', () => openProjectAutomation(), 'link');
    const nav = pageSubnav(`${item.name}子页面`, [
      { id: 'settings', label: '设置', href: automationHash(id) },
      { id: 'history', label: '运行记录', href: automationHash(id, 'history') },
    ], tab, next => owns() ? openProjectAutomation({ feature: id, subpage: next }) : undefined);
    panel.replaceChildren(back, header, nav, content);
    const current = () => owns() && state.feature === id && request === state.request;
    let node = state.nodes.get(id);
    if (node) { node.hidden = false; node.setSubpage?.(tab); content.append(node); return node.ready; }
    content.append(el('p', '正在读取功能…', 'hint'));
    const pending = (async () => {
      try {
        const render = await item.load(); if (!current()) return;
        // Only engines needing the Hook catalogue read it; the directory never loads all modules.
        const catalogue = ['push', 'convergence'].includes(id) ? await api('/api/hooks') : null;
        if (!current()) return;
        if (catalogue) ui.hookCatalogue = catalogue;
        node = render({ catalogue, ownsPage: () => owns() && state.feature === id });
        state.nodes.set(id, node); node.setSubpage?.(state.subpage); content.replaceChildren(node);
        await node.ready;
      } catch (error) {
        if (current()) content.replaceChildren(el('p', `功能读取失败：${error.message}`, 'error'), button('重新读取', () => state.select(id, tab), 'ghost'));
      }
    })();
    state.pending = pending; return pending;
  };
  return state.select(feature, subpage);
}
