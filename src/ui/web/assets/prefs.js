/**
 * 本地偏好中心：Web UI 里所有存在 localStorage 的用户偏好都在这里登记**键名、默认值与解析规则**，
 * 其它模块一律通过 readPref / writePref / setPref 读写，不再各自拼 key，也不各自兜默认值。
 *
 * - readPref(name)          读一个规整过的值（坏数据一律回落默认值，存储不可用时也不抛异常）。
 * - writePref(name, value)  只落盘（转成稳定字符串），不触发重画。
 * - setPref(name, value)    落盘 + 通知所有注册过的重画器（onPrefChange）——「变更后重画」的统一入口。
 * - resetPrefs()            删掉全部受管键（含历史键），并逐项通知回默认值。
 *
 * 老用户的键值继续生效：`lush.markdown` / `lush.theme` 保持原样；左栏排序从 `lush.treeSort`
 * 迁到 `lush.sidebarSort` 后，读取时仍回落旧键。
 * 设备偏好由 Host 权威保存；localStorage 只是首帧缓存。具体折叠／过滤仍是项目工作状态。
 * writePref/setPref 是同步缓存原语；用户设备偏好写入必须 await saveDevicePreference。
 */
import { COLLAPSED_KEY, FILTERS_KEY, parseCollapsed, parseFilters, serializeCollapsed } from './sidebar.js';
import { SORT_MODES } from './tree-order.js';
import { STATUS } from './format.js';
import { preferenceScope } from './route.js';

export const MARKDOWN_KEY = 'lush.markdown';
export const THEME_KEY = 'lush.theme';
export const SIDEBAR_SORT_KEY = 'lush.sidebarSort';
export const LEGACY_TREE_SORT_KEY = 'lush.treeSort';
export const REDUCED_MOTION_KEY = 'lush.reduceMotion';
export const POLLING_KEY = 'lush.polling';
export const TOAST_DURATION_KEY = 'lush.toastDuration';
export const TRANSCRIPT_ORDER_KEY = 'lush.transcriptOrder';
export const TASK_GRAPH_STATUSES_KEY = 'lush.taskGraph.hiddenStatuses';

export const SORT_IDS = new Set(SORT_MODES.map(mode => mode.id));
export const THEME_VALUES = ['system', 'light', 'dark'];

/**
 * 「行为」组的轮询频率：标准档严格等于改造前写死的间隔（快照 1500ms + 实时 3000ms）。
 * 这里是唯一一份间隔表，app.js 的定时器与设置页的说明都读它。
 */
export const POLLING_MODES = [
  { id: 'fast', label: '快速', snapshot: 800, live: 1600, note: '最快，请求也最多' },
  { id: 'standard', label: '标准', snapshot: 1500, live: 3000, note: '与默认一致（1.5s / 3s）' },
  { id: 'power', label: '省电', snapshot: 5000, live: 10000, note: '请求最少，更新最慢' },
];
export const POLLING_IDS = new Set(POLLING_MODES.map(mode => mode.id));

/** 「行为」组的消息提示停留时长：标准档严格等于改造前写死的 info 4000ms / error 8000ms。 */
export const TOAST_MODES = [
  { id: 'short', label: '短', info: 2000, error: 4000 },
  { id: 'standard', label: '标准', info: 4000, error: 8000 },
  { id: 'long', label: '长', info: 8000, error: 16000 },
];
export const TOAST_IDS = new Set(TOAST_MODES.map(mode => mode.id));

/**
 * 「阅读」组的执行过程排序：默认倒序（最新在前），可切回按时间正序。
 * 全屏执行详情与设置页共用同一阅读方向。
 */
export const TRANSCRIPT_ORDER_MODES = [
  { id: 'desc', label: '最新在前（倒序）' },
  { id: 'asc', label: '最早在前（正序）' },
];
export const TRANSCRIPT_ORDER_IDS = new Set(TRANSCRIPT_ORDER_MODES.map(mode => mode.id));

