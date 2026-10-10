/** Attach one shared undo stack for buttons, keyboard and native history input intents.
 * Normal input remains the host's responsibility; only undo/redo calls onChange.
 * Hosts must reset() after externally replacing/consuming text, and sync() after disabling it.
 */
export function attachTextEditor(textarea, { onChange } = {}) {
  // Session-only body history, bounded independently of textarea limits.
  const MAX_EDITS = 100, MAX_CHARS = 1024 * 1024;
  // Keep this stateless helper independent of application imports so lazy
  // consumers do not split new stateful chunks out of the startup graph.
  const el = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const controls = el('div', undefined, 'text-editor-controls');
  controls.setAttribute('role', 'group'); controls.setAttribute('aria-label', '正文编辑');
  let entries = [], position = 0, chars = 0, before = null, composition = null;
  let ending = false, generation = 0, disposed = false, nativeIntent = null;
  const snapshot = () => ({ value: textarea.value, start: textarea.selectionStart ?? textarea.value.length,
    end: textarea.selectionEnd ?? textarea.value.length, direction: textarea.selectionDirection ?? 'none' });
  let current = snapshot();
  const blocked = () => disposed || textarea.disabled || textarea.readOnly || composition !== null;
  const makeControl = (label, direction, shortcut) => {
    const node = el('button', label, `ghost text-editor-${direction === -1 ? 'undo' : 'redo'}`); node.type = 'button';
    const host = el('span', undefined, 'help-host');
    const help = `${direction === -1 ? '撤销' : '恢复'}本页最近的正文编辑（${shortcut}）；不改变引用、父 Worker、运行设置或已保存/发送的请求。`;
    node.setAttribute('data-help', help); host.setAttribute('data-help', help);
    // Keep the textarea's selection when a mouse/touch button is used.
    node.onmousedown = event => event.preventDefault();
    node.onclick = () => replay(direction);
    host.append(node); controls.append(host);
    return { node, host, help };
  };
  const undo = makeControl('撤销', -1, 'Ctrl/⌘+Z');
  const redo = makeControl('重做', 1, 'Ctrl/⌘+Shift+Z 或 Ctrl+Y');
  function sync() {
    for (const [control, available] of [[undo, position > 0], [redo, position < entries.length]]) {
      control.node.disabled = blocked() || !available;
      control.host.tabIndex = control.node.disabled ? 0 : -1;
      const reason = disposed ? '编辑器已关闭。' : textarea.disabled || textarea.readOnly ? '正文当前不可编辑。'
        : composition !== null ? '请先完成输入法候选确认。' : !available ? '没有可恢复的正文编辑。' : '';
      control.host.setAttribute('data-help', reason + control.help);
    }
  }
  const size = entry => entry.before.value.length + entry.after.value.length;
  function record(from, to) {
    current = to; before = null;
    if (from.value !== to.value) {
      for (const entry of entries.splice(position)) chars -= size(entry);
      const entry = { before: from, after: to }; entries.push(entry); chars += size(entry); position++;
      while (entries.length > MAX_EDITS || chars > MAX_CHARS) { chars -= size(entries.shift()); position--; }
    }
    sync();
  }
  function restore(state) {
    textarea.value = state.value;
    textarea.setSelectionRange?.(state.start, state.end, state.direction);
    current = state;
  }
  function reset() {
    generation++; entries = []; position = 0; chars = 0; before = composition = nativeIntent = null; ending = false;
    current = snapshot(); sync();
  }
  function replay(direction) {
    if (blocked()) return;
    // Do not revive old text if a host replaced it without resetting the controller.
    if (textarea.value !== current.value) { reset(); return; }
    const entry = entries[direction === -1 ? position - 1 : position];
    if (!entry) return;
    position += direction;
    restore(direction === -1 ? entry.before : entry.after);
    textarea.focus({ preventScroll: true }); sync();
    onChange?.();
  }
  const stop = event => { event.preventDefault(); event.stopImmediatePropagation?.(); };
  const historyDirection = event => event.inputType === 'historyUndo' ? -1 : event.inputType === 'historyRedo' ? 1 : 0;
  const listeners = [];
  function listen(type, handler, capture = false) {
    const guarded = event => { if (!disposed) handler(event); };
    textarea.addEventListener(type, guarded, capture); listeners.push([type, guarded, capture]);
  }
  listen('keydown', event => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    const key = event.key?.toLowerCase();
    const direction = key === 'z' ? (event.shiftKey ? 1 : -1) : key === 'y' && event.ctrlKey && !event.shiftKey ? 1 : 0;
    if (!direction) return;
    stop(event);
    if (!event.isComposing && event.keyCode !== 229) replay(direction);
  }, true);
  listen('beforeinput', event => {
    const direction = historyDirection(event);
    if (direction) {
      stop(event);
      // Some mobile native history intents cannot be cancelled. Restore our state
      // after that input, then apply the shared stack rather than trusting native history.
      if (event.cancelable === false) nativeIntent = direction;
      else replay(direction);
      return;
    }
    if (composition !== null || event.isComposing) return;
    if (textarea.value !== current.value) reset();
    before = snapshot();
  }, true);
  listen('input', event => {
    const direction = nativeIntent || historyDirection(event);
    if (direction) {
      nativeIntent = null; restore(current); stop(event); replay(direction); return;
    }
    if (composition !== null || event.isComposing) { current = snapshot(); sync(); return; }
    record(before ?? current, snapshot());
  }, true);
  listen('compositionstart', () => {
    if (textarea.value !== current.value) reset();
    composition = snapshot(); before = null; ending = false; generation++; sync();
  });
  listen('compositionend', () => {
    if (composition === null) return;
    ending = true; const token = generation;
    // Engines differ on whether the final input precedes or follows compositionend.
    // Both synchronous event orders belong to the same confirmed IME edit.
    queueMicrotask(() => {
      if (disposed || generation !== token || !ending) return;
      const from = composition; composition = null; ending = false; record(from, snapshot());
    });
  });
  for (const type of ['select', 'keyup', 'pointerup']) listen(type, () => {
    if (!before && composition === null && textarea.value === current.value) current = snapshot();
  });
  sync();
  return { controls, reset, sync, dispose() {
    if (disposed) return;
    disposed = true; generation++;
    for (const [type, handler, capture] of listeners) textarea.removeEventListener?.(type, handler, capture);
    entries = []; before = composition = nativeIntent = null; current = { value: '', start: 0, end: 0, direction: 'none' }; chars = position = 0;
    sync();
  } };
}
