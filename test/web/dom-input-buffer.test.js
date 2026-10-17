import { test, expect, afterAll } from 'bun:test';
import { installDom } from '../dom-stub.js';

const calls = [], json = value => ({ ok: true, json: async () => value });
const dom = installDom({ fetch: async (url, options = {}) => {
  if (String(url).endsWith('/api/input-parents')) return json({ items: [{ id: 1, branch: 'main', goal: 'main' }] });
  if (String(url).endsWith('/api/action')) {
    const body = JSON.parse(options.body); calls.push(body);
    return json(body.method === 'draft.add' ? { id: 9 } : { emitted: true, draft_id: 9, dispatch: { state: 'queued' } });
  }
  throw new Error(`Unexpected ${url}`);
} });
const { initComposer, buffer, appendToWorker } = await import('../../src/ui/web/assets/composer.js');
const { resetUiState, ui } = await import('../../src/ui/web/assets/state.js');
const { registerNavigation } = await import('../../src/ui/web/assets/navigate.js');
const restore = registerNavigation({ refresh: async () => {} });
afterAll(() => { restore(); dom.restore(); });

test('composer saves a draft, submits a new instruction and explicitly appends to a Worker', async () => {
  resetUiState(); await initComposer(); const input = dom.node('input');
  const type = text => { input.value = text; input.oninput(); };
  const submit = () => input.onkeydown({ key: 'Enter', ctrlKey: true, preventDefault() {} });
  type('先保存'); await buffer();
  expect(calls[0]).toMatchObject({ method: 'draft.add', params: { content: '先保存' } });
  expect(dom.node('error').textContent).toContain('尚未提交');
  type('新工作'); await submit();
  expect(calls.at(-1).method).toBe('input.emit'); expect(input.value).toBe('');
  ui.view = { id: 'task' }; ui.selected = 126;
  appendToWorker({ id: 126, worker_number: 'W15', status: 'running', task_kind: 'order', branch: 'lush/126', workspace: '/tmp/126' });
  type('追加要求'); await submit();
  expect(calls.at(-1)).toMatchObject({ method: 'input.emit', params: { mode: 'append', target_id: 126, content: '追加要求' } });
  expect(dom.node('input-form').dataset.mode).toBe('create'); expect(ui.composerAppendTarget).toBeNull();
});
