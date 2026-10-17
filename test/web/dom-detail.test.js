import { test, expect, afterAll } from 'bun:test';
import { installDom, findByText } from './project-dom.js';
import { until } from '../helpers.js';
import { makeWorld } from './dom-world.js';

const world = makeWorld(), dom = installDom({ fetch: world.fetchImpl });
const { boot } = await import('../../src/ui/web/assets/app.js');
dom.node('side-nav').replaceChildren(); await boot();
afterAll(() => dom.restore());

test('Worker detail links its original Input and opens the execution reader on demand', async () => {
  dom.location.hash = '#worker-1'; await dom.fire('hashchange');
  const detail = dom.node('detail');
  await until(() => findByText(detail.querySelector('.head'), '输入 O1'));
  const input = findByText(detail.querySelector('.head'), '输入 O1');
  expect(input.tagName).toBe('A'); expect(input.getAttribute('href')).toBe('#input-input-1');
  expect(world.state.transcriptAfter).toEqual([]);
  expect(findByText(detail, '打开执行详情').target).toBe('_blank');
  dom.location.hash = '#worker-1-execution'; await dom.fire('hashchange');
  const panel = () => dom.document.body.querySelector('.transcript-dialog');
  await until(() => panel()?.querySelector('.steps')?.children.length === 5);
  expect([...panel().querySelector('.steps').children].map(node => node.dataset.seq)).toEqual(['5', '4', '3', '2', '1']);
  const list = panel().querySelector('.steps'); await dom.intervalFor(1500)();
  expect(panel().querySelector('.steps')).toBe(list);
  expect(findByText(panel(), '返回 Worker')).toBeNull();
  const reader = panel(); reader.onkeydown({ key: 'Escape', preventDefault() {} }); expect(panel()).toBe(reader);
  dom.location.hash = '#workers'; await dom.fire('hashchange'); expect(panel()).toBeNull();
});
