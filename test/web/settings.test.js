import { test, expect, afterAll } from 'bun:test';
import { installDom } from '../dom-stub.js';
import { makeWorld } from './dom-world.js';

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
  dom.location.hash = ''; await dom.fire('hashchange'); expect(panel.dataset.view).toBe('projects');
});
