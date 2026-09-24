import { $, button, el } from './dom.js';
import { show } from './messages.js';
import { detail, graph, resource } from './navigate.js';
import { transcriptOpen, ui } from './state.js';
import { startExplanation, startIntro } from './explanations.js';
import { agentHelp, modelHelp } from './help.js';

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
    if (['textarea','input','select','option'].includes(tag)) return true;
    if (at.id === 'project-gate' || at.id === 'context-menu' || hasClass(at, 'composer') || hasClass(at, 'context-menu')) return true;
  }
  return false;
};
// 页面内容＝`main` 之内：composer、右键菜单、项目启动门都在 main 之外，天然不作为引用来源。
const inPage = node => {
  const main = typeof document?.querySelector === 'function' ? document.querySelector('main') : null;
  return !main || inside(node, main);
};
const pageLocation = extra => ({ view: ui.graphOpen ? 'branch-graph' : ui.docsOpen ? 'docs' : ui.settingsOpen ? 'settings'
  : ui.statisticsOpen ? 'statistics'
  : ui.indexOpen ? `${ui.indexOpen}-index` : ui.selected === null ? 'overview' : 'task-detail',
  ...(ui.selected === null ? {} : { task_id: ui.selected }), ...extra });
const referenceKey = value => `${value.kind}:${JSON.stringify(value.target || {})}:${value.quote}`;

/**
 * 定位索引：把语义引用折成稳定的 `data-ref` 记号。语义元素经 `referenceable` 注册时会把记号写到
 * 节点上，卡片点击后按记号找元素、滚动并闪烁。`text` 引用没有稳定目标，不参与定位。
 */
function locateToken(kind, target = {}) {
  switch (kind) {
    case 'task': case 'task_subtree': return target.task_id == null ? null : `task-${target.task_id}`;
    case 'result': return target.task_id == null ? null : `result-${target.task_id}`;
    case 'diff': return target.task_id == null ? null : `diff-${target.task_id}`;
    case 'message': return target.message_id == null ? null : `message-${target.message_id}`;
    case 'transcript_step': return target.task_id == null || target.seq == null ? null : `step-${target.task_id}-${target.seq}`;
    case 'verification': return target.verification_id == null ? null : `verification-${target.verification_id}`;
    case 'history_event': return target.event_id == null ? null : `event-${target.event_id}`;
    case 'delivery_branch': return target.target_branch ? `branch:${target.target_branch}` : null;
    case 'intent': return target.input_id == null ? null : `intent-${target.input_id}`;
    case 'spec': return target.spec_id == null ? null : `spec-${target.spec_id}`;
    case 'notice': return target.notice_id == null ? null : `notice-${target.notice_id}`;
    default: return null;
  }
}
export const locatable = reference => Boolean(locateToken(reference?.kind, reference?.target));
const LOCATE_ROOTS = { intent: 'side-intents', spec: 'side-specs', notice: 'side-notices' };
function findByRef(root, token) {
  if (!root || !token) return null;
  const stack = [root];
  while (stack.length) {
    const node = stack.pop();
    const refs = node?.dataset?.ref;
    if (refs && String(refs).split(/\s+/).includes(token)) return node;
    for (const child of node?.children || []) stack.push(child);
  }
  return null;
}

/** Register one or more semantic references on a rendered node. Re-registering replaces the old descriptor. */
export function referenceable(node, descriptor) {
  if (!node) return node;
  const list = Array.isArray(descriptor) ? descriptor : [descriptor];
  descriptors.set(node, list);
  node.classList?.add?.('referenceable');
  if (node.dataset) {
    const tokens = new Set();
    for (const value of list) {
      const token = locateToken(value?.kind, value?.target);
      if (token) tokens.add(token);
    }
    if (tokens.size) node.dataset.ref = [...tokens].join(' ');
    else if ('ref' in node.dataset) delete node.dataset.ref;
  }
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
  if (excluded(target) || !inPage(target)) return null;
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
    const canLocate = locatable(reference);
    // Locatable cards navigate back to the source; plain text references stay inert.
    const label = canLocate
      ? button(reference.label, () => locateReference(reference), 'context-chip-label')
      : el('span', reference.label, 'context-chip-label');
    label.title = canLocate ? `${reference.quote}\n点击定位到来源` : reference.quote;
    const remove = button('×', () => {
      ui.composerReferences.splice(index, 1);
      renderComposerReferences();
    }, 'context-remove');
    remove.setAttribute('aria-label', `移除引用：${reference.label}`);
    chip.append(label, remove); return chip;
  }));
  holder.hidden = ui.composerReferences.length === 0;
}

