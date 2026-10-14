import { el } from './dom.js';
import { formDialog } from './dialog.js';
import { projectHref } from './route.js';
import { STATUS } from './format.js';
import { projectDevelopment } from './project-development.js';
import { onlineDashboardProject } from './project-dashboard-content.js';
import { renderAccountGroup } from './dashboard-accounts-group.js';
import { createWidgetRenderer } from './dashboard-widget-render.js';
import { widgetPagination } from './dashboard-widget-pagination.js';
import { GLOBAL_LINKS, PROJECT_LINKS, reflowWidgetPage } from './dashboard-widget-model.js';
import { aggregateBudget } from './dashboard-widget-aggregate-model.js';

export function dashboardNavigation(links, { name = '' } = {}) {
  const root = el('nav', undefined, 'project-dashboard-shortcuts dashboard-navigation-menu');
  const seen = new Set();
  for (const item of links) {
    if (item.scope === 'project' && item.target === 'versions') continue;
    const key = JSON.stringify([item.scope, item.project_id, item.target]);
    if (seen.has(key)) continue;
    seen.add(key);
    const label = (item.scope === 'global' ? GLOBAL_LINKS : PROJECT_LINKS).find(([target]) => target === item.target)?.[1] || item.target;
    const target = el('a', `${name && item.scope === 'project' ? `${name} · ` : ''}${label}`, 'nav-link');
    target.href = item.scope === 'global' ? `/#${item.target}` : projectHref(item.project_id, `/#${item.target}`);
    target.target = '_blank'; target.rel = 'noopener'; root.append(target);
  }
  return root;
}
/** Project cards and one quota window; no independent five-type UI or natural-height measurement. */
export function createAggregateRenderer({ ownsPage = () => true, canAct = ownsPage, messages, refresh, refreshAccounts } = {}) {
  const owner = globalThis.document, accountState = { index: 0 };
  const widgets = createWidgetRenderer({ ownsPage, canAct, messages, refresh, refreshAccounts });
  const value = number => Number.isSafeInteger(number) ? String(number) : '—';
  function render(row, { geometry = row.geometry, mode = 'list' } = {}) {
    row = { ...row, links: row.links?.filter(item => !(item.scope === 'project' && item.target === 'versions')) };
    if (row.type === 'accounts') {
      const identity = JSON.stringify(row.connection_ids);
      if (accountState.identity !== identity) { accountState.identity = identity; accountState.index = 0; accountState.error = null; }
      let root;
      root = renderAccountGroup(row, { geometry, state: accountState, bounded: true, mode, sections: row.sections,
        sectionsForAccount: account => row.accountSections[account.id], ownsPage: () => owner === globalThis.document && canAct() && root?.parentNode != null, refresh,
        refreshAll: typeof refreshAccounts === 'function' ? () => refreshAccounts(row.connection_ids) : undefined });
      root.classList.add('dashboard-widget'); root.dataset.widgetType = 'accounts'; return root;
    }
    const root = el('li', undefined, 'project-item dashboard-widget dashboard-project-card');
    root.dataset.cardId = row.id; root.dataset.cardType = 'project'; root.dataset.widgetType = 'project';
    const current = () => owner === globalThis.document && ownsPage() && root.parentNode != null;
    const header = el('header', undefined, 'dashboard-widget-header');
    const title = el('a', undefined, 'project-open dashboard-widget-title'); title.href = projectHref(row.id); title.target = '_blank'; title.rel = 'noopener';
    title.append(el('strong', row.name || '未命名项目')); header.append(title);
    if (!onlineDashboardProject(row)) header.append(el('span', row.error || '离线', 'project-status dashboard-widget-source-error'));
    root.append(header);
    const body = el('div', undefined, 'project-dashboard-content dashboard-widget-body'); root.append(body);
    const groups = new Map(), summary = onlineDashboardProject(row) ? row.summary?.development : null;
    if (row.sections.includes('metrics')) {
      const metrics = el('div', undefined, 'project-development-metrics dashboard-widget-metrics'); metrics.dataset.section = 'metrics';
      for (const [label, number, tone] of [['Worker', summary?.workers_total, 'blue'], ['进行中', summary?.active, 'violet'], ['待验收', summary?.awaiting_acceptance, 'violet'], ['待我处理', summary ? row.summary?.notices : null, 'green'], ['待父确认', summary?.parent_confirmation, 'green'], ['Agent', summary?.agents_running, 'blue']]) {
        const metric = el('div', undefined, `project-development-metric dashboard-widget-metric tone-${tone}`);
        metric.append(el('span', label, 'metric-label'), el('strong', value(number), 'project-development-value')); metrics.append(metric);
      }
      groups.set('metrics', metrics);
    }
    for (const key of ['distribution', 'delivery']) if (row.sections.includes(key)) {
      const node = el('div', undefined, `project-development-${key} dashboard-project-summary dashboard-widget-row`); node.dataset.section = key;
      const text = !summary ? '状态未确认' : key === 'distribution' ? (Array.isArray(summary.counts) ? summary.counts : []).filter(item => item.count > 0).map(item => `${STATUS[item.status]?.label || '未知'} ${item.count}`).join(' · ') || (summary.workers_total === 0 ? 'Worker 0' : '分布未确认')
        : `待合并 ${value(summary.pending_merges)} · 合并中 ${value(summary.merging)} · 冲突 ${value(summary.merge_conflicts)}`;
      node.append(el('span', text, 'dashboard-widget-title')); groups.set(key, node);
    }
    if (row.sections.includes('messages')) {
      const node = el('section', undefined, 'project-dashboard-messages dashboard-project-messages'); node.dataset.section = 'messages';
      widgets.mountMessages(root, node, row, () => current() && node.parentNode === body, { footer: false }); groups.set('messages', node);
    }
    const workerBody = el('div', undefined, 'project-development-recent dashboard-project-workers'); workerBody.dataset.section = 'recent';
    function details() {
      if (!current()) return;
      const content = el('div', undefined, 'dashboard-project-details');
      if (row.sections.some(section => ['metrics', 'distribution', 'delivery', 'recent'].includes(section))) {
        const development = summary && { ...summary, counts: Array.isArray(summary.counts) ? summary.counts : [], recent_workers: Array.isArray(summary.recent_workers) ? summary.recent_workers : [] };
        if (development) for (const key of ['workers_total', 'active', 'awaiting_acceptance', 'parent_confirmation', 'agents_running', 'pending_merges', 'merging', 'merge_conflicts']) development[key] = value(summary[key]);
        content.append(projectDevelopment(development ? { ...row, summary: { ...row.summary, notices: value(row.summary?.notices), development } } : row, { sections: row.sections }));
      }
      if (row.sections.includes('messages')) {
        const messageBody = el('section', undefined, 'project-dashboard-messages'); content.append(messageBody);
        const inModal = () => {
          for (let node = content; node; node = node.parentNode) if (node === owner.getElementById('modal')) return true;
          return false;
        };
        widgets.mountMessages(content, messageBody, row, () => current() && inModal(), { footer: false, viewKey: `${row.id}:details` });
      }
      content.append(dashboardNavigation(navigationLinks(), { name: row.name }));
      void formDialog({ title: row.name || '项目详情', content, confirmLabel: '关闭' });
    }
    function navigationLinks() {
      const links = [...row.links];
      for (const [section, target] of [['recent', 'workers'], ['messages', 'notices']]) {
        if (row.sections.includes(section) && !links.some(link => link.scope === 'project' && link.project_id === row.id && link.target === target)) links.push({ scope: 'project', project_id: row.id, target });
      }
      return links;
    }
    const footerControls = new Map();
    const navigationOnly = row.sections.length === 1 && row.sections[0] === 'shortcuts';
    const navigationBody = dashboardNavigation(row.links);
    navigationBody.classList.add('dashboard-project-navigation-slots');
    navigationBody.dataset.section = 'shortcuts';
    const navigationItems = [...navigationBody.children], navigationState = { index: 0 };
    const directLinks = dashboardNavigation(row.links);
    directLinks.classList.add('dashboard-project-direct-links');
    let navigationGeometry = geometry;
    function footer(footer) {
      // Wide normal cards keep selected shortcuts flat; CSS hides this region
      // at narrow/edit widths. The single details control remains the fallback.
      const hasDetails = row.sections.some(section => section !== 'shortcuts'), key = hasDetails ? 'details' : 'links';
      if (hasDetails && directLinks.children.length) footer.append(directLinks);
      if (!hasDetails && !navigationLinks().length) return;
      if (!footerControls.has(key)) {
        const button = el('button', hasDetails ? '详情' : '入口', `ghost dashboard-project-${key}`); button.type = 'button';
        button.dataset.help = '弹窗查看所选内容及项目入口；链接原生新标签打开，不答复、不已读、不调用 Agent。';
        button.onclick = hasDetails ? details : () => {
          if (current()) void formDialog({ title: `${row.name || '项目'}入口`, content: dashboardNavigation(navigationLinks()), confirmLabel: '关闭' });
        };
        footerControls.set(key, button);
      }
      footer.append(footerControls.get(key));
    }
    function reflow(next) {
      const budget = aggregateBudget(row.sections, next), visible = new Set(budget.visible);
      navigationGeometry = next;
      if (navigationOnly) {
        const capacity = Math.max(0, Math.min(12, Math.floor((budget.body + 4) / 48)));
        reflowWidgetPage(navigationState, capacity);
        const pages = capacity ? Math.max(1, Math.ceil(navigationItems.length / capacity)) : 1;
        navigationState.index = Math.min(navigationState.index, pages - 1);
        navigationBody.replaceChildren(...(capacity ? navigationItems.slice(navigationState.index * capacity, (navigationState.index + 1) * capacity) : []));
        body.replaceChildren(...(capacity ? [navigationBody] : []));
        footer(widgetPagination(root, { previous: navigationState.index > 0, next: navigationState.index + 1 < pages,
          label: capacity && navigationItems.length ? `${navigationState.index + 1} / ${pages}` : '',
          onPrevious() { if (current()) { navigationState.index--; reflow(navigationGeometry); } },
          onNext() { if (current()) { navigationState.index++; reflow(navigationGeometry); } } }));
        return;
      }
      const desired = [...['metrics', 'distribution', 'delivery', 'messages'].filter(key => visible.has(key)).map(key => groups.get(key)), ...(row.sections.includes('recent') && budget.workers > 0 ? [workerBody] : [])];
      for (const child of [...body.children]) if (!desired.includes(child)) child.remove();
      for (let i = desired.length - 1; i >= 0; i--) if (desired[i].parentNode !== body) body.insertBefore(desired[i], desired.slice(i + 1).find(node => node.parentNode === body) || null);
      root.dataset.workerSlots = String(budget.workers);
      widgets.repaintMessages(row.id);
    }
    reflow(geometry);
    if (row.sections.includes('recent')) widgets.mountWorkers(root, workerBody, { ...row, type: 'workers', connection_ids: [] }, { geometry, current,
      capacityFor: geometry => aggregateBudget(row.sections, geometry).workers, onFooter: footer });
    else if (!navigationOnly) footer(widgetPagination(root, { previous: false, next: false, label: '', onPrevious() {}, onNext() {} }));
    const resize = root.dashboardGeometryChange;
    root.dashboardGeometryChange = next => { reflow(next); resize?.(next); };
    return root;
  }
  return { render, syncActions: widgets.syncActions, resetWorkers() { widgets.resetWorkers(); accountState.error = null; } };
}
