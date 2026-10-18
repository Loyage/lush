import { test, expect, afterAll } from 'bun:test';
import { repo } from '../helpers.js';
import { fetch as httpFetch, setup } from './harness.js';
import { installDom } from '../dom-stub.js';

let fixture;
const requests = [];
const dom = installDom({ fetch: (url, options) => { if (options?.body) requests.push(JSON.parse(options.body)); return httpFetch(fixture.url + url, options); } });
const { resetUiState } = await import('../../src/ui/web/assets/state.js');
const { initComposer, buffer } = await import('../../src/ui/web/assets/composer.js');
const { selectComposerMode, resumeComposerDraft, currentEdit, collapseComposer } = await import('../../src/ui/web/assets/composer-workspace.js');
const { action } = await import('../../src/ui/web/assets/api.js');
const { loadDetail } = await import('../../src/ui/web/assets/detail.js');
const { registerNavigation } = await import('../../src/ui/web/assets/navigate.js');
afterAll(() => dom.restore());

test('real detail DOM submits an explicit append through HTTP/RPC and returns composer to create mode', async () => {
  fixture = await setup(); fixture.project.stopping = true; await repo(fixture.root);
  const restore = registerNavigation({ refresh: async () => {}, detail: loadDetail });
  try {
    resetUiState(); dom.node('input').value = ''; dom.node('input-parent').value = ''; await initComposer();
    const { task } = await fixture.project.order('初始要求', 'main', [], null, false);
    await loadDetail(task.id);
    expect(dom.node('input-form').dataset.mode).toBe('create');
    const append = dom.node('detail').querySelectorAll('button').find(node => node.textContent === '追加输入');
    append.onclick();
    expect(dom.node('composer-mode-target').textContent).toContain(task.worker_number);
    const input = dom.node('input'); input.value = '后续要求'; input.oninput();
    await input.onkeydown({ key: 'Enter', ctrlKey: true, preventDefault() {} });
    const drafts = fixture.store.all('SELECT * FROM drafts'); expect(drafts).toHaveLength(1);
    expect(input.value).toBe(''); expect(dom.node('input-form').dataset.mode).toBe('create');
    expect(fixture.store.all('SELECT * FROM agent_runs')).toHaveLength(0);
  } finally { restore(); await fixture.close(); }
});

for (const mode of ['order', 'append']) test(`real floating composer resumes, updates and emits one ${mode} draft via HTTP/RPC permissions and SQLite`, async () => {
  fixture = await setup(); fixture.project.stopping = true; await repo(fixture.root);
  const restore = registerNavigation({ refresh: async () => {} });
  try {
    // Disable automatic scheduling, not the real authorization or dispatch path. No model is called.
    fixture.project.kick = () => {}; fixture.project.scheduleInputEmissions = () => {};
    const worker = mode === 'append' ? (await fixture.project.order('追加目标', 'main', [], null, false)).task : null;
    const refs = mode === 'order' ? [{ version: 1, kind: 'text', target: {}, label: '快照', quote: '引用原文', location: {}, captured_at: '2026-01-01T00:00:00.000Z' }] : [];
    const draft = await action('draft.add', { content: '原始暂存', references: refs, ...(worker ? { mode, target_id: worker.id } : { branch: 'main' }) }, { refresh: false });
    resetUiState(); dom.node('input').value = ''; dom.node('input-parent').value = ''; await initComposer();
    selectComposerMode(mode, worker); await resumeComposerDraft();
    expect(currentEdit().saved).toMatchObject({ id: draft.id, revision: 1, references: refs });
    const input = dom.node('input'); input.value = '原位续写后的正文'; input.oninput(); requests.length = 0;
    collapseComposer(); expect(requests).toHaveLength(0); // Automatic save is browser-only, not an RPC or authorization.
    resetUiState(); input.value = ''; dom.node('input-parent').value = ''; await initComposer(); selectComposerMode(mode, worker);
    expect(input.value).toBe('原位续写后的正文'); expect(currentEdit().saved.id).toBe(draft.id);
    await buffer(); expect(input.value).toBe(''); expect(currentEdit().saved).toBeNull();
    expect(fixture.store.draft(draft.id).content).toBe('原位续写后的正文');
    collapseComposer(); resetUiState(); input.value = ''; dom.node('input-parent').value = ''; await initComposer(); selectComposerMode(mode, worker);
    expect(input.value).toBe(''); // A manually stashed item must never automatically reload.
    await resumeComposerDraft(); expect(currentEdit().saved.revision).toBe(2);
    await input.onkeydown({ key: 'Enter', ctrlKey: true, preventDefault() {} });
    const authorization = requests.find(request => request.method === 'input.emit');
    expect(authorization.params).toMatchObject({ draft_id: draft.id, expected_revision: 2 });
    expect(requests.map(request => request.method)).toEqual(['draft.update', 'input.emit']);
    const replay = await action('input.emit', authorization.params, { refresh: false }); expect(replay.draft_id).toBe(draft.id);
    fixture.project.stopping = false; await fixture.project.drainInputEmissions(); await fixture.project.drainInputEmissions(); fixture.project.stopping = true;
    const receipt = fixture.project.inputGet('draft', draft.id); expect(receipt.dispatch.state).toBe('succeeded');
    expect(fixture.store.all('SELECT * FROM drafts')).toHaveLength(1);
    if (mode === 'append') {
      expect(fixture.store.all('SELECT * FROM messages WHERE body=?', '原位续写后的正文')).toHaveLength(1);
      expect(fixture.store.all('SELECT * FROM inputs')).toHaveLength(1); // Only the original target.
    } else {
      expect(fixture.store.all('SELECT * FROM inputs WHERE content=?', '原位续写后的正文')).toHaveLength(1);
      expect(fixture.project.inputGet('input', receipt.input_id).references[0].quote).toBe('引用原文');
    }
    expect(fixture.store.all('SELECT * FROM agent_runs')).toHaveLength(0);
    await expect(action('draft.update', { id: draft.id, content: '不可改写授权', expected_revision: 2 }, { refresh: false })).rejects.toThrow();
    // The same public HTTP action still cannot invoke methods outside its narrow user whitelist.
    await expect(action('input.submit', { content: 'not an authorized API' }, { refresh: false })).rejects.toThrow();
  } finally { restore(); await fixture.close(); }
});
