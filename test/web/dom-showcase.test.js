import { test, expect } from 'bun:test';
import { installDom, deepText, findByText, dialogText, answerDialog } from '../dom-stub.js';
import { startBranchShowcase, renderShowcase } from '../../src/ui/web/assets/render-showcase.js';
import { registerNavigation } from '../../src/ui/web/assets/navigate.js';
import { until } from '../helpers.js';

function setup() {
  const actions = [], details = [];
  const dom = installDom({ fetch: async (url, options) => {
    if (url === '/api/graph') return Response.json({ current_branch: 'main', nodes: [
      { kind: 'branch', name: 'feature', head_commit: 'abc', created_from_commit: 'def' },
      { kind: 'branch', name: 'main', head_commit: 'def' },
    ] });
    if (url === '/api/action') { actions.push(JSON.parse(options.body)); return Response.json({ id: 42 }); }
    throw new Error(`unexpected ${url}`);
  } });
  const restore = registerNavigation({ refresh: async () => {}, detail: async id => details.push(id) });
  return { dom, actions, details, close() { restore(); dom.restore(); } };
}

test('known fork uses confirmation and showcase.start, unknown local branch asks baseline, cancellation sends nothing', async () => {
  const f = setup();
  try {
    const known = startBranchShowcase('feature');
    await until(() => dialogText(f.dom).includes('展示 feature'));
    expect(dialogText(f.dom)).toContain('def');
    await answerDialog(f.dom, '开始效果展示'); await known;
    expect(f.actions).toEqual([{ method: 'showcase.start', params: { branch: 'feature', baseline: null } }]);
    expect(f.details).toEqual([42]);
    const unknown = startBranchShowcase('main');
    await until(() => dialogText(f.dom).includes('选择对比基线'));
    await answerDialog(f.dom, '下一步', 'feature');
    await until(() => dialogText(f.dom).includes('展示 main'));
    await answerDialog(f.dom, '开始效果展示'); await unknown;
    expect(f.actions.at(-1)).toEqual({ method: 'showcase.start', params: { branch: 'main', baseline: 'feature' } });
    const cancel = startBranchShowcase('feature');
    await until(() => dialogText(f.dom).includes('展示 feature'));
    await answerDialog(f.dom, '取消'); await cancel;
    expect(f.actions).toHaveLength(2);
  } finally { f.close(); }
});

test('showcase detail embeds sandboxed report, renders safe loopback preview, stops it and rejects malicious URLs', async () => {
  const f = setup();
  try {
    const task = { id: 42, status: 'completed', report: '/ignored/runtime/path', showcase: { branch: 'feature', commit: 'abc', baseline_commit: 'def',
      preview: { status: 'running', url: 'http://127.0.0.1:43210/demo' } } };
    const panel = renderShowcase(task);
    expect(deepText(panel)).toContain('展示完成 ≠ 检验通过');
    expect(panel.querySelector('iframe').getAttribute('sandbox')).toBe('allow-scripts');
    expect(panel.querySelector('iframe').src).toBe('/api/task/42/report');
    expect(findByText(panel, '打开可操作预览 ↗').rel).toBe('noopener noreferrer');
    await findByText(panel, '停止预览').onclick();
    expect(f.actions.at(-1)).toEqual({ method: 'showcase.stop', params: { id: 42 } });
    task.showcase.preview.url = 'javascript:alert(1)';
    expect(findByText(renderShowcase(task), '打开可操作预览 ↗')).toBeFalsy();
    task.showcase.preview = { status: 'stopped', url: null };
    expect(deepText(renderShowcase(task))).toContain('未运行');
    task.status = 'failed';
    const partial = renderShowcase(task);
    expect(deepText(partial)).toContain('中断前写入的未确认展示页');
    expect(partial.querySelector('iframe')).toBeTruthy();
    task.report = null;
    expect(deepText(renderShowcase(task))).toContain('未生成展示页');
  } finally { f.close(); }
});
