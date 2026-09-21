/**
 * 顶部消息提示（toast）：统一收口页面上的成功 / 失败反馈。
 *
 * 之前这块是 composer 里的 `<p id="error">`：有消息就撑高输入栏、压缩内容区，而且只有
 * action() 或重新上线才清空，看过的提示一直占着地方。现在同一个 `#error` 节点搬进页面顶部
 * 的固定浮层（脱离 `.composer` 与 `.app` 的 grid，出现 / 消失都不改变布局）：文本照旧按
 * textContent 读写（调用点与既有 DOM 测试不必改名），显示 / 隐藏、停留时长与悬停暂停都由这里决定。
 *
 * 口径：成功 / 信息类默认约 4s 自动消失；失败 / 错误类默认约 8s，并给一个手动关闭按钮。停留时长是本地偏好
 * （`lush.toastDuration`，设置页「行为」组；标准档严格等于 4s / 8s），每次 `show` 读一次，所以对之后出现的提示立即生效。
 * 同一条文本被轮询反复写成一样时不重置计时（离线错误不闪烁），文本变了才重新计时。
 * 计时器可注入（setTimers），DOM 测试用假时钟推进，不靠真实 sleep 拖慢套件。
 */
import { toastDurations } from './prefs.js';

// 可注入的计时器：不注入时用宿主 setTimeout / clearTimeout / Date.now。
let timers = null;
export function setTimers(next) { timers = next; }
const later = (fn, ms) => (timers?.setTimeout ?? globalThis.setTimeout)(fn, ms);
const stopLater = id => (timers?.clearTimeout ?? globalThis.clearTimeout)(id);
const now = () => (timers?.now ?? Date.now)();

/** 该停多久：读当前「消息提示停留时长」偏好，标准档 4000 / 8000。 */
function durationFor(kind) { const { info, error } = toastDurations(); return kind === 'error' ? error : info; }

const node = id => globalThis.document?.getElementById?.(id) ?? null;

let text = '';       // 当前显示的文本；'' 表示浮层隐藏
let kind = 'info';   // 'info' | 'error'
let handle = null;   // 倒计时句柄；null 表示没在跑（隐藏或已暂停）
let deadline = 0;    // 倒计时终点，暂停时据此算剩余时间
let remaining = 0;   // 暂停时留下的剩余毫秒
let paused = false;

/** 把「显不显示、哪种类型、有没有关闭按钮」画到浮层上；不碰正文（正文由 paint 负责）。 */
function render() {
  const box = node('toast');
  if (!box) return;
  const visible = text !== '';
  box.hidden = !visible;
  box.classList.toggle('toast-error', kind === 'error');
  // 错误用 alert / assertive，信息用 status / polite：屏幕阅读器按紧急程度播报。
  box.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  box.setAttribute('aria-live', kind === 'error' ? 'assertive' : 'polite');
  const close = node('toast-close');
  if (close) { close.hidden = !(visible && kind === 'error'); close.onclick = clear; }
  box.onmouseenter = pause;
  box.onmouseleave = resume;
}

/** 正文落点仍是 `#error`：调用点与 DOM 测试都按 textContent 读写它。 */
function paint(value) { const content = node('error'); if (content) content.textContent = value; }

function stop() { if (handle !== null) { stopLater(handle); handle = null; } }

/** 从「现在」起重新倒计时 ms。 */
function arm(ms) {
  stop();
  paused = false;
  remaining = 0;
  deadline = now() + ms;
  handle = later(() => { handle = null; clear(); }, ms);
}

/** 显示一段消息。kind='error' 用更长的停留时间并带关闭按钮；空文本等于 clear。 */
export function show(value, nextKind = 'info') {
  const next = value === undefined || value === null ? '' : String(value);
  if (!next) { clear(); return; }
  const type = nextKind === 'error' ? 'error' : 'info';
  // 同一段文本（例如轮询反复报的同一条离线错误）不重置计时，避免一直闪。
  const same = next === text && type === kind;
  text = next; kind = type;
  render();
  paint(text);
  if (same) return;
  arm(durationFor(type));
}

/** 立即隐藏并清空消息（动手前清场、恢复在线、手动关闭都走这里）。 */
export function clear() {
  stop();
  paused = false;
  text = ''; kind = 'info';
  render();
  paint('');
}

/** 鼠标悬停在浮层上时暂停倒计时。 */
function pause() {
  if (paused || handle === null) return;
  remaining = Math.max(0, deadline - now());
  stop();
  paused = true;
}

/** 鼠标离开后从剩余时间继续。 */
function resume() { if (paused) arm(remaining); }
