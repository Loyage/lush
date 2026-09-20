import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../../src/ui/web/assets/appearance.js', import.meta.url), 'utf8');
function world({ saved = null, dark = false, blocked = false, media = true } = {}) {
  const root = { dataset: {} };
  const toggle = { attrs: {}, setAttribute(name, value) { this.attrs[name] = value; } };
  let ready, change, mounted = false;
  const storage = new Map(saved === null ? [] : [['lush.theme', saved]]);
  runInNewContext(source, {
    document: {
      documentElement: root,
      getElementById: () => mounted ? toggle : null,
      addEventListener: (event, fn) => { if (event === 'DOMContentLoaded') ready = fn; },
    },
    window: media ? { matchMedia: () => ({ matches: dark, addEventListener: (_event, fn) => { change = fn; } }) } : {},
    localStorage: {
      getItem: key => { if (blocked) throw new Error('denied'); return storage.get(key); },
      setItem: (key, value) => { if (blocked) throw new Error('denied'); storage.set(key, value); },
    },
  });
  return { root, toggle, storage, mount() { mounted = true; ready(); }, system(value) { change?.({ matches: value }); } };
}

test('theme is applied before the button exists, then follows the system until chosen', () => {
  const w = world({ dark: true });
  expect(w.root.dataset.theme).toBe('dark');
  w.mount();
  expect(w.toggle.attrs['aria-label']).toBe('切换到浅色主题');
  w.system(false);
  expect(w.root.dataset.theme).toBe('light');
  w.toggle.onclick();
  expect(w.root.dataset.theme).toBe('dark');
  expect(w.storage.get('lush.theme')).toBe('dark');
  expect(w.toggle.attrs['aria-pressed']).toBe('true');
  w.system(false);
  expect(w.root.dataset.theme).toBe('dark');
});

test('explicit theme survives reload and ignores a conflicting OS preference', () => {
  for (const theme of ['light', 'dark']) {
    const w = world({ saved: theme, dark: theme === 'light' });
    expect(w.root.dataset.theme).toBe(theme);
    w.mount();
    w.system(theme === 'light');
    expect(w.root.dataset.theme).toBe(theme);
    w.toggle.onclick();
    const next = theme === 'dark' ? 'light' : 'dark';
    expect(w.storage.get('lush.theme')).toBe(next);
    expect(world({ saved: next }).root.dataset.theme).toBe(next);
  }
});

test('invalid preferences, blocked storage and missing matchMedia are safe', () => {
  expect(world({ saved: 'invalid', dark: true }).root.dataset.theme).toBe('dark');
  const w = world({ blocked: true, media: false });
  expect(w.root.dataset.theme).toBe('light');
  w.mount();
  expect(() => w.toggle.onclick()).not.toThrow();
  expect(w.root.dataset.theme).toBe('dark');
});