/** 轮询频率对应的两个定时器间隔；未知值回落标准档。 */
export function pollingIntervals(id = readPref('polling')) {
  return POLLING_MODES.find(mode => mode.id === id) ?? POLLING_MODES[1];
}

/** 消息提示的停留时长；未知值回落标准档。 */
export function toastDurations(id = readPref('toastDuration')) {
  return TOAST_MODES.find(mode => mode.id === id) ?? TOAST_MODES[1];
}

const boolPref = (key, defaultValue = false) => ({
  key,
  default: defaultValue,
  parse: raw => raw === null ? defaultValue : raw !== '0',
  format: value => (value ? '1' : '0'),
});

const enumPref = (key, values, fallback) => ({
  key,
  default: fallback,
  parse: raw => (values.includes(raw) ? raw : fallback),
  format: value => (values.includes(value) ? value : fallback),
});

/** Task 图状态筛选：存「隐藏了哪些状态」的集合；未知状态名与坏数据一律丢弃，回落空集（＝全部显示）。 */
const TASK_STATUS_IDS = new Set(Object.keys(STATUS));
const parseTaskGraphStatuses = raw => {
  try {
    const value = JSON.parse(raw);
    return new Set(Array.isArray(value) ? value.filter(status => TASK_STATUS_IDS.has(status)) : []);
  } catch { return new Set(); }
};

/**
 * 全部受管偏好。`legacy` 是升级前的旧键，只在当前键缺失时读取。
 * `default` 可以是值或工厂（集合 / 对象每次都要新的，避免调用方改到共享默认值）。
 */
export function normalizeNoticeChannels(value) {
  return Object.fromEntries(['created', 'idle', 'analysis', 'failed'].map(type => [type,
    Object.fromEntries(['banner', 'system'].map(channel => [channel,
      typeof value?.[type]?.[channel] === 'boolean' ? value[type][channel] : true]))]));
}

export const PREF_DEFS = {
  noticeChannels: { key: 'lush.noticeChannels', default: () => normalizeNoticeChannels(),
    parse: raw => { try { return normalizeNoticeChannels(JSON.parse(raw)); } catch { return normalizeNoticeChannels(); } },
    format: value => JSON.stringify(normalizeNoticeChannels(value)) },
  noticeNotifications: { key: 'lush.noticeNotifications', default: false, parse: raw => raw === '1', format: value => value ? '1' : '0' },
  markdown: boolPref(MARKDOWN_KEY, true),
  theme: enumPref(THEME_KEY, THEME_VALUES, 'system'),
  sidebarSort: {
    key: SIDEBAR_SORT_KEY, legacy: [LEGACY_TREE_SORT_KEY], default: 'smart',
    parse: raw => (SORT_IDS.has(raw) ? raw : 'smart'),
    format: value => (SORT_IDS.has(value) ? value : 'smart'),
  },
  collapsed: { key: COLLAPSED_KEY, default: () => new Set(), parse: parseCollapsed, format: serializeCollapsed, scope: true },
  taskGraphMinimal: { key: 'lush.taskGraph.minimal', default: true, parse: raw => raw !== '0',
    format: value => value ? '1' : '0' },
  taskGraphStatuses: { key: TASK_GRAPH_STATUSES_KEY, default: () => new Set(), parse: parseTaskGraphStatuses,
    format: value => JSON.stringify([...value]), scope: true },
  taskGraphCollapsed: { key: 'lush.taskGraph.collapsed', default: () => new Set(), scope: true,
    parse: raw => { try { const value = JSON.parse(raw); return new Set(Array.isArray(value) ? value.filter(id => typeof id === 'string' || (Number.isSafeInteger(id) && id > 0)) : []); } catch { return new Set(); } },
    format: value => JSON.stringify([...value]) },
  filters: { key: FILTERS_KEY, default: () => parseFilters(null), parse: parseFilters, format: value => JSON.stringify(value), scope: true },
  reduceMotion: boolPref(REDUCED_MOTION_KEY, false),
  polling: enumPref(POLLING_KEY, [...POLLING_IDS], 'standard'),
  toastDuration: enumPref(TOAST_DURATION_KEY, [...TOAST_IDS], 'standard'),
  transcriptOrder: enumPref(TRANSCRIPT_ORDER_KEY, [...TRANSCRIPT_ORDER_IDS], 'desc'),
};
export const PREF_NAMES = Object.keys(PREF_DEFS);

