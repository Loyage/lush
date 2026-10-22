/** Presentation only: callers retain ownership of disabled gates and request lifetimes. */
export function buttonFeedback(node, label = '处理中…') {
  let restore = null, reserved = false, observer = null;
  // Only change a direct text label, never replace icons or caller-owned child elements.
  const labelTarget = () => [...node.childNodes].find(child => child.nodeType === 3 && child.textContent.trim())
    || (node.childNodes.length ? null : node);
  function reserve() {
    const target = labelTarget();
    if (reserved || !target || !node.cloneNode || !node.getBoundingClientRect().width) return;
    // Measure intrinsic labels, not a flex-stretched width that would overflow after resizing.
    // The hidden sibling keeps contextual typography without changing the live accessible name.
    const sample = node.cloneNode(true); sample.removeAttribute('id'); sample.setAttribute('aria-hidden', 'true');
    sample.disabled = true;
    Object.assign(sample.style, { position: 'absolute', visibility: 'hidden', pointerEvents: 'none', width: 'max-content', minWidth: '0', maxWidth: 'none' });
    node.parentNode.insertBefore(sample, node);
    const before = sample.getBoundingClientRect().width;
    if (target === node) sample.textContent = label;
    else sample.childNodes[[...node.childNodes].indexOf(target)].textContent = label;
    const during = sample.getBoundingClientRect().width;
    sample.remove();
    // Reserve both labels before first paint; never shrink a caller's existing minimum.
    const minimum = parseFloat(globalThis.getComputedStyle(node).minWidth) || 0;
    node.style.minWidth = `min(100%, ${Math.max(before, during, minimum)}px)`;
    reserved = true; observer?.disconnect();
  }
  if (globalThis.ResizeObserver) { observer = new ResizeObserver(reserve); observer.observe(node); }
  return busy => {
    if (busy && !restore) {
      reserve();
      const priorBusy = node.getAttribute('aria-busy'), target = labelTarget();
      const original = target?.textContent;
      let extra = null;
      if (target) target.textContent = label;
      else { extra = document.createElement('span'); extra.textContent = ` ${label}`; node.append(extra); }
      node.setAttribute('aria-busy', 'true');
      restore = () => {
        if (target?.textContent === label) target.textContent = original;
        extra?.remove();
        if (node.getAttribute('aria-busy') === 'true') {
          if (priorBusy === null) node.removeAttribute('aria-busy'); else node.setAttribute('aria-busy', priorBusy);
        }
      };
    } else if (!busy && restore) { restore(); restore = null; }
  };
}
