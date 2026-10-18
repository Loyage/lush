import { test, expect } from 'bun:test';
import { installDom, deepText, dialogButton, dialogText } from '../dom-stub.js';
import { gate, until } from '../helpers.js';
import { valetEmergencyControl } from '../../src/ui/web/assets/valet-emergency.js';
import { renderTree } from '../../src/ui/web/assets/render-tree.js';
import { renderManagementState } from '../../src/ui/web/assets/management-state.js';
import { closeDialog, formDialog } from '../../src/ui/web/assets/dialog.js';
import { resetUiState, ui } from '../../src/ui/web/assets/state.js';

const totals = { enabled: 1, pending_occurrences: 1, unstarted_actions: 1, unstarted_calls: 1,
  started_receipts: 0, unknown_receipts: 2, open_decisions: 1, live_workers: 0 };
const preview = (extra = {}) => ({ version: 1, scope: 'current_project', revision: 'exact-r1', total: 1, affected_total: 1,
  already_isolated_total: 0, stopping_total: 0, items: [{ id: 801, worker_number: 'V12', ...totals, blockers: [] }],
  items_truncated: false, totals: { ...totals }, history_preserved: true, ...extra });
const result = (extra = {}) => ({ version: 1, scope: 'current_project', request_revision: 'exact-r1', status: 'isolated',
  affected_total: 1, isolated_total: 1, stopping_total: 0, blockers: [], blockers_total: 0, blockers_truncated: false,
  history_preserved: true, ...extra });
function setup(fetch, refresh = async () => {}) {
  const dom = installDom({ fetch }); resetUiState(); ui.view = { id: 'valets' }; dom.node('modal').hidden = true;
  const root = valetEmergencyControl({ refresh }); dom.node('side-valets').append(root);
  return { dom, root, stop: root.querySelector('button'), check: root.querySelectorAll('button')[1],
    close() { closeDialog(); resetUiState(); dom.restore(); } };
}
async function open(f) {
  const opening = f.stop.onclick();
  await until(() => !f.dom.node('modal').hidden && dialogButton(f.dom, '确认强制终结并解除占位'));
  return { opening };
}

test('list hero exposes one non-Agent emergency entry even with no loaded Valets, with no eager reads', () => {
  const calls = [], f = setup((url) => { calls.push(url); return Response.json(preview()); });
  try {
    const hero = document.createElement('header'); hero.className = 'resource-hero'; f.dom.node('side-valets').append(hero);
    renderTree({ tasks: [], notices: [] }); renderTree({ tasks: [], notices: [] });
    expect(hero.querySelectorAll('.valet-emergency-control')).toHaveLength(1);
    expect(hero.querySelector('button').textContent).toBe('强制终结全部管家');
    expect(hero.querySelector('button').classList.contains('agent-call')).toBe(false);
    expect(hero.querySelector('button').dataset.help).toContain('不停止开发 Worker');
    expect(calls).toEqual([]);
  } finally { f.close(); }
});

test('full-scope preview, explicit cancellation and collapsed bounded details never mutate', async () => {
  const calls = [], f = setup((url, options) => { calls.push([url, options]); return Response.json(preview({ total: 105, affected_total: 105, items_truncated: true })); });
  let opening;
  try {
    ({ opening } = await open(f));
    expect(calls).toHaveLength(1); expect(calls[0][0]).toBe('/api/management/emergency-preview');
    expect(dialogText(f.dom)).toContain('本次影响 105 个');
    expect(dialogText(f.dom)).toContain('上述汇总及确认范围覆盖全部');
    expect(dialogText(f.dom)).toContain('不自动创建救援管家');
    expect(f.dom.node('modal').querySelector('details').open).not.toBe(true);
    const confirm = dialogButton(f.dom, '确认强制终结并解除占位');
    expect(confirm.classList.contains('agent-call')).toBe(false); expect(confirm.dataset.help).toContain('不回滚副作用');
    await dialogButton(f.dom, '关闭').onclick(); await opening;
    expect(calls).toHaveLength(1);
  } finally { f.close(); await opening; }
});

