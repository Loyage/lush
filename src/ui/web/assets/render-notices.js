import { $, badge, button, el, syncChildren } from './dom.js';
import { action, api } from './api.js';
import { promptDialog } from './dialog.js';
import { show } from './messages.js';
import { notificationControl } from './notice-notifications.js';
import { absolute, relative, noticeNumber } from './format.js';
import { detail, refresh } from './navigate.js';
import { projectBase } from './route.js';
import { agentHelp } from './help.js';
import { activateDetailView, openResource, setNavCount, setViewChrome } from './sidebar-ui.js';
import { orderList } from './tree-order.js';
import { ui } from './state.js';
import { referenceable } from './context-references.js';
import { questionnairePanel } from './render-questionnaire.js';
import { settledDecision } from './choice-snapshot.js';
import { sleepChoiceCard } from './sleep-ui.js';
import { lifecycleNotice, unreadNotice, noticeMatches, positiveId, noticeIdentity } from './notice-kind.js';
import { searchField, noticeSearchText } from './search-field.js';
import { listEntry, listSurface } from './list-surface.js';
import { enhanceModule } from './shared-module.js';
import { workerLabel } from './worker-label.js';
import { linkWorkerNumbers } from './worker-links.js';

const STATUS = { open: '待处理', answered: '已回答', dismissed: '已忽略', sent: '已发送' };
const answerSource = notice => ['answered', 'dismissed'].includes(notice.status) && ['question', 'questionnaire'].includes(notice.kind)
  ? notice.answer_source === 'lush' ? 'Lush 自动选择' : notice.answer_source === 'user' ? '用户答复' : '答复来源未记录' : null;

export function initNoticeRecords() {
  const host = $('side-notices-body');
  if (!host) return;
  const state = ui.noticeRecords = { status: 'open', rows: [], page: null, request: 0,
    observedRevision: ui.lastSnapshot?.revision ?? null, stale: false, loadedPages: 0, query: '' };
  const tools = el('div', undefined, 'resource-tools');
  const filters = el('div', undefined, 'filters');
  const selectFilter = value => {
    state.status = value; state.page = null; state.rows = []; state.choices = [];
    state.stale = false; state.loadedPages = 0; state.request++; state.pending = false;
    $('notices')?.replaceChildren();
    for (const node of filters.children) node.setAttribute('aria-pressed', String(node.dataset.noticeFilter === value));
  };
  ui.selectNoticeFilter = selectFilter;
  for (const [value, label] of [['open','待决'],['unread','未读告知'],['automatic','自动选择'],['answered','已回答'],['dismissed','已忽略'],['all','全部记录']]) {
    const tab = button(label, () => { selectFilter(value); return loadNoticeRecords(); }, 'ghost');
    tab.dataset.noticeFilter = value;
    tab.setAttribute('aria-pressed', String(value === 'open')); filters.append(tab);
  }
  state.searchControl = searchField({ label: '搜索事项记录', placeholder: '标题、正文、答复或编号', scope: '范围：当前筛选已加载记录；加载更早后继续按已提交词筛选，不是全库检索', onSubmit: value => {
    state.query = value.toLocaleLowerCase(); paintNoticeRows(state.rows.filter(row => noticeMatches(row, state.status))); paintNoticeFooter(state);
  } });
  tools.append(state.searchControl.root, filters, notificationControl());
  const footer = $('notice-pagination') || el('div'); footer.id = 'notice-pagination'; footer.replaceChildren();
  host.replaceChildren(tools, $('notices'), footer);
  const root = $('side-notices'), card = root?.querySelector('.resource-card');
  const heading = card?.querySelector('.section-title');
  listSurface({ root, tools, card, heading, body: $('notices'), pagination: footer });
  ui.loadNoticeRecords = () => state.page ? Promise.resolve() : loadNoticeRecords();
}

async function readNoticeRecord(id, options) {
  const page = await api(`/api/notices?before=${Number(id) + 1}&limit=1`, options);
  const notice = page.notices?.find(row => row.id === id);
  if (!notice) throw new Error('该事项记录已不存在');
  return notice;
}

