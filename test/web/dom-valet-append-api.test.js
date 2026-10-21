import { test, expect } from 'bun:test';
import { fetch as httpFetch, setup } from './harness.js';
import { installDom } from '../dom-stub.js';
import { initComposer } from '../../src/ui/web/assets/composer.js';
import { loadDetail } from '../../src/ui/web/assets/detail.js';
import { registerNavigation } from '../../src/ui/web/assets/navigate.js';
import { resetUiState, ui } from '../../src/ui/web/assets/state.js';
import { closeDialog } from '../../src/ui/web/assets/dialog.js';

const append = dom => dom.node('detail').querySelectorAll('button').find(button => button.textContent === '追加输入');

test('real Valet detail -> authenticated HTTP/RPC rejects busy input intact, then appends one fresh round to the same identity', async () => {
  const f = await setup(), invocations = [], writes = [];
  f.project.kick = () => {};
  let managementDraftId;
  f.project.provider = { async run(options) {
    invocations.push(options);
    const dispatch = (method, params) => f.project.rpcDispatcher.dispatch(method, { ...params, _token: options.token });
    await expect(dispatch('management.submit', { draft_id: managementDraftId, expected_revision: 1 })).rejects.toThrow();
    await expect(dispatch('manager.call', { method: 'input.emit', params: { draft_id: managementDraftId, expected_revision: 1 } })).rejects.toThrow();
    await expect(dispatch('manager.call', { method: 'draft.add', params: { content: 'must not create a manager input', mode: 'management' } })).rejects.toThrow();
    return '正常结束';
  } };
  const dom = installDom({ fetch: (url, options) => {
    if (options?.method === 'POST') writes.push(JSON.parse(options.body));
    return httpFetch(f.url + url, options);
  } });
  resetUiState();
  const restore = registerNavigation({ detail: loadDetail, refresh: async () => {} });
  const pump = async () => { f.project.pump(); await Promise.all([...f.project.running.values()].map(run => run.promise)); };
  const call = async (method, params, ok = true) => {
    const response = await httpFetch(f.url + '/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, params }) });
    expect(response.ok).toBe(ok); return response.json();
  };
  try {
    await initComposer();
    const definition = { content: '保留的最初管理指令', mode: 'management', client_request_id: 'new-management-draft' };
    const draft = await call('draft.add', definition); managementDraftId = draft.id;
    expect(draft).toMatchObject({ mode: 'management', revision: 1, parent_id: null, branch: null, target_id: null, dispatch: null });
    expect(draft.draft_number).toBeGreaterThan(0);
    expect((await call('draft.add', definition)).id).toBe(draft.id);
    await call('draft.add', { ...definition, content: 'changed definition' }, false);
    expect(f.store.get("SELECT count(*) AS n FROM tasks WHERE task_kind='management'").n).toBe(0);
    const submit = { draft_id: draft.id, expected_revision: 1, client_request_id: 'submit-management-draft' };
    const accepted = await call('management.submit', submit), manager = accepted.task;
    expect(accepted).toMatchObject({ management: true, draft_id: draft.id, revision: 1, dispatch: { kind: 'management', state: 'succeeded', authority: 'ordinary', worker_id: manager.id } });
    expect((await call('management.submit', submit)).task.id).toBe(manager.id);
    await call('input.emit', submit, false);
    await call('draft.update', { id: draft.id, content: 'immutable', expected_revision: 1 }, false);
    expect(f.project.inputHistory({ view: 'drafts', modes: ['management'] }).items).toEqual([]);
    expect(f.project.inputGet('management', manager.id).source_draft_id).toBe(draft.id);
    await pump();
    await loadDetail(manager.id);
    expect(append(dom).disabled).toBe(false);
    const other = f.project.submitManagementInstruction({ instruction: '占用串行位' }).task;
    // A busy lane rejects submission, never preservation of the user's next management input.
    const appendDraft = await call('draft.add', { content: '项目草稿追加', mode: 'management', target_id: manager.id });
    const updated = await call('draft.update', { id: appendDraft.id, content: '项目草稿追加（已修改）', expected_revision: 1 });
    expect(updated).toMatchObject({ id: appendDraft.id, revision: 2, target_id: manager.id, target_worker_number: manager.worker_number });
    const draftSubmit = { draft_id: updated.id, expected_revision: 2, client_request_id: 'append-management-draft' };
    await call('management.submit', draftSubmit, false);
    expect(f.project.inputGet('draft', updated.id).dispatch).toBeNull();
    await append(dom).onclick();
    expect(dom.node('modal').querySelector('textarea')).toBe(null);
    expect(dom.node('composer-mode-target').textContent).toContain(manager.worker_number);
    const input = dom.node('input'); input.value = '本轮新增需求'; input.oninput();
    // Management Enter is a newline, not an implicit authorization.
    input.onkeydown({ key: 'Enter', preventDefault() { throw Error('plain Enter must not submit'); } });
    await dom.node('input-form').onsubmit({ preventDefault() {} });
    expect(dom.node('error').textContent).toContain('已有管家'); expect(input.value).toBe('本轮新增需求');
    expect(dom.node('draft-commit').disabled).toBe(true);
    expect(f.store.unread(manager.id)).toEqual([]);
    expect(f.store.task(manager.id).calls).toBe(1);
    f.project.cancel(other.id);
    await loadDetail(manager.id);
    expect(append(dom).disabled).toBe(false);
    await append(dom).onclick();
    expect(input.value).toBe('本轮新增需求');
    await input.onkeydown({ key: 'Enter', ctrlKey: true, preventDefault() {} });
    expect(input.value).toBe(''); expect(dom.node('input-form').dataset.mode).toBe('create');
    expect(f.store.task(manager.id)).toMatchObject({ goal: manager.goal, worker_number: manager.worker_number, status: 'queued' });
    const created = writes.find(write => write.method === 'draft.add');
    expect(created.params).toMatchObject({ mode: 'management', target_id: manager.id, content: '本轮新增需求' });
    expect(created.params.client_request_id).toBeTruthy();
    expect(writes.filter(write => write.method === 'draft.add')).toHaveLength(1);
    expect(writes.filter(write => write.method === 'management.submit')).toHaveLength(2);
    expect(writes.some(write => write.method === 'worker.message' || write.method === 'input.emit')).toBe(false);
    expect(f.store.unread(manager.id)).toMatchObject([{ body: '本轮新增需求', append_number: null }]);
    expect(f.store.get('SELECT count(*) AS n FROM inputs').n).toBe(0);
    expect(f.store.draftCount()).toBe(1);
    await pump();
    expect(invocations.map(options => options.context.management.instruction)).toEqual([manager.goal, '本轮新增需求']);
    expect(f.store.task(manager.id)).toMatchObject({ id: manager.id, status: 'completed', calls: 2, goal: manager.goal, branch: null });
    expect(f.store.unread(manager.id)).toEqual([]);
    await loadDetail(manager.id); expect(append(dom).disabled).toBe(false);
    await call('management.submit', { ...draftSubmit, expected_revision: 1 }, false);
    const appended = await call('management.submit', draftSubmit);
    expect(appended).toMatchObject({ task: { id: manager.id }, draft_id: updated.id, revision: 2, dispatch: { authority: 'ordinary', worker_id: manager.id } });
    expect(appended.dispatch.message_id).toBeGreaterThan(0);
    expect((await call('management.submit', draftSubmit)).dispatch.receipt_id).toBe(appended.dispatch.receipt_id);
    expect(f.project.inputGet('message', appended.dispatch.message_id)).toMatchObject({ mode: 'management', source_draft_id: updated.id, append_number: null });
    expect(f.project.inputHistory({ view: 'drafts', modes: ['management'] }).items).toEqual([]);
    await call('draft.remove', { id: updated.id, expected_revision: 2 }, false);
    await pump();
    expect(invocations.map(options => options.context.management.instruction)).toEqual([manager.goal, '本轮新增需求', updated.content]);
    expect(f.store.get('SELECT count(*) AS n FROM inputs').n).toBe(0);
  } finally {
    closeDialog(); ui.disposeDetailRequests?.(); restore(); resetUiState(); dom.restore(); await f.close();
  }
});
