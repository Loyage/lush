import { enhanceModule, observeModules, disposeModules, revealModule } from './shared-module.js';

// Reading choices belong to this rendered Worker, not a project/global preference.
const panels = new WeakMap();
let nextPreviewId = 0;

/** Apply only to the detail renderer's reading blocks; lifecycle actions/forms stay outside. */
export function limitDetailModules(panel, { taskId, from = 0 }) {
  disposeModules(panel);
  const old = panels.get(panel);
  const expanded = old?.taskId === taskId ? old.expanded : new Map();
  const views = [], occurrences = new Map();
  for (const section of [...panel.children].slice(from)) {
    if (!section.classList.contains('block')) continue;
    const title = section.children[0]?.querySelector('h2')?.textContent || '模块';
    const occurrence = occurrences.get(title) || 0; occurrences.set(title, occurrence + 1);
    const key = `${title}:${occurrence}`;
    const view = enhanceModule(section, { key, states: expanded, mode: 'preview',
      id: `worker-${taskId}-preview-${++nextPreviewId}` });
    // Retain the detail DOM/CSS contract for conversation/progressive updates and references.
    section.classList.add('detail-preview');
    for (const [node, name] of [[view.body, 'body'], [view.content, 'content'], [view.gauge, 'limit'],
      [view.footer, 'footer'], [view.toggle, 'toggle']]) node.classList.add(`detail-preview-${name}`);
    view.toggle.setAttribute('data-help', '只改变本模块的展示长度，不删除内容，也不调用 Agent；同一 Worker 刷新时保留选择。');
    view.setExpanded(view.expanded, false); views.push(view);
  }
  observeModules(panel, views, { isCurrent: () => !panel.dataset.view || panel.dataset.view === 'task' });
  panels.set(panel, { taskId, expanded });
}

/** Release geometry observers/listeners on navigation; keep this Worker's expansion choices. */
export function disposeDetailModules(panel) { disposeModules(panel); }

/** Reference navigation must reveal its real destination before scrolling/highlighting. */
export function revealDetailPreview(node) { return revealModule(node); }
