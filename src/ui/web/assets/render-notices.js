import { $, badge, button, el, syncChildren } from './dom.js';
import { action, api } from './api.js';
import { promptDialog } from './dialog.js';
import { show } from './messages.js';
import { notificationControl } from './notice-notifications.js';
import { absolute, relative } from './format.js';
import { detail } from './navigate.js';
import { setNavCount } from './sidebar-ui.js';
import { orderList } from './tree-order.js';
import { ui } from './state.js';
import { referenceable } from './context-references.js';
import { questionnairePanel } from './render-questionnaire.js';

const STATUS = { open: '待处理', answered: '已回答', dismissed: '已忽略', sent: '已发送' };

export function initNoticeRecords() {
  const host = $('side-notices-body');
  if (!host) return;
  const state = ui.noticeRecords = { status: 'open', rows: [], page: null, request: 0, selected: null, task: null, signature: null };
  const tools = el('div', undefined, 'resource-tools');
  const filters = el('div', undefined, 'filters');
  for (const [value, label] of [['open','未处理'],['answered','已回答'],['dismissed','已忽略'],['all','全部记录']]) {
    const tab = button(label, () => {
      state.status = value; state.page = null; state.rows = [];
      for (const node of filters.children) node.setAttribute('aria-pressed', String(node === tab));
      return loadNoticeRecords();
    }, 'ghost');
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

export async function loadNoticeRecords({ more = false, preserve = false } = {}) {
  const state = ui.noticeRecords;
  if (!state) return;
  const request = ++state.request;
  state.pending = true;
  const cursor = more && state.page?.has_more ? `&before=${state.page.cursor}` : '';
  const status = state.status;
  try {
    const selected = state.selected;
    const page = await api(`/api/notices?status=${status}${cursor}`);
    if (ui.noticeRecords !== state || request !== state.request) return;
    // A settled old question may have fallen outside both the snapshot and this filtered page.
    const current = selected && !page.notices?.some(row => row.id === selected) ? await readNoticeRecord(selected) : null;
    if (ui.noticeRecords !== state || request !== state.request) return;
    if (current && selected === state.selected) {
      ui.noticeIndex.set(current.id, current);
      state.rows = state.rows.map(row => row.id === current.id ? current : row);
    }
    if (!Array.isArray(page.notices)) throw new Error('请重启 Web 与 daemon 以加载 notice 历史');
    state.rows = more || preserve
      ? [...new Map([...state.rows, ...page.notices].map(row => [row.id, row])).values()]
        .filter(row => status === 'all' || row.status === status).sort((a, b) => b.id - a.id)
      : page.notices;
    if (!preserve || !state.page) state.page = page;
    for (const row of state.rows) ui.noticeIndex.set(row.id, row);
    paintNoticeRows(state.rows);
    const footer = $('notice-pagination');
    footer.replaceChildren(el('p', state.rows.length ? `已显示 ${state.rows.length} 条记录` : '没有符合条件的记录', 'hint'));
    if (state.page.has_more) footer.append(button('加载更早记录', () => loadNoticeRecords({ more: true }), 'ghost'));
    paintRecordFocus();
  } catch (error) {
    if (ui.noticeRecords === state && request === state.request) {
      $('notice-pagination').replaceChildren(el('p', `记录加载失败：${error.message}`, 'error'), button('重试', () => loadNoticeRecords(), 'ghost'));
    }
  } finally { if (request === state.request) state.pending = false; }
}

function paintRecordFocus() {
  const state = ui.noticeRecords;
  const target = $('notice-record-detail');
  if (!target || !state?.selected) return;
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
    row.append(badge(STATUS[notice.status] || notice.status, notice.status === 'open' ? 'b-awaiting' : 'b-neutral'),
      el('span', `#${notice.task_id}`, 'tid'), el('span', relative(notice.created_at), 'when'));
    node.append(row, el('span', notice.title, 'goal'));
    node.title = `${notice.title}\n发布于 ${absolute(notice.created_at)}`;
    referenceable(node, { kind: 'notice', target: { notice_id: notice.id }, label: `事项记录 #${notice.id}`,
      quote: `${notice.title}\n${notice.body || ''}`, location: { view: 'notice-list', notice_id: notice.id } });
    return node;
  });
  syncChildren(container, nodes);
}

