// DOM 原语：建节点、按钮、区块与徽章。
import { statusOf } from './format.js';
import { show } from './messages.js';

export const $ = id => document.getElementById(id);
export const el = (tag, text, className) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; };
export function button(text, fn, className) {
  const node = el('button', text, className); node.type = 'button';
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
