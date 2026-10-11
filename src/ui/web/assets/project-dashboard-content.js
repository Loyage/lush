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
const pending = notice => notice?.status === 'open' && ['question', 'questionnaire', 'plan'].includes(notice.kind);
const online = row => row.running === true && !row.error;

/** Bounded, source-specific reads: never start an offline daemon or mark records read. */
export async function loadProjectCardMessages(rows, { ownsPage = () => true } = {}) {
  const messages = new Map();
  let index = 0;
  async function next() {
    while (ownsPage() && index < rows.length) {
      const row = rows[index++];
      if (!online(row)) { messages.set(row.id, { offline: true, notices: [], complete: false }); continue; }
      const results = await Promise.allSettled(['open', 'unread'].map(async status => {
        const page = await api(projectHref(row.id, `/api/notices?status=${status}&limit=3`));
        if (!Array.isArray(page?.notices) || typeof page.has_more !== 'boolean'
          || page.notices.some(notice => !positiveId(notice?.id) || !positiveId(notice?.task_id))) {
          throw new Error('消息读面未确认');
        }
        return page;
      }));
      if (!ownsPage()) return;
      const notices = new Map();
      for (const result of results) if (result.status === 'fulfilled') {
        for (const notice of result.value.notices) if (pending(notice) || unreadNotice(notice)) notices.set(notice.id, notice);
      }
      messages.set(row.id, { notices: [...notices.values()],
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
  const more = el('a', '查看全部'); more.href = projectHref(row.id, '/#notices'); more.target = '_blank'; more.rel = 'noopener';
  heading.append(more); root.append(heading);
  if (!online(row) || model?.offline) root.append(el('p', '后台未运行或不可达，消息未确认。', 'hint'));
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
    for (const [hash, label] of [['workers', 'Worker'], ['inputs', '历史输入'], ['versions', '版本迭代']]) {
      const link = el('a', label); link.href = projectHref(row.id, `/#${hash}`); link.target = '_blank'; link.rel = 'noopener'; shortcuts.append(link);
    }
    root.append(shortcuts);
  }
  return root;
}
