import { test, expect, afterAll } from 'bun:test';
import { installDom, deepText } from '../dom-stub.js';
import { makeWorld } from './dom-world.js';

// 设置页：入口 / #settings 路由 / 轮询不覆盖、偏好默认值与老键回落、每项即时生效并持久化、恢复默认。
// 每个 DOM 测试文件自给自足：自己建 world、装 stub，再显式装配一次当前 DOM。
const world = makeWorld();
const dom = installDom({ fetch: world.fetchImpl });
const { boot } = await import('../../src/ui/web/assets/app.js');
const prefs = await import('../../src/ui/web/assets/prefs.js');
const state = await import('../../src/ui/web/assets/state.js');
const { renderSettings } = await import('../../src/ui/web/assets/render-settings.js');
dom.node('side-nav').replaceChildren();
await boot();

afterAll(() => dom.restore());

const panel = () => dom.node('detail');
const openSettings = () => dom.node('settings-open').onclick();
const systemBlock = () => [...panel().querySelectorAll('.block')]
  .find(node => node.querySelector('h2')?.textContent === '系统信息') || null;

test('设置入口：侧栏工作区导航进入 #settings，后退回概览，1.5s 轮询不覆盖该视图', async () => {
  await dom.intervalFor(1500)();
  expect(panel().dataset.view).toBe('overview');

  openSettings();
  expect(dom.location.hash).toBe('#settings');
  expect(panel().dataset.view).toBe('settings');
  expect(deepText(panel())).toContain('设置');
  expect(deepText(panel())).toContain('Markdown 渲染');
  expect(deepText(panel())).toContain('跟随系统');

  // 轮询照旧更新左栏与连接状态，但不把设置页换成概览。
  await dom.intervalFor(1500)();
  expect(panel().dataset.view).toBe('settings');
  expect(deepText(panel())).not.toContain('项目概览');

  // 后退到无 hash：回概览。
  dom.location.hash = '';
  await dom.fire('hashchange');
  expect(panel().dataset.view).toBe('overview');
});

test('偏好默认值与老键值：全部走默认，旧键继续生效，坏值回落', () => {
  for (const name of prefs.PREF_NAMES) globalThis.localStorage.removeItem(prefs.PREF_DEFS[name].key);
  expect(prefs.readPref('markdown')).toBe(true);
  expect(prefs.readPref('theme')).toBe('system');
  expect(prefs.readPref('sidebarSort')).toBe('smart');
  expect(prefs.readPref('reduceMotion')).toBe(false);
  expect(prefs.readPref('polling')).toBe('standard');
  expect(prefs.readPref('toastDuration')).toBe('standard');
  // 标准档严格等于改造前写死的间隔
  expect(prefs.pollingIntervals('standard')).toMatchObject({ snapshot: 1500, live: 3000 });
  expect(prefs.toastDurations('standard')).toMatchObject({ info: 4000, error: 8000 });
  // 左栏排序从 lush.treeSort 迁到 lush.sidebarSort：旧键仍被识别，坏值回落 smart。
  globalThis.localStorage.setItem(prefs.LEGACY_TREE_SORT_KEY, 'updated');
  expect(prefs.readPref('sidebarSort')).toBe('updated');
  globalThis.localStorage.setItem(prefs.SIDEBAR_SORT_KEY, 'nonsense');
  expect(prefs.readPref('sidebarSort')).toBe('smart');
  globalThis.localStorage.removeItem(prefs.SIDEBAR_SORT_KEY);
  globalThis.localStorage.removeItem(prefs.LEGACY_TREE_SORT_KEY);
  // 主题老键（light / dark）继续生效；坏值回落跟随系统。
  globalThis.localStorage.setItem(prefs.THEME_KEY, 'dark');
  expect(prefs.readPref('theme')).toBe('dark');
  globalThis.localStorage.setItem(prefs.THEME_KEY, 'sepia');
  expect(prefs.readPref('theme')).toBe('system');
  globalThis.localStorage.removeItem(prefs.THEME_KEY);
});

test('偏好快照与变更通知：setPref 只通知对应偏好', () => {
  let seen = null;
  const off = prefs.onPrefChange('polling', value => { seen = value; });
  prefs.setPref('polling', 'fast');
  expect(seen).toBe('fast');
  off();
  prefs.setPref('polling', 'standard');
  expect(seen).toBe('fast');   // 取消注册后不再收到
  const snapshot = prefs.prefsSnapshot();
  for (const name of prefs.PREF_NAMES) expect(snapshot).toHaveProperty(name);
  expect(prefs.prefsSnapshot().polling).toBe('standard');
});

