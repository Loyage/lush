import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { installDom, deepText, answerDialog } from '../dom-stub.js';
import { installDom as installProjectDom } from './project-dom.js';
import { makeWorld } from './dom-world.js';
import { renderDetail } from '../../src/ui/web/assets/render-detail.js';
import { renderTaskGraph } from '../../src/ui/web/assets/render-task-graph.js';
import { parentTasks } from '../../src/ui/web/assets/composer.js';
import { resetUiState, ui } from '../../src/ui/web/assets/state.js';
import { appendInputBlocker } from '../../src/ui/web/assets/worker-input.js';
import { deliveryControls } from '../../src/ui/web/assets/render-delivery.js';
import { iterationControls } from '../../src/ui/web/assets/render-iteration.js';
import { workerHooks } from '../../src/ui/web/assets/render-hooks.js';
import { workerDeleteControl, runWorkerDelete } from '../../src/ui/web/assets/worker-delete.js';
import { canClearOverride } from '../../src/ui/web/assets/worker-model-source.js';
import { integrationControl } from '../../src/ui/web/assets/render-integration.js';
import { retryTask, configureTask } from '../../src/ui/web/assets/retry-dialog.js';
import { mergeCandidates } from '../../src/ui/web/assets/merge-select.js';
import { settingsClient } from '../../src/ui/web/assets/settings-api.js';
import { createProjectOrderForm } from '../../src/ui/web/assets/project-order-form.js';
import { readDashboardConfig } from '../../src/ui/web/assets/dashboard-cards.js';
import { newWidget, validateWidgets, widgetRows } from '../../src/ui/web/assets/dashboard-widget-model.js';
import { aggregateLinks } from '../../src/ui/web/assets/dashboard-widget-aggregate-model.js';
import { dashboardPatch } from '../../src/ui/web/assets/dashboard-edit-model.js';
import { createDashboardPanel } from '../../src/ui/web/assets/dashboard-panel.js';

const at = '2026-10-17T12:00:00Z';
const worker = { id: 7, worker_number: 'W232', role: 'agent', task_kind: 'order', calls: 0,
  goal: '历史远端工作', branch: 'lush/history', target_branch: 'main', workspace: '/retired/workspace',
  base_commit: 'a'.repeat(40), head_commit: 'b'.repeat(40), created_at: at, updated_at: at,
  deps: [], dependents: [], children: [], execution_retired: true,
  branch_archive: { archivable: true }, model_selection: { explicit: true } };

test('retired Runner bookmarks are explicit read-only tombstones in root and project shells', async () => {
  for (const install of [installDom, installProjectDom]) for (const hash of ['#runners', '#settings-runners', '#runners-project-aaaaaaaaaaaaaaaa']) {
    const world = makeWorld(), calls = [];
    const dom = install({ fetch: (url, options) => { calls.push(String(url)); return world.fetchImpl(url, options); } });
    try {
      dom.location.hash = hash;
      const { boot } = await import('../../src/ui/web/assets/app.js'); await boot();
      expect(dom.node('detail').dataset.view).toBe('retired-execution');
      expect(deepText(dom.node('detail'))).toContain('执行节点已移除');
      expect(dom.node('detail').querySelectorAll('button')).toHaveLength(0);
      expect(calls.some(path => path.includes('/runner/'))).toBe(false);
    } finally { dom.restore(); }
  }
});

test('retired task detail preserves historical output and code reader but no mutation or recovery controls', () => {
  const dom = installDom(); resetUiState(); ui.view = { id: 'task', key: 'task-7' };
  try {
    for (const status of ['paused', 'failed', 'awaiting_acceptance', 'completed', 'waiting', 'running']) {
      // A late retirement projection must also drop an already-mounted editable Hook form.
      const previousHooks = document.createElement('section'); previousHooks.className = 'worker-hooks';
      previousHooks.dataset.hookEditing = 'true'; dom.node('detail').dataset.taskId = String(worker.id);
      dom.node('detail').append(previousHooks);
      const patches = renderDetail({ ...worker, status, integration: 'pending', acceptance_recovery: true },
        { events: [{ id: 1, type: 'invocation.completed', created_at: at, data: { run_id: 1, result: '保留的历史结果' } }] }, null, null, null, { current: () => true });
      try {
        const panel = dom.node('detail');
        expect(panel.querySelector('.execution-retired').textContent).toContain('不再续跑、迁移或回收');
        expect(deepText(panel)).toContain('保留的历史结果');
        expect(panel.querySelector('.code-reader-open')).toBeTruthy();
        expect(panel.querySelector('.worker-runner')).toBeNull();
        expect(panel.querySelector('.worker-hooks')).toBeNull();
        expect(panel.querySelector('.task-actions').querySelectorAll('button').map(node => node.textContent)).toEqual(['刷新详情']);
      } finally { patches.dispose(); }
    }
    const patches = renderDetail({ ...worker, execution_retired: undefined, status: 'paused' }, { events: [] }, null, null);
    expect(dom.node('detail').querySelector('.execution-retired')).toBeNull();
    expect(deepText(dom.node('detail').querySelector('.task-actions'))).toContain('开始');
    patches?.dispose?.();
  } finally { resetUiState(); dom.restore(); }
});

