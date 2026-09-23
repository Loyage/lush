/**
 * 统一按钮帮助提示与 Agent 触发标识的基础设施。
 *
 * 以前按钮的解释分散在原生 `title` 属性里：桌面悬停才看得到、触屏看不到、键盘用户也看不到，
 * 而且会调用 Agent 的按钮（耗时、烧 token）和普通按钮长得一模一样。这里把两件事收在一起：
 * - 任何带 `data-help` 的元素（按钮、菜单项、外层 `span.help-host`）在悬停、键盘聚焦、触屏长按时
 *   显示同一个 `#help-tip`（role="tooltip"），Esc / 滚动 / 点别处隐藏，屏幕阅读器经 `aria-describedby` 读到；
 * - `agentHelp()` 统一给会启动 Agent 的按钮补上代价说明，`button.agent-call` 用紫色 ⚡ 把它们标出来。
 *
 * 监听挂在 document 级做事件委托，按钮随视图重画也不必逐个重绑；`initHelp()` 可重复调用，
 * 重复装配前会先摘掉上一轮监听。计时器可注入（`setHelpTimers`），DOM 测试用假时钟推进长按判定。
 */
export const AGENT_NOTE = '会调用 Agent：需要较长时间并消耗 token';

/**
 * 给帮助文本追加统一的 Agent 代价说明。`text` 为空时只返回说明。
 * 所有会启动 Agent 的按钮都应经它生成 `data-help`，避免同一句话各写各的。
 */
export function agentHelp(text) {
  const clean = text === undefined || text === null ? '' : String(text).trim();
  return clean ? `${clean} ${AGENT_NOTE}` : AGENT_NOTE;
}

const TIP_ID = 'help-tip';
const LONG_PRESS_MS = 500;   // 触屏按住多久算长按
const SUPPRESS_MS = 1500;    // 长按后抑制 click / contextmenu 的有效窗口

// 可注入的计时器：不注入时用宿主 setTimeout / clearTimeout。
let timers = null;
export function setHelpTimers(next) { timers = next ?? null; }
const later = (fn, ms) => (timers?.setTimeout ?? globalThis.setTimeout)(fn, ms);
const stopLater = id => (timers?.clearTimeout ?? globalThis.clearTimeout)(id);

let handlers = null;
let pressTimer = null;
let suppressTimer = null;
let suppressClick = false;
let described = null; // { node, previous }：当前挂了 aria-describedby 的目标与它原来的值

const node = id => globalThis.document?.getElementById?.(id) ?? null;

/** 取元素上的帮助文本；空串 / 纯空白视为没有帮助，不显示提示。 */
function helpText(target) {
  const value = target?.dataset?.help;
  return value === undefined || value === null ? '' : String(value).trim();
}

/** 从事件目标向上找最近的、确实带非空 data-help 的元素。 */
function closestHelp(from) {
  for (let at = from; at; at = at.parentNode ?? at.parentElement ?? null) {
    if (at === globalThis.document?.body) break;
    if (helpText(at)) return at;
  }
  return null;
}

/** 惰性建唯一的 #help-tip；每次显示前都重新按当前 DOM 收口，避免模块重载后指向旧节点。 */
function ensureTip() {
  const doc = globalThis.document;
  if (!doc) return null;
  let tip = typeof doc.getElementById === 'function' ? doc.getElementById(TIP_ID) : null;
  if (!tip && typeof doc.createElement === 'function') tip = doc.createElement('div');
  if (!tip) return null;
  tip.id = TIP_ID;
  if (tip.className !== 'help-tip') tip.className = 'help-tip';
  tip.setAttribute?.('role', 'tooltip');
  if (tip.hidden !== true) tip.hidden = true;
  if (!tip.parentNode && doc.body?.append) doc.body.append(tip);
  return tip;
}

/** 把提示夹在视口内：默认贴在目标下方，放不下就翻到上方，左右都留出边距。 */
function place(target, tip) {
  const rect = typeof target.getBoundingClientRect === 'function' ? target.getBoundingClientRect() : null;
  const tipRect = typeof tip.getBoundingClientRect === 'function' ? tip.getBoundingClientRect() : null;
  if (!rect) return;
  const viewWidth = Number(globalThis.innerWidth ?? globalThis.document?.documentElement?.clientWidth ?? 0);
  const viewHeight = Number(globalThis.innerHeight ?? globalThis.document?.documentElement?.clientHeight ?? 0);
  const tipWidth = tipRect?.width || tip.offsetWidth || 220;
  const tipHeight = tipRect?.height || tip.offsetHeight || 36;
  const margin = 8;
  let left = Number(rect.left) || 0;
  let top = (Number(rect.bottom) || 0) + margin;
  if (viewWidth > 0 && left + tipWidth > viewWidth - margin) left = viewWidth - margin - tipWidth;
  if (left < margin) left = margin;
  if (viewHeight > 0 && top + tipHeight > viewHeight - margin) {
    const above = (Number(rect.top) || 0) - tipHeight - margin;
    top = above >= margin ? above : Math.max(margin, viewHeight - margin - tipHeight);
  }
  if (top < margin) top = margin;
  tip.style.left = `${Math.round(left)}px`;
  tip.style.top = `${Math.round(top)}px`;
}

