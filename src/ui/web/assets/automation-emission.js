import { el } from './dom.js';
import { createInputBrowser } from './render-inputs.js';

/** A project-scoped feature body; its parent owns titles, routing and subpage tabs. */
export function renderEmissionAutomation({ ownsPage, catalogue } = {}) {
  const root = el('section', undefined, 'automation-emission');
  root.setAttribute('aria-label', '条件发射');
  let disposed = false, subpage = 'settings';
  const pages = new Map();
  function page(next) {
    if (!pages.has(next)) {
      const node = createInputBrowser({ embedded: true, conditional: next === 'history' ? 'mounted' : 'configured',
        readOnly: next === 'history', ownsPage: () => !disposed && ownsPage() });
      pages.set(next, node); root.append(node);
    }
    return pages.get(next);
  }
  root.setSubpage = next => {
    if (disposed) return Promise.resolve();
    subpage = next === 'history' ? 'history' : 'settings';
    const active = page(subpage);
    for (const [name, node] of pages) node.hidden = name !== subpage;
    // Only the list refreshes: local draft edits survive tab switches and explicit refreshes.
    root.ready = active.state.pending ?? active.load();
    return root.ready;
  };
  root.dispose = () => { disposed = true; for (const node of pages.values()) node.dispose(); };
  root.ready = root.setSubpage('settings');
  return root;
}
