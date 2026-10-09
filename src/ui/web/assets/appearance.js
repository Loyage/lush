/** Browser workbench theme; project pages use Host-persisted appearance, never localStorage. */
import { readPref, setPref } from './prefs.js';
import { PROJECT_COLORS } from './project-colors.js';
export { PROJECT_COLORS };
const themes = ['system', 'light', 'dark'];
const listeners = new Set();
export function onAppearanceChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function notify() { for (const fn of listeners) { try { fn(); } catch { /* isolated view */ } } }
export function systemThemeMedia() {
  return typeof window !== 'undefined' ? window.matchMedia?.('(prefers-color-scheme: dark)') ?? null : null;
}
export function resolveTheme(preference, systemDark) {
  return preference === 'dark' || preference === 'light' ? preference : (systemDark ? 'dark' : 'light');
}
export function effectiveTheme(media = systemThemeMedia()) {
  return resolveTheme(appearance?.preference() ?? readPref('theme'), Boolean(media?.matches));
}
export function applyTheme(theme, { root, toggle } = {}) {
  const host = root ?? globalThis.document?.documentElement;
  const button = toggle === undefined ? globalThis.document?.getElementById('theme-toggle') : toggle;
  const previous = host?.dataset?.theme;
  if (host?.dataset) host.dataset.theme = theme;
  if (previous && previous !== theme && typeof host?.dispatchEvent === 'function') {
    const EventType = host.ownerDocument?.defaultView?.CustomEvent || globalThis.CustomEvent;
    if (EventType) host.dispatchEvent(new EventType('lush-themechange', { detail: { theme } }));
  }
  if (!button) return theme;
  button.textContent = theme === 'dark' ? '☀ 浅色' : '☾ 深色';
  button.removeAttribute?.('title');
  button.setAttribute('data-help', `当前为${theme === 'dark' ? '深色' : '浅色'}主题，点击切换${appearance?.snapshot().projectId ? '并保存到本项目，影响其他浏览器' : ''}。`);
  button.setAttribute('aria-label', `切换到${theme === 'dark' ? '浅色' : '深色'}主题`);
  button.setAttribute('aria-pressed', String(theme === 'dark'));
  return theme;
}

