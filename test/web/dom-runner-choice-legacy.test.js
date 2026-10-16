import { beforeEach, afterEach, test, expect } from 'bun:test';
import { installDom, deepText } from '../dom-stub.js';
import { renderDrafts } from '../../src/ui/web/assets/render-drafts.js';
import { initComposer } from '../../src/ui/web/assets/composer.js';
import { registerNavigation } from '../../src/ui/web/assets/navigate.js';
import { ui } from '../../src/ui/web/assets/state.js';

const NODE = '11111111-1111-4111-8111-111111111111';
const draft = () => ({ id: 10, revision: 4, content: 'persisted original', references: [], runner_node_id: NODE });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
let dom, calls, reply, refreshRead, restore;
const root = () => dom.node('drafts');
const button = text => root().querySelectorAll('button').find(node => node.textContent === text);
beforeEach(async () => {
  calls = []; refreshRead = async () => {};
  reply = body => Response.json(body.method === 'input.emit' ? { emitted: true, draft_id: 10, revision: 5 }
    : { ...draft(), content: body.params.content, revision: 5 });
  dom = installDom({ fetch: async (path, options) => {
    if (path === '/api/input-parents') return Response.json({ items: [] });
    if (path === '/api/action') { const body = JSON.parse(options.body); calls.push(body); return reply(body); }
    throw Error(`unexpected ${path}`);
  } });
  restore = registerNavigation({ refresh: () => refreshRead() });
  await initComposer(); renderDrafts({ drafts: [draft()] });
});
afterEach(() => { restore(); dom.restore(); });

test('legacy emit ACK consumes old controls before failed refresh; stale snapshot cannot enable a second mutation', async () => {
  refreshRead = async () => { throw Error('read offline'); };
  const send = button('发送'), edit = button('编辑'), remove = button('移除');
  dom.node('input').value = 'new composer text'; ui.composerRunnerNodeId = 'local';
  await send.onclick(); await Promise.resolve();
  expect(calls).toEqual([{ method: 'input.emit', params: { draft_id: 10, expected_revision: 4 } }]);
  expect(deepText(root())).toContain('已提交'); expect(deepText(root())).toContain(NODE);
  expect(deepText(root())).toContain('persisted original'); expect(button('发送')).toBeUndefined();
  expect(dom.node('error').textContent).toContain('草稿已提交，但页面更新失败');
  await send.onclick(); await edit.onclick(); await remove.onclick();
  renderDrafts({ drafts: [draft()] });
  expect(button('发送')).toBeUndefined(); expect(calls).toHaveLength(1);
  expect(dom.node('input').value).toBe('new composer text'); expect(ui.composerRunnerNodeId).toBe('local');
});

test('slow post-ACK emission refresh neither holds submission lock nor revives the consumed row', async () => {
  const read = deferred(); refreshRead = async () => { await read.promise; renderDrafts({ drafts: [draft()] }); };
  const send = button('发送'); await send.onclick();
  expect(button('发送')).toBeUndefined(); await send.onclick(); expect(calls).toHaveLength(1);
  read.resolve(); await Promise.resolve(); await Promise.resolve();
  expect(button('发送')).toBeUndefined(); expect(calls).toHaveLength(1);
});

test('edit ACK updates local body/revision before failed refresh, never retries old save or loses runner choice', async () => {
  refreshRead = async () => { throw Error('read offline'); };
  button('编辑').onclick(); const oldBox = root().querySelector('textarea'); oldBox.value = 'acknowledged edit';
  await oldBox.listeners.blur[0](); await Promise.resolve();
  expect(calls).toEqual([{ method: 'draft.update', params: { id: 10, content: 'acknowledged edit', expected_revision: 4 } }]);
  expect(dom.node('error').textContent).toContain('草稿已保存，但页面更新失败');
  expect(root().querySelector('textarea')).toBeNull(); expect(ui.draftEditing).toBeNull();
  expect(oldBox.disabled).toBe(true); await oldBox.listeners.blur[0](); expect(calls).toHaveLength(1);
  renderDrafts({ drafts: [draft()] });
  expect(deepText(root())).toContain('acknowledged edit'); expect(deepText(root())).toContain(NODE);
  await button('发送').onclick(); expect(calls.at(-1)).toEqual({ method: 'input.emit', params: { draft_id: 10, expected_revision: 5 } });
});

test('late edit refresh preserves new edit and ACK revision; old detached controls cannot write', async () => {
  const read = deferred(); refreshRead = async () => { await read.promise; renderDrafts({ drafts: [draft()] }); };
  const oldSend = button('发送'); button('编辑').onclick(); const oldBox = root().querySelector('textarea'); oldBox.value = 'first edit';
  await oldBox.listeners.blur[0]();
  button('编辑').onclick(); const currentBox = root().querySelector('textarea'); currentBox.value = 'next unsaved edit';
  read.resolve(); await Promise.resolve(); await Promise.resolve();
  expect(root().querySelector('textarea')).toBe(currentBox); expect(currentBox.value).toBe('next unsaved edit');
  expect(deepText(root())).toContain(NODE); await oldBox.listeners.blur[0](); await oldSend.onclick(); expect(calls).toHaveLength(1);
  reply = body => Response.json({ ...draft(), revision: 6, content: body.params.content });
  await currentBox.listeners.blur[0]();
  expect(calls.at(-1).params).toEqual({ id: 10, content: 'next unsaved edit', expected_revision: 5 });
});

test('invalid emission ACK retains original and explicit selection, makes no read or automatic retry', async () => {
  let reads = 0; refreshRead = async () => { reads++; };
  reply = () => Response.json({ emitted: true, draft_id: 999 });
  await button('发送').onclick();
  expect(calls).toHaveLength(1); expect(reads).toBe(0);
  expect(button('发送').disabled).toBe(false); expect(deepText(root())).toContain('persisted original'); expect(deepText(root())).toContain(NODE);
  expect(dom.node('error').textContent).toContain('缺少可靠草稿收据');
});
