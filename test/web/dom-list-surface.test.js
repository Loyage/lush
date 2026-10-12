import { test, expect } from 'bun:test';
import { installDom } from '../dom-stub.js';
import { el } from '../../src/ui/web/assets/dom.js';
import { listEntry, listSurface } from '../../src/ui/web/assets/list-surface.js';

test('list chrome is opt-in and keeps links, controls, DOM identity and paging outside the body', () => {
  const dom = installDom();
  try {
    const root = el('section'), tools = el('form'), card = el('section'), heading = el('div'), body = el('ol'), pagination = el('div');
    const input = el('input'); input.value = '未提交关键词'; tools.append(input);
    const row = el('a', '输入 O1', 'input-row'); row.href = '#input-input-1'; body.append(row);
    card.append(heading, body); root.append(tools, card, pagination);
    const before = [...root.children];
    const surface = listSurface({ root, tools, card, heading, body, pagination });
    expect(surface.body).toBe(body); expect(root.children).toEqual(before);
    expect(input.value).toBe('未提交关键词'); expect(row.href).toBe('#input-input-1');
    expect(pagination.parentNode).toBe(root); expect(body.classList.contains('module-body')).toBe(false);
    expect(heading.classList.contains('ui-list-heading')).toBe(true);
    listSurface(surface); listEntry(row); listEntry(row);
    expect(body.children).toEqual([row]); expect(row.classList.contains('input-row')).toBe(true);
    expect(row.classList.contains('ui-list-entry')).toBe(true);
  } finally { dom.restore(); }
});

test('list entry decoration preserves the existing action and disabled state', async () => {
  const dom = installDom();
  try {
    const node = el('button', '查看记录'); let calls = 0;
    node.onclick = () => { calls++; }; node.disabled = true;
    expect(listEntry(node)).toBe(node); expect(node.disabled).toBe(true);
    node.disabled = false; await node.onclick(); expect(calls).toBe(1);
    expect(listSurface()).toEqual({ root: undefined, tools: undefined, card: undefined, heading: undefined, body: undefined, pagination: undefined });
  } finally { dom.restore(); }
});
