import { test, expect, afterAll } from 'bun:test';
import { installDom } from '../dom-stub.js';
import { makeWorld } from './dom-world.js';

const world = makeWorld();
const dom = installDom({ fetch: world.fetchImpl });
const { boot } = await import('../../src/ui/web/assets/app.js');
const { ui } = await import('../../src/ui/web/assets/state.js');
await boot();
afterAll(() => dom.restore());

test('lazy pages announce destination immediately; late imports cannot reclaim a newer page', async () => {
  const first = dom.node('settings-open').onclick();
  expect(dom.node('detail').dataset.view).toBe('settings');
  expect(dom.location.hash).toBe('#settings');
  const second = dom.node('overview-open').onclick();
  await Promise.all([first, second]);
  expect(ui.view.id).toBe('overview');
  expect(dom.location.hash).toBe('');
  expect(dom.node('detail').querySelector('button.settings-tab')).toBeNull();
});

test('two pending page chunks settle only the newest navigation, including hash/back navigation', async () => {
  const first = dom.node('settings-open').onclick();
  const second = dom.node('versions-open').onclick();
  await Promise.all([first, second]);
  expect(ui.view.id).toBe('versions');
  expect(dom.location.hash).toBe('#versions');
  const third = dom.node('agent-status-open').onclick();
  dom.location.hash = '#workers';
  await dom.fire('hashchange'); await third;
  expect(ui.view.id).toBe('tasks');
  expect(dom.node('resource-panels').hidden).toBe(false);
});

test('replacement boot cancels old chunk navigation and rebuilds exactly one pair of timers/listener', async () => {
  const pending = dom.node('settings-open').onclick();
  dom.location.hash = '#workers';
  await boot(); await pending;
  expect(ui.view.id).toBe('tasks');
  expect(dom.location.hash).toBe('#workers');
  await boot();
  expect(ui.view.id).toBe('tasks');
  expect(typeof dom.intervalFor(1500)).toBe('function');
  expect(typeof dom.intervalFor(3000)).toBe('function');
  dom.location.hash = '#settings'; await dom.fire('hashchange');
  expect(ui.view.id).toBe('settings');
  expect(dom.node('detail').querySelector('button.settings-tab')).toBeTruthy();
});

test('a same-route hash event does not cancel a pending page and leave the loading canvas stranded', async () => {
  await dom.node('overview-open').onclick();
  const pending = dom.node('settings-open').onclick();
  await dom.fire('hashchange'); await pending;
  expect(ui.view.id).toBe('settings');
  expect(dom.node('detail').querySelector('button.settings-tab')).toBeTruthy();
});

test('boot awaits a lazy settings deep link before returning and supports a second DOM', async () => {
  dom.location.hash = '#settings';
  await boot();
  expect(dom.node('detail').querySelector('button.settings-tab')).toBeTruthy();
  const replacement = installDom({ fetch: world.fetchImpl });
  try {
    replacement.location.hash = '#settings';
    await boot();
    expect(replacement.node('detail').querySelector('button.settings-tab')).toBeTruthy();
    expect(typeof replacement.intervalFor(1500)).toBe('function');
    expect(typeof replacement.intervalFor(3000)).toBe('function');
  } finally { replacement.restore(); await boot(); }
});