test('Markdown 开关：设置页控件与头部按钮共用同一个偏好', async () => {
  const { agentText, markdownEnabled } = await import('../../src/ui/web/assets/text.js');
  openSettings();
  const toggle = panel().querySelector('input.pref-toggle[data-pref="markdown"]');
  expect(toggle.checked).toBe(true);

  toggle.checked = false;
  await toggle.listeners.change[0]();
  expect(globalThis.localStorage.getItem(prefs.MARKDOWN_KEY)).toBe('0');
  expect(markdownEnabled()).toBe(false);
  expect(dom.node('md-toggle').textContent).toContain('关');
  const plain = agentText('**粗** 和 *斜*');
  expect(plain.tagName).toBe('DIV');
  expect(plain.className).toBe('');
  expect(plain.textContent).toBe('**粗** 和 *斜*');

  // 反向：头部按钮翻转 → 设置页控件同步
  dom.node('md-toggle').onclick();
  expect(markdownEnabled()).toBe(true);
  expect(panel().querySelector('input.pref-toggle[data-pref="markdown"]').checked).toBe(true);
});

test('设置项即时生效并持久化：左栏排序、主题、动效、轮询频率', async () => {
  openSettings();
  // 左栏默认排序 = 左栏顶部下拉的同一个偏好。
  const sort = panel().querySelector('select.pref-select[data-pref="sidebarSort"]');
  expect(sort.value).toBe('smart');
  sort.value = 'updated';
  await sort.listeners.change[0]();
  expect(globalThis.localStorage.getItem(prefs.SIDEBAR_SORT_KEY)).toBe('updated');
  expect(dom.node('sidebar-sort').value).toBe('updated');

  // 外观：选中深色立刻改 <html data-theme> 并落盘。
  openSettings();
  const dark = panel().querySelector('input.pref-radio[data-value="dark"]');
  expect(dark.checked).toBe(false);
  dark.checked = true;
  await dark.listeners.change[0]();
  expect(globalThis.localStorage.getItem(prefs.THEME_KEY)).toBe('dark');
  expect(dom.document.documentElement.dataset.theme).toBe('dark');
  // 头部主题按钮写回偏好，设置页 radio 跟着走（下一次打开状态一致）。
  dom.node('theme-toggle').onclick();
  expect(globalThis.localStorage.getItem(prefs.THEME_KEY)).toBe('light');

  // 动效：覆盖系统偏好，写到 <html> 上让 CSS 生效。
  openSettings();
  const motion = panel().querySelector('input.pref-toggle[data-pref="reduceMotion"]');
  motion.checked = true;
  await motion.listeners.change[0]();
  expect(globalThis.localStorage.getItem(prefs.REDUCED_MOTION_KEY)).toBe('1');
  expect(dom.document.documentElement.dataset.reducedMotion).toBe('true');

  // 轮询频率：改动后立即按新间隔重建定时器（标准 1500/3000 → 快速 800/1600）。
  openSettings();
  const polling = panel().querySelector('select.pref-select[data-pref="polling"]');
  expect(polling.value).toBe('standard');
  polling.value = 'fast';
  await polling.listeners.change[0]();
  expect(globalThis.localStorage.getItem(prefs.POLLING_KEY)).toBe('fast');
  expect(dom.intervals.some(entry => entry.ms === 800)).toBe(true);
  expect(dom.intervals.some(entry => entry.ms === 1600)).toBe(true);
});

test('消息提示停留时长偏好对之后出现的提示生效', async () => {
  const { show, clear, setTimers } = await import('../../src/ui/web/assets/messages.js');
  let clock = 0, nextId = 1;
  const pending = new Map();
  setTimers({
    setTimeout: (fn, ms) => { const id = nextId++; pending.set(id, { fn, at: clock + ms }); return id; },
    clearTimeout: id => pending.delete(id),
    now: () => clock,
  });
  const advance = ms => { clock += ms; for (const [id, entry] of [...pending]) if (entry.at <= clock) { pending.delete(id); entry.fn(); } };
  try {
    openSettings();
    const toast = panel().querySelector('select.pref-select[data-pref="toastDuration"]');
    toast.value = 'short';
    await toast.listeners.change[0]();
    expect(globalThis.localStorage.getItem(prefs.TOAST_DURATION_KEY)).toBe('short');

    clear();
    show('短提示');
    advance(1999); expect(dom.node('toast').hidden).toBe(false);
    advance(1); expect(dom.node('toast').hidden).toBe(true);

    // 错误类走错误档（短＝4s），并且对之后出现的提示生效。
    show('短错误', 'error');
    advance(3999); expect(dom.node('toast').hidden).toBe(false);
    advance(1); expect(dom.node('toast').hidden).toBe(true);
  } finally {
    setTimers(null);
    clear();
    prefs.setPref('toastDuration', 'standard');
  }
});

