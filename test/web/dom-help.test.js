import { test, expect, afterAll } from 'bun:test';
import { installDom } from '../dom-stub.js';

// 统一按钮帮助提示（help.js）：悬停 / 聚焦 / 长按显示，Esc / 滚动 / 点别处关闭，
// aria-describedby 生命周期，空白文本忽略；长按判定用注入的假时钟，不靠真实 sleep。
const dom = installDom({ fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }) });
const help = await import('../../src/ui/web/assets/help.js');
const { initHelp, hideHelp, setHelpTimers, agentHelp, AGENT_NOTE } = help;

let clock = 0, nextId = 1;
const pending = new Map();
const fake = {
  setTimeout: (fn, ms) => { const id = nextId++; pending.set(id, { fn, at: clock + ms }); return id; },
  clearTimeout: id => { pending.delete(id); },
};
const advance = ms => {
  clock += ms;
  for (const [id, entry] of [...pending]) if (entry.at <= clock) { pending.delete(id); entry.fn(); }
};
setHelpTimers(fake);
initHelp();

const tip = () => dom.node('help-tip');
const makeButton = value => {
  const button = dom.document.createElement('button');
  button.textContent = '动作';
  button.setAttribute('data-help', value);
  dom.document.body.append(button);
  return button;
};

afterAll(() => { setHelpTimers(null); hideHelp(); dom.restore(); });

test('悬停显示提示并挂 aria-describedby，移出即隐藏并移除', async () => {
  hideHelp();
  const button = makeButton('保存当前设置');
  expect(tip().hidden).toBe(true);

  await dom.fire('pointerover', { target: button, pointerType: 'mouse' });
  expect(tip().hidden).toBe(false);
  expect(tip().textContent).toBe('保存当前设置');
  expect(tip().getAttribute('role')).toBe('tooltip');
  expect(button.getAttribute('aria-describedby')).toBe('help-tip');

  await dom.fire('pointerout', { target: button, pointerType: 'mouse', relatedTarget: null });
  expect(tip().hidden).toBe(true);
  expect(button.getAttribute('aria-describedby')).toBe(null);
});

test('键盘聚焦同样可见：focusin 显示、focusout 隐藏', async () => {
  hideHelp();
  const button = makeButton('按 Tab 也要看得到');
  await dom.fire('focusin', { target: button });
  expect(tip().hidden).toBe(false);
  expect(tip().textContent).toBe('按 Tab 也要看得到');
  await dom.fire('focusout', { target: button });
  expect(tip().hidden).toBe(true);
});

test('Esc / 滚动 / 点击别处都关闭提示', async () => {
  const button = makeButton('关闭方式');
  const show = async () => { await dom.fire('pointerover', { target: button, pointerType: 'mouse' }); expect(tip().hidden).toBe(false); };

  hideHelp(); await show();
  await dom.fire('keydown', { key: 'Escape' });
  expect(tip().hidden).toBe(true);

  await show();
  await dom.fire('scroll', {});
  expect(tip().hidden).toBe(true);

  await show();
  await dom.fire('click', { target: dom.document.body });
  expect(tip().hidden).toBe(true);
});

test('空白 data-help 不显示提示，也不挂 aria-describedby', async () => {
  hideHelp();
  const blank = makeButton('   ');
  await dom.fire('pointerover', { target: blank, pointerType: 'mouse' });
  expect(tip().hidden).toBe(true);
  expect(blank.getAttribute('aria-describedby')).toBe(null);
});

test('触屏长按 500ms 出现提示，触摸期间移开 / 提前松手都取消', async () => {
  hideHelp();
  const held = makeButton('长按查看');
  await dom.fire('touchstart', { target: held });
  advance(499);
  expect(tip().hidden).toBe(true);
  advance(1);
  expect(tip().hidden).toBe(false);
  expect(tip().textContent).toBe('长按查看');
  expect(held.getAttribute('aria-describedby')).toBe('help-tip');

  hideHelp();
  const moved = makeButton('移动取消');
  await dom.fire('touchstart', { target: moved });
  advance(200);
  await dom.fire('touchmove', { target: moved });
  advance(500);
  expect(tip().hidden).toBe(true);

  hideHelp();
  const lifted = makeButton('松手取消');
  await dom.fire('touchstart', { target: lifted });
  advance(200);
  await dom.fire('touchend', { target: lifted });
  advance(500);
  expect(tip().hidden).toBe(true);
});

test('长按后的第一次 click 被吃掉（不触发按钮、不关提示），再点才关闭', async () => {
  hideHelp();
  const button = makeButton('防误触');
  await dom.fire('touchstart', { target: button });
  advance(500);
  expect(tip().hidden).toBe(false);

  let prevented = false, stopped = false;
  await dom.fire('click', { target: button, preventDefault: () => { prevented = true; }, stopPropagation: () => { stopped = true; } });
  expect(prevented).toBe(true);
  expect(stopped).toBe(true);
  expect(tip().hidden).toBe(false);

  await dom.fire('click', { target: button });
  expect(tip().hidden).toBe(true);
});

test('agentHelp 统一追加 Agent 代价说明，空文本只给说明', () => {
  expect(agentHelp('提交后启动规划 Agent 拆解计划')).toBe(`提交后启动规划 Agent 拆解计划 ${AGENT_NOTE}`);
  expect(agentHelp('')).toBe(AGENT_NOTE);
  expect(agentHelp('   ')).toBe(AGENT_NOTE);
  expect(agentHelp(null)).toBe(AGENT_NOTE);
});
