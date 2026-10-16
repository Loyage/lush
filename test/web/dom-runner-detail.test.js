import { test, expect } from 'bun:test';
import { installDom, deepText } from '../dom-stub.js';
import { renderWorkerRunner } from '../../src/ui/web/assets/worker-runner.js';
import { renderDetail } from '../../src/ui/web/assets/render-detail.js';
import { resetUiState } from '../../src/ui/web/assets/state.js';

const runner = { node_id: '11111111-1111-4111-8111-111111111111', runner_id: 'installation', workspace_id: 'workspace-7',
  generation: 3, state: 'ready', head_commit: 'a'.repeat(40), authorized: true, barriers: { bindings: 0, runs: 0, receipts: 0 } };
const worker = (id = 7, extra = {}) => ({ id, role: 'agent', task_kind: 'order', status: 'waiting', goal: '位置', calls: 0,
  created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z', runner, ...extra });
function fixture(run) {
  const dom = installDom({ fetch: () => Promise.resolve({ ok: true, json: async () => ({}) }) }); resetUiState();
  try { run(dom); } finally { resetUiState(); dom.restore(); }
}

test('missing binding remains local; fixed remote facts and zero barriers never imply online or live HEAD', () => fixture(() => {
  expect(deepText(renderWorkerRunner({}))).toBe('执行环境：本地');
  const section = renderWorkerRunner(worker());
  expect(deepText(section)).toContain('代次 3');
  expect(deepText(section)).toContain('中央已接收 HEAD');
  expect(deepText(section)).toContain('不是远端实时 HEAD');
  expect(deepText(section)).toContain('屏障为 0 不证明在线');
  expect(deepText(section)).toContain('项目授权不等于设备已启用或连接可用');
  expect(section.querySelector('.worker-runner-warning')).toBeNull();
  expect(section.querySelector('.worker-runner-details').open).toBe(false);
  expect(section.querySelectorAll('button')).toHaveLength(0);
}));

test('all known unsettled kinds and unknown counts are visible outside advanced details', () => fixture(() => {
  for (const barriers of [{ bindings: 1, runs: 2, receipts: 3 }, {}, { bindings: -1, runs: '0', receipts: null }]) {
    const section = renderWorkerRunner(worker(7, { runner: { ...runner, state: 'unknown', authorized: false, barriers } }));
    const warnings = section.querySelectorAll('.worker-runner-warning');
    expect(warnings).toHaveLength(3);
    expect(warnings.every(node => node.parentNode === section)).toBe(true);
    expect(warnings[0].textContent).toContain('写入结果或停止证据尚未核实');
    expect(warnings[1].textContent).toContain('不代表进程已停止');
    expect(warnings[2].textContent).toContain('工作区／同步');
    expect(warnings[2].textContent).toContain('Run');
    expect(warnings[2].textContent).toContain('操作收据');
  }
}));

test('preparing and malformed future state stay visibly uncertain; strings are text, never HTML', () => fixture(() => {
  const pending = renderWorkerRunner(worker(7, { runner: { ...runner, state: 'preparing' } }));
  expect(pending.querySelector('.worker-runner-warning').textContent).toContain('尚未确认');
  const unknown = renderWorkerRunner(worker(7, { runner: { ...runner, state: 'unexpected', authorized: undefined,
    node_id: '<img src=x onerror=alert(1)>', runner_id: '<script>bad()</script>' } }));
  expect(deepText(unknown)).toContain('远端现场未知');
  expect(deepText(unknown)).toContain('授权状态未知');
  expect(unknown.querySelector('img')).toBeNull(); expect(unknown.querySelector('script')).toBeNull();
}));

test('detail keeps diagnostics outside reading folds and preserves expansion only for the same Worker', () => fixture(dom => {
  const panel = dom.node('detail');
  renderDetail(worker(), null, null, null);
  panel.querySelector('.worker-runner-details').open = true;
  renderDetail(worker(7, { runner: { ...runner, state: 'unknown', barriers: { bindings: 1, runs: 0, receipts: 2 } } }), null, null, null);
  const section = panel.querySelector('.worker-runner');
  expect(section.parentNode).toBe(panel);
  expect(section.classList.contains('ui-module')).toBe(false);
  expect(section.querySelector('.worker-runner-details').open).toBe(true);
  expect(section.querySelectorAll('.worker-runner-warning').every(node => node.parentNode === section)).toBe(true);
  renderDetail(worker(8), null, null, null);
  expect(panel.querySelector('.worker-runner-details').open).toBe(false);
  renderDetail(worker(8, { role: 'manager', task_kind: 'management' }), null, null, null);
  expect(panel.querySelector('.worker-runner')).toBeNull();
}));
