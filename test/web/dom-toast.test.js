import { test, expect, afterAll } from 'bun:test';
import { installDom } from '../dom-stub.js';
import { makeWorld } from './dom-world.js';

// 顶部消息提示（messages.js）：出现 / 按类型自动消失 / 手动关闭 / 同文本不重置计时 / 悬停暂停。
// 计时器换成假时钟，按需推进时间——不靠真实 sleep 拖慢套件。
const world = makeWorld();
const dom = installDom({ fetch: world.fetchImpl });
const { show, clear, setTimers } = await import('../../src/ui/web/assets/messages.js');

let clock = 0, nextId = 1;
const pending = new Map();
const fake = {
  setTimeout: (fn, ms) => { const id = nextId++; pending.set(id, { fn, at: clock + ms }); return id; },
  clearTimeout: id => { pending.delete(id); },
  now: () => clock,
};
const advance = ms => {
  clock += ms;
  for (const [id, entry] of [...pending]) if (entry.at <= clock) { pending.delete(id); entry.fn(); }
};
setTimers(fake);

const { boot } = await import('../../src/ui/web/assets/app.js');
dom.node('side-nav').replaceChildren();
await boot();

afterAll(() => { setTimers(null); dom.restore(); });

test('消息浮层：显示、信息类 4s 自动消失、错误类 8s 且可手动关闭', () => {
  clear();
  show('已保存');
  expect(dom.node('error').textContent).toBe('已保存');
  expect(dom.node('toast').hidden).toBe(false);
  expect(dom.node('toast').classList.contains('toast-error')).toBe(false);
  expect(dom.node('toast').getAttribute('role')).toBe('status');
  expect(dom.node('toast-close').hidden).toBe(true);

  advance(3999);
  expect(dom.node('toast').hidden).toBe(false);
  advance(1);
  expect(dom.node('toast').hidden).toBe(true);
  expect(dom.node('error').textContent).toBe('');

  show('对话失败', 'error');
  expect(dom.node('toast').classList.contains('toast-error')).toBe(true);
  expect(dom.node('toast').getAttribute('role')).toBe('alert');
  expect(dom.node('toast-close').hidden).toBe(false);
  advance(7999);
  expect(dom.node('toast').hidden).toBe(false);
  advance(1);
  expect(dom.node('toast').hidden).toBe(true);

  // 手动关闭：立即消失，之后也不会被旧计时器翻出来
  show('又失败了', 'error');
  dom.node('toast-close').onclick();
  expect(dom.node('toast').hidden).toBe(true);
  expect(dom.node('error').textContent).toBe('');
  advance(10000);
  expect(dom.node('toast').hidden).toBe(true);
});

test('同一文本反复写入不重置计时，新文本会重新计时', () => {
  clear();
  show('离线了', 'error');
  advance(7000);
  show('离线了', 'error');   // 轮询又报同一条：不该重新计满 8s
  advance(999);
  expect(dom.node('toast').hidden).toBe(false);
  advance(1);
  expect(dom.node('toast').hidden).toBe(true);

  show('第一条');
  advance(2000);
  show('第二条');            // 文本变了：计满 4s
  advance(2000);
  expect(dom.node('toast').hidden).toBe(false);
  advance(2000);
  expect(dom.node('toast').hidden).toBe(true);
});

test('悬停在浮层上暂停倒计时，离开后按剩余时间继续', () => {
  clear();
  show('处理中', 'error');
  advance(3000);
  dom.node('toast').onmouseenter();
  advance(20000);
  expect(dom.node('toast').hidden).toBe(false);
  dom.node('toast').onmouseleave();
  advance(4999);
  expect(dom.node('toast').hidden).toBe(false);
  advance(1);
  expect(dom.node('toast').hidden).toBe(true);
});

test('空文本立即隐藏且不留内容', () => {
  show('有内容');
  expect(dom.node('toast').hidden).toBe(false);
  show('');
  expect(dom.node('toast').hidden).toBe(true);
  expect(dom.node('error').textContent).toBe('');
});