export async function loadNoticeRecords({ more = false, preserve = false, reload = false } = {}) {
  const state = ui.noticeRecords;
  if (!state) return;
  if (state.status === 'butler') return loadButlerChoices(state, { more, preserve });
  const request = ++state.request;
  state.pending = true;
  const revision = state.observedRevision;
  const status = state.status;
  const pagesToRead = reload ? Math.max(1, state.loadedPages) : 1;
  let cursor = more && state.page?.has_more ? `&before=${state.page.cursor}` : '';
  try {
    const notices = [];
    let page, pagesRead = 0;
    // Only a user-requested reload revisits older pages. Freeze the loaded-page
    // count; concurrent polling cannot expand this request into a history scan.
    do {
      page = await api(`/api/notices?status=${status}${cursor}`);
      if (ui.noticeRecords !== state || request !== state.request) return;
      if (!Array.isArray(page.notices)) throw new Error('请重启 Web 与 daemon 以加载 notice 历史');
      notices.push(...page.notices); pagesRead++;
      cursor = `&before=${page.cursor}`;
    } while (pagesRead < pagesToRead && page.has_more);
    page = { ...page, notices: [...new Map(notices.map(row => [row.id, row])).values()] };
    if (!Array.isArray(page.notices)) throw new Error('请重启 Web 与 daemon 以加载 notice 历史');
    page.notices = page.notices.filter(row => !ui.deletedWorkerIds.has(row.task_id))
      .map(row => ui.noticeReadRows.get(noticeIdentity(row)) || row)
      .filter(row => noticeMatches(row, status));
    state.rows = state.rows.filter(row => !ui.deletedWorkerIds.has(row.task_id));
    state.rows = more || preserve
      ? [...new Map([...state.rows, ...page.notices].map(row => [row.id, row])).values()]
        .filter(row => noticeMatches(row, status)).sort((a, b) => b.id - a.id)
      : page.notices;
    if (!preserve || !state.page) state.page = page;
    if (more) state.loadedPages += pagesRead;
    else if (!preserve) {
      state.loadedPages = pagesRead;
      state.stale = state.observedRevision !== revision;
    }
    for (const row of state.rows) ui.noticeIndex.set(row.id, row);
    paintNoticeRows(state.rows);
    paintNoticeFooter(state);
  } catch (error) {
    if (ui.noticeRecords === state && request === state.request) {
      paintNoticeFooter(state);
      $('notice-pagination').append(el('p', `记录加载失败：${error.message}`, 'error'),
        button('重试', () => loadNoticeRecords({ more, preserve, reload }), 'ghost'));
    }
  } finally { if (request === state.request) state.pending = false; }
}

function paintNoticeFooter(state) {
  const footer = $('notice-pagination');
  const rows = state.rows.filter(row => noticeMatches(row, state.status));
  const count = searchedNoticeRows(rows).length;
  footer.replaceChildren(el('p', count ? `已显示 ${count} / ${rows.length} 条已加载记录` : '当前筛选已加载记录中没有匹配；不代表全库无结果。', 'hint'));
  if (state.status === 'automatic') footer.append(el('p', '仅显示 Lush 自动选择处理的问答；不代表用户亲自决断。关闭自动选择后，记录仍保留。', 'hint'));
  if (state.stale) {
    const warning = el('p', '列表可能已过期；旧页未自动重查，打开事项时会核验当前状态。', 'hint');
    warning.setAttribute('role', 'status');
    footer.append(warning, button('刷新已加载记录', () => loadNoticeRecords({ reload: true }), 'ghost', {
      help: '只读重载当前已加载页数，保留当前答复；不会提交答案或调用 Agent。',
    }));
  }
  if (state.page?.has_more) footer.append(button('加载更早记录', () => loadNoticeRecords({ more: true }), 'ghost'));
}

async function loadButlerChoices(state, { more, preserve }) {
  const request = ++state.request;
  state.pending = true;
  try {
    const cursor = more && state.page?.has_more ? `?before=${state.page.cursor}` : '';
    const page = await api(`/api/sleep/choices${cursor}`);
    if (ui.noticeRecords !== state || request !== state.request || state.status !== 'butler') return;
    state.choices = more || preserve
      ? [...new Map([...(state.choices || []), ...page.choices].map(row => [row.id, row])).values()].sort((a, b) => b.id - a.id)
      : page.choices;
    if (!preserve || !state.page) state.page = page;
    $('notices').replaceChildren(...state.choices.map(sleepChoiceCard));
    const footer = $('notice-pagination');
    footer.replaceChildren(el('p', `已显示 ${state.choices.length} 条管家选择；代理决定不等于你亲自确认。`, 'hint'));
    if (state.page.has_more) footer.append(button('加载更早选择', () => loadNoticeRecords({ more: true }), 'ghost'));
  } catch (error) {
    if (request === state.request) $('notice-pagination').replaceChildren(el('p', `管家选择加载失败：${error.message}`, 'error'));
  } finally { if (request === state.request) state.pending = false; }
}

