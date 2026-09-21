/**
 * 应用内弹窗：`window.confirm` / `window.prompt` 的替代品。
 *
 * 原生弹窗不属于页面，浏览器可以静默吃掉它：用户勾过「阻止此页面创建更多对话框」、
 * 页面跑在沙箱 iframe / 内嵌 webview 里、或浏览器判定不该弹时，`confirm()` 会**不显示任何
 * 东西直接返回 false**——调用方以为用户点了「取消」，用户看到的是「点了没反应」。分支图的
 * 「归档」就这样变成过一个什么都不做的按钮（流程本身是好的，`branch.archive` 早在测试里跑通）。
 *
 * 所以确认与输入都在页面里画：`#modal` 是独立于 `#detail` 的容器，1.5s 轮询重画视图不会把它
 * 冲掉，也不受滚动位置影响。约定：
 * - 同一时刻只有一个弹窗，打开新的会先把上一个按「取消」收尾，绝不让调用方的 await 永远悬着；
 * - Esc / 点背景 / 「取消」＝取消，Enter 与「确定」＝确认；输入框里 Enter 直接提交；
 * - 关闭后焦点还给打开弹窗的那个元素。
 */
import { $, button, el } from './dom.js';

/** 当前弹窗的收尾函数：`null` 表示没有弹窗；调用它就把那次 open() 收掉。 */
let active = null;

/** 按「取消」收尾当前弹窗（Esc、点背景、或程序自己要关掉时用）。 */
export function closeDialog() { if (active) active(null); }

/**
 * 打开一个弹窗并等用户作答。`field` 非空时多一个文本输入框。
 * @returns {Promise<true|string|null>} 确认时是 `true`；有输入框时是输入的字符串；取消时是 `null`。
 */
function open({ title, message = null, detail = null, confirmLabel, cancelLabel, danger = false, field = null }) {
  if (active) active(null);
  const previous = globalThis.document?.activeElement ?? null;
  const root = $('modal');
  let settle;
  const done = new Promise(resolve => { settle = resolve; });
  // 收尾：清空容器、把焦点还回去，再兑现 Promise。`active` 先清掉，重复收尾只是空转。
  active = value => {
    active = null;
    root.hidden = true;
    root.replaceChildren();
    settle(value);
    previous?.focus?.();
  };

  root.hidden = false;
  const card = el('div', undefined, 'modal-card');
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'true');
  const heading = el('h2', title, 'modal-title');
  heading.id = 'modal-title';
  card.append(heading);
  card.setAttribute('aria-labelledby', 'modal-title');
  if (message) card.append(el('p', message, 'modal-message'));
  if (detail) card.append(el('pre', detail, 'modal-detail'));

  let input = null;
  if (field) {
    const wrap = el('div', undefined, 'modal-field');
    // for= 指向输入框：点标签就能聚焦，屏幕阅读器也读得到这层关系。
    const label = el('label', field.label, 'modal-label');
    label.setAttribute('for', 'modal-input');
    input = el('input', undefined, 'modal-input');
    input.id = 'modal-input';
    input.setAttribute('type', 'text');
    input.value = field.value ?? '';
    if (field.placeholder) input.setAttribute('placeholder', field.placeholder);
    // 输入框里按 Enter 就是提交，不必先摸鼠标（原生 prompt 也是这样）。
    input.onkeydown = event => {
      if (event.key !== 'Enter') return;
      event.preventDefault?.();
      active?.(String(input.value));
    };
    wrap.append(label, input);
    card.append(wrap);
  }

  const actions = el('div', undefined, 'modal-actions');
  const cancel = button(cancelLabel, () => active?.(null), 'ghost');
  const confirm = button(confirmLabel, () => active?.(field ? String(input.value) : true), danger ? 'danger' : undefined);
  actions.append(cancel, confirm);
  card.append(actions);

  // Esc 收尾，Tab 只在弹窗里转（`aria-modal` 声明了外面的内容是惰性的，键盘焦点也得跟上）。
  // 监听挂在弹窗容器上，按键从里面的按钮 / 输入框冒泡上来。
  root.onkeydown = event => {
    if (event.key === 'Escape') { event.preventDefault?.(); active?.(null); return; }
    if (event.key !== 'Tab') return;
    const stops = [input, cancel, confirm].filter(node => node && !node.disabled);
    const index = stops.indexOf(globalThis.document?.activeElement ?? null);
    // 焦点不在弹窗里（或已经跑到外面）时，Tab 从首/尾接上，不让它漏出去。
    const next = index < 0
      ? (event.shiftKey ? stops.length - 1 : 0)
      : (index + (event.shiftKey ? -1 : 1) + stops.length) % stops.length;
    event.preventDefault?.();
    stops[next]?.focus?.();
  };
  // 点背景＝取消；点卡片内部不关。
  root.onclick = event => { if (event.target === root) active?.(null); };
  root.replaceChildren(card);
  // 有输入框就先让人打字，否则焦点落在确认键上（Enter 直接确认）。
  (input ?? confirm)?.focus?.();
  return done;
}

/**
 * 应用内确认框：`await confirmDialog({...})` 为真才继续。
 * 文案分两层：`message` 是一句话的后果，`detail` 是需要逐行核对的长清单（命令、路径、批次顺序）。
 */
export function confirmDialog({ title, message = null, detail = null, confirmLabel = '确定', cancelLabel = '取消', danger = false }) {
  return open({ title, message, detail, confirmLabel, cancelLabel, danger, field: null }).then(value => value === true);
}

/** 应用内输入框：确认返回输入内容（可能是空串），取消返回 `null`。 */
export function promptDialog({ title, message = null, value = '', label = '内容', placeholder = '', confirmLabel = '确定', cancelLabel = '取消' }) {
  return open({ title, message, detail: null, confirmLabel, cancelLabel, danger: false, field: { label, value, placeholder } })
    .then(result => (typeof result === 'string' ? result : null));
}
