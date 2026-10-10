// Only the active narrow-screen composer follows the soft keyboard's visual viewport.
export function viewportScrollDelta(rect, { top, height }, margin = 8) {
  const bottom = top + height - margin;
  if (rect.bottom > bottom) return rect.bottom - bottom;
  if (rect.top < top + margin) return rect.top - top - margin;
  return 0;
}

export function usesTouchEnter(win = window) {
  return Boolean(win.matchMedia?.('(pointer: coarse)').matches);
}

export function attachComposerViewport(input, shell, win = window) {
  if (!shell || !win.addEventListener || !win.requestAnimationFrame) return () => {};
  const viewport = win.visualViewport;
  let frame = null, disposed = false;
  const active = () => !disposed && win.matchMedia('(max-width: 760px)').matches
    && (document.activeElement === input || shell.contains(document.activeElement)) && !shell.hidden;
  const clear = () => {
    shell.style.removeProperty('--composer-keyboard-inset');
    shell.style.removeProperty('--composer-visible-height');
    document.body.style.removeProperty('--composer-keyboard-inset');
  };
  function update() {
    frame = null;
    if (!active()) { clear(); return; }
    // Do not fight pinch zoom / accessibility magnification.
    if (viewport && Math.abs(viewport.scale - 1) > 0.01) { clear(); return; }
    const height = viewport?.height ?? win.innerHeight, top = viewport?.offsetTop ?? 0;
    const inset = Math.max(0, win.innerHeight - height - top);
    shell.style.setProperty('--composer-keyboard-inset', `${inset}px`);
    shell.style.setProperty('--composer-visible-height', `${height}px`);
    // Extra scroll runway lets the document's last field clear an overlay keyboard.
    document.body.style.setProperty('--composer-keyboard-inset', `${inset}px`);
    const shellRect = shell.getBoundingClientRect();
    const rect = shellRect.height <= height - 16 ? shellRect : input.getBoundingClientRect();
    const delta = viewportScrollDelta(rect, { top, height });
    if (Math.abs(delta) > 1) win.scrollBy({ top: delta, behavior: 'instant' });
  }
  function schedule() {
    if (!disposed && frame === null) frame = win.requestAnimationFrame(update);
  }
  input.addEventListener('focus', schedule);
  shell.addEventListener('focusout', schedule);
  viewport?.addEventListener('resize', schedule);
  viewport?.addEventListener('scroll', schedule);
  win.addEventListener('resize', schedule);
  const observer = win.ResizeObserver ? new win.ResizeObserver(schedule) : null;
  observer?.observe(shell);
  return () => {
    disposed = true;
    if (frame !== null) win.cancelAnimationFrame(frame);
    input.removeEventListener('focus', schedule);
    shell.removeEventListener('focusout', schedule);
    viewport?.removeEventListener('resize', schedule);
    viewport?.removeEventListener('scroll', schedule);
    win.removeEventListener('resize', schedule);
    observer?.disconnect();
    clear();
  };
}
