// Opt-in geometry transitions, never a blanket handler for native details.
// State is committed synchronously; only the short-lived visual box is interpolated.
const active = new Map();
let release = null;
const reduced = () => globalThis.document?.documentElement?.dataset.reducedMotion === 'true'
  || globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

export function cancelDisclosureMotion(body) { active.get(body)?.(); }
export function cancelDisclosureMotions() { for (const finish of [...active.values()]) finish(); }

function watch() {
  if (release) return;
  const media = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)');
  const check = () => {
    for (const [body, finish] of active) if (!body.isConnected || reduced()) finish();
  };
  const observer = new MutationObserver(check);
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-reduced-motion'] });
  media?.addEventListener('change', check);
  globalThis.addEventListener('pagehide', cancelDisclosureMotions);
  release = () => {
    observer.disconnect(); media?.removeEventListener('change', check);
    globalThis.removeEventListener('pagehide', cancelDisclosureMotions); release = null;
  };
}

/** Natural content taller than a viewport switches immediately: its heading/arrow is the
 * orientation cue, not a multi-screen height tween. No node replacement or inline geometry. */
export function transitionDisclosure(body, commit, { animate = false, expanded = false } = {}) {
  const canAnimate = animate && body?.isConnected && typeof body.animate === 'function' && !reduced();
  const from = canAnimate ? body.getBoundingClientRect().height : 0;
  cancelDisclosureMotion(body);
  commit();
  if (!canAnimate) return;
  const to = body.getBoundingClientRect().height;
  if (Math.abs(to - from) < 1 || Math.max(from, to) > Math.min(600, globalThis.innerHeight * .75)) return;
  // Closing is already semantically collapsed. The visual remnant cannot take focus or be
  // read twice by assistive technology while CSS temporarily overrides display:none.
  const hidden = to === 0, inert = body.inert, ariaHidden = body.getAttribute('aria-hidden');
  if (hidden) { body.inert = true; body.setAttribute('aria-hidden', 'true'); }
  body.setAttribute('data-disclosure-motion', '');
  const animation = body.animate([{ height: `${from}px` }, { height: `${to}px` }], {
    duration: expanded ? 200 : 160, easing: 'cubic-bezier(.2, 0, .2, 1)', fill: 'both',
  });
  const finish = () => {
    if (active.get(body) !== finish) return;
    active.delete(body); animation.onfinish = animation.oncancel = null; animation.cancel();
    body.removeAttribute('data-disclosure-motion');
    if (hidden) {
      body.inert = inert;
      if (ariaHidden === null) body.removeAttribute('aria-hidden'); else body.setAttribute('aria-hidden', ariaHidden);
    }
    if (!active.size) release?.();
  };
  active.set(body, finish); animation.onfinish = animation.oncancel = finish; watch();
}