const memory = new Map();
function readRaw(key) { try { return localStorage.getItem(key) ?? memory.get(key) ?? null; } catch { return memory.get(key) ?? null; } }
function removeRaw(key) { memory.delete(key); try { localStorage.removeItem(key); } catch { /* 隐私模式里忽略 */ } }

/** 非偏好类的持久键（如提醒去重）也统一走这里，其它模块不直接拼 localStorage。 */
export function readStored(key) { return readRaw(key); }
export function writeStored(key, value) { try { localStorage.setItem(key, String(value)); memory.delete(key); } catch { memory.set(key, String(value)); } }
function defaultValue(def) { return typeof def.default === 'function' ? def.default() : def.default; }

/**
 * 项目相关偏好（折叠 / 筛选 / 排序）按项目隔离：同一浏览器里 A 的视图状态不会带到 B，
 * 主题 / Markdown / 轮询 / 提醒等设备偏好统一由 Host 管理，本地仅缓存。项目辨识色由 appearance.js 独立读取；旧项目 theme 不参与显示。
 */
function prefKey(def) {
  if (!def.scope) return def.key;
  return scopedKey(def.key);
}

/** 把一个 localStorage 键挂到当前项目下；单项目模式 / 全局根保持原键。供 prefs 以外的模块（Task 图折叠等）复用。 */
export function scopedKey(base) {
  const scope = preferenceScope();
  return scope ? `${base}:${scope}` : base;
}

/** localStorage 是否可写：隐私模式 / 内嵌 webview 里写不进去，调用方切换到内存兜底。 */
export function storageAvailable() {
  const probe = '__lush_prefs_probe__';
  try {
    localStorage.setItem(probe, '1');
    const ok = localStorage.getItem(probe) === '1';
    localStorage.removeItem(probe);
    return ok;
  } catch { return false; }
}

/** 读一个偏好；存储里没有就回落旧键，再没有就回落默认值。 */
export function readPref(name) {
  const def = PREF_DEFS[name];
  if (!def) throw new Error(`unknown preference: ${name}`);
  let raw = readRaw(prefKey(def));
  if (raw === null) for (const legacy of def.legacy ?? []) { raw = readRaw(legacy); if (raw !== null) break; }
  return raw === null ? defaultValue(def) : def.parse(raw);
}

/** 值先规整成稳定字符串；存储不可用时保留会话选择。 */
export function writePref(name, value) {
  const def = PREF_DEFS[name];
  if (!def) throw new Error(`unknown preference: ${name}`);
  const raw = def.format(value);
  try { localStorage.setItem(prefKey(def), raw); memory.delete(prefKey(def)); }
  catch { memory.set(prefKey(def), raw); }
  return def.parse(raw);
}

const repainters = new Map();

/** 注册「某个偏好变了要重画什么」；返回取消函数。 */
export function onPrefChange(name, fn) {
  if (!PREF_DEFS[name]) throw new Error(`unknown preference: ${name}`);
  if (!repainters.has(name)) repainters.set(name, new Set());
  repainters.get(name).add(fn);
  return () => repainters.get(name)?.delete(fn);
}

function notify(name, value) {
  // 单个重画器失败不能把偏好写入拖下水（例如设置页没打开、DOM 还没装配）。
  for (const fn of repainters.get(name) ?? []) { try { fn(value, name); } catch { /* 重画失败不影响已落盘的值 */ } }
}

