import { widgetPagination } from './dashboard-widget-pagination.js';
import { api } from './api.js';
import { formDialog } from './dialog.js';
import { el } from './dom.js';
import { noticeNumber, workerNumber, taskTitle, STATUS } from './format.js';
import { unreadNotice, positiveId } from './notice-kind.js';
import { noticeSyncIdentity, sameInboxRecord, validateInboxItem } from './global-inbox-model.js';
import { projectHref } from './route.js';
import { renderAccountGroup } from './dashboard-accounts-group.js';
import { WIDGET_NAMES, GLOBAL_LINKS, PROJECT_LINKS, widgetSlots, reflowWidgetPage } from './dashboard-widget-model.js';
import { onlineDashboardProject, pendingDashboardNotice, loadProjectMessageGroup } from './project-dashboard-content.js';

const link = (text, href, className) => {
  const node = el('a', text, className); node.href = href; node.target = '_blank'; node.rel = 'noopener'; return node;
};
/** Transient pages and source-specific write locks survive board geometry repaints. */
export function createWidgetRenderer({ ownsPage = () => true, canAct = ownsPage, messages = () => new Map(), refresh, refreshAccounts } = {}) {
  const owner = globalThis.document;
  const pages = new Map(), readLocks = new Map(), actionSync = new Map(), messagePaints = new Map();
  const stateFor = row => {
    const identity = JSON.stringify([row.type, row.project_id, row.connection_ids, row.links]);
    if (pages.get(row.id)?.identity !== identity) {
      pages.get(row.id)?.abort?.abort();
      pages.set(row.id, { identity, type: row.type, index: 0, pages: [], busy: false, epoch: 0 });
    }
    return pages.get(row.id);
  };
  function render(row, { geometry = row.geometry } = {}) {
    const state = stateFor(row);
    if (row.type === 'accounts') {
      const root = renderAccountGroup(row, { sections: row.sections, sectionsForAccount: account => row.accountSections?.[account.id], geometry, state, bounded: true,
        ownsPage: () => owner === globalThis.document && canAct(), refresh, refreshAll: typeof refreshAccounts === 'function' ? () => refreshAccounts(row.connection_ids) : undefined });
      root.classList.add('dashboard-widget'); root.dataset.widgetType = row.type; root.dataset.cardId = row.id; return root;
    }
    const root = el('li', undefined, `project-item dashboard-widget dashboard-widget-${row.type}`);
    root.dataset.widgetType = row.type; root.dataset.cardId = row.id;
    const header = el('header', undefined, 'dashboard-widget-header');
    header.append(el('h2', row.name || WIDGET_NAMES[row.type], 'dashboard-widget-title')); root.append(header);
    const body = el('div', undefined, 'dashboard-widget-body'); root.append(body);
    const current = () => owner === globalThis.document && ownsPage() && root.parentNode != null && stateFor(row) === state;
    if (row.source?.error || (row.source && !onlineDashboardProject(row.source))) header.append(el('span', row.source.error || '离线', 'dashboard-widget-source-error'));
    if (row.type === 'status') status(body, row);
    if (row.type === 'messages' && row.sections.includes('messages')) messageLines(root, body, row, current);
    if (row.type === 'workers' && row.sections.includes('recent')) workers(root, body, row, state, geometry, current);
    if (row.type === 'shortcuts' && row.sections.includes('shortcuts')) shortcuts(root, body, row, state, geometry, current);
    return root;
  }
  function status(body, row) {
    const summary = onlineDashboardProject(row.source) ? row.source.summary?.development : null;
    if (!summary) { body.append(el('p', onlineDashboardProject(row.source) ? '摘要未确认' : '状态未确认', 'dashboard-widget-error')); return; }
    if (row.sections.includes('metrics')) {
      const metrics = el('div', undefined, 'project-development-metrics dashboard-widget-metrics');
      for (const [label, value, tone] of [['Worker', summary.workers_total, 'blue'], ['进行中', summary.active, 'violet'], ['待验收', summary.awaiting_acceptance, 'violet'], ['待答', row.source.summary.notices, 'green']]) {
        const metric = el('div', undefined, `project-development-metric dashboard-widget-metric tone-${tone}`);
        metric.append(el('span', label, 'metric-label'), el('strong', Number.isSafeInteger(value) ? String(value) : '—', 'project-development-value')); metrics.append(metric);
      }
      body.append(metrics);
    }
    if (row.sections.includes('distribution')) {
      const distribution = el('div', undefined, 'project-development-distribution');
      for (const item of summary.counts || []) if (item.count > 0) distribution.append(el('span', `${STATUS[item.status]?.label || '未知'} ${item.count}`, `chip c-${item.status}`));
      body.append(distribution);
    }
    if (row.sections.includes('delivery')) body.append(el('p', `待合并 ${summary.pending_merges ?? '—'} · 合并中 ${summary.merging ?? '—'} · 冲突 ${summary.merge_conflicts ?? '—'}`, 'project-development-delivery'));
  }
  async function nextInfo(row, model) {
    const group = model.groups.unread;
    const active = () => owner === globalThis.document && ownsPage() && messages().get(row.project_id) === model
      && [...messagePaints.values()].some(paint => paint.project_id === row.project_id && paint.current());
    if (!group.needNext || group.loadingNext || !active()) return;
    group.needNext = false; group.loadingNext = true; group.nextError = null;
    const epoch = group.ackVersion || 0;
    const repaint = () => { for (const paint of messagePaints.values()) if (paint.project_id === row.project_id) paint(); };
    repaint();
    try {
      const next = await loadProjectMessageGroup(row.source, 'unread', { ownsPage: active });
      if (!active() || epoch !== (group.ackVersion || 0)) { group.needNext = true; return; }
      Object.assign(group, next, { error: false });
      model.notices = [...new Map([...model.notices, ...next.notices].map(notice => [notice.id, notice])).values()];
      model.complete = Object.values(model.groups).every(group => !group.error && !group.has_more);
      model.error = Object.values(model.groups).some(group => group.error);
    } catch {
      if (active()) group.nextError = '下一条读取失败（当前已知已确认）';
      else if (ownsPage() && messages().get(row.project_id) === model) group.needNext = true;
    } finally { group.loadingNext = false; repaint(); }
  }
  function messageLines(root, body, row, current, { viewKey = row.id, footer: showFooter = true } = {}) {
    const model = messages().get(row.project_id);
    const error = el('span', undefined, `dashboard-widget-error${showFooter ? '' : ' dashboard-widget-title'}`); error.hidden = true;
    if (showFooter) {
      const footer = el('footer', undefined, 'dashboard-widget-footer'); footer.append(link('查看全部', projectHref(row.project_id, '/#notices')), error); root.append(footer);
    }
    const paint = () => {
      body.replaceChildren();
      for (const [key, title] of [['open', '待答'], ['unread', '告知']]) {
        const group = model?.groups?.[key], notice = group?.notices?.[0];
        const unknownOpen = key === 'open' && group?.notices?.some(item => !pendingDashboardNotice(item));
        const line = el('div', undefined, `dashboard-widget-message ${unknownOpen ? 'tone-neutral' : key === 'open' ? 'tone-amber' : 'tone-blue'}`);
        const confirmed = onlineDashboardProject(row.source) && !model?.offline && group && !group.error;
        const count = confirmed ? `${group.total ?? group.notices.length}${group.exact ? '' : '+'}` : '—';
        line.append(el('span', `${unknownOpen ? '待处理' : title} ${count}`, 'dashboard-widget-count'));
        if (confirmed && notice) {
          const target = link(undefined, projectHref(row.project_id, `/#notices-${notice.id}`), 'project-dashboard-message dashboard-widget-title');
          target.append(el('span', noticeNumber(notice), 'tid'), el('strong', notice.title || '未命名消息'), el('small', workerNumber({ id: notice.task_id, worker_number: notice.task_worker_number })));
          if (key === 'open' && !pendingDashboardNotice(notice)) { target.classList.add('dashboard-widget-unknown'); target.append(el('small', '类型未知')); }
          line.append(target);
          if (key === 'unread' && notice.kind === 'info' && unreadNotice(notice)) {
            const host = el('span', undefined, 'help-host'), button = el('button', '已知', 'ghost dashboard-widget-notice-read'); button.type = 'button';
            button.dataset.help = '仅标记当前这条告知已读，不答复问题、不调用 Agent。'; host.append(button); line.append(host);
            const id = `${row.project_id}:${notice.id}:${notice.sync_identity || notice.created_at}`;
            const sourceReady = typeof row.source?.project === 'string' && !!row.source.project && typeof notice.created_at === 'string' && !!notice.created_at;
            const sync = () => { button.disabled = !sourceReady || group.loadingNext || readLocks.has(id) || !canAct(); if (button.disabled) { host.dataset.help = !sourceReady ? '来源身份未确认，请刷新后核验；不会提交已知。' : '此告知请求在途或页面忙碌，请等待确认。'; host.setAttribute('tabindex', '0'); } else { delete host.dataset.help; host.removeAttribute('tabindex'); } };
            button.onclick = async () => {
              if (!sourceReady || group.loadingNext || !current() || !canAct() || readLocks.has(id) || group.notices[0] !== notice || !unreadNotice(notice)) return;
              readLocks.set(id, true); for (const update of actionSync.values()) update(); error.hidden = true;
              try {
                const original = { project_id: row.project_id, project: row.source.project, notice };
                const identity = noticeSyncIdentity(notice);
                const receipt = validateInboxItem(await api('/api/host/inbox/action', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ project_id: row.project_id, id: notice.id, method: 'notice.read', ...(identity ? { expected_identity: identity } : {}) }) }));
                if (!sameInboxRecord(original, receipt) || receipt.project !== original.project || receipt.notice.task_id !== notice.task_id || receipt.notice.kind !== 'info' || !receipt.notice.read_at) throw new Error('告知确认与来源不一致，请刷新核对');
                if (owner !== globalThis.document || !ownsPage()) return;
                // A concurrent refresh may have replaced the model while this write was in flight.
                for (const snapshot of new Set([model, messages().get(row.project_id)])) {
                  if (!snapshot) continue;
                  const matches = item => item.kind === 'info' && sameInboxRecord(original, { project_id: row.project_id, notice: item });
                  const currentGroup = snapshot.groups?.unread;
                  if (currentGroup) {
                    currentGroup.ackVersion = (currentGroup.ackVersion || 0) + 1;
                    const removed = currentGroup.notices.filter(matches).length;
                    currentGroup.notices = currentGroup.notices.filter(item => !matches(item));
                    if (removed) {
                      currentGroup.total = Math.max(currentGroup.notices.length, (currentGroup.total || 0) - removed);
                      if (!currentGroup.notices.length && (currentGroup.total > 0 || currentGroup.has_more)) currentGroup.needNext = true;
                    } else if (snapshot !== model) currentGroup.needNext = true;
                  }
                  snapshot.notices = snapshot.notices.filter(item => !matches(item));
                }
                for (const repaint of messagePaints.values()) repaint();
                const snapshot = messages().get(row.project_id);
                if (snapshot?.groups?.unread?.needNext) await nextInfo(row, snapshot);
              } catch (failure) { if (current()) { error.textContent = `已知失败：${failure.message}`; error.hidden = false; } }
              finally { readLocks.delete(id); for (const update of actionSync.values()) update(); }
            }; actionSync.set(`${viewKey}:${key}`, () => { if (current()) sync(); }); sync();
          }
        } else line.append(el('span', confirmed ? (group.loadingNext ? '读取中…' : group.nextError || (group.total || (!group.exact && group.has_more) ? '最新记录未加载' : '暂无')) : '未确认', 'dashboard-widget-title'));
        if (key === 'unread' && !showFooter) line.append(error);
        body.append(line);
      }
      if (model?.groups?.unread?.needNext && current()) queueMicrotask(() => { void nextInfo(row, model); });
    };
    const repaint = () => { if (current()) paint(); };
    repaint.project_id = row.project_id; repaint.current = current; messagePaints.set(viewKey, repaint);
    paint();
  }
  function workers(root, body, row, state, geometry, current, options = {}) {
    const capacityFor = options.capacityFor || (geometry => widgetSlots('workers', geometry));
    let capacity = capacityFor(geometry);
    const slots = el('div', undefined, 'dashboard-widget-slots'); body.append(slots);
    const paint = () => {
      const page = state.pages[state.index]; slots.replaceChildren(); slots.dataset.slotCount = String(capacity);
      for (let i = 0; i < capacity; i++) {
        const slot = el('div', undefined, 'dashboard-widget-slot dashboard-widget-worker'), task = page?.tasks[i];
        if (task) {
          const target = link(undefined, projectHref(row.project_id, `/#worker-${task.id}`), 'dashboard-widget-title');
          target.append(el('span', workerNumber(task), 'tid'), el('span', taskTitle(task)));
          slot.append(target, el('span', STATUS[task.status]?.label || '状态未知', `chip c-${task.status}`));
        } else { slot.dataset.empty = 'true'; slot.setAttribute('aria-hidden', 'true'); } slots.append(slot);
      }
      const footer = widgetPagination(root, { previous: capacity > 0 && state.index > 0 && !state.busy, next: capacity > 0 && !!page?.has_more && !state.busy,
        label: state.error || (capacity === 0 ? '无可用行' : state.busy ? '读取中…' : page ? `第 ${state.index + 1} 页${page.has_more ? ' +' : ''}` : '未确认'),
        onPrevious: () => {
          if (capacity === 0 || !current() || state.busy || state.index === 0) return;
          const index = state.index - 1, previous = state.pages[index];
          if (previous?.capacity === capacity) { state.index = index; paint(); }
          else return loadTracked(previous?.before ?? null, index);
        },
        onNext: () => {
          if (capacity === 0 || !current() || state.busy || !page?.has_more) return;
          const index = state.index + 1, next = state.pages[index];
          if (next?.capacity === capacity && next.before === page.cursor) { state.index = index; paint(); }
          else return loadTracked(page.cursor, index);
        } });
      footer.children[1].classList.toggle('dashboard-widget-error', !!state.error);
      if (options.onFooter) options.onFooter(footer);
      else footer.append(link('全部 Worker', projectHref(row.project_id, '/#workers')));
    };
    async function load(before, index) {
      if (capacity === 0 || !onlineDashboardProject(row.source) || !current() || state.busy) return;
      state.busy = true; state.error = null; state.loadingBefore = before;
      const epoch = ++state.epoch, limit = capacity;
      state.abort = new AbortController(); paint();
      try {
        const page = await api(projectHref(row.project_id, `/api/workers?scope=work&limit=${limit}${before ? `&before=${before}` : ''}`), { signal: state.abort.signal });
        if (owner !== globalThis.document || !ownsPage() || epoch !== state.epoch) return;
        if (!Array.isArray(page?.tasks) || page.tasks.length > limit || page.tasks.some(task => !positiveId(task?.id)) || typeof page.has_more !== 'boolean' || (page.has_more && (!positiveId(page.cursor) || (before && page.cursor >= before)))) throw new Error('Worker 分页响应未确认');
        // A changed cursor invalidates later cached pages, not the current source anchor.
        if (state.pages[index + 1]?.before !== page.cursor) state.pages.length = index + 1;
        state.pages[index] = { ...page, before, capacity: limit, tasks: [...page.tasks].sort((a, b) => b.id - a.id) }; state.index = index;
      } catch (failure) { if (ownsPage() && epoch === state.epoch) state.error = `读取失败：${failure.message}`; }
      finally { if (epoch === state.epoch) { state.busy = false; state.abort = null; state.repaint?.(); } }
    }
    function loadTracked(before, index) {
      const pending = load(before, index); state.pending = pending;
      void pending.finally(() => { if (state.pending === pending) state.pending = null; }); return pending;
    }
    function resize(next) {
      const nextCapacity = capacityFor(next);
      if (state.capacity === nextCapacity) return;
      const page = state.pages[state.index];
      const before = page ? page.before : state.reload ? state.reload.before : state.loadingBefore ?? null;
      state.epoch++; state.abort?.abort(); state.busy = false; state.pending = null;
      capacity = nextCapacity; state.capacity = nextCapacity; state.reload = { before, index: state.index };
      state.pages[state.index] = null; state.pages.length = state.index + 1;
      paint(); queueMicrotask(() => { if (current()) void root.dashboardReady(); });
    }
    state.repaint = () => { if (current()) paint(); };
    root.dashboardGeometryChange = resize;
    root.dashboardReady = () => {
      if (capacity === 0) return Promise.resolve();
      if (state.pending) return state.pending;
      if (state.reload) { const { before, index } = state.reload; state.reload = null; return loadTracked(before, index); }
      if (state.pages[state.index] || state.busy || state.error) return Promise.resolve();
      return loadTracked(null, 0);
    };
    if (state.offline && onlineDashboardProject(row.source)) { state.error = null; state.offline = false; }
    if (state.capacity !== capacity) resize(geometry); else paint();
    queueMicrotask(() => { if (current()) void root.dashboardReady(); });
    if (!onlineDashboardProject(row.source)) { state.pages = []; state.index = 0; state.offline = true; state.error = '来源离线，Worker 未确认'; paint(); }
  }
  function shortcuts(root, body, row, state, geometry, current) {
    let capacity = widgetSlots('shortcuts', geometry);
    reflowWidgetPage(state, capacity);
    const slots = el('nav', undefined, 'dashboard-widget-slots dashboard-widget-links'); body.append(slots);
    let footer;
    function paint() {
      if (capacity > 0) state.index = Math.min(state.index, Math.max(0, Math.ceil(row.links.length / capacity) - 1)); slots.replaceChildren(); slots.dataset.slotCount = String(capacity);
      for (let i = 0; i < capacity; i++) {
        const slot = el('div', undefined, 'dashboard-widget-slot'), item = row.links[state.index * capacity + i];
        if (item) slot.append(link(`${item.scope === 'project' ? `${row.linkLabels?.[state.index * capacity + i] || '来源项目不可用'} · ` : ''}${(item.scope === 'global' ? GLOBAL_LINKS : PROJECT_LINKS).find(([target]) => target === item.target)?.[1] || item.target}`,
          item.scope === 'global' ? `/#${item.target}` : projectHref(item.project_id, `/#${item.target}`)));
        else { slot.dataset.empty = 'true'; slot.setAttribute('aria-hidden', 'true'); } slots.append(slot);
      }
      footer = widgetPagination(root, { previous: capacity > 0 && state.index > 0, next: capacity > 0 && (state.index + 1) * capacity < row.links.length,
        label: capacity ? `${row.links.length ? state.index + 1 : 0} / ${Math.ceil(row.links.length / capacity)}` : `— · ${row.links.length}`,
        onPrevious: () => { if (capacity > 0 && current() && state.index > 0) { state.index--; paint(); } }, onNext: () => { if (capacity > 0 && current() && (state.index + 1) * capacity < row.links.length) { state.index++; paint(); } } });
      if (capacity === 0) {
        const more = el('button', '全部入口', 'ghost dashboard-widget-fullpage'); more.type = 'button';
        more.onclick = () => {
          if (!current()) return;
          const nav = el('nav');
          for (const item of row.links) nav.append(link(`${item.scope === 'project' ? `${row.linkLabels?.[row.links.indexOf(item)] || '来源项目不可用'} · ` : ''}${(item.scope === 'global' ? GLOBAL_LINKS : PROJECT_LINKS).find(([target]) => target === item.target)?.[1] || item.target}`,
            item.scope === 'global' ? `/#${item.target}` : projectHref(item.project_id, `/#${item.target}`)));
          void formDialog({ title: '常用入口', content: nav, confirmLabel: '关闭' });
        }; footer.append(more);
      }
    }
    root.dashboardGeometryChange = next => {
      const nextCapacity = widgetSlots('shortcuts', next);
      if (capacity === nextCapacity) return;
      capacity = nextCapacity; reflowWidgetPage(state, capacity); paint();
    };
    paint();
  }
  return { render, mountMessages: messageLines,
    repaintMessages(viewKey) { messagePaints.get(viewKey)?.(); },
    mountWorkers(root, body, row, options) { return workers(root, body, row, stateFor(row), options.geometry, options.current, options); },
    syncActions() { for (const sync of actionSync.values()) sync(); }, resetWorkers() { for (const state of pages.values()) if (state.type === 'workers') { state.epoch++; state.abort?.abort(); state.pages = []; state.index = 0; state.busy = false; state.pending = null; state.error = null; state.reload = null; state.loadingBefore = null; } } };
}
