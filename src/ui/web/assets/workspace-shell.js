import { $ } from './dom.js';
import { projectRoute, workspaceHref } from './route.js';

/** Keep global navigation outside a project tab. Native links preserve drafts, selection and reading position. */
export function workspaceLink(id, hash, open) {
  const target = $(id); if (!target) return;
  const project = projectRoute(), href = workspaceHref(hash);
  target.href = href;
  if (project) { target.target = '_blank'; target.rel = 'noopener'; }
  else { target.removeAttribute?.('target'); target.removeAttribute?.('rel'); }
  target.onclick = event => {
    if (project && target.tagName === 'A') return;
    if (event?.button > 0 || event?.metaKey || event?.ctrlKey || event?.shiftKey || event?.altKey) return;
    event?.preventDefault?.();
    if (project) return globalThis.window?.open?.(href, '_blank', 'noopener');
    return open();
  };
}
export function configureWorkspaceShell() {
  const project = projectRoute();
  if (globalThis.document?.documentElement?.dataset) document.documentElement.dataset.lushSpace = project ? 'project' : 'global';
  for (const node of document.querySelectorAll?.('[data-global-navigation="true"]') || []) node.hidden = Boolean(project);
  if ($('project-switch')) $('project-switch').hidden = true;
  const themeToggle = $('theme-toggle');
  if (themeToggle) {
    themeToggle.hidden = Boolean(project);
    if (themeToggle.parentNode?.classList?.contains('help-host')) themeToggle.parentNode.hidden = Boolean(project);
  }
  const sidebar = $('sidebar'); sidebar?.setAttribute('aria-label', project ? '项目工作导航' : '用户工作台导航');
  const detail = $('detail'); detail?.setAttribute('aria-label', project ? '项目内容' : '用户工作台内容');
  const context = $('host-context'); if (context) context.textContent = project ? '当前项目' : '用户工作台';
  if (!project) {
    if ($('project')) $('project').textContent = '用户工作台';
    if ($('connection')) $('connection').textContent = '设备设置 · 所有项目事项';
    if ($('side-nav')) $('side-nav').hidden = true;
    if ($('composer-shell')) $('composer-shell').hidden = true;
    if ($('sleep-banner')) $('sleep-banner').hidden = true;
    if ($('notice-banner')) $('notice-banner').hidden = true;
  }
  const navLabel = $('nav-space-label'); if (navLabel) navLabel.textContent = project ? '项目工作' : '用户工作台';
  const navEyebrow = $('nav-space-eyebrow'); if (navEyebrow) navEyebrow.textContent = project ? 'PROJECT WORKSPACE' : 'USER WORKSPACE';
}
export function renderGlobalInboxSummary(summary) {
  const count = $('global-inbox-count');
  const open = Number.isSafeInteger(summary?.open) && summary.open >= 0 ? summary.open : 0;
  const unread = Number.isSafeInteger(summary?.unread) && summary.unread >= 0 ? summary.unread : 0;
  if (count) { count.textContent = summary ? `${open + unread}${summary.complete === false ? '+' : ''}` : '…'; count.setAttribute('aria-label', summary?.complete ? `${open} 项待答问题，${unread} 条未读告知` : '全局事项仍在同步，数量未完整确认'); }
}
