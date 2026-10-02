import { readPref } from './prefs.js';

const motions = new WeakMap();
export function graphMotionRunning(box) {
  return (motions.get(box) || []).some(animation => animation.playState === 'running');
}
const cards = box => [...(box?.querySelectorAll('.task-graph-card') || [])];
const rect = node => node?.getBoundingClientRect?.();

export function captureGraph(host) {
  const box = host.querySelector('.task-graph');
  const entries = cards(box).map(node => ({ id: node.dataset.taskId, rect: rect(node),
    relationScroll: node.querySelector?.('.task-graph-merge-relations')?.scrollLeft || 0 }));
  const viewport = rect(host);
  const anchor = entries.find(item => item.rect && item.rect.bottom > Math.max(0, viewport?.top || 0));
  return { box, entries, anchor, scrollTop: host.scrollTop, scrollLeft: box?.scrollLeft || 0,
    windowY: globalThis.window?.scrollY || 0, windowX: globalThis.window?.scrollX || 0 };
}

/** No rAF, timers, or global listeners: finite WAAPI effects die with their cards. */
export function restoreGraph(host, box, before) {
  box.scrollLeft = before.scrollLeft;
  host.scrollTop = before.scrollTop;
  const after = cards(box);
  const previous = new Map(before.entries.map(item => [item.id, item]));
  for (const node of after) {
    const line = node.querySelector?.('.task-graph-merge-relations');
    if (line) line.scrollLeft = previous.get(node.dataset.taskId)?.relationScroll || 0;
  }
  const sameView = before.box?.dataset.layoutKey === box.dataset.layoutKey;
  const oldOrder = before.entries.map(item => item.id).join(',');
  const newOrder = after.map(node => node.dataset.taskId).join(',');
  if (!sameView || oldOrder === newOrder) return;
  const oldRects = new Map(before.entries.map(item => [item.id, item.rect]));
  // Preserve the first card being read, rather than scrolling to the promoted sibling.
  if (before.anchor && (before.scrollTop || before.windowY)) {
    const anchor = after.find(node => node.dataset.taskId === before.anchor.id);
    const delta = (rect(anchor)?.top ?? before.anchor.rect.top) - before.anchor.rect.top;
    if (host.scrollHeight > host.clientHeight) host.scrollTop += delta;
    else globalThis.window?.scrollTo?.({ top: before.windowY + delta, left: before.windowX, behavior: 'instant' });
  }
  if (readPref('reduceMotion') || document.documentElement.dataset.reducedMotion === 'true'
    || globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
  const viewport = rect(host);
  const top = Math.max(0, viewport?.top || 0);
  const bottom = Math.min(globalThis.innerHeight || Infinity, viewport?.bottom ?? Infinity);
  const animations = [];
  for (const node of after) {
    const first = oldRects.get(node.dataset.taskId), last = rect(node);
    if (!first || !last || !node.animate) continue;
    if ((first.bottom <= top || first.top >= bottom) && (last.bottom <= top || last.top >= bottom)) continue;
    const x = first.left - last.left, y = first.top - last.top;
    if (Math.abs(x) < 1 && Math.abs(y) < 1) continue;
    animations.push(node.animate([{ transform: `translate(${x}px, ${y}px)` }, { transform: 'translate(0, 0)' }],
      { duration: 250, easing: 'ease-out' }));
  }
  motions.set(box, animations);
}
