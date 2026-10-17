import { test, expect, afterAll } from 'bun:test';
import { repo } from '../helpers.js';
import { fetch as httpFetch, setup } from './harness.js';
import { installDom } from '../dom-stub.js';

let fixture;
const dom = installDom({ fetch: (url, options) => httpFetch(fixture.url + url, options) });
const { resetUiState } = await import('../../src/ui/web/assets/state.js');
const { initComposer } = await import('../../src/ui/web/assets/composer.js');
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
