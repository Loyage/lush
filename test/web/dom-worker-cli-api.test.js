import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { setup, fetch as httpFetch } from './harness.js';
import { installDom, dialogButton, dialogText } from '../dom-stub.js';
import { repo, until } from '../helpers.js';
import { loadDetail } from '../../src/ui/web/assets/detail.js';
import { disposeWorkerCli } from '../../src/ui/web/assets/worker-cli-detail.js';
import { openWorkerCliPage } from '../../src/ui/web/assets/worker-cli-page.js';
import { registerNavigation } from '../../src/ui/web/assets/navigate.js';
import { resetUiState, ui } from '../../src/ui/web/assets/state.js';
import { openResource } from '../../src/ui/web/assets/sidebar-ui.js';
import { closeDialog } from '../../src/ui/web/assets/dialog.js';
import { initRefreshPolling, refresh } from '../../src/ui/web/assets/refresh.js';

function controls(node) {
  const input = node.querySelector('textarea'), run = node.querySelector('.worker-cli-run');
  return {
    edit(command) { input.value = command; for (const handler of input.listeners.input || []) handler(); },
    click: () => run.listeners.click?.[0]?.(), input,
    send: () => input.listeners.keydown?.[0]?.({ key: 'Enter', preventDefault() {} }),
  };
}

test('fourth CLI tab → overview polling → real lush/lushw → encrypted history reload and confirmed clear without replay', async () => {
  const f = await setup(); await repo(f.root); f.project.kick = () => {};
  const calls = [];
  const dom = installDom({ fetch: (url, options) => {
    if (options?.method === 'POST') calls.push({ url, ...JSON.parse(options.body) });
    return httpFetch(f.url + url, options);
  } });
  resetUiState();
  const disposePolling = initRefreshPolling();
  const restore = registerNavigation({ detail: loadDetail, refresh: async () => { throw Error('CLI must not refresh/replay its write'); } });
  let pending;
  try {
    const task = (await f.project.order('CLI detail integration', null, [], null, false)).task;
    await loadDetail(task.id);
    const link = dom.node('detail').querySelector('.worker-workbench-open');
    expect(link.target).toBe('_blank'); expect(link.href).toBe(`/#worker-${task.id}-execution`);
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
    await refresh({ force: true });
    c.edit('lushw --json self show'); await c.send();
    expect(root.querySelector('.worker-cli-status').textContent).toBe('执行成功。');
    const output = root.querySelector('.worker-cli-output').textContent;
    expect(JSON.parse(output)).toMatchObject({ version: 1, data: { id: task.id, workspace: task.workspace } });
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
    for (const secret of ['self show', 'from CLI panel', task.workspace]) expect(ciphertext).not.toContain(secret);
    c.edit('lush help'); c.input.focus();
    await openWorkerCliPage({ taskId: task.id });
    expect(ui.transcriptView.cli).toBe(root);
    expect(c.input.value).toBe('lush help');
    expect(root.querySelector('.worker-cli-status').textContent).toBe('执行成功。');
    expect(calls).toHaveLength(5);
    // Production overview polling carries a summary, not the full inspect. It must
    // not erase the CLI workspace, draft, history or successful execution ACK.
    const results = root.querySelectorAll('.worker-cli-result');
    for (let tick = 0; tick < 2; tick++) {
      await refresh({ force: true });
      const summary = ui.lastSnapshot.tasks.find(item => item.id === task.id);
      expect(Object.hasOwn(summary, 'workspace')).toBe(false);
      expect(root.querySelector('.worker-cli-workspace').textContent).toBe(task.workspace);
      expect(root.querySelector('.worker-cli-unavailable').hidden).toBe(true);
      expect(root.querySelector('.worker-cli-run').disabled).toBe(false);
      expect(c.input.value).toBe('lush help');
      expect(root.querySelector('.worker-cli-status').textContent).toBe('执行成功。');
      expect(root.querySelectorAll('.worker-cli-result')).toEqual(results);
      expect(calls).toHaveLength(5);
    }
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
    expect(records[0].querySelector('.worker-cli-result-command').textContent).toContain('$ lushw --json self show');
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
    // Main execution remains on the independent CLI page, never the docs page.
    dom.location.hash = `#worker-${task.parent_id}-execution-cli`;
    const main = await openWorkerCliPage({ taskId: task.parent_id }); await main.ready;
    const mainControls = controls(main);
    mainControls.edit('lushw --json self show'); await mainControls.send();
    expect(main.querySelector('.worker-cli-status').textContent).toBe('执行成功。');
    expect(JSON.parse(main.querySelector('.worker-cli-output').textContent).data.id).toBe(task.parent_id);
    mainControls.edit(`lush worker rename ${task.id} 'independent main CLI'`); pending = mainControls.send();
    await until(() => dialogText(dom).includes('确认真实 CLI 执行'));
    expect(f.store.task(task.id).display_title).toBe('from CLI panel');
    await dialogButton(dom, '确认执行').onclick(); await pending;
    expect(f.store.task(task.id).display_title).toBe('independent main CLI');
    ui.disposeWorkerCli();
    const mainReload = await openWorkerCliPage({ taskId: task.parent_id }); await mainReload.ready;
    expect(mainReload.querySelectorAll('.worker-cli-result')).toHaveLength(2);
    expect(mainReload.querySelector('.worker-cli-history-disclosure').open).not.toBe(true);
  } finally {
    closeDialog(); await pending; disposePolling(); ui.disposeWorkerCli?.(); ui.disposeDetailRequests?.(); disposeWorkerCli(); restore(); resetUiState(); dom.restore(); await f.close();
  }
});
