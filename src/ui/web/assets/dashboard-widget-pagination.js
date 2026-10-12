import { el } from './dom.js';

/** Keep pagination nodes (and keyboard focus) stable when data or page state changes. */
export function widgetPagination(parent, { previous, next, label, onPrevious, onNext }) {
  const container = parent.querySelector('.project-board-content') || parent;
  let footer = [...container.children].find(node => node.classList.contains('dashboard-widget-pagination'));
  if (!footer) {
    footer = el('footer', undefined, 'dashboard-widget-footer dashboard-widget-pagination');
    const previousHost = el('span', undefined, 'help-host'), nextHost = el('span', undefined, 'help-host');
    for (const [host, text, help] of [[previousHost, '‹', '查看此卡片上一页，位置和尺寸不变。'], [nextHost, '›', '查看此卡片下一页，位置和尺寸不变。']]) {
      const button = el('button', text, 'ghost'); button.type = 'button'; button.dataset.help = help; host.append(button);
    }
    footer.append(previousHost, el('span', undefined, 'dashboard-widget-page-label'), nextHost); container.append(footer);
  }
  // Caller-owned navigation links are replaced, while native pagination controls survive.
  for (const child of [...footer.children].slice(3)) child.remove();
  footer.children[1].textContent = label;
  for (const [host, enabled, action] of [[footer.children[0], previous, onPrevious], [footer.children[2], next, onNext]]) {
    const button = host.children[0]; button.disabled = !enabled; button.onclick = action;
    if (!enabled) { host.dataset.help = '此方向没有已确认的页面。'; host.setAttribute('tabindex', '0'); }
    else { delete host.dataset.help; host.removeAttribute('tabindex'); }
  }
  return footer;
}
