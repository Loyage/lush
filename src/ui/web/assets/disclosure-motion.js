// Opt-in geometry transitions, never a blanket handler for native details.
// State is committed synchronously; only the short-lived visual box is interpolated.
import { animateMotion, cancelMotions, reducedMotion } from './motion.js';
const active = new Map();

export function cancelDisclosureMotion(body) { active.get(body)?.(); }
export function cancelDisclosureMotions() { for (const finish of [...active.values()]) finish(); }

/** Natural content taller than a viewport switches immediately: its heading/arrow is the
 * orientation cue, not a multi-screen height tween. No node replacement or inline geometry. */
export function transitionDisclosure(body, commit, { animate = false, expanded = false } = {}) {
  const canAnimate = animate && body?.isConnected && typeof body.animate === 'function' && !reducedMotion();
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
  const animation = animateMotion(body, [{ height: `${from}px` }, { height: `${to}px` }], {
    duration: expanded ? 200 : 160, fill: 'both',
  }, () => {
    active.delete(body);
    body.removeAttribute('data-disclosure-motion');
    if (hidden) {
      body.inert = inert;
      if (ariaHidden === null) body.removeAttribute('aria-hidden'); else body.setAttribute('aria-hidden', ariaHidden);
    }
  });
  if (animation) active.set(body, () => cancelMotions(body));
}
