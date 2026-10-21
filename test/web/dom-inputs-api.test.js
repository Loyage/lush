import { test, expect, afterAll } from 'bun:test';
import { repo } from '../helpers.js';
import { fetch as httpFetch, setup } from './harness.js';
import { installDom } from '../dom-stub.js';

let fixture;
const requests = [];
const dom = installDom({ fetch: (url, options) => { if (options?.body) requests.push(JSON.parse(options.body)); return httpFetch(fixture.url + url, options); } });
const { resetUiState } = await import('../../src/ui/web/assets/state.js');
const { initComposer } = await import('../../src/ui/web/assets/composer.js');
const { openInputs } = await import('../../src/ui/web/assets/render-inputs.js');
const { selectComposerMode, resumeComposerDraft, currentEdit, collapseComposer } = await import('../../src/ui/web/assets/composer-workspace.js');
const { action } = await import('../../src/ui/web/assets/api.js');
const { loadDetail } = await import('../../src/ui/web/assets/detail.js');
const { registerNavigation } = await import('../../src/ui/web/assets/navigate.js');
afterAll(() => dom.restore());

test('real detail DOM submits an explicit append through HTTP/RPC and returns composer to create mode', async () => {
  fixture = await setup(); fixture.project.stopping = true; await repo(fixture.root);
  const restore = registerNavigation({ refresh: async () => {}, detail: async () => {} });
  try {
    dom.localStorage.clear(); resetUiState(); dom.node('input').value = ''; dom.node('input-parent').value = ''; await initComposer();
    const { task } = await fixture.project.order('初始要求', 'main', [], null, false);
    await loadDetail(task.id);
    expect(dom.node('input-form').dataset.mode).toBe('create');
    const append = dom.node('detail').querySelectorAll('button').find(node => node.textContent === '追加输入');
    append.onclick();
    expect(dom.node('composer-mode-target').textContent).toContain(task.worker_number);
    const input = dom.node('input'); input.value = '后续要求'; input.oninput();
    await input.onkeydown({ key: 'Enter', preventDefault() { throw Error('Enter must only insert a newline'); } });
    await input.onkeydown({ key: 's', ctrlKey: true, repeat: true, preventDefault() {} });
    expect(fixture.store.all('SELECT * FROM drafts')).toHaveLength(0);
    await input.onkeydown({ key: 's', metaKey: true, preventDefault() {} });
    expect(input.value).toBe('');
    expect(fixture.store.all('SELECT * FROM drafts')).toHaveLength(1);
    expect(fixture.store.all('SELECT * FROM inputs')).toHaveLength(1); // Saving does not authorize the append.
    await resumeComposerDraft();
    await input.onkeydown({ key: 'Enter', ctrlKey: true, preventDefault() {} });
    expect(fixture.store.all('SELECT * FROM drafts')).toHaveLength(1);
    expect(input.value).toBe(''); expect(dom.node('input-form').dataset.mode).toBe('create');
    expect(fixture.store.all('SELECT * FROM agent_runs')).toHaveLength(0);
  } finally { restore(); await fixture.close(); }
});

test('real composer resumes, updates and emits an order draft through HTTP/RPC and SQLite', async () => {
  fixture = await setup(); fixture.project.stopping = true; await repo(fixture.root);
  const restore = registerNavigation({ refresh: async () => {} });
  try {
    dom.localStorage.clear(); fixture.project.kick = () => {}; fixture.project.scheduleInputEmissions = () => {};
    const refs = [{ version: 1, kind: 'text', target: {}, label: '快照', quote: '引用原文', location: {}, captured_at: '2026-01-01T00:00:00.000Z' }];
    const draft = await action('draft.add', { content: '原始暂存', references: refs, branch: 'main' }, { refresh: false });
    resetUiState(); dom.node('input').value = ''; dom.node('input-parent').value = ''; await initComposer();
    selectComposerMode('order'); requests.length = 0;
    const input = dom.node('input');
    await input.onkeydown({ key: 'ArrowUp', preventDefault() {} });
    expect(currentEdit().saved).toMatchObject({ id: draft.id, revision: 1, references: refs });
    input.value = '原位续写后的正文'; input.oninput();
    collapseComposer(); expect(requests).toHaveLength(0);
    resetUiState(); input.value = ''; dom.node('input-parent').value = ''; await initComposer();
    dom.node('composer-launcher').click();
    dom.node('composer-pending-order').querySelectorAll('button').find(row => row.dataset.editKey === `draft:${draft.id}`).click();
    expect(input.value).toBe('原位续写后的正文');
    await input.onkeydown({ key: 's', ctrlKey: true, preventDefault() {} }); expect(input.value).toBe('');
    expect(fixture.store.draft(draft.id).content).toBe('原位续写后的正文');
    await openInputs({ item: { kind: 'draft', id: draft.id } });
    const panel = dom.node('detail').querySelector('.input-detail'), body = panel.querySelector('textarea');
    const key = options => panel.onkeydown({ preventDefault() {}, ...options });
    body.value += '！'; body.oninput();
    await key({ key: 'Enter' });
    await key({ key: 'Enter', ctrlKey: true, isComposing: true });
    await key({ key: 'Enter', metaKey: true, repeat: true });
    expect(requests.some(request => request.method === 'input.emit')).toBe(false);
    await key({ key: 's', metaKey: true });
    expect(fixture.store.draft(draft.id).revision).toBe(3);
    expect(body.value).toBe('原位续写后的正文！');
    body.value += '最终'; body.oninput();
    await key({ key: 'Enter', ctrlKey: true });
    expect(requests.find(request => request.method === 'input.emit').params).toMatchObject({ draft_id: draft.id, expected_revision: 4 });
    fixture.project.stopping = false; await fixture.project.drainInputEmissions(); fixture.project.stopping = true;
    const receipt = fixture.project.inputGet('draft', draft.id); expect(receipt.dispatch.state).toBe('succeeded');
    expect(fixture.store.all('SELECT * FROM inputs WHERE content=?', '原位续写后的正文！最终')).toHaveLength(1);
    expect(fixture.project.inputGet('input', receipt.input_id).references[0].quote).toBe('引用原文');
    expect(fixture.store.all('SELECT * FROM agent_runs')).toHaveLength(0);
  } finally { restore(); await fixture.close(); }
});
