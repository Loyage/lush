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
  f.project.provider = { async run(options) { invocations.push(options); return '正常结束'; } };
  const dom = installDom({ fetch: (url, options) => {
    if (options?.method === 'POST') writes.push(JSON.parse(options.body));
    return httpFetch(f.url + url, options);
  } });
  resetUiState();
  const restore = registerNavigation({ detail: loadDetail, refresh: async () => {} });
  const pump = async () => { f.project.pump(); await Promise.all([...f.project.running.values()].map(run => run.promise)); };
  try {
    await initComposer();
    const manager = f.project.submitManagementInstruction({ instruction: '保留的最初管理指令' }).task;
    await pump();
    await loadDetail(manager.id);
    expect(append(dom).disabled).toBe(false);
    const other = f.project.submitManagementInstruction({ instruction: '占用串行位' }).task;
    append(dom).onclick();
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
    append(dom).onclick();
    expect(input.value).toBe('本轮新增需求');
    await input.onkeydown({ key: 'Enter', ctrlKey: true, preventDefault() {} });
    expect(input.value).toBe(''); expect(dom.node('input-form').dataset.mode).toBe('create');
    expect(f.store.task(manager.id)).toMatchObject({ goal: manager.goal, worker_number: manager.worker_number, status: 'queued' });
    expect(writes).toEqual([
      { method: 'worker.message', params: { id: manager.id, body: '本轮新增需求' } },
      { method: 'worker.message', params: { id: manager.id, body: '本轮新增需求' } },
    ]);
    expect(f.store.unread(manager.id)).toMatchObject([{ body: '本轮新增需求', append_number: null }]);
    expect(f.store.get('SELECT count(*) AS n FROM inputs').n).toBe(0);
    expect(f.store.draftCount()).toBe(0);
    await pump();
    expect(invocations.map(options => options.context.management.instruction)).toEqual([manager.goal, '本轮新增需求']);
    expect(f.store.task(manager.id)).toMatchObject({ id: manager.id, status: 'completed', calls: 2, goal: manager.goal, branch: null });
    expect(f.store.unread(manager.id)).toEqual([]);
    await loadDetail(manager.id); expect(append(dom).disabled).toBe(false);
  } finally {
    closeDialog(); ui.disposeDetailRequests?.(); restore(); resetUiState(); dom.restore(); await f.close();
  }
});