/** Injectable request/timers let tests exercise late responses without real services. */
export function createAppearance({ root, toggle, media, projectId = null, request,
  reportError = () => {}, setInterval: interval = globalThis.setInterval,
  clearInterval: clear = globalThis.clearInterval } = {}) {
  const host = root ?? globalThis.document?.documentElement;
  const button = toggle === undefined ? globalThis.document?.getElementById('theme-toggle') : toggle;
  const mq = media === undefined ? systemThemeMedia() : media;
  const path = globalThis.location?.pathname;
  let alive = true, value = null, busy = false, loading = false, error = '', timer = null, pending = null;
  const current = () => alive && globalThis.location?.pathname === path;
  const preference = () => projectId ? value?.theme ?? 'system' : readPref('theme');
  const snapshot = () => ({ projectId, appearance: value ? { ...value } : null, busy, loading, error });
  const paint = () => {
    if (!current()) return;
    if (host?.dataset) {
      if (projectId && value) host.dataset.projectColor = value.color;
      else delete host.dataset.projectColor;
    }
    applyTheme(resolveTheme(preference(), Boolean(mq?.matches)), { root: host, toggle: button });
    if (button) {
      button.disabled = Boolean(projectId && (!value || busy || loading));
      if (error) button.setAttribute('data-help', `项目外观未同步：${error}。请到设置中重试；未改用浏览器主题。`);
      else if (button.disabled) button.setAttribute('data-help', busy ? '正在保存本项目外观，请稍候。' : '项目外观尚未加载，读取完成后才能切换主题。');
      const helpHost = button.parentNode?.classList?.contains('help-host') ? button.parentNode : null;
      if (helpHost) {
        if (button.disabled) {
          helpHost.setAttribute('data-help', button.getAttribute('data-help'));
          helpHost.setAttribute('tabindex', '0');
          button.removeAttribute('data-help');
        } else { helpHost.removeAttribute('data-help'); helpHost.removeAttribute('tabindex'); }
      }
    }
  };
  const publish = () => { if (current()) { paint(); notify(); } };
  const validate = result => {
    const next = result?.appearance;
    if (result?.id !== projectId || !next || next.version !== 1 || !themes.includes(next.theme)
      || !PROJECT_COLORS.some(color => color.id === next.color) || typeof next.revision !== 'string' || !next.revision) {
      throw new Error('项目外观响应无效，请更新 Host 后重试');
    }
    return { version: 1, theme: next.theme, color: next.color, revision: next.revision };
  };
  const endpoint = `/api/host/projects/${projectId}/appearance`;
  const post = body => request(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const load = (initialize = false) => {
    if (!projectId || !current() || busy) return Promise.resolve();
    if (pending) return pending;
    loading = !value; publish();
    pending = (async () => {
      try {
        let result = await request(endpoint);
        if (!current()) return;
        if (result?.id === projectId && result.appearance === null && initialize) result = await post({ initialize: true });
        if (!current()) return;
        const next = validate(result), changed = next.revision !== value?.revision || Boolean(error) || loading;
        value = next; error = ''; loading = false;
        if (changed) publish();
      } catch (failure) {
        if (current()) { error = failure.message; loading = false; publish(); }
      } finally { pending = null; }
    })();
    return pending;
  };
  const save = async patch => {
    if (!projectId) { setPref('theme', patch.theme); paint(); notify(); return; }
    if (!current() || !value || busy || loading || pending) throw new Error('项目外观尚未就绪或正在同步，请稍后重试');
    const theme = patch.theme ?? value.theme, color = patch.color ?? value.color;
    if (!themes.includes(theme) || !PROJECT_COLORS.some(entry => entry.id === color)) throw new Error('无效的项目主题或颜色');
    busy = true; error = ''; publish();
    try {
      const result = await post({ theme, color, expected_revision: value.revision });
      if (!current()) return;
      value = validate(result);
    } catch (failure) {
      if (current()) error = failure.message;
      throw failure;
    } finally { busy = false; publish(); }
  };
  const onSystemChange = () => { if (preference() === 'system') paint(); };
  mq?.addEventListener?.('change', onSystemChange);
  if (button) button.onclick = async () => {
    try { await save({ theme: resolveTheme(preference(), Boolean(mq?.matches)) === 'dark' ? 'light' : 'dark' }); }
    catch (failure) { if (current()) reportError(failure.message); }
  };
  if (projectId && interval) timer = interval(() => {
    if (!globalThis.document?.hidden) return load(false);
  }, 15000);
  paint();
  return { paint, host, button, preference, snapshot, load, save,
    destroy() { alive = false; mq?.removeEventListener?.('change', onSystemChange); if (timer !== null) clear?.(timer); },
  };
}
let appearance = null;
export function initAppearance(options = {}) {
  appearance?.destroy();
  appearance = createAppearance(options);
  return appearance;
}
export function appearanceSnapshot() { return appearance?.snapshot() ?? { projectId: null, appearance: null, busy: false, loading: false, error: '' }; }
export function saveAppearance(patch, projectId = appearanceSnapshot().projectId) {
  if (appearanceSnapshot().projectId !== projectId) return Promise.reject(new Error('项目页面已切换，未保存外观'));
  return appearance?.save(patch);
}
export function reloadAppearance() { return appearance?.load(true); }
export function refreshTheme() { appearance?.paint(); }

// Do not flash a project's old browser-specific theme while its persisted configuration loads.
if (globalThis.document?.documentElement?.dataset) {
  const project = /^\/p\/([a-f0-9]{16})(?:\/|$)/.exec(globalThis.location?.pathname || '')?.[1];
  if (project) applyTheme(resolveTheme('system', Boolean(systemThemeMedia()?.matches)));
  else initAppearance();
}
