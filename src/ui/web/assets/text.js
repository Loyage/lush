import { renderMarkdown } from './markdown.js';
import { $, el } from './dom.js';
import { detail } from './navigate.js';
import { ui } from './state.js';

/* ---------- markdown 渲染开关 ---------- */
const MARKDOWN_KEY = 'lush.markdown';
let markdownEnabled = readMarkdownPref();
function readMarkdownPref() {
  try { return localStorage.getItem(MARKDOWN_KEY) !== '0'; } catch { return true; }   // 默认开启
}
export function syncMarkdownToggle() {
  const toggle = $('md-toggle');
  toggle.textContent = `Markdown 渲染：${markdownEnabled ? '开' : '关'}`;
  toggle.setAttribute('aria-pressed', String(markdownEnabled));
}
/** 受开关影响的 agent 输出：开启时返回 markdown 容器，关闭时保持与原来一致的纯文本节点。 */
export function agentText(value, { className = '', plain = 'div' } = {}) {
  const text = value == null ? '' : String(value);
  if (!markdownEnabled) return el(plain, text, className || undefined);
  const node = renderMarkdown(text, document);
  if (className) node.className = `${node.className} ${className}`;
  return node;
}
/** 切换开关：存回 localStorage，同步按钮的 aria 状态，再重画当前详情。 */
export function toggleMarkdown() {
    markdownEnabled = !markdownEnabled;
    try { localStorage.setItem(MARKDOWN_KEY, markdownEnabled ? '1' : '0'); } catch { /* 隐私模式里忽略 */ }
    syncMarkdownToggle();
    if (ui.selected !== null) detail(ui.selected).catch(error => { $('error').textContent = error.message; });
}
