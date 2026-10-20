import { button, el } from './dom-base.js';
import { paintDisclosure } from './view-controls.js';
import { captureModuleReading, restoreModuleReading } from './module-reading.js';

// Allocate registries only on first use; importing the common UI base has no eager state work.
let modules = null, observers = null;
let nextId = 0;
const COLLAPSE_MARGIN = 120;
const inside = (root, node) => { for (let at = node; at; at = at.parentNode) if (at === root) return true; return false; };

/** Opt-in only. preview clips long reading content; fold hides editors only on explicit request.
 * states is page/Worker-owned (true = expanded). Re-enhancing preserves nodes, never nests bodies.
 * Append later content to view.content, and keep summaries/diagnostics in view.summary or outside.
 */
export function enhanceModule(section, { key, mode = 'preview', states, summary, id } = {}) {
  if (!['preview', 'fold'].includes(mode)) throw new Error(`Unknown module mode: ${mode}`);
  modules ||= new WeakMap();
  let view = modules.get(section);
  if (view && (view.body.parentNode !== section || view.head.parentNode !== section)) {
    view.dispose(); modules.delete(section); view = null;
  }
  if (view && view.mode !== mode) throw new Error('A module cannot have two presentation modes');
  if (!view) {
    const head = [...section.children].find(node => node.classList.contains('section-title'));
    if (!head) throw new Error('A shared module needs a direct section-title heading');
    const title = head.querySelector('h2')?.textContent || head.querySelector('h3')?.textContent || '模块';
    const body = el('div', undefined, 'module-body'); body.id = id || `module-body-${++nextId}`;
    const content = el('div', undefined, 'module-content');
    // Move all nodes, including bare text. Editors, references, selection and lazy controls survive.
    for (const child of [...section.childNodes]) if (child !== head) content.insertBefore(child, null);
    body.append(content);
    const status = el('p', undefined, 'hint module-summary'); status.setAttribute('role', 'status');
    const top = button('', () => view.setExpanded(!view.expanded), 'ghost module-toggle');
    top.setAttribute('aria-controls', body.id);
    top.setAttribute('data-help', '只改变本模块的展示长度，不删除内容，也不调用 Agent；当前页面刷新时保留选择。');
    head.append(top); section.append(status, body);
    section.classList.add('ui-module', `module-${mode}`);
    let gauge = null, footer = null, note = null;
    if (mode === 'preview') {
      gauge = el('span', undefined, 'module-preview-limit'); gauge.setAttribute('aria-hidden', 'true');
      footer = el('div', undefined, 'module-preview-footer');
      note = el('span', '仅展示预览，完整内容可展开。', 'hint'); footer.append(note);
      section.append(footer, gauge);
    }
    const changes = new Set(), disposers = new Set();
    view = { section, head, body, content, summary: status, toggle: top, gauge, footer, mode, expanded: false,
      setExpanded(value, user = true) {
        this.expanded = Boolean(value);
        section.classList.toggle('module-expanded', this.expanded);
        if (section.classList.contains('detail-preview')) section.classList.toggle('detail-preview-expanded', this.expanded);
        if (mode === 'fold') body.hidden = !this.expanded;
        paintDisclosure(top, this.expanded, { expand: mode === 'preview' ? '展开完整内容' : '展开' });
        top.setAttribute('aria-label', `${top.textContent}：${title}`);
        if (note) note.hidden = this.expanded;
        if (user) this.states.set(this.key, this.expanded);
        this.measure();
        if (user && !this.expanded) {
          if (inside(body, globalThis.document?.activeElement)) top.focus?.();
          top.scrollIntoView?.({ block: 'nearest', behavior: 'auto' });
        }
        if (user) for (const callback of changes) callback();
      },
      measure() {
        const headingHeight = `${head.getBoundingClientRect?.().height ?? 0}px`;
        section.style.setProperty('--module-heading-height', headingHeight);
        section.style.setProperty('--detail-heading-height', headingHeight);
        if (mode === 'fold') { top.hidden = false; return; }
        const limit = gauge.getBoundingClientRect?.().height ?? 0;
        for (const node of content.querySelectorAll('.conversation-message')) node.measureReadingContent?.(limit);
        const long = (content.getBoundingClientRect?.().height ?? 0) > limit + COLLAPSE_MARGIN;
        top.hidden = footer.hidden = !long;
        section.classList.toggle('module-long', long);
        if (section.classList.contains('detail-preview')) section.classList.toggle('detail-preview-long', long);
      },
      onChange(callback) { changes.add(callback); return () => changes.delete(callback); },
      onDispose(callback) { disposers.add(callback); return () => disposers.delete(callback); },
      dispose() { this.active = false; for (const callback of [...disposers]) callback(); changes.clear(); },
    };
    // Never leave an invisible keyboard focus target in a clipped reading body.
    body.addEventListener('focusin', event => {
      if (!view.active || view.expanded) return;
      view.setExpanded(true);
      // Firefox may scroll focus against the old clipped box before expansion.
      // Reveal the actual destination too, not just its previously hidden ancestors.
      if (section.classList.contains('module-long')) event?.target?.scrollIntoView?.({ block: 'center', behavior: 'auto' });
    });
    modules.set(section, view);
  }
  view.active = true; view.key = key ?? view.key ?? view.body.id; view.states = states ?? view.states ?? new Map();
  // Re-enhancement must not erase renderer-owned asynchronous diagnostics.
  if (summary !== undefined) { view.summary.textContent = summary; view.summary.hidden = !summary; }
  else if (!view.summary.childNodes.length) view.summary.hidden = true;
  view.setExpanded(view.states.get(view.key) ?? (mode === 'fold'), false);
  return view;
}