/** 还原目标原来的 aria-describedby（多数元素本来就没有，于是移除）。 */
function restoreDescribed() {
  if (!described) return;
  const { node: target, previous } = described;
  described = null;
  if (previous === null || previous === undefined || previous === '') target.removeAttribute?.('aria-describedby');
  else target.setAttribute?.('aria-describedby', previous);
}

/** 针对某个带 data-help 的元素显示提示；空文本直接忽略。 */
export function showHelp(target) {
  const text = helpText(target);
  if (!target || !text) return;
  const tip = ensureTip();
  if (!tip) return;
  tip.textContent = text;
  tip.hidden = false;
  place(target, tip);
  if (described && described.node !== target) restoreDescribed();
  if (!described) described = { node: target, previous: target.getAttribute?.('aria-describedby') ?? null };
  target.setAttribute?.('aria-describedby', TIP_ID);
}

/** 隐藏提示并解除 aria-describedby；导航 / 重渲染前可主动调用。 */
export function hideHelp() {
  clearPress();
  clearSuppress(); // 提示都收了，再扣着下一次 click 只会误伤后续正常操作。
  const tip = node(TIP_ID);
  if (tip) tip.hidden = true;
  restoreDescribed();
}

function clearPress() {
  if (pressTimer !== null) { stopLater(pressTimer); pressTimer = null; }
}

function clearSuppress() {
  suppressClick = false;
  if (suppressTimer !== null) { stopLater(suppressTimer); suppressTimer = null; }
}

/* ---------- document 级事件委托 ---------- */
function onPointerOver(event) {
  if (event?.pointerType === 'touch') return;
  const target = closestHelp(event?.target);
  if (target) showHelp(target);
}
function onPointerOut(event) {
  if (event?.pointerType === 'touch') return;
  const target = closestHelp(event?.target);
  if (!target) return;
  // 在目标与它的子节点之间移动不算离开；换到另一个带帮助的元素则藏着，让 pointerover 接管。
  if (closestHelp(event?.relatedTarget) === target) return;
  hideHelp();
}
function onFocusIn(event) {
  const target = closestHelp(event?.target);
  if (target) showHelp(target);
}
function onFocusOut() { hideHelp(); }
function onTouchStart(event) {
  const target = closestHelp(event?.target);
  if (!target) return;
  clearPress();
  // 按住约 500ms 就显示提示，并抑制随后由这次触摸触发的 click / 右键菜单，避免误触按钮。
  pressTimer = later(() => {
    pressTimer = null;
    suppressClick = true;
    if (suppressTimer !== null) stopLater(suppressTimer);
    suppressTimer = later(() => { suppressTimer = null; suppressClick = false; }, SUPPRESS_MS);
    showHelp(target);
  }, LONG_PRESS_MS);
}
function onTouchEnd() { clearPress(); }
function onClick(event) {
  // 长按后的第一次 click 只用来「吃掉」这次触摸：不关提示、不触发按钮。
  if (suppressClick) { clearSuppress(); event?.preventDefault?.(); event?.stopPropagation?.(); return; }
  hideHelp();
}
function onContextMenu(event) {
  if (suppressClick) { clearSuppress(); event?.preventDefault?.(); event?.stopPropagation?.(); return; }
  hideHelp();
}
function onKeydown(event) { if (event?.key === 'Escape') hideHelp(); }
function onScroll() { hideHelp(); }

const LISTENERS = [
  ['pointerover', onPointerOver], ['pointerout', onPointerOut],
  ['focusin', onFocusIn], ['focusout', onFocusOut],
  ['touchstart', onTouchStart], ['touchmove', onTouchEnd], ['touchend', onTouchEnd], ['touchcancel', onTouchEnd],
  ['scroll', onScroll], ['keydown', onKeydown],
  ['click', onClick, true], ['contextmenu', onContextMenu, true],
];

/** 装配一次 document 级委托；重复调用先摘掉上一轮监听，不残留。 */
export function initHelp() {
  destroyHelp();
  handlers = LISTENERS;
  for (const [type, fn, capture] of handlers) addEventListener(type, fn, Boolean(capture));
}

function destroyHelp() {
  if (handlers) {
    for (const [type, fn, capture] of handlers) removeEventListener(type, fn, Boolean(capture));
    handlers = null;
  }
  clearPress();
  clearSuppress();
}