test('恢复默认设置：删掉所有偏好键（含历史键）并就地重画', async () => {
  for (const name of prefs.PREF_NAMES) globalThis.localStorage.setItem(prefs.PREF_DEFS[name].key, 'x');
  globalThis.localStorage.setItem(prefs.MARKDOWN_KEY, '0');
  globalThis.localStorage.setItem(prefs.THEME_KEY, 'dark');
  globalThis.localStorage.setItem(prefs.SIDEBAR_SORT_KEY, 'id');
  globalThis.localStorage.setItem(prefs.REDUCED_MOTION_KEY, '1');
  globalThis.localStorage.setItem(prefs.POLLING_KEY, 'fast');
  globalThis.localStorage.setItem(prefs.TOAST_DURATION_KEY, 'long');
  globalThis.localStorage.setItem(prefs.LEGACY_TREE_SORT_KEY, 'updated');

  openSettings();
  await panel().querySelector('button.pref-reset').onclick();

  for (const name of prefs.PREF_NAMES) expect(globalThis.localStorage.getItem(prefs.PREF_DEFS[name].key)).toBeNull();
  expect(globalThis.localStorage.getItem(prefs.LEGACY_TREE_SORT_KEY)).toBeNull();
  expect(prefs.readPref('markdown')).toBe(true);
  expect(prefs.readPref('theme')).toBe('system');
  expect(prefs.readPref('sidebarSort')).toBe('smart');
  expect(prefs.readPref('reduceMotion')).toBe(false);
  expect(prefs.readPref('polling')).toBe('standard');
  expect(prefs.readPref('toastDuration')).toBe('standard');
  // 重画把控件与页面同步回默认值。
  expect(dom.node('sidebar-sort').value).toBe('smart');
  expect(dom.document.documentElement.dataset.reducedMotion).toBeUndefined();
  expect(panel().querySelector('input.pref-toggle[data-pref="markdown"]').checked).toBe(true);
});

// 「系统信息」组：只读镜像 system.status，值取自 ui.lastSnapshot（轮询持续更新它），无快照时占位。
const systemSnapshot = overrides => ({ status: {
  provider: 'pi', concurrency: 4, control_concurrency: 2,
  call_timeout: 600, task_call_limit: 12, max_depth: 5, pi_model: '', pi_provider: '',
  ...overrides,
} });

test('系统信息组：只读展示快照字段，pi 覆写未设置时显示「pi 默认」', () => {
  openSettings();
  state.ui.lastSnapshot = systemSnapshot();
  renderSettings();

  const block = systemBlock();
  expect(block).toBeTruthy();
  const value = field => block.querySelector(`[data-system-field="${field}"]`).textContent;
  expect(value('provider')).toBe('pi');
  expect(value('concurrency')).toBe('4（控制通道 2）');
  expect(value('call_timeout')).toBe('600 秒');
  expect(value('task_call_limit')).toBe('12');
  expect(value('max_depth')).toBe('5');
  expect(value('pi_model')).toBe('pi 默认');
  expect(value('pi_provider')).toBe('pi 默认');
  // 只读：该组内没有任何可编辑控件或写回按钮（stub 的选择器不支持逗号列表，逐个查）。
  for (const control of ['input', 'select', 'textarea', 'button']) expect(block.querySelector(control)).toBeNull();
  // 说明文字点明这些是环境变量、需重启 daemon 才生效、本组仅供查看。
  const note = deepText(block);
  expect(note).toContain('环境变量');
  expect(note).toContain('重启 daemon');
  expect(note).toContain('仅供查看');
});

test('系统信息组：pi 模型 / provider 有值时原样显示', () => {
  openSettings();
  state.ui.lastSnapshot = systemSnapshot({ pi_model: 'gpt-5', pi_provider: 'openai' });
  renderSettings();
  const block = systemBlock();
  expect(block.querySelector('[data-system-field="pi_model"]').textContent).toBe('gpt-5');
  expect(block.querySelector('[data-system-field="pi_provider"]').textContent).toBe('openai');
});

test('系统信息组：没有快照时显示占位、不抛异常也不留空块', () => {
  openSettings();
  state.ui.lastSnapshot = null;
  expect(() => renderSettings()).not.toThrow();
  const block = systemBlock();
  expect(block).toBeTruthy();
  // 组里没有字段值，只剩占位文案（不抛异常、不留空壳）。
  expect(block.querySelector('[data-system-field="provider"]')).toBeNull();
  expect(block.querySelector('[data-system-field="pi_model"]')).toBeNull();
  expect(block.querySelector('.settings-placeholder')).toBeTruthy();
  expect(deepText(block)).toContain('尚未收到 daemon 快照');
});