/** 快照维护计数；信息页按需分页读完整记录。 */
export function renderNotices(data) {
  // Plan、普通提问和问卷共享待决入口；info 只出现在历史中。
  const open = data.notices.filter(notice => notice.status === 'open');
  ui.noticeIndex = new Map([...(ui.noticeRecords?.rows || []), ...data.notices].map(notice => [notice.id, notice]));
  // notice 可能被 CLI 或另一个标签页答复/忽略；关掉了就不再展开。
  if (ui.noticeFocus !== null && ui.noticeIndex.get(ui.noticeFocus)?.status !== 'open') ui.noticeFocus = null;
  $('notice-count').textContent = open.length ? String(open.length) : '无';
  setNavCount('notices', open.length);
  paintRecordFocus();
  if (ui.indexOpen === 'notices' && ui.noticeRecords) {
    // Preserve loaded older pages. Snapshot updates their status without discarding history.
    if (ui.noticeRecords.page) {
      const state = ui.noticeRecords;
      const newest = Math.max(0, ...state.rows.map(row => row.id));
      const additions = data.notices.filter(row => row.id > newest && (state.status === 'all' || row.status === state.status));
      state.rows = [...additions, ...state.rows.map(row => ui.noticeIndex.get(row.id) || row)];
      const rows = ui.noticeRecords.rows.filter(row => ui.noticeRecords.status === 'all' || row.status === ui.noticeRecords.status);
      paintNoticeRows(rows);
      if (!state.pending) void loadNoticeRecords({ preserve: true });
    } else if (!ui.noticeRecords.pending) void loadNoticeRecords();
    return;
  }
  paintNoticeRows(open);
}
export function openNotice(noticeId) {
  const notice = ui.noticeIndex.get(noticeId);
  if (!notice) return Promise.resolve();
  if (ui.indexOpen === 'notices' && ui.noticeRecords) {
    const state = ui.noticeRecords;
    state.selected = noticeId; state.signature = null;
    return Promise.all([api(`/api/task/${notice.task_id}`), readNoticeRecord(noticeId)]).then(([task, current]) => {
      if (ui.noticeRecords !== state || state.selected !== noticeId || ui.indexOpen !== 'notices') return;
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
  const section = el('section', undefined, 'notice focus');
  section.dataset.id = notice.id;
  const head = el('div', undefined, 'notice-head');
  head.append(badge(STATUS[notice.status] || notice.status, notice.status === 'open' ? 'b-awaiting' : 'b-neutral'), el('span', `任务 #${notice.task_id}`, 'tid'),
    el('span', `${relative(notice.created_at)} · ${absolute(notice.created_at)}`, 'when'));
  section.append(head, el('h3', notice.title));
  if (notice.status !== 'open') {
    if (notice.kind === 'questionnaire') section.append(questionnairePanel(notice));
    else {
      section.append(el('p', notice.body || '（没有补充说明）', 'notice-body'));
      section.append(el('p', notice.answer ? `处理结果：${notice.answer}` : notice.status === 'dismissed' ? '已忽略 · 不代表批准' : '无需答复', 'notice-body'));
    }
    return section;
  }
  const inRecords = ui.indexOpen === 'notices' && ui.noticeRecords?.selected === notice.id;
  const refreshRecord = async () => {
    ui.detailDirty = false;
    if (!inRecords) return detail(notice.task_id);
    const current = await readNoticeRecord(notice.id);
    ui.noticeIndex.set(current.id, current);
    paintRecordFocus();
    await loadNoticeRecords();
  };
  if (notice.kind === 'plan') {
    section.append(el('p', notice.body || '（没有补充说明）', 'notice-body'));
    const actions = el('div', undefined, 'actions');
    const send = async (method, params) => {
      actions.querySelectorAll('button').forEach(node => { node.disabled = true; });
      try { await action(method, params); await refreshRecord(); }
      finally { actions.querySelectorAll('button').forEach(node => { node.disabled = false; }); }
    };
    actions.append(button('批准并开发', () => send('plan.approve', { id: notice.id })), button('驳回', async () => {
      const reason = await promptDialog({ title: '驳回计划', message: '说明需要调整的地方。', confirmLabel: '驳回' });
      if (reason?.trim()) await send('plan.reject', { id: notice.id, reason: reason.trim() });
    }, 'ghost'));
    section.append(actions); return section;
  }
  if (notice.kind === 'questionnaire') {
    const settled = async (method, params) => {
      await action(method, params);
      ui.detailDirty = false;
      if (inRecords) { await refreshRecord(); return; }
      const next = [...ui.noticeIndex.values()].filter(row => row.id !== notice.id && row.status === 'open').sort((a, b) => a.id - b.id)[0];
      ui.noticeFocus = next?.id ?? null;
      try { if (next) await openNotice(next.id); else await detail(notice.task_id); }
      catch (error) { $('error').textContent = `答案已提交，详情刷新失败：${error.message}`; }
    };
    section.append(questionnairePanel(notice, {
      settle: answer => settled('notice.answer', { id: notice.id, answer }),
      dismiss: () => settled('notice.dismiss', { id: notice.id }),
    }));
    if (!inRecords) section.append(button('收起，只看任务详情', () => { ui.noticeFocus = null; ui.detailDirty = false; return detail(notice.task_id); }, 'ghost'));
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
    actions.querySelectorAll('button').forEach(node => { node.disabled = true; });
    try {
      await action('notice.answer', { id: notice.id, answer: value });
      ui.noticeFocus = null; ui.detailDirty = false;
      await refreshRecord();
    } finally { actions.querySelectorAll('button').forEach(node => { node.disabled = false; }); }
  };
  const dismiss = async () => {
    actions.querySelectorAll('button').forEach(node => { node.disabled = true; });
    try {
      await action('notice.dismiss', { id: notice.id });
      ui.noticeFocus = null; ui.detailDirty = false;
      await refreshRecord();
    } finally { actions.querySelectorAll('button').forEach(node => { node.disabled = false; }); }
  };
  if (resolutionDecision) actions.append(
    button('开始解冲突', () => settle('批准，开始解冲突')),
    button('暂不处理', dismiss, 'ghost'));
  else actions.append(button('回复并继续任务', () => settle(answer.value)), button('忽略', dismiss, 'ghost'));
  actions.append(button(inRecords ? '查看任务上下文' : '收起，只看任务详情', () => { ui.noticeFocus = null; ui.detailDirty = false; return detail(notice.task_id); }, 'ghost'));
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
