import { test, expect, afterAll } from 'bun:test';
import { installDom, deepText } from '../dom-stub.js';
import { initAppearance } from '../../src/ui/web/assets/appearance.js';
import { setProjectIdentity } from '../../src/ui/web/assets/project-identity.js';
import { setPref, resetPrefs, THEME_KEY } from '../../src/ui/web/assets/prefs.js';
import { openSettings } from '../../src/ui/web/assets/render-settings.js';
import { resetUiState } from '../../src/ui/web/assets/state.js';

const dom = installDom();
const id = 'abcdef0123456789';
let value = { version: 1, theme: 'dark', color: 'blue', revision: 'revision-1' };
const calls = [];
resetUiState();
const controller = initAppearance({ projectId: id, request: async (_url, options) => {
  if (options) {
    const body = JSON.parse(options.body); calls.push(body);
    value = { ...value, theme: body.theme, color: body.color, revision: `revision-${calls.length + 1}` };
  }
  return { id, appearance: value };
} });
await controller.load(true);
afterAll(() => { controller.destroy(); initAppearance({ projectId: null }); dom.restore(); });

const panel = () => dom.node('detail');
async function settings() {
  await openSettings();
  await panel().querySelector('button.settings-tab[data-settings-tab="interface"]').onclick();
}

test('project name is in document title, including offline identity; workbench resets it', () => {
  setProjectIdentity('测试项目 <demo>', '/fixture/test');
  expect(dom.document.title).toBe('测试项目 <demo> · Lush');
  expect(dom.node('project').textContent).toBe('测试项目 <demo>');
  setProjectIdentity('', '/fixture/my-app');
  expect(dom.document.title).toBe('my-app · Lush');
  setProjectIdentity(); expect(dom.document.title).toBe('Lush');
});

test('settings provide project theme and six named color swatches and persist via Host', async () => {
  await settings();
  expect(deepText(panel())).toContain('不同浏览器共用');
  expect(panel().querySelectorAll('.project-color-swatch')).toHaveLength(6);
  const dark = panel().querySelector('input.pref-radio[data-value="dark"]');
  expect(dark.checked).toBe(true);
  const rose = panel().querySelector('input[data-project-color="rose"]');
  rose.checked = true; await rose.listeners.change[0]();
  expect(calls[0]).toEqual({ theme: 'dark', color: 'rose', expected_revision: 'revision-1' });
  expect(dom.document.documentElement.dataset.projectColor).toBe('rose');
  const light = panel().querySelector('input.pref-radio[data-value="light"]');
  light.checked = true; await light.listeners.change[0]();
  expect(calls[1]).toEqual({ theme: 'light', color: 'rose', expected_revision: 'revision-2' });
  expect(dom.document.documentElement.dataset.theme).toBe('light');
});

test('browser theme/reset cannot override project theme; sidebar toggle saves project settings', async () => {
  setPref('theme', 'dark'); resetPrefs();
  controller.paint();
  expect(dom.document.documentElement.dataset.theme).toBe('light');
  expect(dom.document.documentElement.dataset.projectColor).toBe('rose');
  await dom.node('theme-toggle').onclick();
  expect(calls.at(-1)).toEqual({ theme: 'dark', color: 'rose', expected_revision: 'revision-3' });
  expect(globalThis.localStorage.getItem(THEME_KEY)).toBeNull();
  expect(dom.node('theme-toggle').getAttribute('data-help')).toContain('影响其他浏览器');
  expect(dom.node('theme-toggle').title).toBe('');
});
