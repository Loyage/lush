import { el } from './dom.js';
import { dashboardIcon } from './dashboard-icons.js';
import { formDialog } from './dialog.js';
import { renderAccountCard } from './dashboard-cards.js';
import { widgetSlots, reflowWidgetPage } from './dashboard-widget-model.js';
import { widgetPagination } from './dashboard-widget-pagination.js';

export const ACCOUNT_GROUP_ID = 'accounts';

/** One board window, many independent cached sources. Reads and refresh/repaint belong to the parent. */
export function renderAccountGroup(row, { mode = 'list', sections, sectionsForAccount, refresh, refreshAll, ownsPage = () => true, geometry, state = { index: 0 }, bounded = false } = {}) {
  const root = el('li', undefined, 'project-item dashboard-accounts-group');
  root.dataset.cardId = row.id || ACCOUNT_GROUP_ID; root.dataset.cardType = 'accounts';
  root.dataset.accountView = mode === 'tiles' ? 'tiles' : 'list';
  const header = el('header', undefined, 'dashboard-accounts-header dashboard-widget-header');
  header.append(el('h2', typeof row.name === 'string' && row.name ? row.name : '额度与余额', 'dashboard-widget-title'));
  const host = el('span', undefined, 'help-host');
  const button = el('button', undefined, 'ghost dashboard-accounts-refresh'); button.type = 'button';
  button.append(dashboardIcon('refresh')); button.setAttribute('aria-label', '刷新额度');
  button.dataset.help = '仅刷新此额度窗已选择的账户来源，不查询其他账户或调用模型。';
  host.append(button); header.append(host); root.append(header);
  const accounts = Array.isArray(row.accounts) ? row.accounts : [];
  const items = el('ul', undefined, bounded ? 'dashboard-accounts-items dashboard-widget-body dashboard-widget-slots' : 'dashboard-accounts-items');
  items.setAttribute('aria-label', '已选择的账户来源');
  root.append(items);
  let footer, capacity = bounded ? widgetSlots('accounts', geometry) : accounts.length;
  if (bounded) reflowWidgetPage(state, capacity);
  function paint() {
    items.replaceChildren();
    if (bounded) items.dataset.slotCount = String(capacity);
    if (capacity > 0) state.index = Math.min(state.index, Math.max(0, Math.ceil(accounts.length / capacity) - 1));
    if (!bounded && !accounts.length) items.append(el('li', '未选择账户来源', 'dashboard-card-note dashboard-accounts-empty'));
    for (let i = 0; i < capacity; i++) {
      const account = accounts[state.index * capacity + i];
      if (!account) { const slot = el('li', undefined, 'dashboard-widget-slot'); slot.dataset.empty = 'true'; slot.setAttribute('aria-hidden', 'true'); items.append(slot); continue; }
      const specific = typeof sectionsForAccount === 'function' ? sectionsForAccount(account) : undefined;
      const selected = Array.isArray(specific) ? specific : sections;
      const card = renderAccountCard(account, { sections: selected, refresh, ownsPage, embedded: true, bounded });
      if (bounded) card.classList.add('dashboard-widget-slot'); items.append(card);
    }
    if (bounded) {
      footer = widgetPagination(root, { previous: capacity > 0 && state.index > 0, next: capacity > 0 && (state.index + 1) * capacity < accounts.length,
        label: state.error || (capacity ? `${accounts.length ? state.index + 1 : 0} / ${Math.ceil(accounts.length / capacity)} · ${accounts.length}` : `— · ${accounts.length}`),
        onPrevious: () => { if (capacity > 0 && ownsPage() && state.index > 0) { state.index--; paint(); } },
        onNext: () => { if (capacity > 0 && ownsPage() && (state.index + 1) * capacity < accounts.length) { state.index++; paint(); } } });
      if (capacity === 0) {
        const details = el('button', '全部来源', 'ghost dashboard-accounts-details'); details.type = 'button';
        details.onclick = () => {
          if (!ownsPage()) return;
          const content = el('ul', undefined, 'dashboard-accounts-details-list');
          for (const account of accounts) content.append(renderAccountCard(account, { sections: sectionsForAccount?.(account) ?? sections }));
          const more = el('a', '模型来源'); more.href = '/#model-sources'; more.target = '_blank'; more.rel = 'noopener'; content.append(more);
          void formDialog({ title: '额度与余额', content, confirmLabel: '关闭' });
        }; footer.append(details);
      }
    }
  }
  root.dashboardGeometryChange = next => {
    const after = widgetSlots('accounts', next);
    geometry = next;
    if (bounded && capacity !== after) {
      capacity = after; reflowWidgetPage(state, capacity); paint();
    }
  };
  paint();
  const blocker = typeof refreshAll !== 'function' ? '当前页面未提供全组刷新操作。' : !accounts.length ? '尚未选择账户来源，无法刷新。'
    : !accounts.some(account => account.connection && account.connection.enabled !== false) ? '所选来源均已停用、删除或不可用，无法刷新。' : null;
  let busy = false;
  function sync() {
    button.disabled = !!blocker || busy;
    if (button.disabled) { host.dataset.help = blocker || '全组刷新尚未完成，请勿重复请求。'; host.setAttribute('tabindex', '0'); }
    else { delete host.dataset.help; host.removeAttribute('tabindex'); }
  }
  button.onclick = async () => {
    if (blocker || busy || !ownsPage()) return;
    busy = true; state.error = null; if (bounded) paint(); sync();
    try { await refreshAll(); }
    catch (error) {
      if (ownsPage()) {
        const message = typeof error?.message === 'string' && error.message ? error.message : '全组刷新失败';
        if (bounded) { state.error = message; paint(); }
        else items.prepend(el('li', message, 'dashboard-card-warning'));
      }
    }
    finally { busy = false; if (ownsPage()) sync(); }
  };
  sync();
  return root;
}
