import { test, expect } from 'bun:test';
import { installDom, deepText } from '../dom-stub.js';
import { renderTaskGraph, openTaskGraph, loadTaskGraph, loadNextTaskGraph } from '../../src/ui/web/assets/render-task-graph.js';
import { setPref } from '../../src/ui/web/assets/prefs.js';
import { fetch as httpFetch, setup } from './harness.js';
import { repo, until } from '../helpers.js';
import { integrationSummary } from '../../src/ui/web/assets/render-integration.js';
import { resetUiState, ui } from '../../src/ui/web/assets/state.js';
import { registerNavigation } from '../../src/ui/web/assets/navigate.js';

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

test('real development graph pages branches, links only running Valets on main, and isolates filters/late responses', async () => {
  const f = await setup(); await repo(f.root); f.project.kick = () => {};
  f.store.create({ role: 'agent', goal: 'legacy non-tree row' });
  const main = await f.project.ensureMainTask();
  const sources = Array.from({ length: 204 }, (_, i) => {
    const task = f.store.create({ role: 'agent', task_kind: 'order', parent_id: main.id, goal: `source ${i}` });
    f.store.update(task.id, { status: 'waiting' }); return task;
  });
  f.store.update(sources[0].id, { reservation: JSON.stringify({ version: 2, kind: 'merge', queue_protocol: 1, parent_id: main.id, status: 'executing' }) });
  const managers = Array.from({ length: 204 }, (_, i) => {
    const task = f.store.create({ role: 'manager', task_kind: 'management', parent_id: i % 2 ? main.id : null, goal: `management ${i}` });
    f.store.update(task.id, { status: 'completed', management: JSON.stringify({ version: 1, enabled: false, state: i ? 'succeeded' : 'unknown', reason: '不显示历史管理诊断' }) });
    return task;
  });
  f.store.event(managers[1].id, 'task.accepted', { resources_reclaimed: true });
  let finishRun;
  const running = new Promise(resolve => { finishRun = resolve; });
  f.project.provider = { async run() { await running; return 'Valet finished'; } };
  const native = (await f.project.submitManagementInstruction({ instruction: '真实开发树运行标签链路' })).task;
  f.project.pump(); await until(() => f.store.task(native.id).status === 'running');
  let hold = false, release, held, opened;
  const dom = installDom({ fetch: async (url, options) => {
    const response = await httpFetch(f.url + url, options);
    if (hold && String(url).includes('worker-graph')) {
      hold = false; held?.(); await new Promise(resolve => { release = resolve; });
    }
    return response;
  } });
  const restoreNavigation = registerNavigation({ detail: async id => {
    opened = await (await httpFetch(`${f.url}/api/worker/${id}`)).json();
  } });
  resetUiState(); ui.taskGraphMinimal = true;
  try {
    await openTaskGraph(); await loadTaskGraph();
    const panel = dom.node('detail');
    const links = () => panel.querySelectorAll('.task-graph-valet-link');
    expect(deepText(panel)).toContain('开发树');
    expect(panel.querySelector('.project-management')).toBeNull();
    expect(deepText(panel)).not.toContain('不显示历史管理诊断');
    expect(ui.taskGraphPage.graph.nodes).toHaveLength(200);
    expect(ui.taskGraphPage.graph.management_count).toBe(1);
    expect(ui.taskGraphPage.graph.counts.waiting).toBe(205);
    expect(ui.taskGraphPage.graph.counts.completed).toBe(0);
    expect(ui.taskGraphPage.graph.archived_count).toBe(0);
    expect(ui.taskGraphPage.graph.has_more).toBe(true);
    expect(links()).toHaveLength(1);
    expect(deepText(links()[0])).toBe(`Valet ${native.worker_number} · 运行中`);
    expect(panel.querySelector(`[data-task-id="${main.id}"]`).querySelector('.task-graph-valet-link')).toBe(links()[0]);
    await links()[0].onclick();
    expect(opened.id).toBe(native.id);
    await loadNextTaskGraph();
    expect(ui.taskGraphPage.graph.nodes).toHaveLength(206);
    expect(panel.querySelectorAll('.task-graph-card')).toHaveLength(205);
    expect(panel.querySelector('.task-graph-merge-own')).toBeTruthy();
    expect(ui.taskGraphPage.graph.edges.some(edge => edge.to === native.id)).toBe(false);
    expect(ui.taskGraphPage.graph.has_more).toBe(false);
    // Development folding does not hide the main-node running link.
    panel.querySelector('.task-graph-fold').onclick(); expect(links()).toHaveLength(1);
    panel.querySelector('.task-graph-fold').onclick();
    hold = true;
    const started = new Promise(resolve => { held = resolve; });
    const late = loadTaskGraph(); await started;
    setPref('taskGraphStatuses', ['completed', 'waiting', 'running']); await loadTaskGraph();
    const filtered = ui.taskGraphPage;
    expect(panel.querySelectorAll('.task-graph-card')).toHaveLength(0);
    expect(panel.querySelector('.project-main-anchor')).toBeTruthy();
    expect(links()).toHaveLength(1);
    release(); await late; expect(ui.taskGraphPage).toBe(filtered);
    setPref('taskGraphStatuses', ['waiting']); await loadTaskGraph();
    // Completed/unknown/accepted Valets never return, including with archives enabled.
    ui.taskGraphShowArchived = true; await loadTaskGraph();
    expect(links()).toHaveLength(1);
    finishRun(); await Promise.all([...f.project.running.values()].map(run => run.promise));
    await loadTaskGraph(); expect(links()).toHaveLength(0);
    expect(panel.querySelector('.project-main-anchor')).toBeNull();
    expect(panel.querySelector('.project-management')).toBeNull();
    expect(f.store.task(managers[2].id).parent_id).toBeNull();
    const history = await (await httpFetch(`${f.url}/api/worker-graph?details=0&scope=all`)).json();
    expect(history.management_count).toBe(205);
  } finally {
    release?.(); finishRun(); await Promise.all([...f.project.running.values()].map(run => run.promise));
    restoreNavigation(); resetUiState(); dom.restore(); await f.close();
  }
});
