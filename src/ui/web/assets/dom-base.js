// DOM 原语：建节点、按钮、区块、搜索与列表外观。
import { ROLE, statusOf } from './format.js';
import { show } from './messages.js';
import { bindWorkerPreview } from './entity-preview.js';

let nextSearchId = 0;

/** Shared text search: input is a draft until Enter/button submission. No nested form. */
export function searchField({ label = '关键词', placeholder = '输入关键词', scope = '', value = '', maxLength = null, escapeClear = true, hint = 'Enter 或搜索按钮提交', onSubmit = () => {} } = {}) {
  const root = el('div', undefined, 'search-field'), row = el('div', undefined, 'search-field-row');
  const field = el('label', undefined, 'search-field-label'), input = el('input', undefined, 'search-field-input');
  input.type = 'search'; input.placeholder = placeholder;
  if (maxLength != null) input.maxLength = maxLength;
  input.setAttribute('aria-label', label); field.append(el('span', label, 'search-field-title'), input);
  const submitButton = el('button', '搜索', 'ghost search-field-submit'); submitButton.type = 'button';
  const clearButton = el('button', '清空', 'ghost search-field-clear'); clearButton.type = 'button';
  const help = el('div', undefined, 'search-field-help'), range = el('span', scope, 'search-field-scope');
  const status = el('span', '', 'search-field-status'); status.setAttribute('role', 'status');
  help.id = `search-field-help-${++nextSearchId}`; input.setAttribute('aria-describedby', help.id);
  help.append(range, status); row.append(field, submitButton, clearButton); root.append(row, help);
  let applied = String(value).trim(), composing = false; input.value = String(value);
  function paint() {
    status.textContent = input.value.trim() !== applied ? '尚未提交 · Enter 或搜索按钮应用' : hint;
    help.hidden = !scope && !status.textContent; clearButton.disabled = !input.value && !applied;
  }
  function submit(event) {
    if (composing || event?.isComposing || event?.keyCode === 229) {
      // Allow IME candidate confirmation itself, but never let an implicit form submit navigate.
      if (event?.type === 'submit') event.preventDefault?.();
      return;
    }
    event?.preventDefault?.();
    applied = input.value.trim(); paint(); return onSubmit(applied, { reason: 'submit' });
  }
  function clear() { input.value = ''; applied = ''; paint(); return onSubmit('', { reason: 'clear' }); }
  input.addEventListener('compositionstart', () => { composing = true; });
  input.addEventListener('compositionend', () => { composing = false; if (input.value === '' && applied) return clear(); paint(); });
  input.addEventListener('input', () => { if (!composing && input.value === '' && applied) return clear(); paint(); });
  input.addEventListener('search', () => { if (!composing && input.value === '' && applied) return clear(); });
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter') return submit(event);
    if (escapeClear && event.key === 'Escape' && !composing && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); return clear(); }
  });
  submitButton.onclick = submit; clearButton.onclick = clear; paint();
  return { root, wrap: root, input, submitButton, clearButton, status, get applied() { return applied; }, submit, clear,
    setValue(value) { input.value = String(value); applied = input.value.trim(); paint(); },
    setScope(value) { scope = value; range.textContent = value; paint(); }, bindForm(form) { form.onsubmit = submit; } };
}

/** Local record search covers only text returned by the existing read API. */
export function noticeSearchText(notice) {
  return [notice.title, notice.body, notice.answer, notice.task_worker_number, notice.id, notice.task_id].filter(value => value != null).join(' ').toLocaleLowerCase();
}

/** Opt-in list chrome keeps all native nodes and the caller's paging semantics. */
export function listSurface({ root, tools, card, heading, body, pagination } = {}) {
  for (const [node, name] of [[root, 'ui-list-page'], [tools, 'ui-list-tools'], [card, 'ui-list-card'],
    [heading, 'ui-list-heading'], [body, 'ui-list-body'], [pagination, 'ui-list-pagination']]) node?.classList.add(name);
  return { root, tools, card, heading, body, pagination };
}
export function listEntry(node) { node.classList.add('ui-list-entry'); return node; }

export const $ = id => document.getElementById(id);
export const el = (tag, text, className) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; };
export function button(text, fn, className, options = {}) {
  const node = el('button', text, className); node.type = 'button';
  // 帮助与 Agent 触发标识是可选的第 4 参：老的三参调用完全不受影响。
  if (options.help) node.setAttribute('data-help', options.help);
  if (options.agent) node.classList.add('agent-call');
  if (options.worker) bindWorkerPreview(node, options.worker);
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
  const key = Object.hasOwn(ROLE, role) ? String(role).toLowerCase() : 'unknown';
  const label = ROLE[role] || String(role ?? '未知');
  const node = el('span', label, `badge role-badge role-${key}`);
  node.title = `Worker 类型：${label}`;
  return node;
};
/** 快速路由标记：前缀短路、未调用规划模型创建的 task。文案与悬停说明是全站唯一口径。 */
export const routeBadge = () => {
  const node = el('span', '⚡ 快速路由', 'badge route-badge');
  node.title = '这条输入的快速路由前缀在提交时命中：未调用规划模型，直接创建了 Worker。';
  return node;
};
