import { test, expect, beforeEach, afterEach } from 'bun:test';
import { installDom, deepText } from '../dom-stub.js';
import { renderBranchConvergence, renderConvergenceRun } from '../../src/ui/web/assets/branch-convergence.js';
import { renderConvergenceAutomation } from '../../src/ui/web/assets/automation-completion.js';
import { openProjectAutomation } from '../../src/ui/web/assets/render-project-automation.js';
import { workerHooks } from '../../src/ui/web/assets/render-hooks.js';
import { activateDetailView } from '../../src/ui/web/assets/sidebar-ui.js';
import { ui } from '../../src/ui/web/assets/state.js';

let dom, reads;
beforeEach(() => {
  reads = [];
  dom = installDom({ fetch(url) { reads.push(url); throw Error('retired settings must not fetch'); } });
  activateDetailView({ view: 'overview' }); ui.automationPage = null;
});
afterEach(() => { ui.disposeProjectAutomation?.(); dom.restore(); });
const root = () => dom.node('detail');

test('old settings and history routes redirect to the existing directory without loading defaults or target handlers', async () => {
  for (const subpage of ['settings', 'history']) {
    await openProjectAutomation({ feature: 'convergence', subpage });
    expect(dom.location.hash).toBe('#hooks');
    expect(root().querySelectorAll('.automation-feature')).toHaveLength(3);
    expect(root().querySelector('[data-feature="convergence"]')).toBeNull();
    expect(root().querySelector('.convergence-defaults')).toBeNull();
    expect(dom.node('error').textContent).toContain('持续归并设置已退役');
  }
  expect(reads).toEqual([]);
});

test('retired component entry points cannot restore settings or execute legacy APIs', async () => {
  for (const node of [renderBranchConvergence(), renderConvergenceAutomation()]) {
    root().replaceChildren(node); await node.ready;
    expect(node.textContent).toContain('持续归并设置已退役');
    expect(node.querySelectorAll('button')).toHaveLength(0);
    expect(node.querySelectorAll('input')).toHaveLength(0);
  }
  expect(reads).toEqual([]);
});

test('child completion remains locked without a persistent target switch; old failures remain diagnostic only', () => {
  const node = workerHooks({ id: 2, task_kind: 'child', branch: 'feature', status: 'waiting',
    hooks: { version: 1, worker_id: 2, revision: 'r1', mounts: [], mounted_features: { completion: true, convergence: true, acceptance_notice: false, push: false },
      completion: { level: 'merge', min_level: 'merge', locked: true, editable: false, state: 'idle' },
      convergence: { version: 1, branch: 'feature', owner_id: 2, mounted: true, enabled: true, editable: true, revision: 'c1', reason: '旧现场需核查', counts: { failed: 2 } } } });
  expect(node.querySelectorAll('.hook-completion-level').every(button => button.disabled)).toBe(true);
  expect(node.querySelector('.worker-convergence-control')).toBeNull();
  expect(node.querySelector('[data-feature="convergence"]')).toBeNull();
  expect(node.querySelector('.hook-convergence-alert').textContent).toContain('旧现场需核查');
  expect(node.querySelector('.hook-convergence-alert').textContent).toContain('失败 2');
  expect(reads).toEqual([]);
});

test('legacy historical cards keep exact commits, real helpers, escaped titles and no retry actions', () => {
  let retries = 0;
  const run = { id: 55, target_branch: 'main', state: 'failed', error: '历史失败', revision: 'r1', baseline: 'a'.repeat(40), commit: 'b'.repeat(40), members_truncated: true,
    members: [{ id: 21, worker_number: 'W205-1', title: '<script>来源</script>', source_commit: 'c'.repeat(40), delivery_id: 101 }], integration_worker: { id: 23 } };
  const before = JSON.stringify(run), node = renderConvergenceRun(run, { retry() { retries++; } });
  expect(deepText(node)).toContain('历史失败'); expect(deepText(node)).toContain('不代表测试通过');
  expect(deepText(node)).toContain('候选提交（尚未确认落地）'); expect(deepText(node)).toContain('已截断');
  expect(deepText(node)).toContain('W205-1'); expect(deepText(node)).toContain('<script>来源</script>'); expect(node.querySelector('script')).toBeNull();
  expect(node.querySelectorAll('button')).toHaveLength(0); expect(retries).toBe(0); expect(JSON.stringify(run)).toBe(before);
});

for (const [state, label] of [['waiting', '等待验证'], ['not_started', '尚未执行'], ['failed', '失败'], ['blocked', '验证受阻'], ['future_state', '未知状态：future_state']]) {
  test(`historical validation ${state} never infers passing from landing`, () => {
    const node = renderConvergenceRun({ id: 55, state: 'integrated', validation: { state, command_name: '旧验证' } });
    expect(node.querySelector('.convergence-validation').textContent).toBe(`最终验证：旧验证 · ${label}`);
    expect(node.querySelector('.convergence-validation').textContent).not.toContain('通过'); expect(reads).toEqual([]);
  });
}
