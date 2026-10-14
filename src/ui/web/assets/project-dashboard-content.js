import { api } from './api.js';
import { el } from './dom.js';
import { noticeNumber, workerNumber } from './format.js';
import { positiveId, unreadNotice } from './notice-kind.js';
import { projectHref } from './route.js';
import { projectDevelopment } from './project-development.js';

export const PROJECT_CARD_SECTIONS = [
  ['metrics', '状态指标'], ['distribution', '状态分布'], ['delivery', '合并进度'],
  ['recent', '最近 Worker'], ['messages', '待决与未读告知'], ['shortcuts', '快捷入口'],
];
export const PROJECT_CARD_DEFAULTS = PROJECT_CARD_SECTIONS.map(([key]) => key);
export const pendingDashboardNotice = notice => notice?.status === 'open' && ['question', 'questionnaire', 'plan'].includes(notice.kind);
export const onlineDashboardProject = row => row.running === true && !row.error;

/** One bounded source/status read; also used to reveal the next info after a successful ACK. */
export async function loadProjectMessageGroup(row, status, { ownsPage = () => true } = {}) {
  if (!['open', 'unread'].includes(status) || !onlineDashboardProject(row)) throw new Error('消息来源未确认');
  let page, before = null;
  for (let attempt = 0; attempt < 3 && ownsPage(); attempt++) {
    page = await api(projectHref(row.id, `/api/notices?status=${status}&limit=3${before ? `&before=${before}` : ''}`));
    if (!Array.isArray(page?.notices) || page.notices.length > 3 || typeof page.has_more !== 'boolean'
      || page.notices.some(notice => !positiveId(notice?.id) || !positiveId(notice?.task_id))
      || (Object.hasOwn(page, 'total') && (!Number.isSafeInteger(page.total) || page.total < page.notices.length))) throw new Error('消息读面未确认');
    // Old Web servers filter plan after pagination. Never treat a filtered empty page as zero.
    if (page.notices.length || page.total === 0 || !page.has_more || !positiveId(page.cursor) || (before && page.cursor >= before)) break;
    before = page.cursor;
  }
  if (!ownsPage() || !page) throw new DOMException('消息页面已离开', 'AbortError');
  const notices = page.notices.filter(notice => status === 'open' ? notice.status === 'open' : unreadNotice(notice)).sort((a, b) => b.id - a.id);
  const exact = Number.isSafeInteger(page.total) && page.total >= notices.length;
  return { notices, total: exact ? page.total : notices.length, exact, has_more: page.has_more, cursor: page.cursor };
}
/** Bounded, source-specific reads: never start an offline daemon or mark records read. */
export async function loadProjectCardMessages(rows, { ownsPage = () => true } = {}) {
  rows = [...new Map(rows.map(row => [row.id, row])).values()];
  const messages = new Map();
  let index = 0;
  async function next() {
    while (ownsPage() && index < rows.length) {
      const row = rows[index++];
      if (!onlineDashboardProject(row)) { messages.set(row.id, { offline: true, notices: [], complete: false }); continue; }
      const results = await Promise.allSettled(['open', 'unread'].map(status => loadProjectMessageGroup(row, status, { ownsPage })));
      if (!ownsPage()) return;
      const notices = new Map(), groups = {};
      for (const [i, result] of results.entries()) {
        const status = ['open', 'unread'][i];
        if (result.status !== 'fulfilled') { groups[status] = { notices: [], total: null, exact: false, error: true }; continue; }
        // Unknown kinds remain visible, but never acquire question semantics or read actions.
        groups[status] = result.value;
        for (const notice of result.value.notices) notices.set(notice.id, notice);
      }
      messages.set(row.id, { notices: [...notices.values()], groups,
        complete: results.every(result => result.status === 'fulfilled' && !result.value.has_more),
        error: results.some(result => result.status === 'rejected') });
    }
  }
  await Promise.all(Array.from({ length: Math.min(3, rows.length) }, next));
  return messages;
}

function messageSection(row, model) {
  const root = el('section', undefined, 'project-dashboard-messages');
  root.setAttribute('aria-label', `${row.name || '项目'}待决与未读告知`);
  const heading = el('div', undefined, 'project-dashboard-section-head');
  heading.append(el('h3', '消息'));
  const more = el('a', '查看全部', 'nav-link'); more.href = projectHref(row.id, '/#notices'); more.target = '_blank'; more.rel = 'noopener';
  heading.append(more); root.append(heading);
  if (!onlineDashboardProject(row) || model?.offline) root.append(el('p', '后台未运行或不可达，消息未确认。', 'hint'));
  else if (!model) root.append(el('p', '消息尚未读取。', 'hint'));
  else {
    for (const notice of model.notices) {
      const link = el('a', undefined, `project-dashboard-message ${notice.kind === 'info' ? 'tone-blue' : 'tone-amber'}`);
      link.href = projectHref(row.id, `/#notices-${notice.id}`); link.target = '_blank'; link.rel = 'noopener';
      link.append(el('span', noticeNumber(notice), 'tid'), el('strong', String(notice.title || '未命名消息').slice(0, 200)));
      link.append(el('small', workerNumber({ id: notice.task_id, worker_number: notice.task_worker_number })));
      root.append(link);
    }
    if (model.error) root.append(el('p', '部分消息读取失败，请刷新核对。', 'error'));
    else if (!model.complete) root.append(el('p', '仅展示最近待决与未读告知。', 'hint'));
    else if (!model.notices.length) root.append(el('p', '暂无待决或未读告知', 'hint'));
  }
  return root;
}

export function projectDashboardContent(row, { sections = PROJECT_CARD_DEFAULTS, messages } = {}) {
  const root = el('div', undefined, 'project-dashboard-content');
  if (sections.some(section => ['metrics', 'distribution', 'delivery', 'recent'].includes(section))) {
    root.append(projectDevelopment(row, { sections }));
  }
  if (sections.includes('messages')) root.append(messageSection(row, messages));
  if (sections.includes('shortcuts')) {
    const shortcuts = el('nav', undefined, 'project-dashboard-shortcuts'); shortcuts.setAttribute('aria-label', `${row.name || '项目'}快捷入口`);
    for (const [hash, label] of [['workers', '工作列表'], ['inputs', '历史输入']]) {
      const link = el('a', label, 'nav-link'); link.href = projectHref(row.id, `/#${hash}`); link.target = '_blank'; link.rel = 'noopener'; shortcuts.append(link);
    }
    root.append(shortcuts);
  }
  return root;
}