test('shared graph and detail controls reject retired tasks without making any API request', async () => {
  const calls = [], dom = installDom({ fetch: url => { calls.push(url); throw Error('unexpected request'); } });
  resetUiState();
  try {
    for (const status of ['paused', 'failed', 'awaiting_acceptance', 'completed']) {
      const task = { ...worker, status, integration: 'pending' };
      expect(appendInputBlocker(task)).toContain('已退役');
      for (const control of [deliveryControls, iterationControls, workerHooks, workerDeleteControl, integrationControl]) expect(control(task)).toBeNull();
      expect(canClearOverride(task)).toBe(false);
      expect(await runWorkerDelete(task)).toBe(false);
      expect(await retryTask(task)).toBe(false);
      expect(await configureTask(task)).toBe(false);
      expect(mergeCandidates([task])).toEqual([]);
      expect(mergeCandidates([task], { groups: [{ items: [{ id: task.id, source_task_id: task.id }] }] })).toEqual([]);
      expect(mergeCandidates([], { groups: [{ items: [task] }] })).toEqual([]);
      expect(parentTasks([task])).toEqual([]);
    }
    expect(calls).toEqual([]);
  } finally { resetUiState(); dom.restore(); }
});

test('Worker graph preserves retired cards and disallows mutating actions', () => {
  const dom = installDom(); resetUiState(); ui.view = { id: 'task-graph' }; ui.taskGraphMinimal = false;
  try {
    renderTaskGraph({ nodes: [{ ...worker, title: worker.goal, status: 'paused', parent_id: null }], edges: [] });
    const panel = dom.node('detail');
    expect(deepText(panel)).toContain('历史远端工作');
    expect(panel.querySelector('.execution-retired')).toBeTruthy();
    panel.querySelector('.task-graph-more-trigger').onclick();
    const labels = panel.querySelectorAll('button').map(node => node.textContent);
    for (const label of ['追加输入', '继续开发', '清理资源', '删除', '验收', '整合全部', '重命名']) expect(labels).not.toContain(label);
  } finally { resetUiState(); dom.restore(); }
});

test('device settings transport cannot call retired Runner reads or actions', async () => {
  const client = settingsClient();
  for (const path of ['nodes', 'credentials', 'ssh/aliases']) await expect(client.read(`/api/runner/${path}`)).rejects.toThrow('不属于配置管理');
  for (const method of ['runner.ssh.test', 'runner.nodes.set', 'runner.credentials.remove']) await expect(client.action(method)).rejects.toThrow('不属于配置管理');
});

test('project creation emits an ordinary local input without node selection or Runner reads', async () => {
  const world = makeWorld(), calls = [], dom = installDom({ fetch: (url, options) => {
    calls.push({ url: String(url), body: options?.body });
    if (String(url).endsWith('/api/action')) return Response.json({ emitted: true, draft_id: 42 });
    return world.fetchImpl(url, options);
  } });
  try {
    const { root } = createProjectOrderForm({ id: 'aaaaaaaaaaaaaaaa', name: '本机项目', running: true });
    const input = root.querySelector('textarea'); input.value = '新建本机工作'; input.oninput();
    await root.querySelector('button').onclick();
    expect(root.querySelector('.runner-input-choice')).toBeNull();
    expect(calls).toHaveLength(1);
    const request = JSON.parse(calls[0].body);
    expect(request.method).toBe('input.emit'); expect(request.params.content).toBe('新建本机工作');
    expect(Object.hasOwn(request.params, 'runner_node_id')).toBe(false);
  } finally { dom.restore(); }
});

