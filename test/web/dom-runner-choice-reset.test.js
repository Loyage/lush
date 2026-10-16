import { beforeEach, afterEach, test, expect } from 'bun:test';
import { installDom, deepText } from '../dom-stub.js';
import { openInputs } from '../../src/ui/web/assets/render-inputs.js';
import { registerNavigation } from '../../src/ui/web/assets/navigate.js';

// D655 component edge cases use a contract mock. The real page/HTTP/RPC/Runner
// reset-to-creation-time-default chain lives in runner-choice-page-integration.test.js.
const NODE = '11111111-1111-4111-8111-111111111111';
let dom, draft, writes, fail, restore, refreshes;
beforeEach(() => {
  writes = []; fail = false; refreshes = 0;
  draft = { kind: 'draft', id: 1, revision: 3, content: 'saved content', references: [], mode: 'order',
    parent_id: 1, branch: 'main', runner_node_id: NODE, conditions: [], exclusive: false, dispatch: null };
  dom = installDom({ fetch: async (path, options) => {
    if (path === '/api/input-parents') return Response.json({ items: [{ id: 1, branch: 'main', goal: 'main' }] });
    if (path === '/api/input/draft/1') return Response.json(draft);
    if (path.startsWith('/api/inputs')) return Response.json({ items: [draft], next_cursor: null });
    if (path === '/api/runner/nodes') return Response.json({ nodes: [{ id: NODE, name: 'remote', enabled: true }] });
    if (path === '/api/runner/project') return Response.json({ allowed_node_ids: [NODE], default_node_id: NODE });
    if (path === '/api/action') {
      const body = JSON.parse(options.body); writes.push(body);
      if (fail) return Response.json({ error: 'draft revision conflict' }, { status: 409 });
      const { method, params } = body;
      expect(params.expected_revision).toBe(draft.revision);
      if (method === 'draft.update') {
        draft = { ...draft, content: params.content, revision: draft.revision + 1 };
        if (Object.hasOwn(params, 'runner_node_id')) {
          expect(draft.mode).toBe('order');
          if (params.runner_node_id === null) delete draft.runner_node_id;
          else draft.runner_node_id = params.runner_node_id;
        }
        return Response.json(draft);
      }
      if (method === 'input.emit') return Response.json({ emitted: true, draft_id: draft.id, revision: draft.revision + 1, dispatch: { state: 'queued' } });
    }
    throw Error(`unexpected ${path}`);
  } });
  // A successful draft ACK must not depend on a subsequent global read.
  restore = registerNavigation({ refresh: async () => { refreshes++; throw Error('overview offline after ACK'); } });
});
afterEach(() => { restore(); dom.restore(); });
const panel = () => dom.node('detail').querySelector('.input-detail');
const button = text => panel().querySelectorAll('button').find(node => node.textContent === text);
const choice = value => panel().querySelector(`[data-runner-node="${value}"]`);
const open = () => openInputs({ item: { kind: 'draft', id: 1 } });
const text = value => { const input = panel().querySelector('textarea'); input.value = value; input.oninput(); };

test('D655 explicit draft reset sends null once, advances ACK baseline and later emits only persisted revision', async () => {
  await open(); await button('更改执行环境').onclick();
  expect(choice('default').disabled).toBe(false); choice('default').onclick();
  expect(button('保存').disabled).toBe(false);
  await button('保存').onclick();
  expect(writes[0]).toMatchObject({ method: 'draft.update', params: { id: 1, expected_revision: 3, runner_node_id: null } });
  expect(draft).not.toHaveProperty('runner_node_id'); expect(button('保存').disabled).toBe(true);
  expect(refreshes).toBe(0); await button('保存').onclick(); expect(writes).toHaveLength(1);
  text('after reset'); await button('保存').onclick();
  expect(writes[1].params.expected_revision).toBe(4); expect(writes[1].params).not.toHaveProperty('runner_node_id');
  await button('提交指令').onclick();
  expect(writes.map(call => call.method)).toEqual(['draft.update', 'draft.update', 'input.emit']);
  expect(writes[2].params).toMatchObject({ draft_id: 1, expected_revision: 5 });
  expect(writes[2].params).not.toHaveProperty('runner_node_id');
  expect(panel().querySelector('textarea')).toBeNull(); expect(deepText(panel())).toContain('实际创建时解析');
});

test('reset failure preserves text, default choice and original revision without emission or automatic retry', async () => {
  await open(); choice('default').onclick(); text('unsaved reset content'); fail = true;
  await button('保存').onclick();
  expect(writes).toHaveLength(1); expect(writes[0].params.runner_node_id).toBeNull();
  expect(draft.runner_node_id).toBe(NODE); expect(draft.revision).toBe(3);
  expect(panel().querySelector('textarea').value).toBe('unsaved reset content');
  expect(choice('default').getAttribute('aria-pressed')).toBe('true'); expect(deepText(panel())).toContain('revision conflict');
  await button('提交指令').onclick();
  expect(writes).toHaveLength(2); expect(writes.every(call => call.method === 'draft.update')).toBe(true);
  expect(writes[1].params.expected_revision).toBe(3); expect(writes[1].params.runner_node_id).toBeNull();
  fail = false; await button('保存').onclick(); expect(draft).not.toHaveProperty('runner_node_id');
});

test('old missing field stays missing, including select/undo; changing only the environment is saved explicitly', async () => {
  delete draft.runner_node_id;
  await open(); await button('更改执行环境').onclick();
  choice('local').onclick(); choice('default').onclick(); expect(button('保存').disabled).toBe(true);
  text('old draft edited'); await button('保存').onclick();
  expect(writes[0].params).not.toHaveProperty('runner_node_id');
  choice('local').onclick(); await button('保存').onclick();
  expect(writes[1].params).toMatchObject({ runner_node_id: 'local', expected_revision: 4 });
  choice('default').onclick(); await button('保存').onclick();
  expect(writes[2].params).toMatchObject({ runner_node_id: null, expected_revision: 5 });
});

test('mounted drafts and append mode expose no environment mutation or reset', async () => {
  draft.dispatch = { state: 'queued' }; await open();
  expect(panel().querySelector('.runner-input-choice')).toBeNull(); expect(panel().querySelector('textarea')).toBeNull();
  expect(writes).toHaveLength(0);
  draft = { ...draft, dispatch: null, mode: 'append', target_id: 2, target_worker_number: 'W1' }; delete draft.runner_node_id;
  await openInputs(); await open();
  expect(panel().querySelector('.runner-input-choice')).toBeNull(); expect(writes).toHaveLength(0);
});