/** 落盘 + 通知重画器；返回规整后的当前值。 */
export function setPref(name, value) {
  const current = writePref(name, value);
  notify(name, current);
  return current;
}

/** 删掉全部受管键（含历史键），逐项通知回默认值。 */
export function resetPrefs() {
  for (const name of PREF_NAMES) {
    const def = PREF_DEFS[name];
    removeRaw(prefKey(def));
    for (const legacy of def.legacy ?? []) removeRaw(legacy);
  }
  for (const name of PREF_NAMES) notify(name, readPref(name));
  return prefsSnapshot();
}

/** 当前全部偏好的快照，给设置页与测试用。 */
export function prefsSnapshot() {
  return Object.fromEntries(PREF_NAMES.map(name => [name, readPref(name)]));
}

export const DEVICE_PREF_NAMES = ['markdown', 'theme', 'sidebarSort', 'taskGraphMinimal', 'reduceMotion',
  'polling', 'toastDuration', 'transcriptOrder', 'noticeChannels', 'noticeNotifications'];
const DEVICE_PREFS = new Set(DEVICE_PREF_NAMES);
const DEVICE_REVISION_KEY = 'lush.device-preferences-revision';
let deviceClient = null;
const deviceListeners = new Set();
export function onDevicePreferences(listener) {
  deviceListeners.add(listener); listener(devicePreferencesStatus()); return () => deviceListeners.delete(listener);
}
function emitDevicePreferences() {
  const status = devicePreferencesStatus();
  for (const listener of deviceListeners) { try { listener(status); } catch (error) { console.error(error); } }
}
function preferenceEqual(a, b) {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
  const left = Object.keys(a).sort(), right = Object.keys(b).sort();
  return left.length === right.length && left.every((key, index) => key === right[index] && preferenceEqual(a[key], b[key]));
}
function deviceState() {
  const owner = globalThis.document, storage = globalThis.localStorage;
  if (deviceClient && deviceClient.owner === owner && deviceClient.storage === storage) return deviceClient;
  deviceClient = { owner, storage, ready: false, pending: 0, error: '', revision: null, generation: 0,
    read: null, applied: null, queue: Promise.resolve() };
  return deviceClient;
}
const ownsDeviceState = state => state === deviceState();
export function devicePreferencesStatus() {
  const state = deviceState();
  return { ready: state.ready, saving: state.pending > 0, error: state.error, revision: state.revision };
}
async function preferenceRequest(options) {
  // Keep the pre-paint appearance entry lightweight; do not statically import the full app/API graph.
  const { api } = await import('./api.js');
  return api('/api/host/preferences', options);
}
function validatedDeviceModel(model) {
  if (model?.version !== 1 || typeof model.revision !== 'string' || !model.revision.trim()
    || !model.values || typeof model.values !== 'object' || Array.isArray(model.values)
    || Object.keys(model.values).some(name => !DEVICE_PREFS.has(name))) throw new Error('设备偏好响应无效；请更新 Host 后重试');
  const values = {};
  for (const name of DEVICE_PREF_NAMES) {
    const value = model.values[name], def = PREF_DEFS[name];
    const normalized = def.parse(def.format(value));
    if (value === undefined || !preferenceEqual(normalized, value)) throw new Error('设备偏好响应缺少有效值；未覆盖缓存');
    values[name] = normalized;
  }
  return { revision: model.revision, values };
}
function applyDeviceModel(state, raw) {
  const model = validatedDeviceModel(raw);
  if (!ownsDeviceState(state)) return model;
  state.ready = true; state.revision = model.revision; state.error = '';
  for (const name of DEVICE_PREF_NAMES) {
    // Same-origin tabs share localStorage. Another tab may already have updated
    // that cache while this page still displays its previously applied snapshot.
    const cached = readPref(name), applied = state.applied?.[name] ?? cached;
    const changed = !preferenceEqual(applied, model.values[name]) || !preferenceEqual(cached, model.values[name]);
    const value = writePref(name, model.values[name]);
    if (changed) notify(name, value);
  }
  state.applied = model.values;
  emitDevicePreferences();
  // An invalidation hint only. Other tabs must fetch the authoritative backend, never trust this value as configuration.
  writeStored(DEVICE_REVISION_KEY, model.revision);
  return model;
}

