import { test, expect, afterAll } from 'bun:test';
import { installDom, deepText, allByTag } from '../dom-stub.js';
import { makeWorld, NOW, iso } from './dom-world.js';

// 全局常驻待决提醒条：与左栏「待我处理」同口径（status === "open"）汇总，任何页面可见，
// 点击进入 #notices 并定位最新一条；结算后计数下降，归零隐藏。
const world = makeWorld();
const dom = installDom({ fetch: world.fetchImpl });
const notice = (id, status, title, kind = 'question', taskId = 4) => ({ id, task_id: taskId, kind, title, body: '请回答', status, created_at: iso(NOW - id * 100) });
world.state.notices = [
  notice(8, 'answered', '已答复的问题'),
  notice(6, 'open', '计划待批', 'plan', 1),
  notice(9, 'open', '最新问题'),
];
const { boot } = await import('../../src/ui/web/assets/app.js');
dom.node('side-nav').replaceChildren();
await boot();
afterAll(() => dom.restore());

const banner = () => dom.node('notice-banner');
const bannerButton = () => banner().querySelector('.notice-banner-main');

test('提醒条汇总全部待决 notice，与左栏同口径；归零后 hidden 且清空', async () => {
  await dom.intervalFor(1500)();
  expect(banner().hidden).toBe(false);
  expect(deepText(banner())).toContain('2 条待你处理');
  expect(deepText(banner())).toContain('最新问题');
  // 同一规则：左栏「待我处理」计数也是 2。
  expect(dom.node('notice-count').textContent).toBe('2');

  // 只剩 answered 时归零：隐藏并清空，不残留旧标题。
  world.state.notices = [notice(8, 'answered', '已答复的问题')];
  await dom.intervalFor(1500)();
  expect(banner().hidden).toBe(true);
  expect(banner().children.length).toBe(0);
  expect(deepText(banner())).not.toContain('最新问题');
});

test('点击提醒条进入待我处理并定位最新一条', async () => {
  world.state.notices = [notice(8, 'answered', '已答复的问题'), notice(6, 'open', '计划待批', 'plan', 1), notice(9, 'open', '最新问题')];
  await dom.intervalFor(1500)();
  await bannerButton().onclick();
  expect(dom.location.hash).toBe('#notices');
  // 记录面板已定位并选中最新一条（id 9）。
  await dom.intervalFor(1500)();
  const selected = dom.node('notices').querySelectorAll('.notice-brief').find(row => row.classList.contains('selected'));
  expect(Number(selected?.dataset.id)).toBe(9);
  expect(deepText(dom.node('notice-record-detail'))).toContain('最新问题');
});

test('经 notice.answer / notice.dismiss 结算后计数下降，归零隐藏', async () => {
  world.state.notices = [notice(10, 'open', '问题十'), notice(11, 'open', '问题十一')];
  await dom.intervalFor(1500)();
  expect(deepText(banner())).toContain('2 条待你处理');
  expect(deepText(banner())).toContain('问题十一');

  // 打开最新一条，写答复 -> notice.answer 结算，计数降到 1。
  await bannerButton().onclick();
  dom.node('notice-record-detail').querySelector('textarea').value = '就这么办';
  const answer = allByTag(dom.node('notice-record-detail'), 'button').find(node => node.textContent === '回复并继续任务');
  await answer.onclick();
  expect(world.state.notices.find(row => row.id === 11).status).toBe('answered');
  expect(banner().hidden).toBe(false);
  expect(deepText(banner())).toContain('1 条待你处理');
  expect(deepText(banner())).toContain('问题十');

  // 再打开剩下这条并忽略 -> notice.dismiss 结算，归零隐藏。
  await bannerButton().onclick();
  const dismiss = allByTag(dom.node('notice-record-detail'), 'button').find(node => node.textContent === '忽略');
  await dismiss.onclick();
  expect(world.state.notices.find(row => row.id === 10).status).toBe('dismissed');
  expect(banner().hidden).toBe(true);
  expect(banner().children.length).toBe(0);
});
