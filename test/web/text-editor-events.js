// Explicit DOM-event delivery for the minimal project stub (which has no event dispatcher).
export function editorEvent(node, type, props = {}) {
  const event = { target: node, cancelable: true, defaultPrevented: false, stopped: false,
    preventDefault() { if (this.cancelable) this.defaultPrevented = true; },
    stopImmediatePropagation() { this.stopped = true; }, ...props };
  for (const listener of [...(node.listeners[type] ?? [])]) { listener(event); if (event.stopped) break; }
  if (!event.stopped) node[`on${type}`]?.(event);
  return event;
}
export function editorSelection(node, start, end = start, direction = 'none') {
  node.setSelectionRange ??= function(from, to, way = 'none') {
    this.selectionStart = from; this.selectionEnd = to; this.selectionDirection = way;
  };
  node.setSelectionRange(start, end, direction);
}
export function editorInput(node, value, { inputType = 'insertText', start = value.length, end = start, direction = 'none', beforeinput = true, isComposing = false } = {}) {
  if (beforeinput) editorEvent(node, 'beforeinput', { inputType, isComposing });
  node.value = value; editorSelection(node, start, end, direction);
  return editorEvent(node, 'input', { inputType, isComposing });
}
