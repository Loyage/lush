import { test, expect, afterAll } from 'bun:test';
import { installDom } from './project-dom.js';
import { makeWorld } from './dom-world.js';

const world = makeWorld(), dom = installDom({ fetch: world.fetchImpl });
const { boot } = await import('../../src/ui/web/assets/app.js');
dom.node('side-nav').replaceChildren(); await boot();
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
});
