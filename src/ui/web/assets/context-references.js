import { $, button, el } from './dom.js';
import { ui } from './state.js';
import { startExplanation } from './explanations.js';

const MAX_REFERENCES = 12;
const MAX_QUOTE = 8192;
const MAX_REFERENCE_BYTES = 48 * 1024;
const descriptors = new WeakMap();
let handlers = null;

const textOf = node => String(node?.innerText ?? node?.textContent ?? '').replace(/\s+/g, ' ').trim();
const parentOf = node => node?.parentElement ?? node?.parentNode ?? null;
const hasClass = (node, name) => Boolean(node?.classList?.contains?.(name));
const inside = (node, target) => { for (let at = node; at; at = parentOf(at)) if (at === target) return true; return false; };
const excluded = node => {
  for (let at = node; at; at = parentOf(at)) {
    const tag = String(at.tagName || '').toLowerCase();
    if (['textarea','input','select','option'].includes(tag) || hasClass(at, 'composer') || hasClass(at, 'context-menu')) return true;
  }
  return false;
};
const pageLocation = extra => ({ view: ui.graphOpen ? 'branch-graph' : ui.docsOpen ? 'docs' : ui.settingsOpen ? 'settings'
  : ui.indexOpen ? `${ui.indexOpen}-index` : ui.selected === null ? 'overview' : 'task-detail',
  ...(ui.selected === null ? {} : { task_id: ui.selected }), ...extra });
const referenceKey = value => `${value.kind}:${JSON.stringify(value.target || {})}:${value.quote}`;

/** Register one or more semantic references on a rendered node. Re-registering replaces the old descriptor. */
export function referenceable(node, descriptor) {
  if (!node) return node;
  descriptors.set(node, Array.isArray(descriptor) ? descriptor : [descriptor]);
  node.classList?.add?.('referenceable');
  return node;
}

function materialize(raw, node) {
  const value = typeof raw === 'function' ? raw(node) : raw;
  if (!value) return null;
  const quote = String(typeof value.quote === 'function' ? value.quote(node) : (value.quote || textOf(node))).trim();
  if (!quote) return null;
  const truncated = quote.length > MAX_QUOTE;
  const label = `${String(value.label || '页面内容')}${truncated ? ' · 已截断' : ''}`;
  return { version: 1, kind: value.kind || 'text', target: { ...(value.target || {}) },
    label: label.slice(0, 200), quote: quote.slice(0, MAX_QUOTE),
    location: pageLocation(value.location || {}), captured_at: new Date().toISOString() };
}
function semanticOptions(node) {
  for (let at = node; at; at = parentOf(at)) {
    const registered = descriptors.get(at);
    if (registered) return registered.map(value => materialize(value, at)).filter(Boolean);
  }
  return [];
}
function selectionReference(target) {
  if (excluded(target) || typeof window?.getSelection !== 'function') return null;
  const selection = window.getSelection();
  const quote = String(selection?.toString?.() || '').trim();
  if (!quote || selection?.isCollapsed) return null;
  if (typeof selection?.containsNode === 'function' && !selection.containsNode(target, true)) return null;
  return { version: 1, kind: 'text', target: {}, label: `所选文字 · ${Math.min(quote.length, MAX_QUOTE)}${quote.length > MAX_QUOTE ? `/${quote.length} 字 · 已截断` : ' 字'}`,
    quote: quote.slice(0, MAX_QUOTE), location: pageLocation({ section: 'selection' }), captured_at: new Date().toISOString() };
}
function genericReference(target) {
  if (excluded(target)) return null;
  const main = typeof document?.querySelector === 'function' ? document.querySelector('main') : null;
  if (main && !inside(target, main)) return null;
  let node = target;
  while (node && !textOf(node)) node = parentOf(node);
  const quote = textOf(node);
  if (!quote) return null;
  const section = node?.dataset?.referenceSection || node?.className || String(node?.tagName || '页面内容').toLowerCase();
  return { version: 1, kind: 'text', target: {}, label: `页面内容 · ${String(section).slice(0, 80)}${quote.length > MAX_QUOTE ? ' · 已截断' : ''}`,
    quote: quote.slice(0, MAX_QUOTE), location: pageLocation({ section: String(section).slice(0, 200) }), captured_at: new Date().toISOString() };
}

