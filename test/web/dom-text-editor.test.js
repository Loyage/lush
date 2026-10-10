import { test, expect, beforeEach, afterEach } from 'bun:test';
import { installDom } from '../dom-stub.js';
import { editorEvent, editorInput, editorSelection } from './text-editor-events.js';
import { attachTextEditor } from '../../src/ui/web/assets/text-editor.js';

let dom, textarea, controller, changes, inputs;
const undo = () => controller.controls.querySelectorAll('button')[0];
const redo = () => controller.controls.querySelectorAll('button')[1];
const key = props => editorEvent(textarea, 'keydown', { key: 'z', ctrlKey: true, ...props });
beforeEach(() => {
  dom = installDom(); textarea = document.createElement('textarea'); textarea.value = '初始正文';
  editorSelection(textarea, 1, 3, 'backward'); changes = inputs = 0;
  textarea.oninput = () => inputs++;
  controller = attachTextEditor(textarea, { onChange: () => changes++ });
  document.body.append(textarea, controller.controls);
});
afterEach(() => { controller.dispose(); dom.restore(); });

test('可见正文撤销/重做、按钮不提交也不调用 Agent，禁用帮助有键盘宿主', () => {
  expect(controller.controls.getAttribute('aria-label')).toBe('正文编辑');
  expect([undo().textContent, redo().textContent]).toEqual(['撤销', '重做']);
  expect(controller.controls.querySelector('.text-editor-undo')).toBe(undo());
  expect(controller.controls.querySelector('.text-editor-redo')).toBe(redo());
  for (const button of [undo(), redo()]) {
    expect(button.type).toBe('button'); expect(button.disabled).toBe(true);
    expect(button.classList.contains('agent-call')).toBe(false);
    expect(button.getAttribute('data-help')).toContain('不改变引用');
    expect(button.parentNode.className).toBe('help-host'); expect(button.parentNode.tabIndex).toBe(0);
    expect(button.parentNode.getAttribute('data-help')).toContain('没有可恢复');
  }
  undo().onclick(); redo().onclick(); expect(changes).toBe(0);
});

test('正文和选区完整往返，正常 input 不重复 onChange，按钮通知并归还焦点', () => {
  editorInput(textarea, '初新文', { start: 2 });
  expect(inputs).toBe(1); expect(changes).toBe(0); expect(undo().disabled).toBe(false);
  expect(undo().parentNode.tabIndex).toBe(-1);
  undo().onclick();
  expect(textarea.value).toBe('初始正文'); expect([textarea.selectionStart, textarea.selectionEnd, textarea.selectionDirection]).toEqual([1, 3, 'backward']);
  expect(changes).toBe(1); expect(inputs).toBe(1); expect(document.activeElement).toBe(textarea);
  redo().onclick(); expect(textarea.value).toBe('初新文'); expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([2, 2]);
  expect(changes).toBe(2); expect(redo().disabled).toBe(true);
});

test('Ctrl/⌘+Z、Ctrl/⌘+Shift+Z 与 Ctrl+Y 和按钮共用栈，阻止外层快捷键', () => {
  for (const modifier of ['ctrlKey', 'metaKey']) {
    controller.reset(); editorInput(textarea, '键盘编辑');
    const event = key({ ctrlKey: false, [modifier]: true });
    expect(event.defaultPrevented).toBe(true); expect(event.stopped).toBe(true); expect(textarea.value).not.toBe('键盘编辑');
    key({ ctrlKey: false, [modifier]: true, shiftKey: true }); expect(textarea.value).toBe('键盘编辑');
    undo().onclick(); key({ key: 'y' }); expect(textarea.value).toBe('键盘编辑');
    undo().onclick(); redo().onclick(); expect(textarea.value).toBe('键盘编辑');
    editorInput(textarea, '下一轮');
  }
  for (const props of [{ key: 'Enter' }, { key: 'z', ctrlKey: false }, { altKey: true }, { key: 'y', ctrlKey: false, metaKey: true }]) {
    expect(key(props).defaultPrevented).toBe(false);
  }
});

test('新编辑丢弃重做分支，粘贴、删除、换行和无 beforeinput 的 input 均记录', () => {
  editorInput(textarea, '初始正文\n粘贴段', { inputType: 'insertFromPaste' });
  editorInput(textarea, '初始正文\n', { inputType: 'deleteContentBackward' });
  undo().onclick(); expect(textarea.value).toBe('初始正文\n粘贴段');
  editorInput(textarea, '新分支', { inputType: 'insertLineBreak' }); expect(redo().disabled).toBe(true);
  redo().onclick(); expect(textarea.value).toBe('新分支');
  undo().onclick(); expect(textarea.value).toBe('初始正文\n粘贴段');
  editorSelection(textarea, 2); editorEvent(textarea, 'select');
  editorInput(textarea, '无 beforeinput', { beforeinput: false }); undo().onclick();
  expect(textarea.value).toBe('初始正文\n粘贴段'); expect(textarea.selectionStart).toBe(2);
  undo().onclick(); expect(textarea.value).toBe('初始正文');
});

