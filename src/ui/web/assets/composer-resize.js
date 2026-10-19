import { readPref, writePref, onPrefChange } from './prefs.js';

/** Remember only deliberate resizing, never layout/soft-keyboard adjustments. */
export function attachComposerResize(input, handle, win = window) {
  if (!input || !handle) return () => {};
  let preferred = readPref('composerHeight'), drag = null;
  const maximum = () => Math.max(64, Math.min(4096, (win.innerHeight || 900) * .5));
  const clamp = value => Math.round(Math.max(64, Math.min(maximum(), value)));
  const height = () => input.getBoundingClientRect?.().height || preferred || 64;
  const describe = () => {
    handle.setAttribute('aria-valuemin', '64');
    handle.setAttribute('aria-valuemax', String(Math.round(maximum())));
    handle.setAttribute('aria-valuenow', String(clamp(height())));
  };
  const paint = () => {
    input.style.setProperty('--composer-input-height', preferred === null ? '' : `${preferred}px`);
    describe();
  };
  const save = () => { preferred = writePref('composerHeight', preferred); };
  const finish = (event, cancelled = false) => {
    if (!drag || event.pointerId !== drag.id) return;
    const previous = drag; drag = null;
    if (cancelled) { preferred = previous.preferred; paint(); }
    else save();
    if (handle.hasPointerCapture?.(previous.id)) handle.releasePointerCapture(previous.id);
  };
  const down = event => {
    if (drag || event.button !== 0 || event.isPrimary === false) return;
    // Capturing before editing also leaves an unsupported/cancelled gesture harmless.
    try { handle.setPointerCapture(event.pointerId); } catch { return; }
    event.preventDefault();
    drag = { id: event.pointerId, y: event.clientY, height: height(), preferred };
    handle.focus({ preventScroll: true });
  };
  const move = event => {
    if (!drag || event.pointerId !== drag.id) return;
    preferred = clamp(drag.height + drag.y - event.clientY); paint();
  };
  const up = event => finish(event);
  const cancel = event => finish(event, true);
  const keydown = event => {
    if (drag || event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
    const step = event.shiftKey ? 64 : 16;
    const next = { ArrowUp: height() + step, ArrowDown: height() - step, Home: 64, End: maximum() }[event.key];
    if (next === undefined) return;
    event.preventDefault(); preferred = clamp(next); paint(); save();
  };
  const handlers = { pointerdown: down, pointermove: move, pointerup: up, pointercancel: cancel, lostpointercapture: cancel, keydown };
  for (const [type, handler] of Object.entries(handlers)) handle.addEventListener(type, handler);
  win.addEventListener?.('resize', describe);
  const observer = win.ResizeObserver ? new win.ResizeObserver(describe) : null;
  observer?.observe(input);
  const stop = onPrefChange('composerHeight', value => { preferred = value; paint(); });
  paint();
  return () => {
    if (drag) cancel({ pointerId: drag.id });
    for (const [type, handler] of Object.entries(handlers)) handle.removeEventListener(type, handler);
    win.removeEventListener?.('resize', describe); observer?.disconnect(); stop();
  };
}
