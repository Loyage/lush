import { test, expect } from 'bun:test';
import { setup, fetch as httpFetch } from './harness.js';
import { installDom, dialogButton, dialogText } from '../dom-stub.js';
import { repo, until, gate } from '../helpers.js';
import { loadDetail } from '../../src/ui/web/assets/detail.js';
import { detailWorkerCli, disposeWorkerCli } from '../../src/ui/web/assets/worker-cli-detail.js';
import { openWorkerCliPage } from '../../src/ui/web/assets/worker-cli-page.js';
import { registerNavigation } from '../../src/ui/web/assets/navigate.js';
import { resetUiState, ui } from '../../src/ui/web/assets/state.js';
import { openResource } from '../../src/ui/web/assets/sidebar-ui.js';
import { closeDialog } from '../../src/ui/web/assets/dialog.js';

function controls(node) {
  const input = node.querySelector('textarea'), run = node.querySelector('.worker-cli-run');
  return {
    edit(command) { input.value = command; for (const handler of input.listeners.input || []) handler(); },
    click: () => run.listeners.click?.[0]?.(), input,
    send: () => input.listeners.keydown?.[0]?.({ key: 'Enter', ctrlKey: true, preventDefault() {} }),
  };
}

test('Worker detail → CLI page → Ctrl+Enter → authenticated HTTP/RPC → real CLI: query, confirmed change and lifecycle', async () => {
  const f = await setup(); await repo(f.root); f.project.kick = () => {};
  const calls = [];
  const dom = installDom({ fetch: (url, options) => {
    if (options?.method === 'POST') calls.push({ url, ...JSON.parse(options.body) });
    return httpFetch(f.url + url, options);
  } });
  resetUiState();
  const restore = registerNavigation({ detail: loadDetail, refresh: async () => { throw Error('CLI must not refresh/replay its write'); } });
  let pending;
  try {
    const task = (await f.project.order('CLI detail integration', null, [], null, false)).task;
    await loadDetail(task.id);
    const link = dom.node('detail').querySelector('.worker-cli-open');
    expect(link.target).toBe('_blank'); expect(link.href).toBe(`/#worker-${task.id}-cli`);
    expect(dom.node('detail').querySelector('.worker-cli')).toBeNull();
    dom.location.hash = `#worker-${task.id}-cli`;
    const root = await openWorkerCliPage({ taskId: task.id }), c = controls(root);
    expect(root).not.toBeNull(); expect(calls).toEqual([]);
    expect(dom.node('detail').querySelector('.nav-back').href).toBe(`/#worker-${task.id}`);
    c.edit(`lush --json worker inspect ${task.id}`); await c.send();
    expect(root.querySelector('.worker-cli-status').textContent).toBe('执行成功。');
    const output = root.querySelector('.worker-cli-output').textContent;
    expect(JSON.parse(output)).toMatchObject({ id: task.id, workspace: task.workspace });
    expect(calls.map(call => call.method)).toEqual(['worker.cli_preview','worker.cli_execute']);
    expect(calls.every(call => call.params.id === task.id && call.url === '/api/action')).toBe(true);
    expect(calls[1].params).toMatchObject({ confirm: false });
    c.edit(`lush worker rename ${task.id} 'from CLI panel'`); pending = c.send();
    await until(() => dialogText(dom).includes('确认真实 CLI 执行'));
    expect(f.store.task(task.id).display_title).toBeNull();
    expect(dialogText(dom)).toContain(task.workspace);
    await dialogButton(dom, '确认执行').onclick(); await pending;
    expect(f.store.task(task.id).display_title).toBe('from CLI panel');
    expect(calls).toHaveLength(4); expect(calls[3].params.confirm).toBe(true);
    c.edit('lush help'); c.input.focus();
    await openWorkerCliPage({ taskId: task.id });
    expect(dom.node('detail').querySelector('.worker-cli')).toBe(root);
    expect(c.input.value).toBe('lush help');
    expect(root.querySelector('.worker-cli-status').textContent).toBe('执行成功。');
    expect(calls).toHaveLength(4);
    openResource('tasks');
    c.edit('lush status'); await c.click();
    expect(calls).toHaveLength(4); // disposed old node cannot send, even if a caller retained its controls
    await loadDetail(1); expect(dom.node('detail').querySelector('.worker-cli')).toBeNull();
  } finally {
    closeDialog(); await pending; ui.disposeWorkerCli?.(); ui.disposeDetailRequests?.(); disposeWorkerCli(); restore(); resetUiState(); dom.restore(); await f.close();
  }
});