test('exact confirmation submits once, reports isolation and does not replay after refresh failure', async () => {
  const calls = [], f = setup((url, options) => {
    if (options?.method === 'POST') { calls.push(JSON.parse(options.body)); return Response.json(result()); }
    return Response.json(preview());
  }, async () => { throw new Error('refresh fixture'); });
  let opening;
  try {
    ({ opening } = await open(f));
    const confirm = dialogButton(f.dom, '确认强制终结并解除占位');
    const first = confirm.onclick(); await confirm.onclick(); await f.stop.onclick(); await first; await opening;
    expect(calls).toEqual([{ method: 'management.emergency_stop', params: { revision: 'exact-r1', confirm: true } }]);
    expect(deepText(f.root)).toContain('历史占位已解除');
    expect(deepText(f.root)).toContain('列表刷新失败'); expect(deepText(f.root)).toContain('不要重发');
    expect(f.dom.node('modal').hidden).toBe(true);
  } finally { f.close(); await opening; }
});

test('stopping shows actual blockers and reads current state without resubmitting the mutation', async () => {
  let checks = 0; const calls = [], f = setup((url, options) => {
    if (options?.method === 'POST') { calls.push(JSON.parse(options.body)); return Response.json(result({ status: 'stopping', isolated_total: 0, stopping_total: 1,
      blockers: [{ id: 801, worker_number: 'V12', kinds: ['provider_cleanup', 'control_owner', 'control_busy'] }], blockers_total: 1 })); }
    checks++; return Response.json(checks === 1 ? preview() : preview({ affected_total: 0, already_isolated_total: 1, items: [], totals: Object.fromEntries(Object.keys(totals).map(key => [key, 0])) }));
  });
  let opening;
  try {
    ({ opening } = await open(f)); await dialogButton(f.dom, '确认强制终结并解除占位').onclick(); await opening;
    expect(deepText(f.root)).toContain('尚未全部解除占位');
    expect(deepText(f.root)).toContain('V12：模型进程或退出清理尚未结束、受控操作尚未退出、受控操作仍在执行');
    expect(deepText(f.root)).not.toContain('可重新提交救援');
    await f.check.onclick();
    expect(deepText(f.root)).toContain('当前没有等待退出的急救事项');
    expect(deepText(f.root)).toContain('历史结果未知不代表已成功');
    expect(checks).toBe(2); expect(calls).toHaveLength(1);
  } finally { f.close(); await opening; }
});

test('unconfirmed write disables that confirmation until a fresh read, never silently retries a stale revision', async () => {
  let reads = 0, writes = 0; const f = setup((url, options) => {
    if (options?.method === 'POST') { writes++; return Response.json({ error: 'revision changed' }, { status: 400 }); }
    reads++; return Response.json(preview({ revision: `exact-r${reads}` }));
  });
  let opening;
  try {
    ({ opening } = await open(f)); const confirm = dialogButton(f.dom, '确认强制终结并解除占位');
    await confirm.onclick(); expect(confirm.disabled).toBe(true);
    expect(dialogText(f.dom)).toContain('终结结果未确认'); expect(dialogText(f.dom)).toContain('重新预检并确认');
    await confirm.onclick(); expect(writes).toBe(1);
    await dialogButton(f.dom, '关闭').onclick(); await opening;
    expect(f.stop.disabled).toBe(true); await f.stop.onclick(); expect(reads).toBe(1);
    await f.check.onclick(); expect(f.stop.disabled).toBe(false); expect(writes).toBe(1);
  } finally { f.close(); await opening; }
});

