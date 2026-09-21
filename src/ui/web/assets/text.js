import { renderMarkdown } from './markdown.js';
import { $, el } from './dom.js';
import { detail } from './navigate.js';
import { show } from './messages.js';
import { onPrefChange, readPref, setPref } from './prefs.js';
import { ui } from './state.js';

/* ---------- markdown 渲染开关（设置页里的「阅读」项，键 lush.markdown） ---------- */
export function markdownEnabled() { return readPref('markdown'); }

/** 头部快捷开关的文案与 aria：与设置页共用同一个偏好，任一边改动都会走到这里。 */
export function syncMarkdownToggle() {
  const toggle = $('md-toggle');
  if (!toggle) return;
  const on = readPref('markdown');
  toggle.textContent = `Markdown 渲染：${on ? '开' : '关'}`;
  toggle.setAttribute('aria-pressed', String(on));
}

/** 受开关影响的 agent 输出：开启时返回 markdown 容器，关闭时保持与原来一致的纯文本节点。 */
export function agentText(value, { className = '', plain = 'div' } = {}) {
  const text = value == null ? '' : String(value);
  if (!markdownEnabled()) return el(plain, text, className || undefined);
  const node = renderMarkdown(text, document);
  if (className) node.className = `${node.className} ${className}`;
  return node;
}

/** 头部开关：翻转偏好；设置页与按钮的同步都交给 onPrefChange 的重画器。 */
export function toggleMarkdown() { setPref('markdown', !readPref('markdown')); }

// 开关变了：头部按钮同步文案，正在看的详情立刻按新偏好重画。
// 设置页打开时 ui.selected 为 null，不会抢走设置视图。
onPrefChange('markdown', () => {
  syncMarkdownToggle();
  if (ui.selected !== null) detail(ui.selected).catch(error => { show(error.message, 'error'); });
});
