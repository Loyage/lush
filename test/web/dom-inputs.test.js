import { test, expect, afterAll } from 'bun:test';
import { installDom, deepText } from './project-dom.js';
import { makeWorld } from './dom-world.js';

const world = makeWorld(), calls = [];
const draft = { kind: 'draft', id: 1, mode: 'order', content: '尚未执行的想法', created_at: '2026-10-01T00:00:00Z',
  parent_id: 1, branch: 'main', status: 'draft', integration: 'none', revision: 3, references: [] };
const json = value => ({ ok: true, json: async () => structuredClone(value) });
const dom = installDom({ fetch: async (url, options = {}) => {
  const path = new URL(String(url), 'http://localhost').pathname;
  if (path === '/api/input-parents') return json({ items: [{ id: 1, branch: 'main', goal: '主干' }] });
  if (path === '/api/inputs') return json({ items: [draft], next_cursor: null });
  if (path === '/api/input/draft/1') return json(draft);
  if (path === '/api/action') {
    const call = JSON.parse(options.body); calls.push(call);
    if (call.method === 'draft.update') { Object.assign(draft, call.params, { revision: draft.revision + 1 }); return json(draft); }
    if (call.method === 'input.emit') { draft.dispatch = { state: 'queued' }; return json({ emitted: true, draft_id: 1, dispatch: draft.dispatch }); }
  }
  return world.fetchImpl(url, options);
} });
const { openInputs } = await import('../../src/ui/web/assets/render-inputs.js');
const { boot } = await import('../../src/ui/web/assets/app.js');
await boot(); afterAll(() => dom.restore());
const button = (root, label) => root.querySelectorAll('button').find(node => node.textContent === label);

test('draft list opens its editor, saves changed text then submits the new revision', async () => {
  await openInputs({ section: 'drafts' });
  expect(dom.node('detail').querySelectorAll('.input-record')).toHaveLength(1);
  await openInputs({ item: { kind: 'draft', id: 1 } });
  const panel = dom.node('detail').querySelector('.input-detail'), editor = panel.querySelector('textarea');
  editor.value = '修改后的正文'; editor.oninput();
  await button(panel, '保存').onclick();
  expect(calls[0]).toMatchObject({ method: 'draft.update', params: { id: 1, content: '修改后的正文', expected_revision: 3 } });
  expect(draft.revision).toBe(4); expect(deepText(panel)).toContain('已保存');
  await button(panel, '提交指令').onclick();
  expect(calls.at(-1)).toMatchObject({ method: 'input.emit', params: { draft_id: 1, expected_revision: 4 } });
  expect(panel.querySelector('textarea')).toBeNull(); expect(deepText(panel)).toContain('等待准入');
  expect(dom.location.hash).toBe('#input-draft-1');
});
