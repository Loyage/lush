import { el } from './dom.js';
import { closeDialog } from './dialog.js';

export const REVOCATION = '此操作拒绝新的远端准入，并请求取消已跟踪命令；不代表进程已停止或现场已回收。失联仍可能是未知状态；不会迁移、删除远端现场或自动重跑。';
/** Disposing an old editor must never dismiss another editor's replacement dialog. */
export function closeRunnerDialog(content) {
  const modal = globalThis.document?.getElementById('modal');
  for (let node = content; node; node = node.parentNode) {
    if (node === modal) { closeDialog(); return; }
  }
}
export const UNKNOWN_WRITE = '操作结果未确认。请先重新读取配置并核对节点状态；不会自动重试。';
export function runnerField(root, key, label, value = '', type = 'text') {
  const wrap = el('label', undefined, 'runner-field'), input = el('input');
  input.type = type; input.dataset.runnerField = key; input.setAttribute('aria-label', label);
  if (type === 'checkbox') input.checked = value === true; else input.value = String(value ?? '');
  input.autocomplete = type === 'password' ? 'new-password' : 'off'; input.spellcheck = false;
  wrap.append(el('span', label), input); root.append(wrap); return input;
}
export function runnerButton(label, action, help = '') {
  const host = el('span', undefined, 'help-host'), control = el('button', label, 'ghost'); control.type = 'button';
  if (help) control.dataset.help = help;
  control.onclick = action; host.append(control);
  return { host, control, disable(disabled, reason = '请求处理中，请等待；不会重复提交。') {
    control.disabled = disabled;
    if (disabled) { host.dataset.help = reason; host.setAttribute('tabindex', '0'); }
    else { delete host.dataset.help; host.removeAttribute('tabindex'); }
  } };
}
export function runnerDetails(label) {
  const root = el('details'); root.append(el('summary', label)); return root;
}
/** Request ownership stays local; no credentials enter shared state, cache or drafts. */
export function runnerLifetime(ownsPage = () => true) {
  const owner = globalThis.document;
  let disposed = false;
  return { current: () => !disposed && owner === globalThis.document && ownsPage(), dispose() { disposed = true; } };
}
