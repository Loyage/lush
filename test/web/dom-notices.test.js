import { test, expect, afterAll } from 'bun:test';
import { installDom, deepText } from '../dom-stub.js';
import { makeWorld, NOW, iso } from './dom-world.js';

// 计划审批（kind='plan'）不是问答 notice：它只在「历史输入」的意图行上批/驳。
// 回归点：概览「需要你的决定」曾把它列成一条「去处理 →」，但 openNotice 只认非 plan 的 notice，
// 点下去什么都不会发生；左栏「待定事项」与「只看待我处理」也必须与概览同一个口径。
const world = makeWorld();
const dom = installDom({ fetch: world.fetchImpl });
world.state.notices = [
  { id: 5, task_id: 4, kind: 'question', title: '普通问题', body: '', status: 'open', created_at: iso(NOW - 9000) },
  { id: 7, task_id: 1, kind: 'plan', title: '计划待批', body: '', status: 'open', created_at: iso(NOW - 8000) },
  { id: 8, task_id: 4, kind: 'question', title: '已答复的问题', body: '', status: 'answered', created_at: iso(NOW - 8500) },
];
const { boot } = await import('../../src/ui/web/assets/app.js');
dom.node('side-nav').replaceChildren();
await boot();
afterAll(() => dom.restore());

const tasks = () => dom.node('tasks').querySelectorAll('.goal').map(node => node.textContent);

test('plan notice 不进「待定事项」也不进概览「需要你的决定」，两处计数一致', async () => {
  await dom.intervalFor(1500)();
  // 左栏：只有非 plan 的 open notice 进索引
  expect(dom.node('notices').querySelectorAll('.notice-brief').map(node => Number(node.dataset.id))).toEqual([5]);
  expect(dom.node('notice-count').textContent).toBe('1');
  // 概览：同一条，且点得开（这条路径坏过一次，点 plan 那条是空动作）
  const panel = dom.node('detail');
  const rows = panel.querySelectorAll('.attention-item');
  expect(rows).toHaveLength(1);
  expect(deepText(rows[0])).toContain('普通问题');
  expect(deepText(panel)).not.toContain('计划待批');
  await rows[0].onclick();
  expect(dom.location.hash).toBe('#task-4');
});

test('「只看待我处理」不把 plan notice 算成待我处理', async () => {
  await dom.intervalFor(1500)();
  // #1 只有那条 plan notice；#2 / #3 是「已完成待批准合并」，本来就命中
  expect(tasks()).toEqual(['正在改点什么', '合并我', '另一个待合的']);
  const toggle = dom.node('task-filters').querySelector('.filter-toggle');
  toggle.checked = true;
  await toggle.listeners.change[0]();
  expect(tasks()).toEqual(['合并我', '另一个待合的']);
  toggle.checked = false;
  await toggle.listeners.change[0]();
});
