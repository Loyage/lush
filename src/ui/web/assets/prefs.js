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
 * 迁到 `lush.sidebarSort` 后，读取时仍回落旧键。偏好只存在当前浏览器，不写进项目库。
 */
import { COLLAPSED_KEY, FILTERS_KEY, parseCollapsed, parseFilters, serializeCollapsed } from './sidebar.js';
import { SORT_MODES } from './tree-order.js';

export const MARKDOWN_KEY = 'lush.markdown';
export const THEME_KEY = 'lush.theme';
export const SIDEBAR_SORT_KEY = 'lush.sidebarSort';
export const LEGACY_TREE_SORT_KEY = 'lush.treeSort';
export const REDUCED_MOTION_KEY = 'lush.reduceMotion';
export const POLLING_KEY = 'lush.polling';
export const TOAST_DURATION_KEY = 'lush.toastDuration';

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

/**
 * 全部受管偏好。`legacy` 是升级前的旧键，只在当前键缺失时读取。
 * `default` 可以是值或工厂（集合 / 对象每次都要新的，避免调用方改到共享默认值）。
 */
export const PREF_DEFS = {
  noticeNotifications: { key: 'lush.noticeNotifications', default: false, parse: raw => raw === '1', format: value => value ? '1' : '0' },
  markdown: boolPref(MARKDOWN_KEY, true),
  theme: enumPref(THEME_KEY, THEME_VALUES, 'system'),
  sidebarSort: {
    key: SIDEBAR_SORT_KEY, legacy: [LEGACY_TREE_SORT_KEY], default: 'smart',
    parse: raw => (SORT_IDS.has(raw) ? raw : 'smart'),
    format: value => (SORT_IDS.has(value) ? value : 'smart'),
  },
  collapsed: { key: COLLAPSED_KEY, default: () => new Set(), parse: parseCollapsed, format: serializeCollapsed },
  filters: { key: FILTERS_KEY, default: () => parseFilters(null), parse: parseFilters, format: value => JSON.stringify(value) },
  reduceMotion: boolPref(REDUCED_MOTION_KEY, false),
  polling: enumPref(POLLING_KEY, [...POLLING_IDS], 'standard'),
  toastDuration: enumPref(TOAST_DURATION_KEY, [...TOAST_IDS], 'standard'),
};
export const PREF_NAMES = Object.keys(PREF_DEFS);

function readRaw(key) { try { return localStorage.getItem(key); } catch { return null; } }
function removeRaw(key) { try { localStorage.removeItem(key); } catch { /* 隐私模式里忽略 */ } }
function defaultValue(def) { return typeof def.default === 'function' ? def.default() : def.default; }

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
  let raw = readRaw(def.key);
  if (raw === null) for (const legacy of def.legacy ?? []) { raw = readRaw(legacy); if (raw !== null) break; }
  return raw === null ? defaultValue(def) : def.parse(raw);
}

/** 只写盘：值先规整成稳定字符串，存储不可用时静默放弃。 */
export function writePref(name, value) {
  const def = PREF_DEFS[name];
  if (!def) throw new Error(`unknown preference: ${name}`);
  const raw = def.format(value);
  try { localStorage.setItem(def.key, raw); } catch { /* 隐私模式里忽略 */ }
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
    removeRaw(def.key);
    for (const legacy of def.legacy ?? []) removeRaw(legacy);
  }
  for (const name of PREF_NAMES) notify(name, readPref(name));
  return prefsSnapshot();
}

/** 当前全部偏好的快照，给设置页与测试用。 */
export function prefsSnapshot() {
  return Object.fromEntries(PREF_NAMES.map(name => [name, readPref(name)]));
}
