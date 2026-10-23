import { test, expect, afterAll } from 'bun:test';
import { installDom } from './project-dom.js';
import { makeWorld } from './dom-world.js';

const world = makeWorld(), deviceReads = [];
const dom = installDom({ fetch: (url, options) => {
  if (String(url).startsWith('/api/host/device-valet/')) {
    deviceReads.push({ url: String(url), method: options?.method || 'GET' });
    if (String(url).endsWith('/options')) return Response.json({ version: 1, default_profile: null, connections: [], registered_models: [] });
    if (String(url).endsWith('/status')) return Response.json({ version: 1, online: false, active: 0 });
    throw Error('navigation must not submit device work');
  }
  return world.fetchImpl(url, options);
} });
const { boot } = await import('../../src/ui/web/assets/app.js');
dom.node('device-valet-open').tagName = 'A'; dom.node('side-nav').replaceChildren(); await boot();
afterAll(() => dom.restore());

test('project Worker list, detail and browser back navigate between independent pages', async () => {
  await dom.node('side-nav').querySelector('[data-side="tasks"]').onclick();
  expect(dom.location.hash).toBe('#workers'); expect(dom.node('resource-panels').hidden).toBe(false);
  expect(dom.node('view-title').textContent).toBe('工作列表');
  await dom.node('tasks').querySelector('[data-id="1"]').onclick();
  expect(dom.location.hash).toBe('#worker-1'); expect(dom.node('detail').hidden).toBe(false);
  expect(dom.node('view-title').textContent).toBe('Worker #1');
  dom.location.hash = '#workers'; await dom.fire('hashchange');
  expect(dom.node('side-tasks').hidden).toBe(false); expect(dom.node('detail').hidden).toBe(true);
  expect(dom.node('device-valet-open').href).toBe('/#device-valet');
  expect(dom.node('device-valet-open').target).toBe('_blank');
  dom.location.hash = '#device-valet'; await dom.fire('hashchange');
  expect(dom.node('view-title').textContent).toBe('此页面已移至用户工作台');
  expect(dom.node('detail').querySelector('a').href).toBe('/#device-valet'); expect(deviceReads).toHaveLength(0);
  dom.location.pathname = '/'; await boot();
  expect(dom.node('view-title').textContent).toBe('设备管家');
  expect(dom.node('detail').querySelector('.device-valet-page')).toBeTruthy();
  expect(deviceReads.map(row => row.method)).toEqual(['GET', 'GET']);
});
