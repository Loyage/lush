import { test, expect, afterAll } from 'bun:test';
import { installDom } from '../dom-stub.js';

// 统一按钮帮助提示（help.js）：持续悬停 / 键盘持续聚焦 / 长按显示，Esc / 滚动 / 点别处关闭，
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

afterAll(() => { hideHelp(); setHelpTimers(null); dom.restore(); });

test('悬停 1200ms 才显示提示并挂 aria-describedby，移出即隐藏并移除', async () => {
  hideHelp();
  const button = makeButton('保存当前设置');
  expect(tip().hidden).toBe(true);

  await dom.fire('pointerover', { target: button, pointerType: 'mouse' });
  advance(1199);
  expect(tip().hidden).toBe(true);
  advance(1);
  expect(tip().hidden).toBe(false);
  expect(tip().textContent).toBe('保存当前设置');
  expect(tip().getAttribute('role')).toBe('tooltip');
  expect(button.getAttribute('aria-describedby')).toBe('help-tip');

  await dom.fire('pointerout', { target: button, pointerType: 'mouse', relatedTarget: null });
  expect(tip().hidden).toBe(true);
  expect(button.getAttribute('aria-describedby')).toBe(null);
});

test('键盘持续聚焦同样可见：延迟显示、focusout 隐藏', async () => {
  hideHelp();
  const button = makeButton('按 Tab 也要看得到');
  await dom.fire('keydown', { key: 'Tab' });
  await dom.fire('focusin', { target: button });
  advance(1199); expect(tip().hidden).toBe(true);
  advance(1); expect(tip().hidden).toBe(false);
  expect(tip().textContent).toBe('按 Tab 也要看得到');
  await dom.fire('focusout', { target: button });
  expect(tip().hidden).toBe(true);
});

test('Esc / 滚动 / 点击别处都关闭提示', async () => {
  const button = makeButton('关闭方式');
  const show = async () => { await dom.fire('pointerover', { target: button, pointerType: 'mouse' }); advance(1200); expect(tip().hidden).toBe(false); };

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

test('触屏长按 650ms 出现提示，触摸期间移开 / 提前松手都取消', async () => {
  hideHelp();
  const held = makeButton('长按查看');
  await dom.fire('touchstart', { target: held });
  advance(649);
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
  advance(650);
  expect(tip().hidden).toBe(false);

  let prevented = false, stopped = false;
  await dom.fire('click', { target: button, preventDefault: () => { prevented = true; }, stopPropagation: () => { stopped = true; } });
  expect(prevented).toBe(true);
  expect(stopped).toBe(true);
  expect(tip().hidden).toBe(false);

  await dom.fire('click', { target: button });
  expect(tip().hidden).toBe(true);
});

test('掠过、普通点击和点击聚焦均不会显示，点击不被阻止', async () => {
  hideHelp();
  const button = makeButton('复杂操作');
  await dom.fire('pointerover', { target: button, pointerType: 'mouse' });
  advance(300);
  await dom.fire('pointerout', { target: button, relatedTarget: null });
  advance(1500); expect(tip().hidden).toBe(true);

  await dom.fire('pointerover', { target: button, pointerType: 'mouse' });
  await dom.fire('pointerdown', { target: button, pointerType: 'mouse', button: 0 });
  await dom.fire('focusin', { target: button });
  advance(100);
  await dom.fire('pointerup', { target: button });
  let prevented = false;
  await dom.fire('click', { target: button, preventDefault: () => { prevented = true; } });
  advance(2000);
  expect(tip().hidden).toBe(true); expect(prevented).toBe(false);
});

test('长按鼠标同样只读帮助，按住很久后松手不执行按钮', async () => {
  hideHelp();
  const button = makeButton('长按鼠标');
  await dom.fire('pointerdown', { target: button, pointerType: 'mouse', button: 0, clientX: 10, clientY: 10 });
  advance(649); expect(tip().hidden).toBe(true);
  advance(1); expect(tip().hidden).toBe(false);
  advance(5000);
  await dom.fire('pointerup', { target: button });
  let prevented = false;
  await dom.fire('click', { target: button, preventDefault: () => { prevented = true; } });
  expect(prevented).toBe(true); expect(tip().hidden).toBe(false);
  hideHelp();
  await dom.fire('pointerdown', { target: button, button: 0, clientX: 10, clientY: 10 });
  await dom.fire('pointermove', { target: button, clientX: 30, clientY: 10 });
  advance(2000); expect(tip().hidden).toBe(true);
});

test('长按菜单事件不放行随后 click，且不误吞其他按钮点击', async () => {
  hideHelp();
  const button = makeButton('长按菜单');
  await dom.fire('touchstart', { target: button }); advance(650);
  let menuPrevented = false, clickPrevented = false;
  await dom.fire('contextmenu', { target: button, preventDefault: () => { menuPrevented = true; } });
  await dom.fire('touchend', { target: button });
  await dom.fire('click', { target: button, preventDefault: () => { clickPrevented = true; } });
  expect(menuPrevented).toBe(true); expect(clickPrevented).toBe(true);
  hideHelp();
  await dom.fire('touchstart', { target: button }); advance(650);
  await dom.fire('touchend', { target: button });
  let otherPrevented = false;
  await dom.fire('click', { target: dom.document.body, preventDefault: () => { otherPrevented = true; } });
  expect(otherPrevented).toBe(false); expect(tip().hidden).toBe(true);
});

test('离焦、取消、滚动、Esc、导航和重新装配清理未触发计时器', async () => {
  const button = makeButton('不残留');
  for (const event of ['focusout', 'pointercancel', 'scroll', 'keydown']) {
    hideHelp();
    await dom.fire('pointerover', { target: button, pointerType: 'mouse' });
    advance(200);
    await dom.fire(event, { key: 'Escape', target: button });
    advance(2000); expect(tip().hidden).toBe(true);
  }
  await dom.fire('pointerover', { target: button });
  hideHelp(); advance(2000); expect(tip().hidden).toBe(true);
  await dom.fire('pointerover', { target: button });
  initHelp(); advance(2000); expect(tip().hidden).toBe(true);
});

test('宿主内部移动不重复等待，禁用按钮的外层与原有 aria 描述仍可用', async () => {
  hideHelp();
  const host = dom.document.createElement('span'); host.setAttribute('data-help', '当前不可用的原因');
  const button = dom.document.createElement('button'); button.disabled = true; host.append(button);
  host.setAttribute('aria-describedby', 'existing'); dom.document.body.append(host);
  await dom.fire('pointerover', { target: host, pointerType: 'mouse' }); advance(700);
  await dom.fire('pointerout', { target: host, relatedTarget: button });
  await dom.fire('pointerover', { target: button, relatedTarget: host }); advance(500);
  expect(tip().hidden).toBe(false); expect(tip().textContent).toBe('当前不可用的原因');
  hideHelp(); expect(host.getAttribute('aria-describedby')).toBe('existing');
});

test('agentHelp 统一追加 Agent 代价说明，空文本只给说明', () => {
  expect(agentHelp('提交后启动规划 Agent 拆解计划')).toBe(`提交后启动规划 Agent 拆解计划 ${AGENT_NOTE}`);
  expect(agentHelp('')).toBe(AGENT_NOTE);
  expect(agentHelp('   ')).toBe(AGENT_NOTE);
  expect(agentHelp(null)).toBe(AGENT_NOTE);
});
