import { test, expect, afterAll } from 'bun:test';
import { installDom, deepText } from '../dom-stub.js';
import { makeWorld } from './dom-world.js';
import { until } from '../helpers.js';

const world = makeWorld(), dom = installDom({ fetch: world.fetchImpl });
const { boot } = await import('../../src/ui/web/assets/app.js');
const prefs = await import('../../src/ui/web/assets/prefs.js');
const { openSettings } = await import('../../src/ui/web/assets/render-settings.js');
await boot(); await prefs.refreshDevicePreferences();
afterAll(() => dom.restore());

test('root settings route changes theme and reading order through authoritative device preferences', async () => {
  await openSettings();
  const panel = dom.node('detail');
  expect(dom.location.hash).toBe('#settings'); expect(panel.dataset.view).toBe('settings');
  expect(dom.intervalFor(1500)).toBeUndefined();
  const dark = panel.querySelector('input.pref-radio[data-value="dark"]'); dark.checked = true; await dark.listeners.change[0]();
  expect(world.state.devicePreferences.values.theme).toBe('dark'); expect(dom.document.documentElement.dataset.theme).toBe('dark');
  const order = panel.querySelector('select.pref-select[data-pref="transcriptOrder"]');
  order.value = 'asc'; await order.listeners.change[0]();
  expect(world.state.devicePreferences.values.transcriptOrder).toBe('asc'); expect(prefs.readPref('transcriptOrder')).toBe('asc');
  await panel.querySelector('[data-settings-tab="system"]').onclick();
  expect(panel.querySelector('input[data-runtime-input="result_notice"]')).toBeNull();
  expect(panel.querySelectorAll('a').some(node => node.href === '/#skills')).toBe(true);
  await until(() => panel.querySelector('[data-runtime-input="call_timeout"]'));
  const timeout = panel.querySelector('[data-runtime-input="call_timeout"]'); timeout.value = '180';
  const save = panel.querySelector('.settings-runtime-save'), fetch = globalThis.fetch;
  let rejectSave, writes = 0;
  globalThis.fetch = (url, options) => {
    if (options?.body && JSON.parse(options.body).method === 'system.configure') {
      writes++; return new Promise((_, reject) => { rejectSave = reject; });
    }
    return fetch(url, options);
  };
  try {
    const saving = save.onclick(); await until(() => rejectSave);
    expect(save.textContent).toBe('保存中…'); expect(save.getAttribute('aria-busy')).toBe('true');
    expect(save.getAttribute('aria-disabled')).toBe('true'); await save.onclick(); expect(writes).toBe(1);
    rejectSave(new Error('controlled save failure')); await saving;
    expect(save.textContent).toBe('保存'); expect(save.getAttribute('aria-busy')).toBeNull();
    expect(save.getAttribute('aria-disabled')).toBeNull(); expect(timeout.value).toBe('180');
    expect(panel.querySelector('[data-runtime-error=""]').textContent).toContain('controlled save failure');
  } finally { globalThis.fetch = fetch; }
  await save.onclick(); expect(world.state.runtimeSettings.call_timeout.value).toBe(180);
  dom.location.hash = '#skills'; await dom.fire('hashchange');
  expect(panel.dataset.view).toBe('skills');
  expect(dom.node('skills-open').getAttribute('aria-current')).toBe('page');
  const report = panel.querySelector('input[data-runtime-input="result_notice"]');
  expect(report.checked).toBe(true);
  report.checked = false; await report.onchange();
  expect(world.state.runtimeSettings.result_notice.value).toBe(false);
  expect(world.state.actions.at(-1)).toMatchObject({ method: 'system.configure', params: { settings: { result_notice: false } } });
  expect(deepText(panel)).toContain('与 runtime 自动提醒独立');
  expect(panel.querySelectorAll('.skill-card')).toHaveLength(5);
  expect(panel.querySelectorAll('details').every(node => !node.open)).toBe(true);
  const page = panel.querySelector('.skills-page');
  await dom.fire('hashchange'); expect(panel.querySelector('.skills-page')).toBe(page);
  await panel.querySelector('button[data-capability-reset=""]').onclick();
  expect(world.state.runtimeSettings.result_notice.value).toBe(true);
  expect(report.checked).toBe(true);
  dom.location.hash = ''; await dom.fire('hashchange'); expect(panel.dataset.view).toBe('projects');
});
