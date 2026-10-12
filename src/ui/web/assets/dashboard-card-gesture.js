/** Card-local long press, delegated once per board; never steals links or native scrolling. */
export function createCardSettingsGesture(board, { active, canReveal, timers = globalThis } = {}) {
  const owner = document;
  let pending = null, shown = null, suppressed = null, disposed = false;
  const inside = (target, root) => { for (let at = target; at; at = at.parentNode) if (at === root) return true; return false; };
  const cardOf = target => {
    for (let at = target; at && at !== board; at = at.parentNode) if (at.classList?.contains('project-board-card')) return at;
    return null;
  };
  const live = card => !disposed && owner === globalThis.document && active() && inside(card, board) && canReveal();
  function cancel() { if (pending) timers.clearTimeout(pending.timer); pending = null; }
  function hide() {
    cancel();
    if (shown) {
      shown.querySelector('.dashboard-card-settings-host').hidden = true;
      shown = null;
    }
  }
  function reveal(card) {
    hide();
    if (!live(card)) return;
    const host = card.querySelector('.dashboard-card-settings-host');
    if (!host) return;
    host.hidden = false; shown = card;
    host.querySelector('button').focus?.({ preventScroll: true });
  }
  function down(event) {
    cancel(); suppressed = null;
    if (event.button !== 0 || event.isPrimary === false) return;
    const card = cardOf(event.target);
    if (!card || !live(card)) return;
    for (let at = event.target; at && at !== card; at = at.parentNode) {
      if (['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'SUMMARY'].includes(at.tagName) || at.isContentEditable || at.dataset?.help) return;
    }
    if (String(globalThis.window?.getSelection?.() || '').trim()) return;
    const state = { card, pointerId: event.pointerId, x: event.clientX, y: event.clientY };
    state.timer = timers.setTimeout(() => {
      if (pending !== state) return;
      pending = null;
      if (!live(card) || String(globalThis.window?.getSelection?.() || '').trim()) return;
      suppressed = { card, until: Date.now() + 1500 };
      reveal(card);
    }, 650);
    pending = state;
  }
  function move(event) {
    if (pending && event.pointerId === pending.pointerId && Math.hypot(event.clientX - pending.x, event.clientY - pending.y) > 8) cancel();
  }
  function end(event) { if (pending && event.pointerId === pending.pointerId) cancel(); }
  function suppress(event) {
    if (suppressed && Date.now() <= suppressed.until && inside(event.target, suppressed.card)) {
      // The synthetic release click must not activate a newly revealed control.
      event.preventDefault(); event.stopPropagation();
      if (event.type === 'click') suppressed = null;
    }
  }
  function key(event) {
    const card = cardOf(event.target);
    if (event.key === 'Escape') { const previous = shown; hide(); previous?.focus?.({ preventScroll: true }); }
    else if (card && (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))) {
      event.preventDefault(); event.stopPropagation(); reveal(card);
    }
  }
  function outside(event) { if (shown && !inside(event.target, shown)) hide(); }
  // Captured element blur is a focus transfer (including card -> entry), not window deactivation.
  function blur(event) { if (!event.target || event.target === globalThis || event.target === globalThis.window) hide(); }
  const local = [['pointerdown', down], ['pointermove', move], ['pointerup', end], ['pointercancel', end],
    ['pointerleave', cancel], ['click', suppress], ['contextmenu', suppress], ['keydown', key]];
  const global = [['pointerdown', outside], ['scroll', hide], ['blur', blur], ['pagehide', hide]];
  for (const [type, handler] of local) board.addEventListener(type, handler, true);
  for (const [type, handler] of global) globalThis.addEventListener?.(type, handler, true);
  const observer = typeof MutationObserver === 'function' ? new MutationObserver(() => {
    if (!active() || owner !== globalThis.document) dispose();
  }) : null;
  if (owner.documentElement) observer?.observe(owner.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] });
  function dispose() {
    if (disposed) return;
    hide(); disposed = true; suppressed = null; observer?.disconnect();
    for (const [type, handler] of local) board.removeEventListener?.(type, handler, true);
    for (const [type, handler] of global) globalThis.removeEventListener?.(type, handler, true);
  }
  return { hide, reveal, dispose };
}
