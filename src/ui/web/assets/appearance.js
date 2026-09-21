/**
 * 深浅主题：偏好经 prefs.js 统一读写（键 `lush.theme`，`system` 跟随系统，`dark` / `light` 显式覆盖系统）。
 *
 * `index.html` 以 module 加载它在首屏前定主题；`app.js` 的 `boot()` 再按当前 DOM 重新装配头部切换按钮。
 * `createAppearance` 是可注入 DOM / matchMedia 的控制器，测试用它；`initAppearance` 绑定当前页面。
 */
import { readPref, setPref, storageAvailable } from './prefs.js';

/** 系统是否偏爱深色；非浏览器环境（bun test）返回 null。 */
export function systemThemeMedia() {
  return typeof window !== 'undefined' ? window.matchMedia?.('(prefers-color-scheme: dark)') ?? null : null;
}

/** 偏好 + 系统状态 → 实际主题。 */
export function resolveTheme(preference, systemDark) {
  return preference === 'dark' || preference === 'light' ? preference : (systemDark ? 'dark' : 'light');
}

/** 当前偏好下实际该显示的主题。 */
export function effectiveTheme(media = systemThemeMedia()) {
  return resolveTheme(readPref('theme'), Boolean(media?.matches));
}

/** 把主题写到 <html data-theme> 并同步头部按钮的文案 / aria；root / toggle 可在测试里注入。 */
export function applyTheme(theme, { root, toggle } = {}) {
  const host = root ?? (typeof document !== 'undefined' ? document.documentElement : null);
  const button = toggle === undefined ? (typeof document !== 'undefined' ? document.getElementById('theme-toggle') : null) : toggle;
  if (host?.dataset) host.dataset.theme = theme;
  if (!button) return theme;
  button.textContent = theme === 'dark' ? '☀ 浅色' : '☾ 深色';
  button.title = `当前为${theme === 'dark' ? '深色' : '浅色'}主题，点击切换`;
  button.setAttribute('aria-label', `切换到${theme === 'dark' ? '浅色' : '深色'}主题`);
  button.setAttribute('aria-pressed', String(theme === 'dark'));
  return theme;
}

/**
 * 建一个绑定当前页面（或注入替身）的主题控制器：应用主题、跟随系统变化、装配头部按钮。
 * 头部按钮与设置页共用 `lush.theme` 偏好：点一下就把当前实际主题反过来并显式写回。
 */
export function createAppearance({ root, toggle, media } = {}) {
  const host = root ?? (typeof document !== 'undefined' ? document.documentElement : null);
  const button = toggle === undefined ? (typeof document !== 'undefined' ? document.getElementById('theme-toggle') : null) : toggle;
  const mq = media === undefined ? systemThemeMedia() : media;
  // 存储不可用（隐私模式）时保留会话内选择，但每次都优先相信已落盘的偏好（设置页与头部按钮共用它）。
  const persisted = storageAvailable();
  let local = readPref('theme');
  const readCurrent = () => { if (persisted) local = readPref('theme'); return local; };
  const paint = () => applyTheme(resolveTheme(readCurrent(), Boolean(mq?.matches)), { root: host, toggle: button });
  const onSystemChange = event => {
    if (readCurrent() === 'system') applyTheme(resolveTheme('system', event.matches), { root: host, toggle: button });
  };
  mq?.addEventListener?.('change', onSystemChange);
  if (button) button.onclick = () => {
    local = resolveTheme(readCurrent(), Boolean(mq?.matches)) === 'dark' ? 'light' : 'dark';
    setPref('theme', local);
    paint();
  };
  paint();
  return {
    paint, host, button,
    /** 卸下系统监听：boot() 重复装配时不让旧控制器继续响应。 */
    destroy() { mq?.removeEventListener?.('change', onSystemChange); },
  };
}

let appearance = null;

/** 初始化（可重复调用：boot() 每个测试文件都会按当前 DOM 重新绑定）。 */
export function initAppearance(options = {}) {
  appearance?.destroy?.();
  appearance = createAppearance(options);
  return appearance;
}

/** 主题偏好变了：按当前 DOM 重画（设置页与头部按钮共用）。 */
export function refreshTheme() { appearance?.paint(); }

// head 里单独加载时立刻应用，避免首屏闪成另一种主题；测试 / 非浏览器里没有 documentElement 时跳过。
if (typeof document !== 'undefined' && document.documentElement?.dataset) initAppearance();