/** Read-only reconciliation. Startup never seeds the backend from stale browser values. */
export async function refreshDevicePreferences() {
  const state = deviceState();
  if (state.read) return state.read;
  if (state.pending) return state.queue.then(() => refreshDevicePreferences());
  const generation = state.generation;
  const pending = preferenceRequest().then(raw => {
    if (ownsDeviceState(state) && state.generation === generation && !state.pending) return applyDeviceModel(state, raw).values;
    return null;
  }).catch(error => {
    if (ownsDeviceState(state) && state.generation === generation) { state.error = error.message; emitDevicePreferences(); }
    throw error;
  }).finally(() => { if (state.read === pending) state.read = null; });
  state.read = pending; return pending;
}

/** Explicit, serialized device write. A stale revision is rejected rather than silently overwriting another client. */
export function saveDevicePreference(name, value) {
  if (!DEVICE_PREFS.has(name)) return Promise.reject(new Error('此项是项目工作状态，不是设备偏好'));
  const def = PREF_DEFS[name], normalized = def.parse(def.format(value));
  return saveDevicePatch({ [name]: normalized }).then(values => values[name]);
}
function saveDevicePatch(patch) {
  const state = deviceState();
  state.pending++; state.generation++; emitDevicePreferences();
  const write = state.queue.catch(() => {}).then(async () => {
    if (!ownsDeviceState(state)) throw new Error('页面已更新，未提交旧偏好');
    try {
      if (!state.ready) applyDeviceModel(state, await preferenceRequest());
      if (!ownsDeviceState(state)) throw new Error('页面已更新，未提交旧偏好');
      const raw = await preferenceRequest({ method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ patch, expected_revision: state.revision }) });
      // Invalidate GETs that began before this ACK, even when they finish after it.
      state.generation++;
      return applyDeviceModel(state, raw).values;
    } catch (error) {
      if (ownsDeviceState(state)) state.error = error.message;
      throw error;
    } finally { state.pending--; if (ownsDeviceState(state)) emitDevicePreferences(); }
  });
  // Keep the serialization queue settled for fire-and-forget lifecycle reads, but return the real rejection to the caller.
  state.queue = write.catch(() => {});
  return write;
}
export function resetDevicePreferences() {
  return saveDevicePatch(Object.fromEntries(DEVICE_PREF_NAMES.map(name => [name, defaultValue(PREF_DEFS[name])])));
}

/** Cross-client sync is read-only and cancellable; it never creates a project or asks for Notification permission. */
export function startDevicePreferencesSync({ interval = 5000 } = {}) {
  const owner = globalThis.document, storage = globalThis.localStorage;
  let disposed = false;
  const update = () => { if (!disposed && owner === globalThis.document && storage === globalThis.localStorage) void refreshDevicePreferences().catch(() => {}); };
  const changed = event => { if (event?.key === DEVICE_REVISION_KEY) update(); };
  const visible = () => { if (!globalThis.document?.hidden) update(); };
  globalThis.addEventListener?.('storage', changed);
  globalThis.addEventListener?.('focus', visible);
  globalThis.document?.addEventListener?.('visibilitychange', visible);
  const timer = setInterval(visible, interval); timer?.unref?.(); update();
  return () => {
    disposed = true; clearInterval(timer);
    globalThis.removeEventListener?.('storage', changed); globalThis.removeEventListener?.('focus', visible);
    globalThis.document?.removeEventListener?.('visibilitychange', visible);
  };
}