for (const bad of [{}, preview({ items_truncated: true }), preview({ totals: {} }), preview({ scope: 'device' })])
  test('incomplete or mismatched preflight fails closed without opening confirmation', async () => {
    let writes = 0; const f = setup((_url, options) => { if (options?.method === 'POST') writes++; return Response.json(bad); });
    try { await f.stop.onclick(); expect(deepText(f.root)).toContain('预检失败'); expect(f.dom.node('modal').hidden).toBe(true); expect(writes).toBe(0); }
    finally { f.close(); }
  });

test('already isolated scope needs no confirmation or mutation', async () => {
  let writes = 0; const f = setup((_url, options) => {
    if (options?.method === 'POST') writes++;
    return Response.json(preview({ affected_total: 0, already_isolated_total: 1, items: [], totals: Object.fromEntries(Object.keys(totals).map(key => [key, 0])) }));
  });
  try {
    await f.stop.onclick(); expect(deepText(f.root)).toContain('没有需要终结的管家');
    expect(f.dom.node('modal').hidden).toBe(true); expect(writes).toBe(0);
  } finally { f.close(); }
});

test('inconsistent completion response stays unconfirmed instead of falsely releasing the lane', async () => {
  let writes = 0; const f = setup((_url, options) => {
    if (options?.method === 'POST') { writes++; return Response.json(result({ blockers_total: 1 })); }
    return Response.json(preview());
  });
  let opening;
  try {
    ({ opening } = await open(f)); await dialogButton(f.dom, '确认强制终结并解除占位').onclick();
    expect(dialogText(f.dom)).toContain('急救结果不完整'); expect(deepText(f.root)).not.toContain('历史占位已解除');
    expect(dialogButton(f.dom, '确认强制终结并解除占位').disabled).toBe(true); expect(writes).toBe(1);
    await dialogButton(f.dom, '关闭').onclick(); await opening;
  } finally { f.close(); await opening; }
});

test('late preview cannot open a dialog in a different view or after project boot replacement', async () => {
  const response = gate(); const f = setup(() => response.promise);
  try {
    const opening = f.stop.onclick(); ui.workerNumbers = new Map(); ui.view = { id: 'overview' };
    response.resolve(Response.json(preview())); await opening;
    expect(f.dom.node('modal').hidden).toBe(true); expect(deepText(f.root)).not.toContain('已解除');
  } finally { f.close(); }
});

test('late mutation does not close a replacement dialog or repaint another project', async () => {
  const response = gate(); let writes = 0; const f = setup((_url, options) => {
    if (options?.method === 'POST') { writes++; return response.promise; }
    return Response.json(preview());
  });
  let opening, replacement;
  try {
    ({ opening } = await open(f)); const confirming = dialogButton(f.dom, '确认强制终结并解除占位').onclick();
    await until(() => writes === 1);
    f.dom.location.pathname = '/p/aaaaaaaaaaaaaaaa/'; ui.view = { id: 'overview' };
    replacement = formDialog({ title: '新项目的弹窗', content: document.createElement('div') });
    response.resolve(Response.json(result())); await confirming; await opening;
    expect(dialogText(f.dom)).toContain('新项目的弹窗'); expect(deepText(f.root)).not.toContain('历史占位已解除'); expect(writes).toBe(1);
  } finally { f.close(); await opening; await replacement; }
});

test('isolated historical unknown records remain unknown and never appear queued for replay', () => {
  const dom = installDom();
  try {
    const state = renderManagementState({ management: { version: 1, enabled: false, state: 'waiting_actions', emergency: { status: 'isolated' },
      pending_signal: { due_at: '2026-10-18T12:00:00Z', control_calls: [{ method: 'worker.retry', status: 'unknown' }] } } });
    expect(deepText(state)).toContain('历史占位已解除'); expect(deepText(state)).toContain('不会再次排队');
    expect(deepText(state)).toContain('结果待核验，不自动重放'); expect(deepText(state)).not.toContain('已提交待处理');
  } finally { dom.restore(); }
});
