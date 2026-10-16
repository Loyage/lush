import { test, expect } from 'bun:test';
import { installDom, deepText } from '../dom-stub.js';
import { resetUiState, ui } from '../../src/ui/web/assets/state.js';
import { renderWorkerRunner } from '../../src/ui/web/assets/worker-runner.js';

const runner = { node_id: 'node', runner_id: 'installation', generation: 1, revision: 4, state: 'unknown',
  authorized: false, barriers: { bindings: 1, runs: 1, receipts: 1 } };
const task = { id: 7, status: 'failed', runner };
const check = root => root.querySelectorAll('button').find(node => node.textContent === '核验远端现场');
const reload = root => root.querySelectorAll('button').find(node => node.textContent === '重新读取状态');
const result = { worker_id: 7, node_id: 'node', runner_id: 'installation', generation: 1, revision: 5, state: 'ready', reconciled: true, pending: 0 };
function setup(respond) {
  const writes = [];
  const dom = installDom({ fetch: async (url, options) => {
    writes.push({ url, ...JSON.parse(options.body) });
    return Response.json(await respond());
  } });
  resetUiState();
  return { writes, dom, close() { resetUiState(); dom.restore(); } };
}

test('explicit non-model check sends exact revision once across rerenders; ACK/read failure cannot trigger a replay', async () => {
  let finish, reads = 0;
  const f = setup(() => new Promise(resolve => { finish = resolve; }));
  try {
    const controls = { refresh: async () => { reads++; throw new Error('read failed'); } };
    const first = renderWorkerRunner(task, null, controls);
    expect(f.writes).toHaveLength(0);
    expect(check(first).classList.contains('agent-call')).toBe(false);
    expect(check(first).getAttribute('data-help')).toContain('不调用 Agent');
    const pending = check(first).onclick();
    const next = renderWorkerRunner(task, first, controls);
    expect(check(next).disabled).toBe(true);
    await check(next).onclick(); expect(f.writes).toHaveLength(1);
    expect(f.writes[0]).toMatchObject({ method: 'runner.worker.reconcile', params: { id: 7, expected_revision: 4 } });
    finish(result); await pending;
    expect(deepText(next)).toContain('核验通过'); expect(deepText(next)).toContain('页面更新失败');
    expect(check(next).disabled).toBe(true); expect(reads).toBe(1);
    await check(next).onclick(); expect(f.writes).toHaveLength(1);
  } finally { f.close(); }
});

for (const response of [{ ...result, reconciled: false, state: 'unknown', blocked_reason: 'evidence_incomplete_or_changed' },
  { ...result, worker_id: 8 }, { ...result, generation: 2 }, { ...result, pending: 1 }, { ...result, revision: 3 }])
  test(`HTTP 200 is not recovery proof: ${JSON.stringify(response)}`, async () => {
    const f = setup(() => response);
    try {
      const section = renderWorkerRunner(task, null, { refresh: async () => {} });
      await check(section).onclick();
      expect(deepText(section)).toContain('核验尚未通过'); expect(deepText(section)).not.toContain('核验通过；');
      expect(f.writes).toHaveLength(1);
      await reload(section).onclick(); expect(check(section).disabled).toBe(false);
      expect(f.writes).toHaveLength(1); // explicit read re-arms, never replays the check
    } finally { f.close(); }
  });

test('late response after navigation neither refreshes the new page nor reports success there', async () => {
  let finish, own = true, reads = 0;
  const f = setup(() => new Promise(resolve => { finish = resolve; }));
  try {
    const section = renderWorkerRunner(task, null, { ownsPage: () => own, refresh: async () => { reads++; } });
    const pending = check(section).onclick(); own = false; finish(result); await pending;
    expect(reads).toBe(0); expect(deepText(f.dom.node('messages'))).not.toContain('核验通过');
  } finally { f.close(); }
});

test('missing revision, offline and active Worker disable check; local/preparing/removed never offer it', async () => {
  const f = setup(() => result);
  try {
    for (const value of [{ ...task, runner: { ...runner, revision: undefined } }, { ...task, status: 'running' }]) {
      const root = renderWorkerRunner(value, null, {});
      expect(check(root).disabled).toBe(true); await check(root).onclick();
    }
    ui.offline = true;
    expect(check(renderWorkerRunner(task, null, {})).disabled).toBe(true);
    for (const value of [{ id: 7 }, { ...task, runner: { ...runner, state: 'preparing' } }, { ...task, runner: { ...runner, state: 'removed' } }])
      expect(check(renderWorkerRunner(value, null, {}))).toBeUndefined();
    expect(f.writes).toHaveLength(0);
  } finally { f.close(); }
});