test('IME 多个候选只形成一组，compositionend 前后最终 input 两种顺序兼容', async () => {
  for (const finalAfterEnd of [false, true]) {
    textarea.value = '原文'; editorSelection(textarea, 2); controller.reset();
    editorEvent(textarea, 'compositionstart');
    editorInput(textarea, '原文n', { isComposing: true, inputType: 'insertCompositionText' });
    editorInput(textarea, '原文ni', { isComposing: true, inputType: 'insertCompositionText' });
    expect(undo().disabled).toBe(true); expect(redo().disabled).toBe(true);
    const beforeChanges = changes; undo().onclick(); key();
    expect(textarea.value).toBe('原文ni'); expect(changes).toBe(beforeChanges);
    if (finalAfterEnd) editorEvent(textarea, 'compositionend');
    editorInput(textarea, '原文你', { inputType: finalAfterEnd ? 'insertText' : 'insertCompositionText', isComposing: !finalAfterEnd });
    if (!finalAfterEnd) editorEvent(textarea, 'compositionend');
    expect(undo().disabled).toBe(true); await Promise.resolve();
    undo().onclick(); expect(textarea.value).toBe('原文'); expect(undo().disabled).toBe(true);
    redo().onclick(); expect(textarea.value).toBe('原文你'); expect(redo().disabled).toBe(true);
  }
});

test('取消候选不造空历史，合成期间 reset/dispose 使延迟结束无效', async () => {
  editorEvent(textarea, 'compositionstart'); editorEvent(textarea, 'compositionend');
  await Promise.resolve(); expect(undo().disabled).toBe(true);
  editorEvent(textarea, 'compositionstart'); editorInput(textarea, '候选', { isComposing: true }); editorEvent(textarea, 'compositionend');
  textarea.value = ''; controller.reset(); await Promise.resolve(); expect(undo().disabled).toBe(true);
  editorEvent(textarea, 'compositionstart'); editorInput(textarea, '另一候选', { isComposing: true }); editorEvent(textarea, 'compositionend');
  controller.dispose(); await Promise.resolve(); expect(undo().disabled).toBe(true); expect(redo().disabled).toBe(true);
});

test('禁用、只读和 IME 键盘事件不执行，恢复可编辑后 sync 保留历史', () => {
  editorInput(textarea, '待保存');
  for (const field of ['disabled', 'readOnly']) {
    textarea[field] = true; controller.sync(); expect(undo().disabled).toBe(true);
    expect(undo().parentNode.getAttribute('data-help')).toContain('不可编辑');
    undo().onclick(); key(); expect(textarea.value).toBe('待保存');
    textarea[field] = false; controller.sync(); expect(undo().disabled).toBe(false);
  }
  key({ isComposing: true }); key({ keyCode: 229 }); expect(textarea.value).toBe('待保存');
  undo().onclick(); expect(textarea.value).toBe('初始正文');
});

test('移动端 native history beforeinput 和不可取消 input 回到同一个共享栈', () => {
  editorInput(textarea, '第一次'); editorInput(textarea, '第二次');
  const intent = editorEvent(textarea, 'beforeinput', { inputType: 'historyUndo' });
  expect(intent.defaultPrevented).toBe(true); expect(textarea.value).toBe('第一次');
  editorEvent(textarea, 'beforeinput', { inputType: 'historyRedo' }); expect(textarea.value).toBe('第二次');
  const previousInputs = inputs;
  editorEvent(textarea, 'beforeinput', { inputType: 'historyUndo', cancelable: false });
  textarea.value = '浏览器独立的原生历史'; editorEvent(textarea, 'input', { inputType: 'historyUndo' });
  expect(textarea.value).toBe('第一次'); expect(inputs).toBe(previousInputs);
  editorEvent(textarea, 'beforeinput', { inputType: 'historyRedo', cancelable: false });
  textarea.value = '错误的原生重做'; editorEvent(textarea, 'input', { inputType: 'historyRedo' });
  expect(textarea.value).toBe('第二次'); expect(changes).toBe(4);
});

test('reset 外部替换和已发送清空不允许复活旧正文，dispose 后停止操作与通知', () => {
  editorInput(textarea, '已发送正文'); textarea.value = ''; controller.reset();
  undo().onclick(); key(); expect(textarea.value).toBe(''); expect(changes).toBe(0);
  editorInput(textarea, '新正文'); textarea.value = '外部加载正文'; controller.reset();
  expect(undo().disabled).toBe(true); expect(redo().disabled).toBe(true);
  editorInput(textarea, '最后一次编辑'); controller.dispose(); controller.dispose();
  undo().onclick(); key(); editorInput(textarea, '关闭后输入'); expect(changes).toBe(0);
  expect(undo().disabled).toBe(true); expect(redo().disabled).toBe(true);
});

test('历史数量与快照内存有界，超大正文不截断用户文本', () => {
  textarea.value = '0'; controller.reset();
  for (let i = 1; i <= 120; i++) editorInput(textarea, String(i));
  for (let i = 0; i < 120; i++) undo().onclick();
  expect(textarea.value).toBe('20'); expect(undo().disabled).toBe(true);
  textarea.value = 'a'.repeat(32000); controller.reset();
  for (let i = 0; i < 40; i++) editorInput(textarea, String(i).padStart(32000, 'b'));
  const beforeChanges = changes; for (let i = 0; i < 100; i++) undo().onclick();
  expect(changes - beforeChanges).toBeLessThanOrEqual(16); expect(textarea.value.length).toBe(32000);
  const huge = '大'.repeat(1024 * 1024 + 1); editorInput(textarea, huge);
  expect(undo().disabled).toBe(true); expect(textarea.value).toBe(huge);
});
