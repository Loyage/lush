import { enhanceModule, observeModules } from './shared-module.js';
import { ui } from './state.js';
import { captureModuleReading, restoreModuleReading } from './module-reading.js';

let page = null;
const inside = (root, node) => { for (let at = node; at; at = at.parentNode) if (at === root) return true; return false; };

export function disposePageModules() {
  if (!page) return;
  page.dispose?.();
  for (const group of page.groups.values()) { group.alerts?.disconnect(); for (const view of group.views) view.dispose(); }
  page = null;
}

/** Explicit page-owned module selection, never an automatic scan of all application blocks.
 * Groups may be rebuilt independently (e.g. settings and software diagnostics). One observer
 * covers their real #detail scrollport. State lasts only for the current navigation identity.
 */
export function pageModules(root, { scope, entries = [] } = {}) {
  const owner = globalThis.document, identity = ui.view;
  if (!page || page.owner !== owner || page.identity !== identity) {
    disposePageModules();
    page = { owner, identity, groups: new Map(), states: new Map(), queued: false };
  }
  ui.disposePageModules = disposePageModules;
  const state = page, previous = state.groups.get(scope);
  previous?.alerts?.disconnect();
  const selected = new Set(entries.map(entry => entry.section));
  for (const view of previous?.views || []) if (!selected.has(view.section)) view.dispose();
  const views = entries.map(({ section, key, mode = 'preview', summary = '' }) => {
    section.dataset.module = `${scope}:${key}`;
    return enhanceModule(section, { key: `${scope}:${key}`, mode, states: state.states, summary });
  });
  const group = { root, views, summaries: entries.map(entry => entry.summary || '') };
  state.groups.set(scope, group);
  const updateAlerts = () => {
    if (page !== state || state.groups.get(scope) !== group || owner !== globalThis.document || ui.view !== identity) return;
    views.forEach((view, index) => {
      if (view.mode !== 'fold') return;
      const alerts = [...new Set(['.settings-error', '.settings-warning', '.agent-status-warning', '.usage-warning', '[role="alert"]']
        .flatMap(selector => [...view.content.querySelectorAll(selector)]))]
        .filter(node => {
          for (let at = node; at && at !== view.content; at = at.parentNode) if (at.hidden) return false;
          return true;
        }).map(node => node.textContent.trim()).filter(Boolean);
      const text = [...new Set([group.summaries[index], ...alerts].filter(Boolean))].join('；');
      if (view.summary.textContent !== text) view.summary.textContent = text;
      if (view.summary.hidden !== !text) view.summary.hidden = !text;
    });
  };
  updateAlerts();
  if (views.some(view => view.mode === 'fold') && typeof MutationObserver === 'function') {
    group.alerts = new MutationObserver(updateAlerts);
    group.alerts.observe(root, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class', 'hidden', 'role'] });
  }
  if (!state.queued) {
    state.queued = true;
    // Renderers may build the root before replacing/appending it. Observe after that safe point.
    queueMicrotask(() => {
      state.queued = false;
      if (page !== state || owner !== globalThis.document || ui.view !== identity) return;
      const panel = owner.getElementById('detail'); if (!panel) return;
      const mounted = [];
      for (const group of state.groups.values()) for (const view of group.views) {
        if (inside(panel, view.section)) mounted.push(view);
      }
      state.dispose = observeModules(panel, [...new Set(mounted)], { isCurrent: () => page === state && owner === globalThis.document && ui.view === identity });
    });
  }
  return views;
}

/** Preserve a content anchor around an independent page region's synchronous redraw. */
export function replacePageContent(root, ...nodes) {
  const panel = globalThis.document?.getElementById('detail');
  const reading = panel && captureModuleReading(panel);
  root.replaceChildren(...nodes);
  if (panel) restoreModuleReading(panel, reading);
}

/** Direct blocks of a known reading/form region; nested editors are not independently wrapped. */
export function pageBlocks(root, scope, mode = 'preview', summaryOf = () => '') {
  const counts = new Map();
  const entries = [...root.children].filter(section => section.classList.contains('block') && !section.classList.contains('agent-network-block')).map(section => {
    const title = section.querySelector('h2')?.textContent || '模块';
    const ordinal = counts.get(title) || 0; counts.set(title, ordinal + 1);
    return { section, key: `${title}:${ordinal}`, mode, summary: summaryOf(section) };
  });
  return pageModules(root, { scope, entries });
}
