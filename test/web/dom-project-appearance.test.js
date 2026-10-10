import { test, expect, afterAll } from 'bun:test';
import { installDom, deepText } from '../dom-stub.js';
import { makeWorld } from './dom-world.js';
import { initAppearance } from '../../src/ui/web/assets/appearance.js';
import { setProjectIdentity } from '../../src/ui/web/assets/project-identity.js';
import { refreshDevicePreferences, saveDevicePreference, resetDevicePreferences } from '../../src/ui/web/assets/prefs.js';
import { openSettings } from '../../src/ui/web/assets/render-settings.js';
import { ensureProject, openProjectManager } from '../../src/ui/web/assets/project-picker.js';
import { resetUiState, ui } from '../../src/ui/web/assets/state.js';

const world = makeWorld(), id = 'abcdef0123456789';
let value = { version: 1, theme: 'dark', color: 'blue', revision: 'revision-1' };
const calls = [];
const dom = installDom({ fetch: async (url, options) => {
  if (url === '/api/host') return Response.json({ mode: 'host', projects: [{ id, name: 'demo', project: '/fixture/demo' }] });
  if (url === '/api/host/projects') return Response.json({ projects: [{ id, name: 'demo', project: '/fixture/demo' }] });
  if (url === `/api/host/projects/${id}/appearance`) {
    if (options) { const body = JSON.parse(options.body); calls.push(body); value = { ...value, color: body.color, revision: `revision-${calls.length + 1}` }; }
    return Response.json({ id, appearance: value });
  }
  return world.fetchImpl(url, options);
} });
const themeHost = dom.document.createElement('span'); themeHost.className = 'help-host'; themeHost.append(dom.node('theme-toggle'));
resetUiState();
let controller = initAppearance();
await refreshDevicePreferences();
afterAll(() => { controller.destroy(); dom.restore(); });
const panel = () => dom.node('detail');

test('project name is in document title, including offline identity; workbench resets it', () => {
  setProjectIdentity('测试项目 <demo>', '/fixture/test');
  expect(dom.document.title).toBe('测试项目 <demo> · Lush');
  expect(dom.node('project').textContent).toBe('测试项目 <demo>');
  setProjectIdentity('', '/fixture/my-app'); expect(dom.document.title).toBe('my-app · Lush');
  setProjectIdentity(); expect(dom.document.title).toBe('Lush');
});

test('global project manager offers six named color swatches; saving preserves old theme and device preference', async () => {
  await ensureProject(); await openProjectManager();
  expect(calls).toHaveLength(0); // List reads do not initialize colors.
  await panel().querySelector('.project-color-open').onclick();
  expect(panel().querySelectorAll('.project-color-swatch')).toHaveLength(6);
  const rose = panel().querySelector('input[data-project-color="rose"]'); rose.checked = true; await rose.onchange();
  expect(calls[0]).toEqual({ color: 'rose', expected_revision: 'revision-1' });
  expect(value).toMatchObject({ theme: 'dark', color: 'rose' });
  expect(dom.document.documentElement.dataset.projectColor).toBeUndefined();
  expect(world.state.devicePreferences.values.theme).toBe('system');
  await panel().querySelector('.project-color-open').onclick();
  expect(panel().querySelector('.project-color-editor')).toBeNull();
});

test('device settings never expose project theme; device reset leaves project color and historical theme intact', async () => {
  await openSettings(); await panel().querySelector('button.settings-tab[data-settings-tab="interface"]').onclick();
  expect(deepText(panel())).toContain('所有项目共用'); expect(panel().querySelectorAll('.project-color-swatch')).toHaveLength(0);
  const light = panel().querySelector('input.pref-radio[data-value="light"]'); light.checked = true; await light.listeners.change[0]();
  controller.paint(); expect(dom.document.documentElement.dataset.theme).toBe('light');
  const before = { ...value }; await resetDevicePreferences(); expect(value).toEqual(before); expect(calls).toHaveLength(1);
});

test('late color save after navigation cannot remount editor or overwrite the new page', async () => {
  await openProjectManager(); await panel().querySelector('.project-color-open').onclick();
  const editor = panel().querySelector('.project-color-editor'), rose = editor.querySelector('input[data-project-color="rose"]');
  await openSettings(); rose.checked = true; await rose.onchange();
  expect(ui.view.id).toBe('settings'); expect(calls).toHaveLength(1); expect(panel().querySelector('.project-color-editor')).toBeNull();
});

test('project color uses Host while sidebar theme saves only device preferences', async () => {
  dom.location.pathname = `/p/${id}/`;
  controller = initAppearance({ projectId: id, request: async () => ({ id, appearance: value }), setInterval: null });
  await controller.load(true); await saveDevicePreference('theme', 'light'); controller.paint();
  await dom.node('theme-toggle').onclick();
  expect(dom.document.documentElement.dataset).toMatchObject({ theme: 'dark', projectColor: 'rose' });
  expect(world.state.devicePreferences.values.theme).toBe('dark'); expect(value.theme).toBe('dark'); expect(calls).toHaveLength(1);
  expect(dom.node('theme-toggle').parentNode.getAttribute('data-help')).toContain('设备唯一');
  expect(dom.node('theme-toggle').title).toBe('');
});
