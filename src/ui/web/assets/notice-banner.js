import { $, el } from './dom.js';
import { openNotice } from './render-notices.js';
import { openResource } from './sidebar-ui.js';

/**
 * 全局常驻待决提醒条：汇总快照里所有 `status === "open"` 的 notice（问卷、计划审批、普通提问），
 * 与左栏「待我处理」、`renderNotices` 用同一口径，不新增 API，也不触发系统通知。
 * 节点在 `.content-shell` 内、`#detail` / `#resource-panels` 之外，因此概览、任务详情、设置、
 * 统计、分支图、文档与四个信息页都看得见（桌面常驻；移动端随 sticky 顶栏固定）。
 * 1.5s 轮询每次都会调用它：用 host.dataset 签名幂等，内容没变就不重画，避免闪烁与抢焦点。
 * 必须在 `renderNotices(data)` 之后调用，这样 `ui.noticeIndex` 已有最新记录，点击能直接定位。
 */
export function renderNoticeBanner(data) {
  const host = $('notice-banner');
  if (!host) return;
  const open = (data?.notices || []).filter(notice => notice.status === 'open');
  if (!open.length) {
    if (host.dataset.signature !== '0') { host.dataset.signature = '0'; host.replaceChildren(); }
    host.hidden = true;
    return;
  }
  const newest = open.reduce((max, notice) => (notice.id > max.id ? notice : max), open[0]);
  host.hidden = false;
  const signature = `${open.length}:${newest.id}:${newest.title}`;
  if (host.dataset.signature === signature) return;
  host.dataset.signature = signature;
  const main = el('button', undefined, 'notice-banner-main');
  main.type = 'button';
  main.title = `最新：${newest.title}`;
  main.append(
    el('span', undefined, 'notice-banner-dot'),
    el('span', `${open.length} 条待你处理`, 'notice-banner-count'),
    el('span', newest.title, 'notice-banner-title'),
    el('span', '去处理 →', 'notice-banner-go'),
  );
  main.onclick = async () => {
    main.disabled = true;
    try {
      openResource('notices');
      await openNotice(newest.id);
    } finally { main.disabled = false; }
  };
  host.replaceChildren(main);
}
