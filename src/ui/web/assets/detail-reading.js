import { button, el } from './dom.js';

/** In-page positioning only: keep filters, folds, drafts, routing and history reads untouched. */
export function detailNavigation(root, panel) {
  root.className = 'actions detail-navigation';
  root.setAttribute('role', 'navigation'); root.setAttribute('aria-label', '详情模块定位');
  root.append(el('span', '本页', 'hint'));
  const headings = () => [...panel.children].filter(section => section.classList.contains('block'))
    .map(section => section.children[0]?.querySelector('h2')).filter(Boolean);
  const occurrences = new Map();
  for (const heading of headings()) {
    const label = heading.textContent, ordinal = occurrences.get(label) || 0;
    occurrences.set(label, ordinal + 1);
    const control = button(label, () => {
      // Supplemental reads can replace a module without rebuilding this navigation.
      const title = headings().filter(node => node.textContent === label)[ordinal];
      if (!title) return;
      // The heading is always outside preview/fold bodies. Do not expand long content merely
      // to position its heading; the nearby disclosure remains the explicit reading choice.
      title.tabIndex = -1;
      title.focus({ preventScroll: true });
      title.scrollIntoView?.({ block: 'start', behavior: 'auto' });
    }, 'ghost');
    root.append(control);
  }
}

// Compatibility exports: detail and ordinary modules share the same reading anchor mechanism.
export { captureModuleReading as captureDetailReading, restoreModuleReading as restoreDetailReading } from './module-reading.js';
