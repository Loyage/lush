import { $, badge, button, el, syncChildren } from './dom.js';
import { action, api } from './api.js';
import { promptDialog } from './dialog.js';
import { show } from './messages.js';
import { notificationControl } from './notice-notifications.js';
import { absolute, relative } from './format.js';
import { detail, refresh } from './navigate.js';
import { projectBase } from './route.js';
import { agentHelp } from './help.js';
import { setNavCount } from './sidebar-ui.js';
import { orderList } from './tree-order.js';
import { ui } from './state.js';
import { referenceable } from './context-references.js';
import { questionnairePanel } from './render-questionnaire.js';
import { settledDecision } from './choice-snapshot.js';
import { sleepChoiceCard } from './sleep-ui.js';
import { lifecycleNotice, unreadNotice, noticeMatches, positiveId, noticeIdentity } from './notice-kind.js';
import { workerLabel } from './worker-label.js';
import { linkWorkerNumbers } from './worker-links.js';

const STATUS = { open: '待处理', answered: '已回答', dismissed: '已忽略', sent: '已发送' };
const answerSource = notice => ['answered', 'dismissed'].includes(notice.status) && ['question', 'questionnaire'].includes(notice.kind)
  ? notice.answer_source === 'lush' ? 'Lush 自动选择' : notice.answer_source === 'user' ? '用户答复' : '答复来源未记录' : null;

export function initNoticeRecords() {
  const host = $('side-notices-body');
  if (!host) return;
  const state = ui.noticeRecords = { status: 'open', rows: [], page: null, request: 0, selected: null, task: null, signature: null,
    observedRevision: ui.lastSnapshot?.revision ?? null, stale: false, loadedPages: 0 };
  const tools = el('div', undefined, 'resource-tools');
  const filters = el('div', undefined, 'filters');
  for (const [value, label] of [['open','待决'],['unread','未读告知'],['answered','已回答'],['dismissed','已忽略'],['all','全部记录']]) {
    const tab = button(label, () => {
      state.status = value; state.page = null; state.rows = []; state.choices = []; state.selected = null;
      state.stale = false; state.loadedPages = 0;
      $('notice-record-detail')?.replaceChildren();
      for (const node of filters.children) node.setAttribute('aria-pressed', String(node === tab));
      return loadNoticeRecords();
    }, 'ghost');
    tab.dataset.noticeFilter = value;
    tab.setAttribute('aria-pressed', String(value === 'open')); filters.append(tab);
  }
  tools.append(filters, notificationControl());
  const footer = $('notice-pagination') || el('div'); footer.id = 'notice-pagination'; footer.replaceChildren();
  const focus = $('notice-record-detail') || el('div'); focus.id = 'notice-record-detail'; focus.replaceChildren();
  host.replaceChildren(tools, $('notices'), footer, focus);
  ui.loadNoticeRecords = () => loadNoticeRecords();
}

async function readNoticeRecord(id) {
  const page = await api(`/api/notices?before=${Number(id) + 1}&limit=1`);
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
    const selected = state.selected;
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
    // A settled old question may have fallen outside both the snapshot and this filtered page.
    const current = selected && !page.notices?.some(row => row.id === selected) ? await readNoticeRecord(selected) : null;
    if (ui.noticeRecords !== state || request !== state.request) return;
    if (current && selected === state.selected) {
      ui.noticeIndex.set(current.id, current);
      state.rows = state.rows.map(row => row.id === current.id ? current : row);
    }
    if (!Array.isArray(page.notices)) throw new Error('请重启 Web 与 daemon 以加载 notice 历史');
    page.notices = page.notices.filter(row => !ui.deletedWorkerIds.has(row.task_id));
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
    paintRecordFocus();
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
  footer.replaceChildren(el('p', state.rows.length ? `已显示 ${state.rows.length} 条记录` : '没有符合条件的记录', 'hint'));
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
    $('notice-record-detail').replaceChildren();
    const footer = $('notice-pagination');
    footer.replaceChildren(el('p', `已显示 ${state.choices.length} 条管家选择；代理决定不等于你亲自确认。`, 'hint'));
    if (state.page.has_more) footer.append(button('加载更早选择', () => loadNoticeRecords({ more: true }), 'ghost'));
  } catch (error) {
    if (request === state.request) $('notice-pagination').replaceChildren(el('p', `管家选择加载失败：${error.message}`, 'error'));
  } finally { if (request === state.request) state.pending = false; }
}

