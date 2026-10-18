import { test, expect } from 'bun:test';
import { setup, fetch as httpFetch } from './harness.js';
import { installDom, dialogButton, dialogText, deepText } from '../dom-stub.js';
import { gate, until } from '../helpers.js';
import { renderTree } from '../../src/ui/web/assets/render-tree.js';
import { managementState, saveManagement } from '../../src/core/project/management-data.js';
import { closeDialog } from '../../src/ui/web/assets/dialog.js';
import { resetUiState, ui } from '../../src/ui/web/assets/state.js';
import { registerNavigation } from '../../src/ui/web/assets/navigate.js';

function mount(dom) {
  const hero = document.createElement('header'); hero.className = 'resource-hero'; dom.node('side-valets').append(hero);
  // Deliberately no history rows: the emergency scope must come from the backend,
  // not the loaded/filtered list or the absence of a visible running process.
  renderTree({ tasks: [], notices: [] });
  return hero.querySelector('.valet-emergency-control');
}
async function confirm(dom, control) {
  const opening = control.querySelector('button').onclick();
  await until(() => dialogButton(dom, '确认强制终结并解除占位'));
  await dialogButton(dom, '确认强制终结并解除占位').onclick(); await opening;
}

test('empty Valet list -> explicit user emergency -> real authenticated HTTP/RPC -> preserved unknown isolation -> fresh rescue submit', async () => {
  const f = await setup(), writes = [];
  f.project.kick = () => {};
  const dom = installDom({ fetch: (url, options) => {
    if (options?.method === 'POST') writes.push(JSON.parse(options.body));
    return httpFetch(f.url + url, options);
  } }); resetUiState(); ui.view = { id: 'valets' };
  const restore = registerNavigation({ refresh: async () => {} });
  try {
    const old = f.project.submitManagementInstruction({ instruction: '旧管家' }).task;
    const state = managementState(f.store.task(old.id));
    state.enabled = false; state.state = 'unknown'; state.pending_signal.phase = 'started';
    state.control_calls = [{ receipt_id: 101, method: 'worker.retry', status: 'unknown', reason: '原始未知收据' }];
    saveManagement(f.project, old.id, state); f.store.update(old.id, { status: 'failed' });
    expect(f.project.running.size).toBe(0);
    expect(() => f.project.submitManagementInstruction({ instruction: 'blocked rescue' })).toThrow('已有管家');
    const control = mount(dom);
    const opening = control.querySelector('button').onclick();
    await until(() => dialogButton(dom, '确认强制终结并解除占位'));
    expect(dialogText(dom)).toContain('本次影响 1 个'); expect(dialogText(dom)).toContain('结果未知收据 1 项');
    expect(writes).toEqual([]);
    await dialogButton(dom, '确认强制终结并解除占位').onclick(); await opening;
    expect(writes).toHaveLength(1); expect(writes[0]).toMatchObject({ method: 'management.emergency_stop', params: { confirm: true } });
    expect(deepText(control)).toContain('历史占位已解除');
    const isolated = managementState(f.store.task(old.id));
    expect(isolated.emergency.status).toBe('isolated'); expect(isolated.control_calls).toEqual(state.control_calls);
    expect(isolated.pending_signal).toEqual(state.pending_signal); expect(f.project.managementOccupant()).toBeNull();
    const rescue = await httpFetch(f.url + '/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'management.submit', params: { instruction: '新授权：救援 Lush' } }) });
    expect(rescue.status).toBe(200);
    const value = await rescue.json(); expect(value.task.status).toBe('queued'); expect(value.task.id).not.toBe(old.id);
    expect(f.project.managementOccupant().id).toBe(value.task.id);
  } finally { closeDialog(); restore(); resetUiState(); dom.restore(); await f.close(); }
});

test('real live Provider retains the lane after UI stop; actual cleanup isolates automatically and read-only status verifies it', async () => {
  const f = await setup(), entered = gate(), release = gate(), writes = [];
  f.project.kick = () => {}; f.project.provider = { async run() { entered.resolve(); await release.promise; return 'returned after stop'; } };
  const dom = installDom({ fetch: (url, options) => {
    if (options?.method === 'POST') writes.push(JSON.parse(options.body));
    return httpFetch(f.url + url, options);
  } }); resetUiState(); ui.view = { id: 'valets' };
  const restore = registerNavigation({ refresh: async () => {} });
  let running;
  try {
    const manager = f.project.submitManagementInstruction({ instruction: '旧在途调用' }).task;
    f.project.pump(); await entered.promise;
    running = [...f.project.running.values()].map(run => run.promise);
    const control = mount(dom); await confirm(dom, control);
    expect(deepText(control)).toContain('尚未全部解除占位'); expect(deepText(control)).toContain('模型进程或退出清理尚未结束');
    expect(f.project.running.has(manager.id)).toBe(true); expect(f.project.managementOccupant().id).toBe(manager.id);
    expect(() => f.project.submitManagementInstruction({ instruction: 'not yet' })).toThrow('已有管家');
    release.resolve(); await Promise.all(running);
    expect(managementState(f.store.task(manager.id)).emergency.status).toBe('isolated');
    expect(f.project.managementOccupant()).toBeNull();
    await control.querySelectorAll('button')[1].onclick();
    expect(deepText(control)).toContain('当前没有等待退出的急救事项'); expect(writes).toHaveLength(1);
    expect(f.project.submitManagementInstruction({ instruction: 'new rescue' }).task.status).toBe('queued');
  } finally { release.resolve(); if (running) await Promise.all(running); closeDialog(); restore(); resetUiState(); dom.restore(); await f.close(); }
});
