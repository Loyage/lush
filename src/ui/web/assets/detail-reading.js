// Preserve a visible piece of content, not a scroll number: blocks above it may change height.
const inside = (root, node) => { for (let at = node; at; at = at.parentNode) if (at === root) return true; return false; };
const rect = node => node?.getBoundingClientRect?.();
const pageMode = () => globalThis.window?.matchMedia?.('(max-width: 760px)')?.matches === true;
const candidatesOf = content => [...new Set(['p', 'pre', 'li', 'summary', '.task-message', '.progress-history-version', '.conversation-message']
  .flatMap(selector => [...content.querySelectorAll(selector)]))]
  .filter(node => {
    // Full message text remains in the DOM, but clipped paragraphs are not visible anchors.
    const message = node.closest?.('.conversation-message');
    if (!message?.classList.contains('conversation-long') || message.classList.contains('conversation-expanded') || node === message) return true;
    const body = rect(message.querySelector('.conversation-body')), box = rect(node);
    return !body || !box || (box.bottom > body.top && box.top < body.bottom);
  })
  .sort((a, b) => (rect(a)?.top ?? Infinity) - (rect(b)?.top ?? Infinity));
const sections = panel => {
  const counts = new Map();
  return [...panel.children].filter(node => node.classList.contains('block')).map(node => {
    const title = node.children[0]?.querySelector('h2')?.textContent || node.className;
    const ordinal = counts.get(title) || 0; counts.set(title, ordinal + 1);
    return { node, key: `${title}:${ordinal}` };
  });
};

export function captureDetailReading(panel) {
  const page = pageMode(), bounds = rect(panel);
  const top = page ? Math.max(0, rect(document.querySelector?.('.view-toolbar'))?.bottom || 0) : bounds?.top;
  const bottom = page ? window.innerHeight : bounds?.bottom;
  const scroll = page ? window.scrollY : panel.scrollTop;
  const state = { page, scroll, width: window.innerWidth, height: window.innerHeight };
  if (!scroll || !Number.isFinite(top) || !Number.isFinite(bottom)) return state;
  const area = sections(panel).find(({ node }) => { const box = rect(node); return box?.bottom > top && box.top < bottom; });
  if (!area) return state;
  // Never anchor to a sticky heading: its screen position hides changes to its block's origin.
  const headHeight = rect(area.node.children[0])?.height || 0;
  const content = area.node.querySelector('.detail-preview-content') || area.node;
  const candidates = candidatesOf(content);
  const anchor = candidates.find(node => { const box = rect(node); return box && box.bottom > box.top && box.bottom > top + headHeight && box.top < Math.min(bottom, rect(area.node).bottom); });
  return { ...state, key: area.key, moduleTop: rect(area.node).top,
    anchor, index: candidates.indexOf(anchor), anchorTop: rect(anchor)?.top };
}

export function restoreDetailReading(panel, state) {
  if (!state || state.page !== pageMode()) return;
  // Resize/reflow is intentional; don't fight a changed viewport or explicit navigation.
  if (state.width !== window.innerWidth || state.height !== window.innerHeight) return;
  const area = sections(panel).find(entry => entry.key === state.key)?.node;
  let delta = 0;
  if (area) {
    const content = area.querySelector('.detail-preview-content') || area;
    const anchor = inside(area, state.anchor) ? state.anchor
      : candidatesOf(content)[state.index];
    delta = anchor && Number.isFinite(state.anchorTop) ? rect(anchor).top - state.anchorTop : rect(area).top - state.moduleTop;
  }
  // Rebuilding can clamp scrollTop while the panel is empty. Correct from the actual
  // post-update scroll, otherwise that clamp would be counted twice in the delta.
  const actual = state.page ? window.scrollY : panel.scrollTop;
  const desired = area ? actual + delta : (state.scroll || 0);
  if (state.page) {
    if (Number.isFinite(desired) && window.scrollY !== desired) window.scrollTo?.({ top: desired, left: window.scrollX, behavior: 'instant' });
  } else if (Number.isFinite(desired)) panel.scrollTop = desired;
}