function paintRecordFocus() {
  const state = ui.noticeRecords;
  const target = $('notice-record-detail');
  if (!target || !state?.selected || state.status === 'butler') return;
  const notice = ui.noticeIndex.get(state.selected);
  if (!notice) return;
  const signature = JSON.stringify(notice);
  // Polls must not erase an in-progress reply; a remotely settled record is read-only immediately.
  if (signature === state.signature) return;
  state.signature = signature;
  ui.detailDirty = false;
  target.replaceChildren(noticePanel(notice, state.task));
}

function paintNoticeRows(rows) {
  const container = $('notices');
  const known = new Map([...container.children].map(node => [Number(node.dataset.id), node]));
  const nodes = orderList(rows, { mode: ui.sidebarSortMode, timeOf: notice => notice.created_at }).map(notice => {
    const node = known.get(notice.id) || button('', () => openNotice(notice.id), 'notice-brief'); node.dataset.id = notice.id;
    node.className = `notice-brief${ui.noticeRecords?.selected === notice.id || ui.noticeFocus === notice.id ? ' selected' : ''}`;
    node.replaceChildren();
    const row = el('span', undefined, 'row');
    row.append(badge(lifecycleNotice(notice) ? unreadNotice(notice) ? '未读告知' : '已读告知' : STATUS[notice.status] || notice.status, notice.status === 'open' ? 'b-awaiting' : 'b-neutral'),
      el('span', workerLabel(notice.task_id, notice.task_worker_number), 'tid'), el('span', relative(notice.created_at), 'when'));
    if (answerSource(notice)) row.append(badge(answerSource(notice), 'b-neutral'));
    node.append(row, el('span', notice.title, 'goal'));
    node.setAttribute('data-help', lifecycleNotice(notice) ? '打开对应 Worker；成功加载后自动已读，不会启动 Agent 或批准合并' : `${notice.title}；发布于 ${absolute(notice.created_at)}`);
    referenceable(node, { kind: 'notice', target: { notice_id: notice.id }, label: `事项记录 #${notice.id}`,
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
  ui.noticeIndex = new Map([...(ui.noticeRecords?.rows || []), ...data.notices].map(notice => [notice.id, notice]));
  // notice 可能被 CLI 或另一个标签页答复/忽略；关掉了就不再展开。
  if (ui.noticeFocus !== null && ui.noticeIndex.get(ui.noticeFocus)?.status !== 'open') ui.noticeFocus = null;
  $('notice-count').textContent = unread.length ? `${open.length} 待决 · ${unread.length} 告知` : open.length ? String(open.length) : '无';
  setNavCount('notices', open.length + unread.length);
  if (ui.indexOpen === 'notices' && ui.noticeRecords?.status === 'butler') {
    if (!ui.noticeRecords.pending) void loadNoticeRecords({ preserve: true });
    return;
  }
  paintRecordFocus();
  if (ui.indexOpen === 'notices' && ui.noticeRecords) {
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
    } else if (!ui.noticeRecords.pending) void loadNoticeRecords();
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
    await refresh();
    return current;
  }).finally(() => pending.delete(key));
  pending.set(key, request);
  return request;
}

let noticeRequest = 0;
export async function openNotice(noticeId) {
  if (!positiveId(noticeId)) return;
  const request = ++noticeRequest;
  const previousView = ui.view;
  const notice = ui.noticeIndex.get(noticeId) || await readNoticeRecord(noticeId);
  if (request !== noticeRequest || ui.view !== previousView || ui.deletedWorkerIds.has(notice.task_id)) return;
  ui.noticeIndex.set(noticeId, notice);
  if (lifecycleNotice(notice)) {
    ui.noticeFocus = null;
    // loadDetail returns true only for a successfully rendered, still-current request.
    const loaded = await detail(notice.task_id);
    if (loaded !== true || request !== noticeRequest || ui.selected !== notice.task_id) return;
    if (!unreadNotice(notice)) return;
    await readNotice(notice);
    return;
  }
  if (ui.indexOpen === 'notices' && ui.noticeRecords) {
    const state = ui.noticeRecords;
    if (state.status === 'butler') {
      state.status = 'open'; state.page = null; state.rows = [];
      $('side-notices-body').querySelectorAll('button').forEach(node => {
        if (node.dataset.noticeFilter) node.setAttribute('aria-pressed', String(node.dataset.noticeFilter === 'open'));
      });
      void loadNoticeRecords();
    }
    state.selected = noticeId; state.signature = null;
    return Promise.all([api(`/api/worker/${notice.task_id}`), readNoticeRecord(noticeId)]).then(([task, current]) => {
      if (ui.noticeRecords !== state || state.selected !== noticeId || ui.indexOpen !== 'notices'
        || ui.deletedWorkerIds.has(notice.task_id)) return;
      state.task = task;
      ui.noticeIndex.set(noticeId, current);
      paintRecordFocus();
      $('notice-record-detail')?.scrollIntoView?.({ block: 'nearest' });
    }).catch(error => show(error.message, 'error'));
  }
  ui.noticeFocus = noticeId;
  return detail(notice.task_id);
}

/* ---------- detail ---------- */
/** 右侧顶部的 notice：完整正文 + 回复框，下面继续跟它所属任务的详情。 */
export function noticePanel(notice, task = null) {
  return linkWorkerNumbers(buildNoticePanel(notice, task));
}
function buildNoticePanel(notice, task = null) {
  const section = el('section', undefined, 'notice focus');
  section.dataset.id = notice.id;
  const head = el('div', undefined, 'notice-head');
  head.append(badge(STATUS[notice.status] || notice.status, notice.status === 'open' ? 'b-awaiting' : 'b-neutral'), el('span', `Worker ${workerLabel(task || notice.task_id, notice.task_worker_number)}`, 'tid'),
    el('span', `${relative(notice.created_at)} · ${absolute(notice.created_at)}`, 'when'));
  if (answerSource(notice)) head.append(badge(answerSource(notice), 'b-neutral'));
  section.append(head, el('h3', notice.title));
  if (notice.status !== 'open') {
    if (notice.kind === 'questionnaire') section.append(settledDecision(notice));
    else {
      section.append(el('p', notice.body || '（没有补充说明）', 'notice-body'));
      section.append(el('p', notice.answer ? `处理结果：${notice.answer}` : notice.status === 'dismissed' ? '已忽略 · 不代表批准' : '无需答复', 'notice-body'));
    }
    return section;
  }
  const inRecords = ui.indexOpen === 'notices' && ui.noticeRecords?.selected === notice.id;
  // Writes still refresh shared data, but their follow-up must not navigate a newer page
  // or replace another selected Notice (which can share the same page identity).
  const actionIdentity = () => {
    const view = ui.view, request = noticeRequest, records = ui.noticeRecords;
    const status = records?.status, selected = records?.selected;
    return () => ui.view === view && noticeRequest === request
      && (!inRecords || (ui.noticeRecords === records && records?.status === status && records?.selected === selected));
  };
  const refreshRecord = async ownsPage => {
    if (!ownsPage()) return;
    ui.detailDirty = false;
    if (!inRecords) return detail(notice.task_id);
    const current = await readNoticeRecord(notice.id);
    ui.noticeIndex.set(current.id, current);
    if (!ownsPage()) return;
    paintRecordFocus();
    await loadNoticeRecords();
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
      try { if (next) await openNotice(next.id); else await detail(notice.task_id); }
      catch (error) { $('error').textContent = `答案已提交，详情刷新失败：${error.message}`; }
    };
    section.append(questionnairePanel(notice, {
      settle: answer => settled('notice.answer', { id: notice.id, answer }),
      dismiss: () => settled('notice.dismiss', { id: notice.id }),
    }));
    if (!inRecords) section.append(button('收起，只看 Worker 详情', () => { ui.noticeFocus = null; ui.detailDirty = false; return detail(notice.task_id); }, 'ghost',
      { help: '收起这条待决提醒，回到 Worker 详情；待决事项仍保留在列表里。' }));
    referenceable(section, { kind: 'notice', target: { notice_id: notice.id }, label: `待定事项 #${notice.id}`,
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
    inRecords ? undefined : { help: '收起这条待决提醒，回到 Worker 详情；待决事项仍保留在列表里。' }));
  if (answer) answer.addEventListener('keydown', event => {
    if (event.key !== 'Enter' || event.isComposing || event.shiftKey) return;
    if (!event.metaKey && !event.ctrlKey) return;
    event.preventDefault(); actions.querySelector('button').click();
  });
  section.append(...(answer ? [answer] : []), actions);
  referenceable(section, { kind: 'notice', target: { notice_id: notice.id }, label: `待定事项 #${notice.id}`,
    quote: `${notice.title}\n${notice.body || ''}`, location: { view: 'notice-detail', notice_id: notice.id, task_id: notice.task_id } });
  return section;
}
