/** Visual time only: never use these values for polling, holds, notices or business work. */
import { onPrefChange, readPref } from './prefs.js';
import { MOTION_EASING } from './motion-values.js';

export const systemMotionMedia = () => globalThis.matchMedia?.('(prefers-reduced-motion: reduce)') ?? null;
export const reducedMotion = () => readPref('reduceMotion')
  || globalThis.document?.documentElement?.dataset.reducedMotion === 'true' || Boolean(systemMotionMedia()?.matches);
export const motionSpeed = () => Number(readPref('motionSpeed'));
const active = new Map();
let release = null, disposePreferences = null;

function applyPreferences() {
  const root = globalThis.document?.documentElement;
  root?.style?.setProperty?.('--motion-factor', String(1 / motionSpeed()));
  if (root?.dataset) {
    if (readPref('reduceMotion')) root.dataset.reducedMotion = 'true'; else delete root.dataset.reducedMotion;
  }
  updateActive();
}
/** Idempotent across app boots. The early appearance entry applies the same cached first frame. */
export function initMotion() {
  disposePreferences?.();
  const offSpeed = onPrefChange('motionSpeed', applyPreferences), offReduced = onPrefChange('reduceMotion', applyPreferences);
  disposePreferences = () => { offSpeed(); offReduced(); };
  applyPreferences();
}
function updateActive() {
  for (const [animation, entry] of [...active]) {
    if (!entry.node.isConnected || reducedMotion()) entry.finish();
    else if (animation.playbackRate !== motionSpeed()) {
      if (typeof animation.updatePlaybackRate === 'function') animation.updatePlaybackRate(motionSpeed());
      else animation.playbackRate = motionSpeed();
    }
  }
}
export function cancelMotions(node = null) {
  for (const entry of [...active.values()]) if (!node || entry.node === node || node.contains?.(entry.node)) entry.finish();
}
function watch() {
  if (release) return;
  const media = systemMotionMedia(), doc = globalThis.document;
  const observer = new MutationObserver(updateActive);
  observer.observe(doc.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-reduced-motion'] });
  const offSpeed = onPrefChange('motionSpeed', updateActive), offReduced = onPrefChange('reduceMotion', updateActive);
  const stop = () => cancelMotions();
  media?.addEventListener('change', updateActive);
  globalThis.addEventListener('pagehide', stop);
  release = () => {
    observer.disconnect(); offSpeed(); offReduced(); media?.removeEventListener('change', updateActive);
    globalThis.removeEventListener('pagehide', stop); release = null;
  };
}
/** State/DOM is committed by callers first. Disposal always releases temporary visual styles. */
export function animateMotion(node, frames, options = {}, cleanup = () => {}) {
  if (!node?.isConnected || typeof node.animate !== 'function' || reducedMotion()) { cleanup(); return null; }
  let animation;
  try {
    animation = node.animate(frames, { duration: 180, easing: MOTION_EASING, ...options });
    animation.playbackRate = motionSpeed();
  } catch {
    animation?.cancel(); cleanup(); return null; // Optional visual support cannot block a business result.
  }
  const finish = () => {
    if (!active.has(animation)) return;
    active.delete(animation); animation.onfinish = animation.oncancel = null; animation.cancel(); cleanup();
    if (!active.size) release?.();
  };
  active.set(animation, { node, finish }); animation.onfinish = animation.oncancel = finish; watch();
  return animation;
}

/** Opt-in surfaces only, not a DOM-insertion observer (polling must never replay entrances).
 * Hidden/ARIA/inert state changes immediately. Exit remnants are visual, not interactive;
 * reopening cancels cleanup before mounting the new content. No clone, focus or selection edits. */
export function showSurface(node, { slide = true } = {}) {
  cancelMotions(node); node.hidden = false;
  animateMotion(node, [{ opacity: 0, ...(slide ? { transform: 'translateY(4px)' } : {}) },
    { opacity: 1, ...(slide ? { transform: 'translateY(0)' } : {}) }]);
}
export function hideSurface(node, cleanup = () => {}) {
  if (!node || node.hidden) { cleanup(); return; }
  const opacity = globalThis.getComputedStyle?.(node).opacity || '1';
  cancelMotions(node); node.hidden = true;
  const inert = node.inert, aria = node.getAttribute('aria-hidden');
  node.inert = true; node.setAttribute('aria-hidden', 'true'); node.setAttribute('data-motion-exit', '');
  animateMotion(node, [{ opacity }, { opacity: 0 }], { duration: 140, fill: 'both' }, () => {
    node.removeAttribute('data-motion-exit'); node.inert = inert;
    if (aria === null) node.removeAttribute('aria-hidden'); else node.setAttribute('aria-hidden', aria);
    cleanup();
  });
}
