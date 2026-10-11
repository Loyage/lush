import { el } from './dom.js';
import { renderAccountCard } from './dashboard-cards.js';

export const ACCOUNT_GROUP_ID = 'accounts';

/** One board window, many independent cached sources. Reads and refresh/repaint belong to the parent. */
export function renderAccountGroup(row, { mode = 'list', sections, sectionsForAccount, refresh, refreshAll, ownsPage = () => true } = {}) {
  const root = el('li', undefined, 'project-item dashboard-accounts-group');
  root.dataset.cardId = ACCOUNT_GROUP_ID; root.dataset.cardType = 'accounts';
  root.dataset.accountView = mode === 'tiles' ? 'tiles' : 'list';
  const header = el('header', undefined, 'dashboard-accounts-header');
  header.append(el('h2', typeof row.name === 'string' && row.name ? row.name : '额度与余额'));
  const host = el('span', undefined, 'help-host');
  const button = el('button', '刷新额度', 'dashboard-accounts-refresh'); button.type = 'button';
  button.dataset.help = '仅刷新此额度窗已选择的账户来源，不查询其他账户或调用模型。';
  host.append(button); header.append(host); root.append(header);
  const accounts = Array.isArray(row.accounts) ? row.accounts : [];
  const items = el('ul', undefined, 'dashboard-accounts-items');
  items.setAttribute('aria-label', '已选择的账户来源');
  // Native focus/scroll keeps the last source reachable in a small, fixed-height window.
  items.setAttribute('tabindex', '0'); root.append(items);
  if (!accounts.length) items.append(el('li', '未选择账户来源', 'dashboard-card-note dashboard-accounts-empty'));
  for (const account of accounts) {
    const specific = typeof sectionsForAccount === 'function' ? sectionsForAccount(account) : undefined;
    const selected = Array.isArray(specific) ? specific : sections;
    items.append(renderAccountCard(account, { sections: selected, refresh, ownsPage, embedded: true }));
  }
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
    busy = true; sync();
    try { await refreshAll(); }
    catch (error) { if (ownsPage()) items.prepend(el('li', typeof error?.message === 'string' && error.message ? error.message : '全组刷新失败', 'dashboard-card-warning')); }
    finally { busy = false; if (ownsPage()) sync(); }
  };
  sync();
  return root;
}