function paintRecordFocus() {
  const state = ui.noticePage;
  if (!state?.current() || !state.notice) return;
  const notice = ui.noticeIndex.get(state.id) || state.notice;
  if (ui.deletedWorkerIds.has(notice.task_id)) return;
  state.notice = notice;
  const number = noticeNumber(notice), title = number.startsWith('D') ? '决策详情' : '告知详情';
  setViewChrome(`${title} · ${number}`, '工作', notice.title);
  const signature = JSON.stringify(notice);
  // Polls must not erase an in-progress reply; a remotely settled record is read-only immediately.
  if (signature === state.signature) return;
  state.signature = signature;
  ui.detailDirty = false;
  state.focus.replaceChildren(noticePanel(notice, state.task));
}

function searchedNoticeRows(rows) {
  const query = ui.noticeRecords?.query || '';
  return rows.filter(row => !query || noticeSearchText(row).includes(query));
}

function paintNoticeRows(rows) {
  rows = searchedNoticeRows(rows);
  const container = $('notices');
  const known = new Map([...container.children].map(node => [Number(node.dataset.id), node]));
  const nodes = orderList(rows, { mode: ui.sidebarSortMode, timeOf: notice => notice.created_at }).map(notice => {
    const node = known.get(notice.id) || el('a', undefined, 'notice-brief'); node.dataset.id = notice.id;
    node.setAttribute('href', `#notices-${notice.id}`);
    node.onclick = event => {
      if (event && (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button > 0)) return;
      event?.preventDefault(); return openNotice(notice.id, { record: true });
    };
    node.className = `notice-brief${notice.kind === 'info' ? ' notice-info' : ' notice-question'}`;
    listEntry(node);
    node.replaceChildren();
    const row = el('span', undefined, 'row');
    row.append(badge(lifecycleNotice(notice) ? unreadNotice(notice) ? '未读告知' : '已读告知' : STATUS[notice.status] || notice.status, notice.status === 'open' ? 'b-awaiting' : 'b-neutral'),
      el('span', noticeNumber(notice), 'tid'), el('span', workerLabel(notice.task_id, notice.task_worker_number), 'tid'), el('span', relative(notice.created_at), 'when'));
    if (answerSource(notice)) row.append(badge(answerSource(notice), 'b-neutral'));
    node.append(row, el('span', notice.title, 'goal'));
    node.setAttribute('data-help', '打开这条记录的独立详情页；不自动答复、标记已读或启动 Agent。');
    referenceable(node, { kind: 'notice', target: { notice_id: notice.id }, label: `事项记录 ${noticeNumber(notice)}`,
      quote: `${notice.title}\n${notice.body || ''}`, location: { view: 'notice-list', notice_id: notice.id } });
    return node;
  });
  syncChildren(container, nodes);
}

