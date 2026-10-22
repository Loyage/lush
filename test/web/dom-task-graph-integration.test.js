import { test, expect } from 'bun:test';
import { installDom, deepText, dialogButton, answerDialog } from '../dom-stub.js';
import { renderTaskGraph, openTaskGraph, loadTaskGraph, loadNextTaskGraph } from '../../src/ui/web/assets/render-task-graph.js';
import { setPref } from '../../src/ui/web/assets/prefs.js';
import { fetch as httpFetch, setup } from './harness.js';
import { repo, until } from '../helpers.js';
import { integrationSummary } from '../../src/ui/web/assets/render-integration.js';
import { resetUiState, ui } from '../../src/ui/web/assets/state.js';

const operation = state => ({ id: 40, revision: 'fixed-operation', target_branch: 'main', state,
  member_count: 2, members: [{ id: 2 }, { id: 3 }], worker: { id: 4, worker_number: 'W700' },
  error: ['failed', 'blocked'].includes(state) ? '完整错误诊断只在详情显示' : null });
const nodes = merge_operation => [
  { id: 1, task_kind: 'main', worker_number: 'W1', title: '目标', branch: 'main', status: 'waiting', merge_operation },
  { id: 2, parent_id: 1, task_kind: 'order', worker_number: 'W2', title: '来源', branch: 'lush/source', status: 'waiting',
    integration: 'pending', merge_operation },
  { id: 4, parent_id: 1, task_kind: 'integration', worker_number: 'W700', title: '不显示的辅助整合 Worker', status: 'running' },
];

for (const minimal of [true, false]) test(`tree ${minimal ? 'minimal' : 'detail'} cards disclose only current integration status`, () => {
  const dom = installDom(); resetUiState(); ui.view = { id: 'task-graph' }; ui.taskGraphMinimal = minimal;
  try {
    for (const [state, label] of [
      ['preparing', '合并处理中'], ['resolving', '合并处理中'], ['ready', '合并处理中'], ['landing', '合并处理中'],
      ['awaiting', '合并等待处理'], ['failed', '合并失败'], ['blocked', '落地待核验'], ['future', '合并状态待核查'],
      ['integrated', null], ['withdrawn', null], ['stale', null],
    ]) {
      const op = operation(state);
      renderTaskGraph({ nodes: nodes(op), edges: [], total: 3, archived_count: 2 });
      const panel = dom.node('detail'), cards = panel.querySelectorAll('.task-graph-card');
      expect(cards).toHaveLength(2);
      const hero = panel.querySelector('.task-graph-hero');
      expect(deepText(hero)).not.toContain('空白创建');
      expect(deepText(hero)).not.toContain('图中');
      expect(deepText(hero)).not.toContain('活动');
      expect(hero.querySelectorAll('.task-graph-status-toggle').length).toBeGreaterThan(0);
      const archived = hero.querySelector('.task-graph-archived-toggle');
      expect(archived.textContent).toBe('已回收 2');
      expect(archived.getAttribute('aria-pressed')).toBe('false');
      expect(archived.getAttribute('data-help')).toContain('已回收历史');
      expect(panel.querySelector('.integration-summary')).toBeNull();
      expect(deepText(panel)).not.toContain('W700');
      expect(deepText(panel)).not.toContain('个来源');
      expect(deepText(panel)).not.toContain('完整错误诊断');
      for (const card of cards) {
        const status = card.querySelector('.task-graph-integration-status');
        if (label) {
          expect(status?.textContent).toBe(label);
          expect(status.getAttribute('data-help')).toContain('当前 Worker 详情');
          expect(status.tabIndex).toBe(0);
        } else expect(status).toBeNull();
      }
      // Details retain the original helper link, scope and diagnostics.
      const detail = integrationSummary({ merge_operation: op });
      expect(deepText(detail)).toContain('2 个来源 · main');
      expect(deepText(detail)).toContain('整合 Worker W700');
      if (op.error) expect(deepText(detail)).toContain(op.error);
    }
    const incomplete = { state: 'resolving' };
    renderTaskGraph({ nodes: nodes(incomplete), edges: [], total: 3 });
    expect(dom.node('detail').querySelector('.task-graph-integration-status').textContent).toBe('合并状态待核查');
    expect(deepText(dom.node('detail'))).not.toContain('整合 Worker');
    const fold = dom.node('detail').querySelector('.task-graph-fold');
    expect(deepText(fold)).toBe('');
    expect(fold.getAttribute('aria-label')).toBe('收起 W1 的子 Worker');
    expect(fold.getAttribute('aria-expanded')).toBe('true');
    fold.onclick();
    expect(dom.node('detail').querySelectorAll('.task-graph-card')).toHaveLength(1);
    const reopen = dom.node('detail').querySelector('.task-graph-fold');
    expect(reopen.getAttribute('aria-expanded')).toBe('false');
    expect(reopen.querySelector('.view-disclosure-icon').dataset.expanded).toBe('false');
    reopen.onclick();
    expect(dom.node('detail').querySelectorAll('.task-graph-card')).toHaveLength(2);
  } finally { resetUiState(); dom.restore(); }
});