test('CLI page ignores late Worker reads on leave, fails closed on unavailable/retired identities and preserves source links', async () => {
  const ready = gate(), task = { id: 77, worker_number: 'W333', task_kind: 'order', workspace: '/owned/worktree' };
  let response = task, delay = true;
  const dom = installDom({ fetch: async () => {
    if (delay) await ready.promise;
    if (response instanceof Error) throw response;
    return Response.json(response);
  } });
  resetUiState(); dom.location.pathname = '/p/aaaaaaaaaaaaaaaa/'; dom.location.hash = '#worker-77-cli';
  let pending;
  try {
    pending = openWorkerCliPage({ taskId: 77 });
    openResource('tasks'); ready.resolve(); await pending;
    expect(ui.view.id).toBe('tasks'); expect(dom.node('detail').querySelector('.worker-cli')).toBeNull();
    delay = false;
    for (const value of [new Error('Worker not found'), { ...task, id: 78 }, { ...task, execution_retired: true }, { ...task, task_kind: 'main' }]) {
      response = value; await openWorkerCliPage({ taskId: 77 });
      expect(dom.node('detail').querySelector('.worker-cli')).toBeNull();
      expect(dom.node('detail').querySelector('.nav-back').href).toBe('/p/aaaaaaaaaaaaaaaa/#worker-77');
      expect(dom.node('detail').querySelector('p').textContent).toMatch(/无法打开|不支持/);
    }
    response = { ...task, workspace: null }; await openWorkerCliPage({ taskId: 77 });
    const root = dom.node('detail').querySelector('.worker-cli');
    expect(root.querySelector('.worker-cli-run').disabled).toBe(true);
    expect(root.querySelector('.worker-cli-unavailable').textContent).toContain('不会回落到项目目录');
  } finally { ready.resolve(); await pending; ui.disposeWorkerCli?.(); resetUiState(); dom.restore(); }
});

test('detail adapter fixes project/id, suppresses cross-project preview continuation and never retries a lost execution ACK', async () => {
  const calls = [], ready = gate(); let previewGate = ready;
  const task = { id: 77, worker_number: 'W324', task_kind: 'order', workspace: '/owned/worktree' };
  const dom = installDom({ fetch: async (url, options) => {
    const body = JSON.parse(options.body); calls.push({ url, ...body });
    if (body.method === 'worker.cli_preview') {
      await previewGate.promise;
      return { ok: true, json: async () => ({ ...body.params, workspace: task.workspace, executable: 'lush',
        path: 'status', argv: ['status'], kind: 'read', requires_confirmation: false, revision: 'revision' }) };
    }
    throw Error('lost response after dispatch');
  } });
  resetUiState();
  try {
    dom.location.pathname = '/p/aaaaaaaaaaaaaaaa/';
    const old = detailWorkerCli(task); dom.node('detail').append(old);
    const c = controls(old); c.edit('lush status'); const pending = c.click();
    expect(calls[0]).toMatchObject({ url: '/p/aaaaaaaaaaaaaaaa/api/action', params: { id: task.id } });
    dom.location.pathname = '/p/bbbbbbbbbbbbbbbb/';
    const next = detailWorkerCli(task); expect(next).not.toBe(old);
    ready.resolve(); await pending; expect(calls).toHaveLength(1);
    previewGate = gate(); previewGate.resolve();
    const d = controls(next); d.edit('lush status'); await d.click();
    expect(calls.map(call => call.url)).toEqual(['/p/aaaaaaaaaaaaaaaa/api/action', '/p/bbbbbbbbbbbbbbbb/api/action', '/p/bbbbbbbbbbbbbbbb/api/action']);
    expect(next.querySelector('.worker-cli-status').textContent).toContain('结果未知');
    expect(next.querySelector('.worker-cli-status').textContent).toContain('不会自动重试');
    expect(calls).toHaveLength(3);
  } finally { ready.resolve(); disposeWorkerCli(); resetUiState(); dom.restore(); }
});
