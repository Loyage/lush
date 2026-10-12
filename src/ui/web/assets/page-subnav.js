import { el } from './dom.js';

/** Bookmarkable subpages, with native keyboard and browser navigation. */
export function pageSubnav(label, items, current, onNavigate = null) {
  const nav = el('nav', undefined, 'settings-tabs page-subnav');
  nav.setAttribute('aria-label', label);
  for (const { id, label: text, href } of items) {
    const link = el('a', text, 'settings-tab'); link.href = href;
    link.dataset.subpage = id;
    if (id === current) { link.classList.add('active'); link.setAttribute('aria-current', 'page'); }
    if (onNavigate) link.onclick = event => {
      if (event?.button > 0 || event?.ctrlKey || event?.metaKey || event?.shiftKey || event?.altKey) return;
      event?.preventDefault(); return onNavigate(id);
    };
    nav.append(link);
  }
  return nav;
}