test('real project graph keeps serial branches, pages Valets inside main, and isolates filters/late responses', async () => {
  const f = await setup(); await repo(f.root); f.project.kick = () => {};
  // Real main is deliberately not internal ID 1. Legacy Valets keep their stored parent unchanged.
  f.store.create({ role: 'agent', goal: 'legacy non-tree row' });
  const main = await f.project.ensureMainTask();
  const source = f.store.create({ role: 'agent', task_kind: 'order', parent_id: main.id, goal: 'serial source' });
  f.store.update(source.id, { status: 'waiting', reservation: JSON.stringify({ version: 2, kind: 'merge', queue_protocol: 1, parent_id: main.id, status: 'executing' }) });
  f.project.provider = { async run() { return 'graph acceptance fixture'; } };
  const native = (await f.project.submitManagementInstruction({ instruction: '真实项目树验收链路' })).task;
  f.project.pump(); await Promise.all([...f.project.running.values()].map(run => run.promise));
  const managers = Array.from({ length: 204 }, (_, i) => {
    const task = f.store.create({ role: 'manager', task_kind: 'management', parent_id: i % 2 ? main.id : null, goal: `management ${i}` });
    f.store.update(task.id, { status: 'completed', management: JSON.stringify({ version: 1, config_revision: 1, enabled: false, consumed: true, state: 'succeeded', mode: 'once' }) });
    return task;
  }).concat(native);
  const accepted = managers[0], unknown = managers[1], latest = managers[100];
  f.store.run('UPDATE tasks SET agent_last_seen_at=? WHERE id=?', '2099-01-02T00:00:00.000Z', latest.id);
  f.store.run('UPDATE tasks SET agent_last_seen_at=? WHERE id=?', '2099-01-01T00:00:00.000Z', unknown.id);
  f.store.run('UPDATE tasks SET updated_at=? WHERE id=?', '2099-01-03T00:00:00.000Z', managers[203].id);
  f.store.event(accepted.id, 'task.accepted', { resources_reclaimed: true });
  f.store.update(unknown.id, { management: JSON.stringify({ version: 1, enabled: false, state: 'unknown', reason: '未知结果不能隐藏' }) });
  let hold = false, release, held;
  const dom = installDom({ fetch: async (url, options) => {
    const response = await httpFetch(f.url + url, options);
    if (hold && String(url).includes('worker-graph')) {
      hold = false; held?.(); await new Promise(resolve => { release = resolve; });
    }
    return response;
  } });
  resetUiState(); ui.taskGraphMinimal = true;
  try {
    await openTaskGraph(); await loadTaskGraph();
    const panel = dom.node('detail');
    expect(deepText(panel)).toContain('项目树');
    expect(ui.taskGraphPage.graph.nodes.length).toBe(200);
    expect(ui.taskGraphPage.graph.management_count).toBe(204);
    expect(ui.taskGraphPage.graph.has_more).toBe(true);
    expect(panel.querySelectorAll('.task-graph-card')).toHaveLength(2);
    expect(panel.querySelector('.task-graph-merge-own')).toBeTruthy();
    expect(panel.querySelector('.task-graph-integration-status')).toBeNull();
    expect(deepText(panel)).toContain('合并中');
    expect(deepText(panel.querySelector('.project-management-head'))).toContain('/ 204');
    const visibleValets = () => panel.querySelectorAll('.project-management-row').filter(row => !row.hidden);
    const managementToggle = () => panel.querySelector('.project-management-head').querySelector('button');
    expect(managementToggle().getAttribute('aria-expanded')).toBe('false');
    expect(visibleValets().map(row => row.dataset.valetId)).toEqual([String(latest.id)]);
    expect(ui.taskGraphPage.graph.nodes.find(row => row.id === latest.id).agent_last_seen_at).toBe('2099-01-02T00:00:00.000Z');
    expect(ui.taskGraphPage.graph.edges.some(edge => managers.some(row => row.id === edge.to))).toBe(false);
    await loadNextTaskGraph();
    expect(ui.taskGraphPage.graph.nodes.length).toBe(206);
    expect(panel.querySelectorAll('.project-management-row')).toHaveLength(204);
    expect(ui.taskGraphPage.graph.has_more).toBe(false);
    expect(visibleValets().map(row => row.dataset.valetId)).toEqual([String(latest.id)]);
    const fold = panel.querySelector('.project-management-head').querySelector('button');
    expect(fold.getAttribute('aria-expanded')).toBe('false');
    expect(panel.querySelector(`[data-valet-id="${unknown.id}"]`).hidden).toBe(true);
    await fold.onclick();
    expect(fold.getAttribute('aria-expanded')).toBe('true');
    expect(visibleValets()).toHaveLength(204);
    expect(deepText(panel)).toContain('未知结果不能隐藏');
    renderTaskGraph({ ...ui.taskGraphPage.graph, sampled_at: 'new sample' });
    expect(managementToggle().getAttribute('aria-expanded')).toBe('true');
    expect(visibleValets()).toHaveLength(204);
    await managementToggle().onclick();
    expect(visibleValets().map(row => row.dataset.valetId)).toEqual([String(latest.id)]);
    await managementToggle().onclick();
    expect(ui.taskGraphPage.graph.nodes.find(row => row.id === managers[2].id)).toMatchObject({ parent_id: null, project_parent_id: main.id });
    expect(f.store.task(managers[2].id).parent_id).toBeNull();
    expect(ui.taskGraphPage.graph.nodes.some(row => row.id === accepted.id)).toBe(false);
    // One old-filter response is delivered after the new filter has already rendered.
    hold = true;
    const started = new Promise(resolve => { held = resolve; });
    const late = loadTaskGraph(); await started;
    setPref('taskGraphStatuses', ['completed', 'waiting']);
    await loadTaskGraph();
    const filtered = ui.taskGraphPage;
    expect(filtered.graph.management_count).toBe(1);
    expect(panel.querySelectorAll('.project-management-row')).toHaveLength(1);
    expect(panel.querySelectorAll('.task-graph-card')).toHaveLength(0);
    expect(panel.querySelector('.project-main-anchor')).toBeTruthy();
    expect(deepText(panel)).toContain('未知结果不能隐藏');
    release(); await late;
    expect(ui.taskGraphPage).toBe(filtered);
    expect(panel.querySelectorAll('.project-management-row')).toHaveLength(1);
    setPref('taskGraphStatuses', []); await loadTaskGraph();
    await panel.querySelector('.task-graph-archived-toggle').onclick();
    await loadTaskGraph(); await loadNextTaskGraph();
    expect(panel.querySelectorAll('.project-management-row')).toHaveLength(205);
    expect(deepText(panel)).toContain('已验收');
    // Cross-change seam: actual native return -> graph projection -> shared control -> authenticated acceptance.
    const nativeNode = ui.taskGraphPage.graph.nodes.find(node => node.id === native.id);
    expect(nativeNode.management).toMatchObject({ accepted: false, can_accept: true, requires_confirmation: false });
    const nativeRow = panel.querySelector(`[data-valet-id="${native.id}"]`);
    const accepting = nativeRow.querySelectorAll('button').find(button => button.textContent === '验收').onclick();
    await until(() => dialogButton(dom, '验收归档'));
    await answerDialog(dom, '验收归档'); await accepting;
    expect(f.project.inspect(native.id).management).toMatchObject({ accepted: true, archived: true });
    await panel.querySelector('.task-graph-archived-toggle').onclick();
    await loadTaskGraph(); await loadNextTaskGraph();
    expect(panel.querySelector(`[data-valet-id="${native.id}"]`)).toBeNull();
    expect(deepText(panel)).toContain('未知结果不能隐藏');
    await managementToggle().onclick();
    ui.taskGraphLocator = unknown.id; ui.taskGraphLocated = false;
    renderTaskGraph(ui.taskGraphPage.graph);
    expect(managementToggle().getAttribute('aria-expanded')).toBe('true');
    expect(panel.querySelector(`[data-valet-id="${unknown.id}"]`).hidden).toBe(false);
    expect(ui.taskGraphLocated).toBe(true);
    // A fresh visit returns to the collapsed default, and a resumed old Valet wins.
    ui.view = { id: 'task-graph' }; ui.taskGraphLocator = null;
    const resumed = ui.taskGraphPage.graph.nodes.map(node => node.id === unknown.id
      ? { ...node, agent_last_seen_at: '2099-01-04T00:00:00.000Z' } : node);
    renderTaskGraph({ ...ui.taskGraphPage.graph, nodes: resumed });
    expect(managementToggle().getAttribute('aria-expanded')).toBe('false');
    expect(visibleValets().map(row => row.dataset.valetId)).toEqual([String(unknown.id)]);
  } finally { release?.(); resetUiState(); dom.restore(); await f.close(); }
});