/** Reveal every enclosing module/details before reference scrolling. No data/model requests. */
export function revealModule(node) {
  let revealed = false;
  for (let at = node; at; at = at.parentNode) {
    if (at.tagName === 'DETAILS') at.open = true;
    at.revealReadingContent?.();
    const view = modules?.get(at);
    if (view) { view.setExpanded(true); revealed = true; }
  }
  return revealed;
}

/** One page-owned observer and reading anchor. Call again after adding/rebuilding modules.
 * Returns an idempotent disposer; call it on navigation. Detached/replaced views also release
 * automatically (MutationObserver where available). No global/persisted expansion preferences.
 */
export function observeModules(panel, views, { capture = captureModuleReading, restore = restoreModuleReading,
  isCurrent } = {}) {
  observers ||= new WeakMap();
  disposeModules(panel);
  const initialView = panel.dataset.view, ownerWindow = globalThis.window;
  const ownsPage = isCurrent || (() => panel.dataset.view === initialView);
  panel.classList.add('module-reading-root');
  let observer = null, mutation = null, disposed = false, position = capture(panel);
  const attached = view => inside(panel, view.section);
  const rememberPosition = () => { if (!disposed) position = capture(panel); };
  const afterInteraction = () => queueMicrotask(rememberPosition);
  const changed = views.map(view => view.onChange(afterInteraction));
  panel.addEventListener('scroll', rememberPosition, { passive: true });
  panel.addEventListener('click', afterInteraction);
  ownerWindow?.addEventListener?.('scroll', rememberPosition, { passive: true });
  const releases = [];
  const dispose = () => {
    if (disposed) return;
    disposed = true; observer?.disconnect(); mutation?.disconnect();
    panel.classList.remove('module-reading-root');
    if (observers.get(panel) === dispose) observers.delete(panel);
    panel.removeEventListener?.('scroll', rememberPosition);
    panel.removeEventListener?.('click', afterInteraction);
    ownerWindow?.removeEventListener?.('scroll', rememberPosition);
    for (const unsubscribe of [...changed, ...releases]) unsubscribe();
  };
  for (const view of views) releases.push(view.onDispose(dispose));
  const current = () => {
    if (disposed) return false;
    if (!ownsPage() || panel.isConnected === false || !views.some(attached)) { dispose(); return false; }
    return true;
  };
  if (typeof ResizeObserver === 'function') {
    observer = new ResizeObserver(() => {
      if (!current()) return;
      const now = capture(panel);
      // User scrolling and synchronous renderer compensation win over saved geometry.
      if (now.scroll !== position.scroll) position = now;
      for (const view of views) {
        if (attached(view)) view.measure();
        else for (const node of [view.content, view.gauge, view.section, view.head].filter(Boolean)) observer.unobserve(node);
      }
      restore(panel, position); rememberPosition();
    });
    for (const view of views) for (const node of [view.content, view.gauge, view.section, view.head].filter(Boolean)) observer.observe(node);
  }
  if (typeof MutationObserver === 'function') {
    mutation = new MutationObserver(() => { current(); });
    mutation.observe(panel, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-view'] });
  }
  observers.set(panel, dispose);
  if (!views.length) dispose();
  return dispose;
}

export function disposeModules(panel) { observers?.get(panel)?.(); }