export function setComposerReferences(values) {
  ui.composerReferences = [...values];
  renderComposerReferences();
}
export const composerReferences = () => [...ui.composerReferences];
export function addComposerReference(value) {
  if (!value) return;
  if (ui.composerReferences.some(existing => referenceKey(existing) === referenceKey(value))) return;
  if (ui.composerReferences.length >= MAX_REFERENCES) throw new Error(`一条输入最多引用 ${MAX_REFERENCES} 项`);
  const next = [...ui.composerReferences, value];
  const bytes = typeof TextEncoder === 'function' ? new TextEncoder().encode(JSON.stringify(next)).length : JSON.stringify(next).length;
  if (bytes > MAX_REFERENCE_BYTES) throw new Error('本条输入的引用快照合计不能超过 48 KiB；请移除较长的引用后再试');
  ui.composerReferences.push(value);
  renderComposerReferences();
  $('input')?.focus?.();
}
export function renderComposerReferences() {
  const holder = $('composer-references');
  if (!holder) return;
  holder.replaceChildren(...ui.composerReferences.map((reference, index) => {
    const chip = el('span', undefined, 'context-chip');
    const label = el('span', reference.label, 'context-chip-label');
    label.title = reference.quote;
    const remove = button('×', () => {
      ui.composerReferences.splice(index, 1);
      renderComposerReferences();
    }, 'context-remove');
    remove.setAttribute('aria-label', `移除引用：${reference.label}`);
    chip.append(label, remove); return chip;
  }));
  holder.hidden = ui.composerReferences.length === 0;
}
function hideMenu() { const menu = $('context-menu'); if (menu) menu.hidden = true; }
function showMenu(event, values, explanation = null) {
  const menu = $('context-menu');
  if (!menu || !values.length) return;
  menu.replaceChildren(...values.map(value => button(`引用：${value.label}`, () => { addComposerReference(value); hideMenu(); }, 'context-action')));
  if (explanation) menu.prepend(button('介绍：目的、原理与结果含义', () => {
    hideMenu(); void startExplanation(explanation.taskId, explanation.seq, explanation.quote);
  }, 'context-action'));
  const width = Number(globalThis.innerWidth || 0), height = Number(globalThis.innerHeight || 0);
  const left = width ? Math.min(event.clientX ?? 0, Math.max(8, width - 370)) : (event.clientX ?? 0);
  const top = height ? Math.min(event.clientY ?? 0, Math.max(8, height - 260)) : (event.clientY ?? 0);
  menu.style.left = `${Math.max(8, left)}px`; menu.style.top = `${Math.max(8, top)}px`; menu.hidden = false;
  event.preventDefault?.();
}
function onContextMenu(event) {
  const selected = selectionReference(event.target);
  const semantic = semanticOptions(event.target);
  const generic = genericReference(event.target);
  const values = selected ? [selected, ...semantic] : [...semantic];
  if (generic && !values.some(value => value.kind === 'text' && value.quote === generic.quote)) values.push(generic);
  const step = semantic.find(value => value.kind === 'transcript_step');
  const selectedText = String(window.getSelection?.()?.toString?.() || '').trim();
  const explanation = selected && step && selectedText.length <= MAX_QUOTE
    ? { taskId: step.target.task_id, seq: step.target.seq, quote: selectedText } : null;
  if (values.length) showMenu(event, values, explanation); else hideMenu();
}
function onClick(event) { if (!inside(event.target, $('context-menu'))) hideMenu(); }
function onKeydown(event) { if (event.key === 'Escape') hideMenu(); }

/** Install the delegated menu once per boot; rendered panels only register semantic descriptors. */
export function initContextReferences() {
  if (handlers && typeof removeEventListener === 'function') {
    removeEventListener('contextmenu', handlers.contextmenu); removeEventListener('click', handlers.click); removeEventListener('keydown', handlers.keydown);
  }
  handlers = { contextmenu: onContextMenu, click: onClick, keydown: onKeydown };
  addEventListener('contextmenu', handlers.contextmenu); addEventListener('click', handlers.click); addEventListener('keydown', handlers.keydown);
  hideMenu(); renderComposerReferences();
}
