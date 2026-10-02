import { test, expect, afterAll } from 'bun:test';
import { repo } from '../helpers.js';
import { fetch as httpFetch, setup } from './harness.js';
import { installDom, deepText } from '../dom-stub.js';

// Drive the actual UI modules against the real temporary HTTP/RPC/SQLite/Git stack, not a permissive API mock.
let fixture;
const dom = installDom({ fetch: (url, options) => httpFetch(fixture.url + url, options) });
const { ui, resetUiState } = await import('../../src/ui/web/assets/state.js');
const { initComposer } = await import('../../src/ui/web/assets/composer.js');
const { openInputs } = await import('../../src/ui/web/assets/render-inputs.js');
const { registerNavigation } = await import('../../src/ui/web/assets/navigate.js');
const { setComposerReferences } = await import('../../src/ui/web/assets/context-references.js');
afterAll(() => dom.restore());
const root = () => dom.node('detail');
const btn = (label, host = root()) => host.querySelectorAll('button').find(node => node.textContent === label);

test('真实 API 串联：Enter 暂存、空筛选/正文检索、保存修订与仅创建、原文引用只读', async () => {
  fixture = await setup(); fixture.project.stopping = true; await repo(fixture.root);
  const restore = registerNavigation({ refresh: async () => {} });
  try {
    resetUiState(); dom.node('input').value = ''; dom.node('input-parent').value = '';
    await initComposer();
    const input = dom.node('input'); input.value = '真实接口想法 <img src=x>\n第二行'; input.oninput();
    setComposerReferences([{ version: 1, kind: 'text', target: {}, label: '引用快照', quote: '捕获时所见', location: {}, captured_at: '2026-10-02T00:00:00Z' }]);
    await input.onkeydown({ key: 'Enter', preventDefault() {} });
    expect(input.value).toBe('');
    expect(fixture.store.all("SELECT * FROM tasks WHERE task_kind='say'")).toHaveLength(0);
    await openInputs(); expect(root().querySelectorAll('.input-record')).toHaveLength(1);
    const form = root().querySelector('.inputs-filters');
    // Both selects default to empty: send no enum restriction, not invalid status='' / integration=''.
    await form.onsubmit({ preventDefault() {} });
    expect(deepText(root())).not.toContain('读取失败');
    form.querySelector('input').value = '第二行'; await form.onsubmit({ preventDefault() {} });
    expect(root().querySelectorAll('.input-record')).toHaveLength(1);
    const selects = form.querySelectorAll('select'); selects[0].value = 'draft'; await selects[0].onchange();
    expect(deepText(root())).not.toContain('读取失败');
    selects[0].value = ''; form.querySelector('input').value = ''; await form.onsubmit({ preventDefault() {} });
    await btn('编辑与发射').onclick();
    const panel = root().querySelector('.input-detail');
    expect(panel.querySelector('textarea').value).toContain('第二行');
    panel.querySelector('textarea').value = '已保存的最终输入';
    await btn('保存', panel).onclick(); expect(deepText(panel)).toContain('已保存。');
    const saved = fixture.store.all('SELECT * FROM drafts')[0]; expect(saved.revision).toBe(2);
    await btn('仅创建', panel).onclick(); expect(deepText(panel)).toContain('已创建·待开始');
    expect(fixture.store.all("SELECT * FROM tasks WHERE task_kind='say'")).toHaveLength(1);
    expect(fixture.store.all("SELECT * FROM tasks WHERE task_kind='say'")[0].status).toBe('paused');
    expect(root().querySelectorAll('.input-record')).toHaveLength(1);
    expect(root().querySelector('.input-record').dataset.input).toMatch(/^input:/);
    await btn('查看原文').onclick();
    expect(panel.querySelector('textarea')).toBe(null); expect(deepText(panel)).toContain('已保存的最终输入');
    expect(deepText(panel)).toContain('引用快照'); expect(deepText(panel)).toContain('捕获时所见');
    expect(root().querySelector('img')).toBe(null);
    expect(ui.composerSubmitting).toBe(false);
  } finally { restore(); await fixture.close(); }
});
