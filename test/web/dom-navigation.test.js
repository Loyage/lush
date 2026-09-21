import { test, expect, afterAll } from 'bun:test';
import { installDom, deepText } from '../dom-stub.js';
import { makeWorld } from './dom-world.js';

const world = makeWorld();
const dom = installDom({ fetch: world.fetchImpl });
const { boot } = await import('../../src/ui/web/assets/app.js');
dom.node('side-nav').replaceChildren();
await boot();
afterAll(() => dom.restore());

test('左栏只做导航：任务索引在右侧成为独立页面，任务详情与浏览器后退仍可往返', async () => {
  const taskNav = dom.node('side-nav').querySelector('[data-side="tasks"]');
  await taskNav.onclick();

  expect(dom.location.hash).toBe('#tasks');
  expect(dom.node('resource-panels').hidden).toBe(false);
  expect(dom.node('detail').hidden).toBe(true);
  expect(dom.node('side-tasks').hidden).toBe(false);
  expect(dom.node('side-notices').hidden).toBe(true);
  expect(dom.node('view-title').textContent).toBe('行动任务');
  expect(dom.node('tasks').querySelector('[data-id="1"]')).toBeTruthy();

  await dom.node('tasks').querySelector('[data-id="1"]').onclick();
  expect(dom.location.hash).toBe('#task-1');
  expect(dom.node('resource-panels').hidden).toBe(true);
  expect(dom.node('detail').hidden).toBe(false);
  expect(dom.node('view-title').textContent).toBe('任务 #1');

  // 用 hashchange 模拟浏览器后退：回到任务页，而不是把任务列表塞回左栏。
  dom.location.hash = '#tasks';
  await dom.fire('hashchange');
  expect(dom.node('resource-panels').hidden).toBe(false);
  expect(dom.node('side-tasks').hidden).toBe(false);
  expect(dom.node('detail').hidden).toBe(true);
});

test('右侧固定返回按钮在没有原生 history.back 的宿主里安全回落到概览', async () => {
  await dom.node('side-nav').querySelector('[data-side="intents"]').onclick();
  expect(dom.node('view-title').textContent).toBe('历史输入');
  await dom.node('view-back').onclick();
  expect(dom.node('detail').hidden).toBe(false);
  expect(dom.node('resource-panels').hidden).toBe(true);
  expect(dom.node('detail').dataset.view).toBe('overview');
  expect(deepText(dom.node('detail'))).toContain('项目概览');
});
