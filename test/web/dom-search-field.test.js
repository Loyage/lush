import { test, expect } from 'bun:test';
import { installDom, deepText } from '../dom-stub.js';
import { searchField } from '../../src/ui/web/assets/search-field.js';

const key = (control, extra = {}) => control.input.listeners.keydown[0]({ key: 'Enter', preventDefault() {}, ...extra });
test('shared field separates draft/applied, submits by Enter/button/form, and exposes range without a nested form', () => {
  const dom = installDom(), seen = [];
  try {
    const control = searchField({ label: '测试搜索', scope: '范围：已加载', onSubmit: value => seen.push(value) });
    const form = dom.document.createElement('form'); control.bindForm(form); form.append(control.root);
    expect(control.root.querySelector('form')).toBeNull(); expect(control.input.getAttribute('aria-describedby')).toBeTruthy();
    control.input.value = ' 未提交 '; control.input.listeners.input[0]();
    expect(control.applied).toBe(''); expect(seen).toEqual([]); expect(deepText(control.root)).toContain('尚未提交');
    key(control); expect(control.applied).toBe('未提交');
    control.input.value = '按钮'; control.submitButton.onclick();
    control.input.value = '表单'; form.onsubmit({ preventDefault() {} });
    expect(seen).toEqual(['未提交', '按钮', '表单']);
    control.clearButton.onclick(); expect(control.applied).toBe(''); expect(control.input.value).toBe('');
    expect(deepText(control.root)).toContain('范围：已加载');
  } finally { dom.restore(); }
});
test('IME confirmation never searches; Escape/native empty clears immediately without committing other drafts', () => {
  const dom = installDom(), seen = [];
  try {
    const control = searchField({ value: '原词', onSubmit: value => seen.push(value) });
    control.input.value = '候选'; control.input.listeners.compositionstart[0]();
    let blocked = false;
    key(control, { preventDefault() { blocked = true; } }); expect(blocked).toBe(false);
    control.submit({ type: 'submit', preventDefault() { blocked = true; } }); expect(blocked).toBe(true);
    expect(seen).toEqual([]); expect(control.applied).toBe('原词');
    control.input.listeners.compositionend[0](); key(control, { keyCode: 229 }); key(control, { isComposing: true });
    expect(seen).toEqual([]); key(control); expect(seen).toEqual(['候选']);
    key(control, { key: 'Escape' }); expect(control.applied).toBe('');
    control.setValue('恢复'); control.input.value = ''; control.input.listeners.input[0](); expect(control.applied).toBe('');
    expect(seen).toEqual(['候选', '', '']);
  } finally { dom.restore(); }
});
