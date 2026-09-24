// DOM 原语：建节点、按钮、区块与徽章。
import { ROLE, statusOf } from './format.js';
import { show } from './messages.js';

export const $ = id => document.getElementById(id);
export const el = (tag, text, className) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; };
export function button(text, fn, className, options = {}) {
  const node = el('button', text, className); node.type = 'button';
  // 帮助与 Agent 触发标识是可选的第 4 参：老的三参调用完全不受影响。
  if (options.help) node.setAttribute('data-help', options.help);
  if (options.agent) node.classList.add('agent-call');
  node.onclick = async () => { node.disabled = true; try { await fn(); } catch (error) { show(error.message, 'error'); } finally { node.disabled = false; } };
  return node;
}
export function syncChildren(container, nodes) {
  const wanted = new Set(nodes);
  for (const child of [...container.children]) if (!wanted.has(child)) child.remove();
  nodes.forEach((node, index) => { if (container.children[index] !== node) container.insertBefore(node, container.children[index] || null); });
}
export function block(title, count) {
  const section = el('div', undefined, 'block');
  const head = el('div', undefined, 'section-title');
  head.append(el('h2', title));
  if (count !== undefined) head.append(el('span', count, 'count'));
  section.append(head);
  return section;
}
export const kv = (label, value, className) => { const node = el('div', undefined, 'kv'); node.append(el('b', label), el('span', value, className)); return node; };
export const badge = (text, className) => el('span', text, `badge ${className}`);
export const statusBadge = task => badge(`${statusOf(task).icon} ${statusOf(task).label}`, `b-${task.status}`);
/**
 * 任务类型胶囊：角色文字 + `role-<role>` 类，颜色由 styles.css 的角色调色板给出。
 * 未知角色兜底成 `role-unknown`，不掷错也不丢标签。
 */
export const roleBadge = role => {
  const key = String(role ?? '').replace(/[^a-z0-9_-]/gi, '').toLowerCase() || 'unknown';
  const label = ROLE[role] || String(role ?? '未知');
  const node = el('span', label, `badge role-badge role-${key}`);
  node.title = `任务类型：${label}`;
  return node;
};
/** 快速路由标记：前缀短路、未调用规划模型创建的 task。文案与悬停说明是全站唯一口径。 */
export const routeBadge = () => {
  const node = el('span', '⚡ 快速路由', 'badge route-badge');
  node.title = '这条输入的快速路由前缀在提交时命中：未调用规划模型，直接创建了任务。';
  return node;
};
