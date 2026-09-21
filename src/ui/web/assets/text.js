import { renderMarkdown } from './markdown.js';
import { el } from './dom.js';
import { detail } from './navigate.js';
import { show } from './messages.js';
import { onPrefChange, readPref } from './prefs.js';
import { ui } from './state.js';

/* ---------- markdown 渲染偏好（只在设置页管理，键 lush.markdown） ---------- */
export function markdownEnabled() { return readPref('markdown'); }

/** 受开关影响的 agent 输出：开启时返回 markdown 容器，关闭时保持与原来一致的纯文本节点。 */
export function agentText(value, { className = '', plain = 'div' } = {}) {
  const text = value == null ? '' : String(value);
  if (!markdownEnabled()) return el(plain, text, className || undefined);
  const node = renderMarkdown(text, document);
  if (className) node.className = `${node.className} ${className}`;
  return node;
}

// 设置页修改偏好后，正在看的详情立刻按新方式重画。
// 设置页打开时 ui.selected 为 null，不会抢走设置视图。
onPrefChange('markdown', () => {
  if (ui.selected !== null) detail(ui.selected).catch(error => { show(error.message, 'error'); });
});