const legacyDashboard = () => ({ version: 6, revision: 'legacy-runner-shortcut', cards: [], hidden_projects: [], layout: [], content: [],
  account_view: 'list', diagnostics: false, quick_actions: false, widgets: [{ ...newWidget('shortcuts', 'widget:legacy-navigation'),
    links: ['runners', 'settings', 'notices'].map(target => ({ scope: 'global', target, project_id: null })) }] });

test('legacy Runner shortcuts remain in the read document but never render or reappear in widget writes', async () => {
  const source = legacyDashboard(), original = structuredClone(source), config = await readDashboardConfig({ value: source });
  expect(config.widgets).toEqual(source.widgets); expect(source).toEqual(original);
  expect(aggregateLinks(config).map(link => link.target)).toEqual(['settings', 'notices']);
  expect(widgetRows(config.widgets, [], [])[0].links.map(link => link.target)).toEqual(['settings', 'notices']);
  expect(() => validateWidgets(source.widgets)).toThrow('独立卡片配置无效');
  await expect(readDashboardConfig({ value: { ...source, widgets: [{ ...source.widgets[0],
    links: [{ scope: 'global', target: 'unknown-future-page', project_id: null }] }] } })).rejects.toThrow();
  const edited = structuredClone(config); edited.widgets[0].links.push({ scope: 'global', target: 'docs', project_id: null });
  const patch = dashboardPatch(config, edited);
  expect(patch.widgets[0].links.map(link => link.target)).toEqual(['settings', 'notices', 'docs']);
  expect(() => validateWidgets(patch.widgets)).not.toThrow();
  expect(config.widgets).toEqual(source.widgets); expect(edited.widgets[0].links[0].target).toBe('runners');
  expect(dashboardPatch(config, { ...config, layout: [{ id: 'widget:legacy-navigation', x: 0, y: 0, w: 6, h: 8 }] })).not.toHaveProperty('widgets');
});

test('real dashboard read/edit/save path tolerates old Runner navigation and publishes only retained links', async () => {
  const source = legacyDashboard(), original = structuredClone(source), writes = [], world = makeWorld();
  const dom = installDom({ fetch: (url, options) => {
    if (String(url) === '/api/host/dashboard') {
      if (options?.method === 'POST') {
        const patch = JSON.parse(options.body); writes.push(patch);
        return Response.json({ ...source, ...patch, version: 7, revision: 'saved-navigation', quick_action_buttons: ['safe_restart', 'auto_select'] });
      }
      return Response.json(source);
    }
    return world.fetchImpl(url, options);
  } });
  let panel;
  try {
    panel = createDashboardPanel(); dom.node('detail').append(panel.root); await panel.ready();
    expect(panel.state().config).toBeTruthy();
    const links = panel.root.querySelector('.dashboard-global-direct-links').querySelectorAll('a');
    expect(links.map(link => link.getAttribute('href') || link.href)).toEqual(['/#settings', '/#notices']);
    panel.root.querySelector('.dashboard-layout-edit').onclick();
    panel.root.querySelector('.dashboard-settings-open').onclick();
    expect(dom.node('modal').querySelector('[data-link-target="runners"]')).toBeNull();
    const docs = dom.node('modal').querySelector('[data-link-target="docs"]');
    docs.checked = true; docs.onchange(); await answerDialog(dom, '应用到草稿');
    await panel.root.querySelector('.dashboard-layout-save').onclick();
    expect(writes).toHaveLength(1);
    expect(writes[0].widgets.flatMap(widget => widget.links).map(link => link.target)).toEqual(['settings', 'notices', 'docs']);
    expect(source).toEqual(original);
    expect(panel.state().failedWrite).toBe(false); expect(panel.state().editing).toBe(false);
  } finally { panel?.dispose(); dom.restore(); }
});

test('shell and dashboard remove node navigation while execution reader remains independently routed', () => {
  const asset = name => readFileSync(new URL(`../../src/ui/web/assets/${name}`, import.meta.url), 'utf8');
  expect(asset('index.html')).not.toContain('runners-open');
  expect(asset('index.html')).not.toContain('composer-runner-choice');
  expect(asset('dashboard-widget-model.js')).not.toContain("['runners'");
  expect(asset('app.js')).toContain("import('./execution-page.js')");
  expect(asset('app.js')).toContain("from './execution-route.js'");
});
