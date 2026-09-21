import { test, expect, beforeEach, afterAll } from 'bun:test';
import { createAppearance, resolveTheme, effectiveTheme, applyTheme } from '../../src/ui/web/assets/appearance.js';
import { setPref, THEME_KEY } from '../../src/ui/web/assets/prefs.js';

/* ---------------- 可注入的存储 / 主题控制器 ---------------- */
const store = new Map();
const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
const realStorage = {
  getItem: key => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => { store.set(key, String(value)); },
  removeItem: key => { store.delete(key); },
};
const installStorage = impl => Object.defineProperty(globalThis, 'localStorage', { value: impl, configurable: true, writable: true });

beforeEach(() => { store.clear(); installStorage(realStorage); });
afterAll(() => {
  if (storageDescriptor) Object.defineProperty(globalThis, 'localStorage', storageDescriptor);
  else delete globalThis.localStorage;
});

const fakeToggle = () => ({ textContent: '', title: '', attrs: {}, setAttribute(name, value) { this.attrs[name] = value; } });
const fakeMedia = (matches = false) => ({
  matches, listeners: [],
  addEventListener(type, fn) { if (type === 'change') this.listeners.push(fn); },
  removeEventListener(type, fn) { if (type === 'change') this.listeners = this.listeners.filter(entry => entry !== fn); },
  emit(matches) { this.matches = matches; for (const fn of this.listeners) fn({ matches }); },
});

test('主题解析：显式值覆盖系统，system 跟随系统', () => {
  expect(resolveTheme('dark', false)).toBe('dark');
  expect(resolveTheme('light', true)).toBe('light');
  expect(resolveTheme('system', true)).toBe('dark');
  expect(resolveTheme('system', false)).toBe('light');
  // 坏偏好（存储里塞了别的东西）也回落到跟随系统
  expect(resolveTheme('nonsense', true)).toBe('dark');
});

test('effectiveTheme 读 lush.theme：默认跟随系统，显式选择覆盖系统', () => {
  expect(effectiveTheme({ matches: true })).toBe('dark');
  expect(effectiveTheme({ matches: false })).toBe('light');
  setPref('theme', 'light');
  expect(effectiveTheme({ matches: true })).toBe('light');
  setPref('theme', 'dark');
  expect(effectiveTheme({ matches: false })).toBe('dark');
});

test('applyTheme 写 <html data-theme> 并同步头部按钮文案 / aria', () => {
  const root = { dataset: {} };
  const toggle = fakeToggle();
  applyTheme('dark', { root, toggle });
  expect(root.dataset.theme).toBe('dark');
  expect(toggle.textContent).toBe('☀ 浅色');
  expect(toggle.attrs['aria-pressed']).toBe('true');
  expect(toggle.attrs['aria-label']).toContain('浅色');
  applyTheme('light', { root, toggle });
  expect(root.dataset.theme).toBe('light');
  expect(toggle.attrs['aria-pressed']).toBe('false');
});

test('createAppearance：跟随系统变化、按钮翻转写回偏好、显式选择后忽略系统', () => {
  const root = { dataset: {} };
  const toggle = fakeToggle();
  const media = fakeMedia(false);
  const app = createAppearance({ root, toggle, media });

  expect(root.dataset.theme).toBe('light');
  // 仍是 system：系统转深色时页面跟着变
  media.emit(true);
  expect(root.dataset.theme).toBe('dark');

  // 点头部按钮：把实际主题反过来并显式写回 lush.theme
  toggle.onclick();
  expect(store.get(THEME_KEY)).toBe('light');
  expect(root.dataset.theme).toBe('light');
  // 已经是显式选择：系统再变也不影响
  media.emit(true);
  expect(root.dataset.theme).toBe('light');
  app.destroy();
  // destroy 后旧控制器不再响应系统变化（boot 重复装配时不留幽灵监听）
  app.paint();
  media.emit(false);
  expect(root.dataset.theme).toBe('light');
});

test('存储不可用（隐私模式）时不抛异常，且主题仍在本页生效', () => {
  installStorage({
    getItem() { throw new Error('denied'); },
    setItem() { throw new Error('denied'); },
    removeItem() { throw new Error('denied'); },
  });
  expect(() => effectiveTheme({ matches: false })).not.toThrow();
  expect(effectiveTheme({ matches: false })).toBe('light');
  const root = { dataset: {} };
  const toggle = fakeToggle();
  expect(() => createAppearance({ root, toggle, media: null })).not.toThrow();
  expect(root.dataset.theme).toBe('light');
  // 没有 matchMedia 的宿主里点按钮也不炸（会话内翻转，只是写不回存储）
  expect(() => toggle.onclick()).not.toThrow();
  expect(root.dataset.theme).toBe('dark');
});