let flashNode = null, flashTimer = null;
/** Clear the one-time locate highlight (boot / re-locate must not leave stale classes behind). */
export function clearLocateFlash() {
  if (flashTimer !== null) { globalThis.clearTimeout?.(flashTimer); flashTimer = null; }
  flashNode?.classList?.remove?.('locate-flash');
  flashNode = null;
}
const prefersReducedMotion = () => Boolean(
  globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches
  || globalThis.document?.documentElement?.dataset?.reducedMotion === 'true');
function flashLocated(node) {
  clearLocateFlash();
  node.classList?.add?.('locate-flash');
  flashNode = node;
  node.scrollIntoView?.({ block: 'center', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  flashTimer = globalThis.setTimeout?.(() => {
    if (flashNode === node) { node.classList?.remove?.('locate-flash'); flashNode = null; }
    flashTimer = null;
  }, 1500);
}
async function navigateForReference(reference) {
  const kind = reference?.kind, target = reference?.target || {};
  if (kind === 'delivery_branch') { await graph(); return $('detail'); }
  if (kind === 'intent' || kind === 'spec' || kind === 'notice') {
    resource(kind === 'intent' ? 'intents' : kind === 'spec' ? 'specs' : 'notices');
    return $(LOCATE_ROOTS[kind]);
  }
  if (['task','task_subtree','result','diff','message','verification','history_event','transcript_step'].includes(kind)) {
    // 检验 / 历史事件的 target 只有实体 id，所属任务在 location.task_id。
    const taskId = target.task_id ?? reference?.location?.task_id;
    if (taskId === null || taskId === undefined) return null;
    // 执行步骤只在展开的执行过程里渲染；定位先展开它，否则只能报找不到。
    if (kind === 'transcript_step') transcriptOpen.add(taskId);
    await detail(taskId);
    return $('detail');
  }
  return null;
}
async function waitForRef(root, token, attempts = 15) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const found = findByRef(root, token);
    if (found) return found;
    // 信息页列表按需加载：给异步渲染一点时间，找不到再如实报错。
    await new Promise(resolve => globalThis.setTimeout(resolve, 80));
  }
  return null;
}
/** 点击引用卡片：跳到对应页面，用 data-ref 找元素、滚动并做一次性闪烁。text 引用不定位。 */
export async function locateReference(reference) {
  const token = locateToken(reference?.kind, reference?.target);
  if (!token) return false;
  let root = null;
  try { root = await navigateForReference(reference); }
  catch (error) { show(`定位失败：${error.message}`, 'error'); return false; }
  const found = await waitForRef(root, token);
  if (!found) { show(`找不到这条引用的目标：${reference.label || token}。它可能已被移除或归档。`, 'error'); return false; }
  flashLocated(found);
  return true;
}
function hideMenu() { const menu = $('context-menu'); if (menu) menu.hidden = true; }
function showMenu(event, values, introduce = null) {
  const menu = $('context-menu');
  if (!menu || !values.length) return;
  menu.replaceChildren(...values.map(value => button(`引用：${value.label}`, () => { addComposerReference(value); hideMenu(); }, 'context-action')));
  if (introduce) menu.prepend(button(introduce.label, () => { hideMenu(); void introduce.run(); }, 'context-action',
    { agent: true, help: introduce.help }));
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
  const selectedText = selected ? String(window.getSelection?.()?.toString?.() || '').trim() : '';
  // 任意非空选区都能「介绍」：落在执行步骤里仍走只读解释 Agent；其余走直连模型的快速介绍。
  const introduce = !selected ? null
    : step && selectedText.length <= MAX_QUOTE
      ? { label: '介绍：目的、原理与结果含义', help: agentHelp('用只读的解释 Agent 说明这个执行步骤的目的、原理与结果含义。'), run: () => startExplanation(step.target.task_id, step.target.seq, selectedText) }
      : { label: '快速介绍所选文字：是什么、为何如此', help: modelHelp('用设置里配置的模型直接解释所选文字是什么、为何如此，不启动 Agent。'), run: () => startIntro(selected.quote, selected.location) };
  if (values.length) showMenu(event, values, introduce); else hideMenu();
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
  clearLocateFlash();
  hideMenu(); renderComposerReferences();
}