/** 快照维护计数；信息页按需分页读完整记录。 */
export function renderNotices(data) {
  // A poll already in flight can contain pre-ACK rows; never resurrect acknowledged notices.
  data.notices = data.notices.filter(row => !ui.deletedWorkerIds.has(row.task_id))
    .map(row => ui.noticeReadRows.get(noticeIdentity(row)) || row);
  // 告知与决策分开计数，不把 info 当作需要答复的问题。
  const open = data.notices.filter(notice => notice.status === 'open');
  const unread = data.notices.filter(unreadNotice);
  ui.noticeIndex = new Map([...(ui.noticeRecords?.rows || []), ...(ui.noticePage?.notice ? [ui.noticePage.notice] : []), ...data.notices].map(notice => [notice.id, notice]));
  // notice 可能被 CLI 或另一个标签页答复/忽略；关掉了就不再展开。
  if (ui.noticeFocus !== null && ui.noticeIndex.get(ui.noticeFocus)?.status !== 'open') ui.noticeFocus = null;
  $('notice-count').textContent = unread.length ? `${open.length} 待决 · ${unread.length} 告知` : open.length ? String(open.length) : '无';
  setNavCount('notices', open.length + unread.length);
  if (ui.indexOpen === 'notices' && ui.noticeRecords?.status === 'butler') {
    if (!ui.noticeRecords.pending) void loadNoticeRecords({ preserve: true });
    return;
  }
  paintRecordFocus();
  if (ui.noticeRecords) {
    // Preserve loaded older pages. Snapshot updates their status without discarding history.
    const state = ui.noticeRecords;
    if (data.revision !== undefined && data.revision !== state.observedRevision) {
      state.observedRevision = data.revision;
      if (state.page || state.pending) state.stale = true;
    }
    if (state.page) {
      const newest = Math.max(0, ...state.rows.map(row => row.id));
      const additions = data.notices.filter(row => row.id > newest && noticeMatches(row, state.status));
      state.rows = [...additions, ...state.rows.map(row => ui.noticeIndex.get(row.id) || row)];
      const rows = ui.noticeRecords.rows.filter(row => noticeMatches(row, ui.noticeRecords.status));
      paintNoticeRows(rows);
      paintNoticeFooter(state);
    } else if (ui.indexOpen === 'notices') {
      if (!ui.noticeRecords.pending) void loadNoticeRecords();
    } else paintNoticeRows([...open, ...unread]);
    return;
  }
  paintNoticeRows([...open, ...unread]);
}
/** Explicit read acknowledgement only: no navigation, Agent, acceptance or merge. */
export function readNotice(notice) {
  if (ui.deletedWorkerIds.has(notice.task_id)) return Promise.resolve(notice);
  const key = noticeIdentity(notice);
  if (ui.noticeReadPending.has(key)) return ui.noticeReadPending.get(key);
  if (ui.noticeReadRows.has(key)) return Promise.resolve(ui.noticeReadRows.get(key));
  if (!unreadNotice(notice)) return Promise.resolve(notice);
  const pending = ui.noticeReadPending, reads = ui.noticeReadRows, source = projectBase();
  const request = Promise.resolve().then(async () => {
    if (source !== projectBase() || ui.noticeReadRows !== reads) throw new Error('项目已切换，请在原项目查看告知');
    if (ui.deletedWorkerIds.has(notice.task_id)) return notice;
    const current = await api('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'notice.read', params: { id: notice.id } }) });
    if (source !== projectBase() || ui.noticeReadRows !== reads || ui.deletedWorkerIds.has(notice.task_id)) return current;
    if (!current?.read_at || noticeIdentity(current) !== key) throw new Error('告知已读确认失败，请重试');
    reads.set(key, current);
    ui.noticeIndex.set(current.id, current);
    if (ui.noticeRecords) ui.noticeRecords.rows = ui.noticeRecords.rows.map(row => noticeIdentity(row) === key ? current : row);
    if (ui.lastSnapshot) renderNotices(ui.lastSnapshot);
    ui.refreshNoticeBanner?.();
    // The ACK is the durable success boundary. Global reads (including detail)
    // must not hold this notice's lock or report a successful read as failed.
    let refreshed = false;
    void Promise.resolve().then(() => {
      if (source !== projectBase() || ui.noticeReadRows !== reads || ui.busy) return;
      refreshed = true;
      return refresh();
    }).then(() => {
      if (refreshed && source === projectBase() && ui.noticeReadRows === reads && ui.offline) {
        show('告知已读，但页面刷新失败；稍后重试刷新。', 'error');
      }
    }).catch(error => {
      if (source === projectBase() && ui.noticeReadRows === reads) {
        show(`告知已读，但页面刷新失败：${error.message}`, 'error');
      }
    });
    return current;
  }).finally(() => {
    if (pending.get(key) === request) pending.delete(key);
    if (source === projectBase() && ui.noticeReadRows === reads) ui.refreshNoticeBanner?.();
  });
  pending.set(key, request);
  ui.refreshNoticeBanner?.();
  return request;
}

let noticeRequest = 0;
export async function openNotice(noticeId, { record = false, push = true } = {}) {
  if (!positiveId(noticeId)) return;
  const request = ++noticeRequest;
  const previousView = ui.view, source = projectBase(), reads = ui.noticeReadRows;
  const ownsProject = () => source === projectBase() && ui.noticeReadRows === reads;
  const notice = record ? null : ui.noticeIndex.get(noticeId) || await readNoticeRecord(noticeId);
  if (!ownsProject() || request !== noticeRequest || ui.view !== previousView || (notice && ui.deletedWorkerIds.has(notice.task_id))) return;
  if (notice) ui.noticeIndex.set(noticeId, notice);
  if (notice && lifecycleNotice(notice) && !record) {
    ui.noticeFocus = null;
    // loadDetail returns true only for a successfully rendered, still-current request.
    const loaded = await detail(notice.task_id);
    if (!ownsProject() || loaded !== true || request !== noticeRequest || ui.selected !== notice.task_id
      || ui.deletedWorkerIds.has(notice.task_id)) return;
    if (!unreadNotice(notice)) return;
    await readNotice(notice);
    return;
  }
  const old = ui.noticePage;
  const reuse = old?.id === noticeId && old.current();
  const view = activateDetailView({ view: 'notice', key: `notice-${noticeId}`, title: '事项详情', context: '工作',
    hint: '原始问题与处理结果', hash: `#notices-${noticeId}`, push });
  ui.noticeFocus = null;
  const state = reuse ? old : { id: noticeId, view, notice: null, task: null, signature: null };
  ui.noticePage = state;
  state.current = () => ownsProject() && ui.noticePage === state && ui.view === view;
  state.controller?.abort(); state.controller = new AbortController();
  const current = () => state.current() && request === noticeRequest;
  ui.disposeDetailRequests = () => state.controller.abort();
  if (!reuse) {
    const root = el('div', undefined, 'notice-detail-page');
    const tools = el('div', undefined, 'actions');
    const back = el('a', '返回待我处理', 'nav-link nav-back'); back.setAttribute('href', '#notices');
    back.onclick = event => {
      if (event && (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button > 0)) return;
      event?.preventDefault(); return openResource('notices');
    };
    state.worker = el('a', '查看 Worker 上下文', 'nav-link'); state.worker.hidden = true;
    state.worker.onclick = event => {
      if (event && (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button > 0)) return;
      event?.preventDefault(); return detail(state.notice.task_id);
    };
    tools.append(back, state.worker, button('刷新记录', () => openNotice(noticeId, { record: true }), 'ghost'));
    state.focus = el('div', undefined, 'notice-record-detail'); state.focus.id = 'notice-record-detail';
    state.message = el('p', '正在读取事项…', 'hint'); state.message.setAttribute('role', 'status');
    root.append(tools, state.message, state.focus); $('detail').replaceChildren(root);
  }
  try {
    const row = await readNoticeRecord(noticeId, { signal: state.controller.signal });
    if (!current() || ui.deletedWorkerIds.has(row.task_id)) return;
    const task = await api(`/api/worker/${row.task_id}`, { signal: state.controller.signal });
    if (!current() || ui.deletedWorkerIds.has(row.task_id)) return;
    state.task = task; state.notice = ui.noticeReadRows.get(noticeIdentity(row)) || row;
    state.worker.setAttribute('href', `#worker-${row.task_id}`); state.worker.hidden = false;
    ui.noticeIndex.set(noticeId, state.notice); state.message.replaceChildren(); paintRecordFocus();
    return true;
  } catch (error) {
    if (current() && error.name !== 'AbortError') {
      state.message.replaceChildren(el('span', `事项读取失败：${error.message}`, 'error'),
        button('重试读取', () => openNotice(noticeId, { record: true }), 'ghost'));
    }
  }
}

/* ---------- detail ---------- */
/** 独立事项详情与 Worker 内待决提醒共用原始正文、答复和历史回放。 */
export function noticePanel(notice, task = null) {
  const section = buildNoticePanel(notice, task), head = section.querySelector('.notice-head'), title = section.querySelector('h3');
  const meta = el('div', undefined, 'notice-meta');
  for (const node of [...head.childNodes]) meta.insertBefore(node, null);
  head.classList.add('section-title'); head.replaceChildren(meta); head.insertBefore(title, null);
  ui.noticeModuleStates ||= new Map();
  enhanceModule(section, { key: `notice-${notice.id}`, mode: 'fold', states: ui.noticeModuleStates,
    summary: `${STATUS[notice.status] || notice.status}${notice.status === 'open' && notice.kind !== 'info' ? ' · 等待明确答复，收起不表示已处理' : ''}` });
  return linkWorkerNumbers(section);
}
function buildNoticePanel(notice, task = null) {
  const section = el('section', undefined, `notice focus${notice.kind === 'info' ? ' notice-info' : ''}`);
  section.dataset.id = notice.id;
  const head = el('div', undefined, 'notice-head');
  head.append(el('span', noticeNumber(notice), 'tid'), badge(STATUS[notice.status] || notice.status, notice.status === 'open' ? 'b-awaiting' : 'b-neutral'), el('span', `Worker ${workerLabel(task || notice.task_id, notice.task_worker_number)}`, 'tid'),
    el('span', `${relative(notice.created_at)} · ${absolute(notice.created_at)}`, 'when'));
  if (answerSource(notice)) head.append(badge(answerSource(notice), 'b-neutral'));
  section.append(head, el('h3', notice.title));
  if (notice.status !== 'open') {
    if (notice.kind === 'questionnaire') section.append(settledDecision(notice));
    else {
      section.append(el('p', notice.body || '（没有补充说明）', 'notice-body'));
      section.append(el('p', notice.answer ? `处理结果：${notice.answer}` : notice.status === 'dismissed' ? '已忽略 · 不代表批准' : '无需答复', 'notice-body'));
    }
    if (lifecycleNotice(notice)) {
      if (unreadNotice(notice)) section.append(button('已知', () => readNotice(notice), 'ghost', {
        help: '只将这条告知标为已读，不提交答案、不批准合并或调用 Agent。',
      }));
      section.append(button('查看 Worker', () => openNotice(notice.id), 'ghost', {
        worker: task || notice.task_id,
      }));
    }
    return section;
  }
  const inRecords = ui.view?.id === 'notice' && ui.noticePage?.id === notice.id;
  // Writes still refresh shared data, but their follow-up must not navigate a newer page
  // or replace another selected Notice (which can share the same page identity).
  const actionIdentity = () => {
    const view = ui.view, request = noticeRequest, page = ui.noticePage, source = projectBase(), reads = ui.noticeReadRows;
    return () => ui.view === view && noticeRequest === request && source === projectBase() && reads === ui.noticeReadRows
      && (!inRecords || (ui.noticePage === page && page?.id === notice.id));
  };
  const refreshRecord = async ownsPage => {
    if (!ownsPage()) return;
    ui.detailDirty = false;
    if (!inRecords) return detail(notice.task_id);
    const current = await readNoticeRecord(notice.id);
    if (!ownsPage()) return;
    ui.noticeIndex.set(current.id, current);
    ui.noticePage.notice = current;
    paintRecordFocus();
  };
  const completedElsewhere = () => show('事项已处理；保留当前页面。');
  if (notice.kind === 'plan') {
    section.append(el('p', notice.body || '（没有补充说明）', 'notice-body'));
    const actions = el('div', undefined, 'actions');
    const send = async (method, params) => {
      const ownsPage = actionIdentity();
      actions.querySelectorAll('button').forEach(node => { node.disabled = true; });
      try { await action(method, params); if (ownsPage()) await refreshRecord(ownsPage); else completedElsewhere(); }
      finally { actions.querySelectorAll('button').forEach(node => { node.disabled = false; }); }
    };
    actions.append(button('批准并开发', () => send('plan.approve', { id: notice.id }), undefined,
      { agent: true, help: agentHelp('批准这份拆解并交给 scheduler 编排成真实 Worker，随后会启动开发 Agent 执行。') }), button('驳回', async () => {
      const reason = await promptDialog({ title: '驳回计划', message: '说明需要调整的地方。', confirmLabel: '驳回' });
      if (reason?.trim()) await send('plan.reject', { id: notice.id, reason: reason.trim() });
    }, 'ghost', { agent: true, help: agentHelp('把驳回理由送给 planner，让它据此重新拆解计划。') }));
    section.append(actions); return section;
  }
  if (notice.kind === 'questionnaire') {
    const settled = async (method, params) => {
      const ownsPage = actionIdentity();
      await action(method, params);
      if (!ownsPage()) { completedElsewhere(); return; }
      ui.detailDirty = false;
      if (inRecords) { await refreshRecord(ownsPage); return; }
      const next = [...ui.noticeIndex.values()].filter(row => row.id !== notice.id && row.status === 'open').sort((a, b) => a.id - b.id)[0];
      ui.noticeFocus = next?.id ?? null;
      try { await detail(next?.task_id ?? notice.task_id); }
      catch (error) { $('error').textContent = `答案已提交，详情刷新失败：${error.message}`; }
    };
    section.append(questionnairePanel(notice, {
      settle: answer => settled('notice.answer', { id: notice.id, answer }),
      dismiss: () => settled('notice.dismiss', { id: notice.id }),
    }));
    section.append(button(inRecords ? '查看 Worker 上下文' : '收起，只看 Worker 详情', () => { ui.noticeFocus = null; ui.detailDirty = false; return detail(notice.task_id); }, 'ghost',
      inRecords ? { worker: task || notice.task_id } : { help: '收起这条待决提醒，回到 Worker 详情；待决事项仍保留在列表里。' }));
    referenceable(section, { kind: 'notice', target: { notice_id: notice.id }, label: `待定事项 ${noticeNumber(notice)}`,
      quote: `${notice.title}\n${notice.body || ''}`, location: { view: 'notice-detail', notice_id: notice.id, task_id: notice.task_id } });
    return section;
  }
  section.append(el('p', notice.body || '（没有补充说明）', 'notice-body'));

  const resolutionDecision = task?.role === 'merger' && task.resolves_task_id && task.agent_wakes === 0;
  const answer = resolutionDecision ? null : el('textarea');
  if (answer) {
    answer.placeholder = '你的决定；⌘/Ctrl+回车提交'; answer.rows = 3;
    answer.addEventListener('input', () => { ui.detailDirty = true; });
  }
  const actions = el('div', undefined, 'actions');
  const settle = async value => {
    const ownsPage = actionIdentity();
    actions.querySelectorAll('button').forEach(node => { node.disabled = true; });
    try {
      await action('notice.answer', { id: notice.id, answer: value });
      if (!ownsPage()) { completedElsewhere(); return; }
      ui.noticeFocus = null; ui.detailDirty = false;
      await refreshRecord(ownsPage);
    } finally { actions.querySelectorAll('button').forEach(node => { node.disabled = false; }); }
  };
  const dismiss = async () => {
    const ownsPage = actionIdentity();
    actions.querySelectorAll('button').forEach(node => { node.disabled = true; });
    try {
      await action('notice.dismiss', { id: notice.id });
      if (!ownsPage()) { completedElsewhere(); return; }
      ui.noticeFocus = null; ui.detailDirty = false;
      await refreshRecord(ownsPage);
    } finally { actions.querySelectorAll('button').forEach(node => { node.disabled = false; }); }
  };
  if (resolutionDecision) actions.append(
    button('开始解冲突', () => settle('批准，开始解冲突'), undefined,
      { agent: true, help: agentHelp('批准并启动解冲突 Agent，把父分支合进当前分支并处理合并冲突。') }),
    button('暂不处理', dismiss, 'ghost', { help: '忽略这条待决事项，不代表批准；它不会再出现在待处理列表。' }));
  else actions.append(
    button('回复并继续 Worker', () => settle(answer.value), undefined,
      { agent: true, help: agentHelp('把你的答复发给该 Worker 的 Agent，它会继续当前工作。') }),
    button('忽略', dismiss, 'ghost', { help: '忽略这条待决事项，不代表批准；它不会再出现在待处理列表。' }));
  actions.append(button(inRecords ? '查看 Worker 上下文' : '收起，只看 Worker 详情', () => { ui.noticeFocus = null; ui.detailDirty = false; return detail(notice.task_id); }, 'ghost',
    inRecords ? { worker: task || notice.task_id } : { help: '收起这条待决提醒，回到 Worker 详情；待决事项仍保留在列表里。' }));
  if (answer) answer.addEventListener('keydown', event => {
    if (event.key !== 'Enter' || event.isComposing || event.shiftKey) return;
    if (!event.metaKey && !event.ctrlKey) return;
    event.preventDefault(); actions.querySelector('button').click();
  });
  section.append(...(answer ? [answer] : []), actions);
  referenceable(section, { kind: 'notice', target: { notice_id: notice.id }, label: `待定事项 ${noticeNumber(notice)}`,
    quote: `${notice.title}\n${notice.body || ''}`, location: { view: 'notice-detail', notice_id: notice.id, task_id: notice.task_id } });
  return section;
}
