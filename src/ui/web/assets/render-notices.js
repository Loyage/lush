import { $, badge, button, el, syncChildren } from './dom.js';
import { action } from './api.js';
import { absolute, relative } from './format.js';
import { detail } from './navigate.js';
import { setNavCount } from './sidebar-ui.js';
import { ui } from './state.js';

/** 左侧只放索引：点一下才在右侧展开正文与回复框。 */
export function renderNotices(data) {
  // 计划审批在意图面板上批（kind='plan'），不走这里的问答。
  const open = data.notices.filter(notice => notice.status === 'open' && notice.kind !== 'plan');
  ui.noticeIndex = new Map(open.map(notice => [notice.id, notice]));
  // notice 可能被 CLI 或另一个标签页答复/忽略；关掉了就不再展开。
  if (ui.noticeFocus !== null && !ui.noticeIndex.has(ui.noticeFocus)) ui.noticeFocus = null;
  $('notice-count').textContent = open.length ? String(open.length) : '无';
  setNavCount('notices', open.length);
  const container = $('notices');
  const known = new Map([...container.children].map(node => [Number(node.dataset.id), node]));
  const nodes = open.map(notice => {
    const node = known.get(notice.id) || button('', () => openNotice(notice.id), 'notice-brief');
    node.dataset.id = notice.id;
    node.className = `notice-brief${ui.noticeFocus === notice.id ? ' selected' : ''}`;
    node.replaceChildren();
    const row = el('span', undefined, 'row');
    row.append(el('span', '◔', 'dot c-awaiting'), el('span', `#${notice.task_id}`, 'tid'),
      el('span', relative(notice.created_at), 'when'));
    node.append(row, el('span', notice.title, 'goal'));
    node.title = `${notice.title}\n发布于 ${absolute(notice.created_at)}`;
    return node;
  });
  syncChildren(container, nodes);
}
export function openNotice(noticeId) {
  const notice = ui.noticeIndex.get(noticeId);
  if (!notice) return Promise.resolve();
  ui.noticeFocus = noticeId;
  return detail(notice.task_id);
}

/* ---------- detail ---------- */
/** 右侧顶部的 notice：完整正文 + 回复框，下面继续跟它所属任务的详情。 */
export function noticePanel(notice) {
  const section = el('section', undefined, 'notice focus');
  section.dataset.id = notice.id;
  const head = el('div', undefined, 'notice-head');
  head.append(badge('◔ 等你决定', 'b-awaiting'), el('span', `任务 #${notice.task_id}`, 'tid'),
    el('span', `${relative(notice.created_at)} · ${absolute(notice.created_at)}`, 'when'));
  section.append(head, el('h3', notice.title), el('p', notice.body || '（没有补充说明）', 'notice-body'));

  const answer = el('textarea');
  answer.placeholder = '你的决定；⌘/Ctrl+回车提交'; answer.rows = 3;
  answer.addEventListener('input', () => { ui.detailDirty = true; });
  const actions = el('div', undefined, 'actions');
  const settle = async () => {
    actions.querySelectorAll('button').forEach(node => { node.disabled = true; });
    await action('notice.answer', { id: notice.id, answer: answer.value });
    ui.noticeFocus = null; ui.detailDirty = false;
    await detail(notice.task_id);
  };
  actions.append(
    button('回复并继续任务', settle),
    button('忽略', async () => {
      actions.querySelectorAll('button').forEach(node => { node.disabled = true; });
      await action('notice.dismiss', { id: notice.id });
      ui.noticeFocus = null; ui.detailDirty = false;
      await detail(notice.task_id);
    }, 'ghost'),
    button('收起，只看任务详情', () => { ui.noticeFocus = null; ui.detailDirty = false; return detail(notice.task_id); }, 'ghost'));
  answer.addEventListener('keydown', event => {
    if (event.key !== 'Enter' || event.isComposing || event.shiftKey) return;
    if (!event.metaKey && !event.ctrlKey) return;
    event.preventDefault(); actions.querySelector('button').click();
  });
  section.append(answer, actions);
  return section;
}
