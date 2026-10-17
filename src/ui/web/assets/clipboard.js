import { button } from './dom.js';
import { show } from './messages.js';

/** Copy exact source text, with a fallback for non-secure project origins. */
export async function copyText(text) {
  const clipboard = globalThis.navigator?.clipboard;
  if (clipboard?.writeText) {
    try { await clipboard.writeText(text); return true; } catch { return false; }
  }
  const focused = document.activeElement;
  const selection = globalThis.window?.getSelection?.();
  const ranges = Array.from({ length: selection?.rangeCount || 0 }, (_, i) => selection.getRangeAt(i).cloneRange());
  let area;
  try {
    area = document.createElement('textarea');
    area.value = text; area.setAttribute('readonly', '');
    area.style.position = 'fixed'; area.style.top = '-1000px';
    document.body.append(area); area.select();
    return document.execCommand?.('copy') ?? false;
  } catch { return false; }
  finally {
    area?.remove(); focused?.focus?.({ preventScroll: true });
    if (ranges.length) { selection.removeAllRanges(); for (const range of ranges) selection.addRange(range); }
  }
}

let copyGeneration = 0;

/** A supplier may return null when its source read was cancelled or superseded. */
export function copyButton(source, { label = '复制原文', className = '', help } = {}) {
  return button(label, async () => {
    const ticket = ++copyGeneration, ownerDocument = globalThis.document;
    const current = () => ticket === copyGeneration && globalThis.document === ownerDocument;
    try {
      const text = typeof source === 'function' ? source() : source;
      const value = text && typeof text.then === 'function' ? await text : text;
      if (value == null || !current()) return;
      if (!await copyText(value)) throw new Error('剪贴板不可用，请手动选中正文复制');
      if (current()) show('已复制');
    } catch (error) { if (current()) show(`复制失败：${error.message}`, 'error'); }
  }, `ghost ${className}`.trim(), { help });
}
