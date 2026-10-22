/** Application dialogs, independent of #detail repaint and native confirm/prompt blocking. */
import { $, button, el } from './dom.js';
import { buttonFeedback } from './button-feedback.js';
let active = null;
const updates = new WeakMap();
/** Re-evaluate caller-owned async gates only while this exact dialog content is mounted. */
export function syncDialog(content) { updates.get(content)?.(); }
/** Explicit programmatic dismissal; an old asynchronous submission cannot close its replacement. */
export function closeDialog() { active?.(null); }

function open({ title, message = null, detail = null, confirmLabel, cancelLabel, danger = false, field = null,
  content = null, cardClass = '', agent = false, confirmHelp = null, onConfirm = null, canConfirm = null, initialFocus = null, busyLabel = '处理中…' }) {
  active?.(null);
  const previous = globalThis.document?.activeElement ?? null, root = $('modal');
  let settle, closed = false, busy = false;
  const done = new Promise(resolve => { settle = resolve; });
  const finish = value => {
    if (closed) return;
    closed = true;
    if (active === finish) active = null;
    if (content) updates.delete(content);
    root.hidden = true; root.replaceChildren(); settle(value); previous?.focus?.();
  };
  active = finish; root.hidden = false;
  const card = el('div', undefined, `modal-card${cardClass ? ` ${cardClass}` : ''}`);
  card.setAttribute('role', 'dialog'); card.setAttribute('aria-modal', 'true'); card.setAttribute('tabindex', '-1');
  const heading = el('h2', title, 'modal-title'); heading.id = 'modal-title'; card.append(heading);
  card.setAttribute('aria-labelledby', 'modal-title');
  if (message) card.append(el('p', message, 'modal-message'));
  if (detail) card.append(el('pre', detail, 'modal-detail'));
  if (content) card.append(content);
  let input = null;
  if (field) {
    const wrap = el('div', undefined, 'modal-field'), label = el('label', field.label, 'modal-label');
    label.setAttribute('for', 'modal-input'); input = el('input', undefined, 'modal-input'); input.id = 'modal-input';
    input.setAttribute('type', 'text'); input.value = field.value ?? '';
    if (field.placeholder) input.setAttribute('placeholder', field.placeholder);
    let composing = false;
    input.oncompositionstart = () => { composing = true; }; input.oncompositionend = () => { composing = false; };
    input.onkeydown = event => {
      if (event.key !== 'Enter' || composing || event.isComposing || event.keyCode === 229) return;
      event.preventDefault?.(); void submit();
    };
    wrap.append(label, input); card.append(wrap);
  }
  const cancelRequest = () => { if (!busy && !closed && active === finish) finish(null); };
  const actions = el('div', undefined, 'modal-actions');
  const cancel = button(cancelLabel, cancelRequest, 'ghost'); cancel.classList.add('modal-cancel');
  const confirm = button(confirmLabel, submit, danger ? 'danger' : undefined, { agent, help: confirmHelp }); confirm.classList.add('modal-confirm');
  const feedback = onConfirm ? buttonFeedback(confirm, busyLabel) : null;
  // The dialog owns disabling; button()'s generic finally-unlock would erase a caller retry gate.
  cancel.onclick = cancelRequest; confirm.onclick = async () => { await submit(); };
  const cancelHost = el('span', undefined, 'help-host'), confirmHost = el('span', undefined, 'help-host');
  cancelHost.append(cancel); confirmHost.append(confirm); actions.append(cancelHost, confirmHost); card.append(actions);
  const error = el('p', undefined, 'error modal-submit-error'); error.hidden = true; error.setAttribute('role', 'alert'); card.insertBefore(error, actions);
  const allowed = () => !canConfirm || canConfirm();
  function sync() {
    confirm.disabled = busy || !allowed(); cancel.disabled = busy;
    for (const [control, host] of [[confirm, confirmHost], [cancel, cancelHost]]) {
      if (control.disabled) {
        host.dataset.help = busy ? '请求尚未结束，请等待，不会重复提交或自动重试。' : '当前设置暂不能保存，请核对读取或保存状态。';
        host.setAttribute('tabindex', '0');
      } else { delete host.dataset.help; host.removeAttribute('tabindex'); }
    }
  }
  async function submit() {
    if (closed || active !== finish || busy || !allowed()) return;
    if (!onConfirm) { finish(field ? String(input.value) : true); return; }
    busy = true; feedback?.(true); sync(); error.hidden = true;
    try {
      const accepted = await onConfirm();
      if (!closed && active === finish && accepted === true) finish(true);
    } catch {
      if (!closed && active === finish) {
        error.textContent = '保存未完成，请检查设置后重试。'; error.hidden = false;
      }
    } finally { busy = false; feedback?.(false); if (!closed && active === finish) sync(); }
  }
  root.onkeydown = event => {
    if (event.key === 'Escape') { event.preventDefault?.(); cancelRequest(); return; }
    if (event.key !== 'Tab') return;
    const contentStops = content ? ['input', 'select', 'textarea', 'button', 'summary', 'a[href]'].flatMap(tag => [...content.querySelectorAll(tag)])
      .sort((a, b) => a.compareDocumentPosition ? (a.compareDocumentPosition(b) & 2 ? 1 : -1) : 0) : [];
    const stops = [input, ...contentStops, cancel, confirm].filter(node => node && !node.disabled
      && (typeof node.getClientRects !== 'function' || node.getClientRects().length));
    const index = stops.indexOf(globalThis.document?.activeElement ?? null);
    const next = index < 0 ? (event.shiftKey ? stops.length - 1 : 0) : (index + (event.shiftKey ? -1 : 1) + stops.length) % stops.length;
    event.preventDefault?.(); (stops[next] || card).focus?.();
  };
  root.onclick = event => { if (event.target === root) cancelRequest(); };
  if (content) updates.set(content, sync);
  root.replaceChildren(card); sync(); (initialFocus ?? input ?? (danger ? cancel : confirm.disabled ? card : confirm))?.focus?.();
  return done;
}

/** Existing confirmation semantics: only an explicit confirmation returns true. */
export function confirmDialog({ title, message = null, detail = null, confirmLabel = '确定', cancelLabel = '取消', danger = false, agent = false, confirmHelp = null, cardClass = '' }) {
  return open({ title, message, detail, confirmLabel, cancelLabel, danger, field: null, agent, confirmHelp, cardClass }).then(value => value === true);
}
export function promptDialog({ title, message = null, value = '', label = '内容', placeholder = '', confirmLabel = '确定', cancelLabel = '取消', agent = false, confirmHelp = null }) {
  return open({ title, message, detail: null, confirmLabel, cancelLabel, danger: false, field: { label, value, placeholder }, agent, confirmHelp })
    .then(result => typeof result === 'string' ? result : null);
}
/** Optional asynchronous confirmation closes only on true; false retains the exact form draft.
 * While submitting, duplicate clicks/Esc/backdrop cannot dismiss the request. canConfirm preserves
 * caller-owned failure gates after the request. Programmatic replacement/navigation remains safe. */
export function formDialog({ title, message = null, content, confirmLabel = '确定', cancelLabel = '取消', danger = false, cardClass = '', agent = false, confirmHelp = null,
  onConfirm = null, canConfirm = null, initialFocus = null, busyLabel = '处理中…' }) {
  return open({ title, message, detail: null, confirmLabel, cancelLabel, danger, content, cardClass, field: null, agent, confirmHelp, onConfirm, canConfirm, initialFocus, busyLabel })
    .then(value => value === true);
}
