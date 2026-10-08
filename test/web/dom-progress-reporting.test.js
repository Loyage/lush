import { test, expect, afterAll } from 'bun:test';
import { installDom, deepText } from '../dom-stub.js';
import { makeWorld } from './dom-world.js';

const world = makeWorld();
let failSave = false;
const graph = { total: 3, truncated: false, nodes: [
  { id: 1, parent_id: null, role: 'agent', task_kind: 'main', title: 'main', status: 'waiting' },
  { id: 2, parent_id: 1, role: 'agent', task_kind: 'order', title: '有进度', status: 'running',
    progress: { total: 2, completed: 1, current: { label: '实现进度开关' } } },
  { id: 3, parent_id: 1, role: 'agent', task_kind: 'child', title: '无进度', status: 'running', progress: null },
] };
const dom = installDom({ fetch: (url, options) => {
  if (String(url).split('?')[0] === '/api/worker-graph') return { ok: true, json: async () => graph };
  if (failSave && String(url) === '/api/action') return { ok: false, status: 500, json: async () => ({ error: '保存失败测试' }) };
  return world.fetchImpl(url, options);
} });
const { boot } = await import('../../src/ui/web/assets/app.js');
const { ui } = await import('../../src/ui/web/assets/state.js');
const { renderTaskGraph } = await import('../../src/ui/web/assets/render-task-graph.js');
const { renderCompactProgress, renderTaskProgress, renderGraphProgress } = await import('../../src/ui/web/assets/render-progress.js');
const { renderSettings } = await import('../../src/ui/web/assets/render-settings.js');
afterAll(() => dom.restore());
const panel = () => dom.node('detail');
const checkbox = () => panel().querySelector('input[data-runtime-input="progress_reporting"]');
const openSettings = async () => {
  await dom.node('settings-open').onclick();
  await panel().querySelector('button[data-settings-tab="system"]').onclick();
  const scope = panel().querySelector('select[data-settings-scope=""]'); scope.value = 'project'; await scope.onchange();
};

test('system switch persists on/off, hides all progress UI including running placeholders, and restores it', async () => {
  await boot(); await openSettings();
  expect(checkbox().checked).toBe(true);
  expect(deepText(panel())).toContain('仅改变当前项目');
  const progress = { items: [
    { key: 'inspect', label: '检查进度', status: 'completed', duration_ms: 1000 },
    { key: 'implement', label: '实现进度', status: 'pending', started_at: new Date().toISOString() },
  ] };
  expect(renderCompactProgress(progress)).not.toBeNull();
  expect(renderTaskProgress(progress)).not.toBeNull();
  checkbox().checked = false; await checkbox().onchange();
  expect(world.state.actions.at(-1)).toMatchObject({ method: 'system.configure', params: { scope: 'project', settings: { progress_reporting: false } } });
  expect(checkbox().checked).toBe(false);
  expect(ui.lastSnapshot.status.settings.progress_reporting.value).toBe(false);
  expect(renderCompactProgress(progress)).toBeNull();
  expect(renderTaskProgress(progress)).toBeNull();
  expect(renderGraphProgress(progress, { running: true })).toBeNull();
  expect(renderGraphProgress(null, { running: true })).toBeNull();

  await dom.node('task-graph-open').onclick();
  for (const minimal of [false, true]) {
    ui.taskGraphMinimal = minimal; renderTaskGraph(graph);
    expect(panel().querySelector('.graph-task-progress')).toBeNull();
    expect(deepText(panel())).not.toMatch(/实现进度开关|等待 Agent 汇报计划|1\/2/);
  }
  await openSettings(); checkbox().checked = true; await checkbox().onchange();
  expect(world.state.runtimeSettings.progress_reporting.value).toBe(true);
  expect(checkbox().checked).toBe(true);
  expect(renderCompactProgress(progress)).not.toBeNull();
  expect(renderTaskProgress(progress)).not.toBeNull();
  await dom.node('task-graph-open').onclick();
  ui.taskGraphMinimal = false; renderTaskGraph(graph);
  expect(panel().querySelectorAll('.graph-task-progress')).toHaveLength(2);
  expect(deepText(panel())).toContain('实现进度开关');
  expect(deepText(panel())).toContain('等待 Agent 汇报计划');
  ui.taskGraphMinimal = true; renderTaskGraph(graph);
  expect(deepText(panel())).toContain('实现进度开关');
  expect(deepText(panel())).toContain('等待 Agent 汇报计划');
  // Older daemon snapshots without a switch still use the default enabled behavior.
  const entry = ui.lastSnapshot.status.settings.progress_reporting;
  delete ui.lastSnapshot.status.settings.progress_reporting;
  expect(renderTaskProgress(progress)).not.toBeNull();
  ui.lastSnapshot.status.settings.progress_reporting = entry;
});

test('failed saving rolls the checkbox back without changing effective settings', async () => {
  await openSettings();
  renderSettings();
  const input = checkbox(); input.checked = false;
  failSave = true;
  try {
    await input.onchange();
    expect(input.checked).toBe(true);
    expect(input.disabled).toBe(false);
    expect(deepText(panel())).toContain('保存失败测试');
    expect(world.state.runtimeSettings.progress_reporting.value).toBe(true);
  } finally { failSave = false; }
});
