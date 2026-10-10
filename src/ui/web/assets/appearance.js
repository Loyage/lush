/** Device theme and project identity color are separate authorities (decision #411). */
import { devicePreferencesStatus, onDevicePreferences, readPref, saveDevicePreference } from './prefs.js';
import { show } from './messages.js';
import { PROJECT_COLORS } from './project-colors.js';
export { PROJECT_COLORS };
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
  return resolveTheme(readPref('theme'), Boolean(media?.matches));
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
  button.setAttribute('aria-label', `切换到${theme === 'dark' ? '浅色' : '深色'}主题`);
  button.setAttribute('aria-pressed', String(theme === 'dark'));
  return theme;
}

/** Project color only: the retained legacy theme is never applied or sent in a color update. */
export function createProjectAppearance({ root, projectId, request, ownsPage = () => true,
  onChange = notify, setInterval: interval = globalThis.setInterval,
  clearInterval: clear = globalThis.clearInterval } = {}) {
  const owner = globalThis.document, pathname = globalThis.location?.pathname;
  let alive = true, value = null, busy = false, loading = false, error = '', timer = null, pending = null;
  const current = () => alive && owner === globalThis.document && globalThis.location?.pathname === pathname && ownsPage();
  const snapshot = () => ({ projectId, appearance: value ? { ...value } : null, busy, loading, error });
  const paint = () => {
    if (!current()) return;
    if (root?.dataset) {
      if (value) root.dataset.projectColor = value.color;
      else delete root.dataset.projectColor;
    }
  };
  const publish = () => { if (current()) { paint(); onChange(snapshot()); } };
  const validate = result => {
    const next = result?.appearance;
    if (result?.id !== projectId || !next || next.version !== 1 || !['system', 'light', 'dark'].includes(next.theme)
      || !PROJECT_COLORS.some(color => color.id === next.color) || typeof next.revision !== 'string' || !next.revision) {
      throw new Error('项目配色响应无效，请更新 Host 后重试');
    }
    return { version: 1, theme: next.theme, color: next.color, revision: next.revision };
  };
  const endpoint = `/api/host/projects/${projectId}/appearance`;
  const post = body => request(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const load = (initialize = false) => {
    if (!current() || busy) return Promise.resolve();
    if (pending) return pending;
    loading = true; publish();
    pending = (async () => {
      try {
        let result = await request(endpoint);
        if (!current()) return;
        if (result?.id === projectId && result.appearance === null && initialize) result = await post({ initialize: true });
        if (!current()) return;
        value = validate(result); error = '';
      } catch (failure) { if (current()) error = failure.message; }
      finally { pending = null; loading = false; publish(); }
    })();
    return pending;
  };
  const save = async patch => {
    if (!current() || !value || busy || loading || pending) throw new Error('项目配色尚未就绪或正在同步，请稍后重试');
    if (!patch || Object.keys(patch).length !== 1 || !PROJECT_COLORS.some(entry => entry.id === patch.color)) {
      throw new Error('仅可修改项目辨识色；主题请使用设备偏好');
    }
    busy = true; error = ''; publish();
    try {
      const result = await post({ color: patch.color, expected_revision: value.revision });
      if (current()) value = validate(result);
    } catch (failure) { if (current()) error = failure.message; throw failure; }
    finally { busy = false; publish(); }
  };
  if (interval) timer = interval(() => { if (current() && !globalThis.document?.hidden) return load(false); }, 15000);
  paint();
  return { paint, snapshot, load, save,
    destroy() { alive = false; if (timer !== null) clear?.(timer); } };
}

/** Injectable device-theme controller; project-color failure never disables the device preference. */
export function createAppearance({ root, toggle, media, persist = null, projectId = null, request,
  setInterval: interval = globalThis.setInterval, clearInterval: clear = globalThis.clearInterval,
  onError = error => show(`主题偏好未保存：${error.message}`, 'error') } = {}) {
  const host = root ?? globalThis.document?.documentElement;
  const button = toggle === undefined ? globalThis.document?.getElementById('theme-toggle') : toggle;
  const mq = media === undefined ? systemThemeMedia() : media;
  const readCurrent = () => readPref('theme');
  let active = true, saving = false;
  const saveTheme = persist || (value => saveDevicePreference('theme', value));
  const availability = status => {
    if (!button || !active) return;
    button.disabled = saving || status.saving || !status.ready || Boolean(status.error);
    const hint = button.parentElement || button.parentNode;
    button.removeAttribute?.('data-help');
    hint?.setAttribute('data-help', !status.ready || status.error ? `设备偏好尚不可用，不能修改主题。${status.error || '正在读取权威配置。'}`
      : status.saving || saving ? '设备偏好正在保存。' : '修改设备唯一的主题偏好，所有项目页面共享。');
    hint?.setAttribute('tabindex', '0');
  };
  const paint = () => applyTheme(resolveTheme(readCurrent(), Boolean(mq?.matches)), { root: host, toggle: button });
  const disposeStatus = persist ? null : onDevicePreferences(availability);
  const onSystemChange = event => { if (readCurrent() === 'system') applyTheme(resolveTheme('system', event.matches), { root: host, toggle: button }); };
  mq?.addEventListener?.('change', onSystemChange);
  if (button) button.onclick = async () => {
    if (!active || saving) return;
    const next = resolveTheme(readCurrent(), Boolean(mq?.matches)) === 'dark' ? 'light' : 'dark';
    saving = true; button.disabled = true; button.setAttribute('aria-busy', 'true');
    try { await saveTheme(next); if (active) paint(); }
    catch (error) { if (active) { paint(); onError(error); } }
    finally { saving = false; if (active) { button.disabled = false; button.setAttribute('aria-busy', 'false'); if (!persist) availability(devicePreferencesStatus()); } }
  };
  const color = projectId ? createProjectAppearance({ root: host, projectId, request, setInterval: interval, clearInterval: clear }) : null;
  if (!projectId && host?.dataset) delete host.dataset.projectColor;
  paint();
  return { paint, host, button, preference: readCurrent,
    snapshot: () => color?.snapshot() ?? { projectId: null, appearance: null, busy: false, loading: false, error: '' },
    load: initialize => color?.load(initialize) ?? Promise.resolve(),
    save: patch => color ? color.save(patch) : Promise.reject(new Error('未选择项目辨识色')),
    destroy() { active = false; disposeStatus?.(); color?.destroy(); mq?.removeEventListener?.('change', onSystemChange); } };
}
let appearance = null;
export function initAppearance(options = {}) {
  appearance?.destroy(); appearance = createAppearance(options); return appearance;
}
export function appearanceSnapshot() { return appearance?.snapshot() ?? { projectId: null, appearance: null, busy: false, loading: false, error: '' }; }
export function saveAppearance(patch, projectId = appearanceSnapshot().projectId) {
  if (appearanceSnapshot().projectId !== projectId) return Promise.reject(new Error('项目页面已切换，未保存配色'));
  return appearance?.save(patch);
}
export function reloadAppearance() { return appearance?.load(true); }
export function refreshTheme() { appearance?.paint(); }
if (globalThis.document?.documentElement?.dataset) initAppearance();
