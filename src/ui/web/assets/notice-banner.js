import { $, el } from './dom.js';
import { openNotice } from './render-notices.js';
import { openResource } from './sidebar-ui.js';
import { unreadNotice } from './notice-kind.js';
import { show } from './messages.js';

/** Global pending-decision and unread-info entry points; polling never invokes Agent. */
export function renderNoticeBanner(data) {
  const host = $('notice-banner');
  if (!host) return;
  const rows = data?.notices || [];
  const groups = [
    { rows: rows.filter(row => row.status === 'open'), label: '条待你处理', action: '去处理 →', kind: 'decision', help: '最新待决提醒；点击打开处理页' },
    { rows: rows.filter(unreadNotice), label: '条未读告知', action: '打开 Worker →', kind: 'info', help: '打开对应 Worker；成功加载后自动已读，不会启动 Agent 或批准合并' },
  ].filter(group => group.rows.length);
  if (!groups.length) {
    if (host.dataset.signature !== '0') { host.dataset.signature = '0'; host.replaceChildren(); }
    host.hidden = true;
    return;
  }
  const newest = group => group.rows.reduce((a, b) => b.id > a.id ? b : a);
  const signature = JSON.stringify(groups.map(group => [group.kind, group.rows.length, newest(group).id, newest(group).title]));
  host.hidden = false;
  if (host.dataset.signature === signature) return;
  host.dataset.signature = signature;
  host.replaceChildren(...groups.map(group => {
    const notice = newest(group);
    const main = el('button', undefined, `notice-banner-main notice-banner-${group.kind}`);
    main.type = 'button'; main.setAttribute('data-help', group.help);
    main.append(el('span', undefined, 'notice-banner-dot'), el('span', `${group.rows.length} ${group.label}`, 'notice-banner-count'),
      el('span', notice.title, 'notice-banner-title'), el('span', group.action, 'notice-banner-go'));
    main.onclick = async () => {
      main.disabled = true;
      try { if (group.kind === 'decision') openResource('notices'); await openNotice(notice.id); }
      catch (error) { show(error.message, 'error'); }
      finally { main.disabled = false; }
    };
    return main;
  }));
}
