import { test, expect, beforeEach, afterAll } from 'bun:test';
import { installDom, dialogButton, dialogText } from '../dom-stub.js';
const dom = installDom();
const { formDialog, confirmDialog, closeDialog } = await import('../../src/ui/web/assets/dialog.js');
const modal = () => dom.node('modal');
beforeEach(() => closeDialog());
afterAll(() => { closeDialog(); dom.restore(); });

test('async form locks duplicate/cancel/Esc/backdrop, retains failed draft and respects caller retry gate', async () => {
  const content = dom.document.createElement('div'), field = dom.document.createElement('input');
  field.value = '原编辑'; content.append(field);
  let calls = 0, release, allowed = true;
  const done = formDialog({ title: '共享设置', content, confirmLabel: '保存', canConfirm: () => allowed,
    onConfirm: () => { calls++; return new Promise(resolve => { release = resolve; }); } });
  const save = dialogButton(dom, '保存'), cancel = dialogButton(dom, '取消');
  const first = save.onclick(); expect(calls).toBe(1);
  expect(save.disabled).toBe(true); expect(cancel.disabled).toBe(true);
  expect(save.parentNode.dataset.help).toContain('请等待');
  await save.onclick(); await cancel.onclick();
  modal().onkeydown({ key: 'Escape', preventDefault() {} }); modal().onclick({ target: modal() });
  modal().onkeydown({ key: 'Tab', preventDefault() {} });
  expect(modal().hidden).toBe(false); expect(calls).toBe(1);
  allowed = false; release(false); await first;
  expect(modal().querySelector('input')).toBe(field); expect(field.value).toBe('原编辑');
  expect(save.disabled).toBe(true); expect(cancel.disabled).toBe(false);
  await save.onclick(); expect(calls).toBe(1);
  allowed = true; const second = save.onclick(); expect(calls).toBe(2);
  release(true); await second; expect(await done).toBe(true); expect(modal().hidden).toBe(true);
});

test('replacement/programmatic close settles old form, late confirmation cannot close new dialog or steal focus', async () => {
  let release;
  const first = formDialog({ title: '旧表单', onConfirm: () => new Promise(resolve => { release = resolve; }) });
  const pending = dialogButton(dom, '确定').onclick();
  const next = confirmDialog({ title: '新弹窗' }), focus = dom.document.activeElement;
  expect(await first).toBe(false); release(true); await pending;
  expect(dialogText(dom)).toContain('新弹窗'); expect(modal().hidden).toBe(false);
  expect(dom.document.activeElement).toBe(focus); expect(dialogButton(dom, '确定').disabled).toBe(false);
  closeDialog(); expect(await next).toBe(false);
});

test('throwing confirmation keeps fields and unlocks without exposing arbitrary errors', async () => {
  let calls = 0; const content = dom.document.createElement('input'); content.value = '保留内容';
  const done = formDialog({ title: '失败表单', content, onConfirm: async () => {
    if (++calls === 1) throw Error('secret credential=DO_NOT_RENDER'); return true;
  } });
  await dialogButton(dom, '确定').onclick();
  expect(modal().hidden).toBe(false); expect(content.value).toBe('保留内容');
  expect(dialogText(dom)).toContain('保存未完成'); expect(dialogText(dom)).not.toContain('DO_NOT_RENDER');
  expect(dialogButton(dom, '确定').disabled).toBe(false);
  await dialogButton(dom, '确定').onclick(); expect(await done).toBe(true);
});
