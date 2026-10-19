import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
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

test('fourth CLI tab → real lush/lushw → encrypted history reload and confirmed clear without replay', async () => {
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
    expect(link.target).toBe('_blank'); expect(link.href).toBe(`/#worker-${task.id}-execution-cli`);
    expect(dom.node('detail').querySelector('.worker-cli')).toBeNull();
    dom.location.hash = `#worker-${task.id}-cli`;
    const root = await openWorkerCliPage({ taskId: task.id }), c = controls(root);
    expect(root).not.toBeNull(); await root.ready;
    expect(calls.map(call => call.method)).toEqual(['worker.cli_history']);
    expect(root.querySelector('.worker-cli-history-status').textContent).toBe('暂无命令历史。');
    expect(ui.transcriptView.standalone).toBe(true);
    expect(ui.transcriptView.mode).toBe('cli');
    expect(ui.transcriptView.panel.querySelectorAll('[role="tab"]')).toHaveLength(4);
    expect(ui.transcriptView.panel.querySelector('.transcript-back')).toBeNull();
    c.edit('lushw --json self inspect'); await c.send();
    expect(root.querySelector('.worker-cli-status').textContent).toBe('执行成功。');
    const output = root.querySelector('.worker-cli-output').textContent;
    expect(JSON.parse(output)).toMatchObject({ id: task.id, workspace: task.workspace });
    expect(calls.map(call => call.method)).toEqual(['worker.cli_history','worker.cli_preview','worker.cli_execute']);
    expect(calls.every(call => call.params.id === task.id && call.url === '/api/action')).toBe(true);
    expect(calls[2].params).toMatchObject({ confirm: false });
    c.edit(`lush worker rename ${task.id} 'from CLI panel'`); pending = c.send();
    await until(() => dialogText(dom).includes('确认真实 CLI 执行'));
    expect(f.store.task(task.id).display_title).toBeNull();
    expect(dialogText(dom)).toContain(task.workspace);
    await dialogButton(dom, '确认执行').onclick(); await pending;
    expect(f.store.task(task.id).display_title).toBe('from CLI panel');
    expect(calls).toHaveLength(5); expect(calls[4].params.confirm).toBe(true);
    expect(root.querySelectorAll('.worker-cli-result')).toHaveLength(2);
    const ciphertext = fs.readFileSync(path.join(f.config.home, 'worker-cli-history', `${task.id}.json`), 'utf8');
    for (const secret of ['self inspect', 'from CLI panel', task.workspace]) expect(ciphertext).not.toContain(secret);
    c.edit('lush help'); c.input.focus();
    await openWorkerCliPage({ taskId: task.id });
    expect(ui.transcriptView.cli).toBe(root);
    expect(c.input.value).toBe('lush help');
    expect(root.querySelector('.worker-cli-status').textContent).toBe('执行成功。');
    expect(calls).toHaveLength(5);
    const tabs = ui.transcriptView.panel.querySelectorAll('[role="tab"]');
    await tabs[0].onclick(); await tabs[3].onclick();
    expect(ui.transcriptView.cli).toBe(root); expect(c.input.value).toBe('lush help');
    expect(root.querySelectorAll('.worker-cli-result')).toHaveLength(2);
    // Simulate a page reload: no in-memory command session remains, only server history.
    ui.disposeWorkerCli();
    const restored = await openWorkerCliPage({ taskId: task.id }); await restored.ready;
    expect(restored).not.toBe(root);
    expect(restored.querySelector('textarea').value).toBe('');
    const records = restored.querySelectorAll('.worker-cli-result');
    expect(records).toHaveLength(2);
    expect(records[0].querySelector('.worker-cli-result-command').textContent).toContain('$ lushw --json self inspect');
    expect(records[1].querySelector('.worker-cli-result-command').textContent).toContain('from CLI panel');
    expect(calls.filter(call => call.method === 'worker.cli_execute')).toHaveLength(2);
    pending = restored.querySelector('.danger').listeners.click[0]();
    await until(() => dialogText(dom).includes('永久清除'));
    await dialogButton(dom, '永久清除').onclick(); await pending;
    expect(restored.querySelectorAll('.worker-cli-result')).toHaveLength(0);
    expect(calls.at(-1).method).toBe('worker.cli_history_clear');
    ui.disposeWorkerCli();
    const empty = await openWorkerCliPage({ taskId: task.id }); await empty.ready;
    expect(empty.querySelectorAll('.worker-cli-result')).toHaveLength(0);
    expect(calls.filter(call => call.method === 'worker.cli_execute')).toHaveLength(2);
    openResource('tasks');
    const callCount = calls.length;
    c.edit('lush status'); await c.click();
    expect(calls).toHaveLength(callCount); // disposed old node cannot send, even if a caller retained its controls
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
      expect(dom.node('detail').querySelector('.nav-back')).toBeNull();
      expect(dom.node('detail').querySelector('p').textContent).toMatch(/无法打开|不支持/);
    }
    response = { ...task, workspace: null }; await openWorkerCliPage({ taskId: 77 });
    const root = ui.transcriptView.cli;
    expect(root.querySelector('.worker-cli-run').disabled).toBe(true);
    expect(root.querySelector('.worker-cli-unavailable').textContent).toContain('不会回落到项目目录');
  } finally { ready.resolve(); await pending; ui.disposeWorkerCli?.(); resetUiState(); dom.restore(); }
});

test('detail adapter fixes project/id, suppresses cross-project preview continuation and never retries a lost execution ACK', async () => {
  const calls = [], ready = gate(); let previewGate = ready;
  const task = { id: 77, worker_number: 'W324', task_kind: 'order', workspace: '/owned/worktree' };
  const dom = installDom({ fetch: async (url, options) => {
    const body = JSON.parse(options.body);
    if (body.method === 'worker.cli_history') return Response.json({ entries: [], before: null, has_more: false });
    calls.push({ url, ...body });
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
