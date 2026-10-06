import { test, expect } from 'bun:test';
import { installDom, deepText } from '../dom-stub.js';
import { renderDiff } from '../../src/ui/web/assets/render-diff.js';

test('改动概览默认只显示文件数与整体 +/-，文件明细收拢后按需展开', () => {
  const dom = installDom();
  try {
    const diff = {
      branch: 'lush/x', target_branch: 'main', base_commit: 'a'.repeat(40), head_commit: 'b'.repeat(40),
      committed: true, base_behind: null,
      added: 120, deleted: 45, pending_added: 3, pending_deleted: 1,
      files_total: 600, pending_total: 2,
      files: [{ path: 'src/a.js', added: 120, deleted: 45 }],
      pending: [{ path: 'src/b.js', code: 'M', added: 3, deleted: 1 }, { path: 'new.txt', code: '??', added: null, deleted: null }],
      commits: ['abc fix things'],
    };
    const section = renderDiff(diff, 7);
    const text = deepText(section);
    expect(text).toContain('改动概览');
    // 汇总行数取服务端在截断前计算的 added/deleted，而不是可见列表的条数。
    expect(text).toContain('600 个 · +120 −45');
    expect(text).toContain('2 个 · +3 −1');
    expect(text).toContain('abc fix things');

    const details = section.querySelector('.diff-files');
    expect(details.tagName).toBe('DETAILS');
    expect(details.open).not.toBe(true);
    expect(deepText(details)).toContain('展开文件明细（共 602 个文件 · +123 −46）');
    expect(deepText(details)).toContain('收起文件明细（共 602 个文件 · +123 −46）');
    // 明细列表仍在，只是由 <details> 默认收拢；展开后能看到逐文件行数与未提交标记。
    expect(details.querySelectorAll('.difflist')).toHaveLength(2);
    expect(deepText(details)).toContain('src/a.js');
    expect(deepText(details)).toContain('new.txt');
  } finally { dom.restore(); }
});

test('没有文件改动时不渲染可展开的文件明细', () => {
  const dom = installDom();
  try {
    const section = renderDiff({
      branch: 'lush/x', target_branch: 'main', base_commit: 'a', head_commit: null, committed: false,
      added: 0, deleted: 0, pending_added: 0, pending_deleted: 0, files_total: 0, pending_total: 0,
      files: [], pending: [], commits: [],
    }, 7);
    expect(section.querySelector('.diff-files')).toBeNull();
    expect(deepText(section)).toContain('改动概览');
  } finally { dom.restore(); }
});

test('没有工作区时仍显示提示而不是明细结构', () => {
  const dom = installDom();
  try {
    const section = renderDiff(null, 7);
    expect(section.querySelector('.diff-files')).toBeNull();
    expect(deepText(section)).toContain('尚无工作区');
  } finally { dom.restore(); }
});
