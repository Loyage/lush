import { button, el } from './dom.js';

// Reading state belongs to this rendered Worker, not a project/global preference.
const panels = new WeakMap();
const modules = new WeakMap();
let nextPreviewId = 0;

function preview(section, id, expanded, remember) {
  let view = modules.get(section);
  if (!view) {
    const head = section.children[0];
    const title = head.querySelector('h2')?.textContent || '模块';
    const body = el('div', undefined, 'detail-preview-body'); body.id = id;
    const content = el('div', undefined, 'detail-preview-content');
    // Move, never serialize: Markdown, references, selections and lazy controls retain their nodes.
    for (const child of [...section.childNodes]) if (child !== head) content.insertBefore(child, null);
    body.append(content);
    const footer = el('div', undefined, 'detail-preview-footer');
    const note = el('span', '仅展示预览，完整内容可展开。', 'hint');
    const toggle = () => view.setExpanded(!view.expanded, true);
    const top = button('', toggle, 'ghost detail-preview-toggle');
    top.setAttribute('aria-controls', id);
    top.setAttribute('data-help', '只改变本模块的展示长度，不删除内容，也不调用 Agent；同一 Worker 刷新时保留选择。');
    const gauge = el('span', undefined, 'detail-preview-limit'); gauge.setAttribute('aria-hidden', 'true');
    head.append(top); footer.append(note); section.append(body, footer, gauge);
    section.classList.add('detail-preview');
    view = { section, body, content, gauge, expanded: false, remember,
      setExpanded(value, user = false) {
        this.expanded = Boolean(value);
        section.classList.toggle('detail-preview-expanded', this.expanded);
        if (user) this.remember(this.expanded);
        top.textContent = this.expanded ? '收起' : '展开完整内容';
        top.setAttribute('aria-expanded', String(this.expanded));
        top.setAttribute('aria-label', `${this.expanded ? '收起' : '展开完整内容'}：${title}`);
        note.hidden = this.expanded;
        if (user && !this.expanded) top.scrollIntoView?.({ block: 'nearest', behavior: 'auto' });
        this.measure();
      },
      measure() {
        // The invisible gauge resolves the same responsive CSS height in either mode.
        const height = content.getBoundingClientRect?.().height ?? 0;
        const limit = gauge.getBoundingClientRect?.().height ?? 0;
        const overflows = height > limit + 1;
        top.hidden = footer.hidden = !overflows;
        section.classList.toggle('detail-preview-long', overflows);
      },
    };
    // A clipped descendant must never become an invisible keyboard focus target.
    body.addEventListener('focusin', () => { if (!view.expanded) view.setExpanded(true, true); });
    modules.set(section, view);
  }
  view.remember = remember;
  view.setExpanded(expanded);
  return view;
}

/** Apply only to the detail renderer's reading blocks; lifecycle actions/forms stay outside. */
export function limitDetailModules(panel, { taskId, from = 0 }) {
  const old = panels.get(panel);
  old?.observer?.disconnect();
  const expanded = old?.taskId === taskId ? old.expanded : new Map();
  const views = [], occurrences = new Map();
  for (const section of [...panel.children].slice(from)) {
    if (!section.classList.contains('block')) continue;
    const title = section.children[0]?.querySelector('h2')?.textContent || '模块';
    const occurrence = occurrences.get(title) || 0; occurrences.set(title, occurrence + 1);
    const key = `${title}:${occurrence}`;
    views.push(preview(section, `worker-${taskId}-preview-${++nextPreviewId}`, expanded.get(key) || false,
      value => expanded.set(key, value)));
  }
  let observer = null;
  if (typeof ResizeObserver === 'function') {
    observer = new ResizeObserver(() => {
      for (const view of views) {
        if (view.section.parentNode !== panel) {
          observer.unobserve(view.content); observer.unobserve(view.gauge);
        } else view.measure();
      }
    });
    // Natural content detects lazy growth; the gauge detects height-only viewport changes.
    // Neither observation changes when our own expand/collapse controls toggle.
    for (const view of views) { observer.observe(view.content); observer.observe(view.gauge); }
  }
  panels.set(panel, { taskId, expanded, observer });
}

/** Reference navigation must reveal its real destination before scrolling/highlighting. */
export function revealDetailPreview(node) {
  for (let at = node; at; at = at.parentNode) {
    if (at.tagName === 'DETAILS') at.open = true;
    const view = modules.get(at);
    if (view) { view.setExpanded(true, true); return true; }
  }
  return false;
}
