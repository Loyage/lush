import { test, expect, afterAll } from 'bun:test';
import { installDom, deepText } from '../dom-stub.js';
import { makeWorld } from './dom-world.js';
import { ui } from '../../src/ui/web/assets/state.js';
import { renderOverview } from '../../src/ui/web/assets/render-overview.js';
import { renderDetail } from '../../src/ui/web/assets/render-detail.js';

const world = makeWorld();
const dom = installDom({ fetch: world.fetchImpl });
const { boot } = await import('../../src/ui/web/assets/app.js');
dom.node('side-nav').replaceChildren();
await boot();
afterAll(() => dom.restore());

test('overview prioritizes decisions and delivery, then preserves expanded runtime on redraw', () => {
  const data = ui.lastSnapshot;
  data.notices = [{ id: 23, task_id: 1, status: 'open', title: '确认兼容方案' }];
  ui.overviewKey = null;
  renderOverview(data);
  const panel = dom.node('detail');
  expect(panel.dataset.view).toBe('overview');
  expect(panel.querySelectorAll('.metric').length).toBe(4);
  const text = deepText(panel);
  expect(text.indexOf('需要你的决定')).toBeLessThan(text.indexOf('交付队列'));
  expect(text.indexOf('交付队列')).toBeLessThan(text.indexOf('运行中的 agent'));
  const runtime = panel.querySelector('[data-fold="runtime"]');
  expect(runtime.open).toBe(false);
  runtime.open = true;
  ui.overviewKey = null;
  renderOverview(data);
  expect(panel.querySelector('[data-fold="runtime"]').open).toBe(true);
  expect(panel.querySelector('[data-fold="maintenance"]').open).toBe(false);
});

test('task goal becomes the page heading and results precede implementation metadata', () => {
  renderDetail({ id: 42, role: 'worker', status: 'completed', integration: 'none', calls: 0,
    goal: '更清晰的项目工作台', result: '已完成主题切换', deps: [], dependents: [] }, null, null, null);
  const panel = dom.node('detail');
  expect(panel.dataset.view).toBe('task');
  expect(panel.querySelector('h1').textContent).toBe('更清晰的项目工作台');
  const text = deepText(panel);
  expect(text.indexOf('已完成主题切换')).toBeLessThan(text.indexOf('调用次数'));
  expect(panel.querySelector('.breadcrumb')).toBeTruthy();
});

test('mobile index toggle exposes its expanded state and is reversible', async () => {
  const toggle = dom.node('sidebar-toggle');
  await toggle.onclick();
  expect(toggle.getAttribute('aria-expanded')).toBe('true');
  expect(dom.node('sidebar').classList.contains('mobile-open')).toBe(true);
  await toggle.onclick();
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  expect(dom.node('sidebar').classList.contains('mobile-open')).toBe(false);
});
