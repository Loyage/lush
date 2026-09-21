import { test, expect, afterAll } from 'bun:test';
import { installDom, dialogText, dialogButton, answerDialog } from '../dom-stub.js';

// 应用内弹窗：替代原生 confirm / prompt。原生版本会被浏览器或内嵌 webview 静默吃掉——不显示任何
// 东西、直接返回 false，用户看到的就是「点了没反应」。所以弹窗自己画在 #modal 里，而且确认、取消、
// Esc、点背景、输入框回车都必须真的把 Promise 收尾，不能有永远悬着的 await。
const dom = installDom({ fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }) });
const { confirmDialog, promptDialog, closeDialog } = await import('../../src/ui/web/assets/dialog.js');
const modal = () => dom.node('modal');

afterAll(() => dom.restore());

test('确认弹窗：打开才出现，确认与取消各自兑现，收尾后容器清空', async () => {
  // stub 不解析 index.html：这里补上那个容器的初始状态（真页面里就是 hidden 的空容器）。
  dom.node('modal').hidden = true;
  expect(modal().hidden).toBe(true);
  expect(modal().children).toHaveLength(0);

  const confirmed = confirmDialog({ title: '归档 lush/demo/1-one？', message: '会删除分支与 worktree。', confirmLabel: '归档', cancelLabel: '保留', danger: true });
  expect(modal().hidden).toBe(false);
  expect(dialogText(dom)).toContain('归档 lush/demo/1-one？');
  expect(dialogText(dom)).toContain('会删除分支与 worktree。');
  expect(dialogButton(dom, '归档').className).toContain('danger');
  await dialogButton(dom, '归档').onclick();
  expect(await confirmed).toBe(true);
  expect(modal().hidden).toBe(true);
  expect(modal().children).toHaveLength(0);

  const cancelled = confirmDialog({ title: '删吗？' });
  await dialogButton(dom, '取消').onclick();
  expect(await cancelled).toBe(false);
});

test('Esc 与点背景都是取消，点卡片内部不关', async () => {
  const escaped = confirmDialog({ title: 'Esc 收尾' });
  modal().onkeydown({ key: 'Escape', preventDefault() {} });
  expect(await escaped).toBe(false);

  const backdrop = confirmDialog({ title: '点背景' });
  modal().onclick({ target: modal() });
  expect(await backdrop).toBe(false);

  const inside = confirmDialog({ title: '点卡片' });
  modal().onclick({ target: dialogButton(dom, '确定') });
  expect(modal().hidden).toBe(false);
  closeDialog();
  expect(await inside).toBe(false);
});

test('输入弹窗：确认返回内容，输入框回车也提交，取消返回 null', async () => {
  const typed = promptDialog({ title: '驳回 #9 的拆解？', label: '驳回理由', placeholder: '例如：别动架构' });
  expect(dialogText(dom)).toContain('驳回理由');
  const input = modal().querySelector('input');
  expect(input).toBeTruthy();
  input.value = '别动架构，先加个开关';
  await dialogButton(dom, '确定').onclick();
  expect(await typed).toBe('别动架构，先加个开关');

  const entered = promptDialog({ title: '再驳一次' });
  const box = modal().querySelector('input');
  box.value = '回车提交';
  box.onkeydown({ key: 'Enter', preventDefault() {} });
  expect(await entered).toBe('回车提交');

  const empty = promptDialog({ title: '空输入也算答案' });
  await dialogButton(dom, '确定').onclick();
  expect(await empty).toBe('');

  const dropped = promptDialog({ title: '取消' });
  await dialogButton(dom, '取消').onclick();
  expect(await dropped).toBe(null);
});

test('焦点：确认键收到焦点，输入框优先；关闭后还给打开它的那个元素，Tab 不跑出弹窗', async () => {
  const opener = dom.document.createElement('button');
  opener.focus();
  const confirmed = confirmDialog({ title: '归档？' });
  expect(dom.document.activeElement).toBe(dialogButton(dom, '确定'));
  // Tab 在弹窗里转：不从「取消」溜到页面后面的东西上。
  modal().onkeydown({ key: 'Tab', preventDefault() {} });
  expect(dom.document.activeElement).toBe(dialogButton(dom, '取消'));
  modal().onkeydown({ key: 'Tab', preventDefault() {}, shiftKey: true });
  expect(dom.document.activeElement).toBe(dialogButton(dom, '确定'));
  await answerDialog(dom, '确定');
  expect(await confirmed).toBe(true);
  expect(dom.document.activeElement).toBe(opener);

  const typed = promptDialog({ title: '驳回理由' });
  expect(dom.document.activeElement).toBe(modal().querySelector('input'));
  closeDialog();
  await typed;
});

test('同一时刻只有一个弹窗：打开新的会把上一个按取消收尾', async () => {
  const first = confirmDialog({ title: '第一个' });
  const second = confirmDialog({ title: '第二个' });
  expect(await first).toBe(false);
  expect(dialogText(dom)).toContain('第二个');
  expect(dialogText(dom)).not.toContain('第一个');
  closeDialog();
  expect(await second).toBe(false);
});
