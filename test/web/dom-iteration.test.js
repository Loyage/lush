import { test, expect, afterAll } from 'bun:test';
import { installDom, dialogText, answerDialog, deepText } from '../dom-stub.js';
import { makeWorld } from './dom-world.js';

const world = makeWorld();
let syncResult;
const calls = [];
const dom = installDom({ fetch: async (url, options) => {
  if (String(url).endsWith('/api/action') && options?.body) {
    const request = JSON.parse(options.body);
    if (['task.accept', 'task.reopen', 'task.sync_parent', 'task.resolve_sync'].includes(request.method)) {
      calls.push(request);
      return new Response(JSON.stringify(request.method === 'task.sync_parent' ? syncResult : task));
    }
  }
  return world.fetchImpl(url, options);
} });
const { iterationControls } = await import('../../src/ui/web/assets/render-iteration.js');
const { renderDetail } = await import('../../src/ui/web/assets/render-detail.js');
const { renderTaskGraph } = await import('../../src/ui/web/assets/render-task-graph.js');
const { activateDetailView } = await import('../../src/ui/web/assets/sidebar-ui.js');
const { STATUS, HOT, TERMINAL_STATUS, statusOf } = await import('../../src/ui/web/assets/format.js');
const { parentTasks } = await import('../../src/ui/web/assets/composer.js');
const { matchTask } = await import('../../src/ui/web/assets/sidebar.js');
const { renderOverview } = await import('../../src/ui/web/assets/render-overview.js');
const { ui } = await import('../../src/ui/web/assets/state.js');
afterAll(() => dom.restore());
const task = { id: 70, task_kind: 'say', role: 'agent', status: 'awaiting_acceptance', integration: 'merged',
  parent_id: 1, goal: 'iterate', title: 'iterate', branch: 'feature/iterate', target_branch: 'main', workspace: '/tmp/work',
  accepted: false, parent_sync_conflict: null, calls: 0, reservation: { version: 2, kind: 'merge', status: 'integrated' }, children: [], deps: [], dependents: [],
  base_commit: 'a'.repeat(40), iteration_base_commit: 'b'.repeat(40), head_commit: 'b'.repeat(40) };
const buttonOf = (root, label) => root.querySelectorAll('button').find(node => node.textContent === label);
const render = row => { const panel = iterationControls(row); dom.node('detail').replaceChildren(panel); return panel; };

test('acceptance is non-terminal, visible and eligible as a parent; freezing still excludes it', () => {
  expect(STATUS.awaiting_acceptance.label).toBe('待验收');
  expect(HOT.has(task.status)).toBe(true); expect(TERMINAL_STATUS.has(task.status)).toBe(false);
  expect(parentTasks([task])).toEqual([task]);
  expect(matchTask(task, { mine: true })).toBe(true);
  expect(matchTask(task, { status: ['awaiting_acceptance'] })).toBe(true);
  expect(matchTask(task, { status: ['completed'] })).toBe(false);
  expect(parentTasks([{ ...task, reservation: { status: 'requested' } }])).toEqual([]);
  expect(parentTasks([{ ...task, branch_info: { archived: true } }])).toEqual([]);
});

test('acceptance and reopen never start Agent, and acceptance never archives', async () => {
  let panel = render(task);
  const accept = buttonOf(panel, '验收完成');
  expect(accept.classList.contains('agent-call')).toBe(false);
  const pending = accept.onclick(); expect(dialogText(dom)).toContain('不删除');
  await answerDialog(dom, '验收完成'); await pending;
  expect(calls.at(-1)).toEqual({ method: 'task.accept', params: { id: 70 } });
  expect(calls.some(call => call.method === 'branch.archive' || call.method === 'task.cleanup')).toBe(false);
  panel = render({ ...task, status: 'completed' });
  const reopen = buttonOf(panel, '继续开发'); expect(reopen.classList.contains('agent-call')).toBe(false);
  const reopening = reopen.onclick(); expect(dialogText(dom)).toContain('不会调用 Agent');
  await answerDialog(dom, '恢复待验收'); await reopening;
  expect(calls.at(-1)).toEqual({ method: 'task.reopen', params: { id: 70 } });
  expect(iterationControls({ ...task, status: 'completed', accepted: true })).toBeNull();
  expect(iterationControls({ ...task, status: 'completed' }, { events: [{ type: 'task.accepted' }] })).toBeNull();
});

test('safe sync returns conflict diagnostics without Agent; conflict resolution is separately confirmed and purple', async () => {
  const row = { ...task };
  const panel = render(row); const sync = buttonOf(panel, '同步父分支');
  expect(sync.classList.contains('agent-call')).toBe(false);
  syncResult = { task, synced: false, conflict: true, source_commit: 'fixed-source', parent_commit: 'fixed-parent', reason: '文件冲突' };
  const count = calls.length;
  await sync.onclick();
  expect(calls.slice(count)).toEqual([{ method: 'task.sync_parent', params: { id: 70 } }]);
  expect(deepText(panel)).toContain('fixed-parent'); expect(deepText(panel)).toContain('文件冲突');
  const solve = buttonOf(panel, 'Agent 解决同步冲突');
  expect(solve.classList.contains('agent-call')).toBe(true); expect(solve.getAttribute('data-help')).toContain('消耗 token');
  const solving = solve.onclick(); expect(dialogText(dom)).toContain('漂移');
  await answerDialog(dom, '调用 Agent'); await solving;
  expect(calls.at(-1)).toEqual({ method: 'task.resolve_sync', params: { id: 70 } });
  syncResult = { task, synced: true, conflict: false, source_commit: 'source', parent_commit: 'parent' };
  await buttonOf(render(task), '同步父分支').onclick();
  expect(calls.at(-1).method).toBe('task.sync_parent');
});

test('disabled archived, busy and frozen iteration actions explain why on help-host', () => {
  for (const row of [{ ...task, branch_info: { archived: true } }, { ...task, status: 'running' },
    { ...task, freeze: { task_id: 99 } }, { ...task, reservation: { status: 'requested' } }]) {
    const panel = render(row), sync = buttonOf(panel, '同步父分支');
    expect(sync.disabled).toBe(true); expect(sync.parentNode.classList.contains('help-host')).toBe(true);
    expect(sync.parentNode.getAttribute('data-help').length).toBeGreaterThan(10);
  }
  expect(iterationControls({ ...task, status: 'completed', branch: null })).toBeNull();
  expect(iterationControls({ ...task, status: 'completed', workspace: null })).toBeNull();
  expect(iterationControls({ ...task, status: 'completed', branch_info: { archived: true } })).toBeNull();
  const parent = render({ ...task, children: [{ id: 71, status: 'awaiting_acceptance' }] });
  const accept = buttonOf(parent, '验收完成');
  expect(accept.disabled).toBe(true); expect(accept.parentNode.getAttribute('data-help')).toContain('后代');
});

test('detail and graph expose the same awaiting acceptance actions and continuing delivery', () => {
  ui.lastSnapshot = null;
  renderDetail({ ...task, branch_archive: { archivable: true } }, null, null, null);
  let panel = dom.node('detail');
  expect(buttonOf(panel, '归档')).toBeUndefined();
  expect(buttonOf(panel, '回收工作区与分支')).toBeUndefined();
  expect(deepText(panel)).toContain('无需你逐个验收');
  expect(buttonOf(panel, '追加输入').classList.contains('agent-call')).toBe(true);
  expect(buttonOf(panel, '验收完成')).toBeTruthy(); expect(buttonOf(panel, '同步父分支')).toBeTruthy();
  expect(buttonOf(panel, '中断')).toBeUndefined(); expect(buttonOf(panel, '已解决')).toBeUndefined();
  activateDetailView({ view: 'task-graph' });
  renderTaskGraph({ total: 1, nodes: [{ ...task, branch_info: { archivable: true } }], edges: [] });
  panel = dom.node('detail').querySelector('[data-task-id="70"]');
  expect(panel.classList.contains('task-graph-awaiting_acceptance')).toBe(true);
  expect(buttonOf(panel, '归档')).toBeUndefined();
  expect(buttonOf(panel, '验收完成')).toBeTruthy(); expect(buttonOf(panel, '同步父分支')).toBeTruthy();
  expect(buttonOf(panel, '向此 Task 输入').classList.contains('agent-call')).toBe(true);
  renderDetail({ ...task, status: 'waiting', integration: 'pending', head_commit: 'c'.repeat(40),
    merge_readiness: { ready: true, reason: null } }, null, null, null);
  expect(buttonOf(dom.node('detail'), '合并到父 Task')).toBeTruthy();
  renderDetail({ ...task, status: 'completed', accepted: true }, null, null, null);
  expect(buttonOf(dom.node('detail'), '继续开发')).toBeUndefined();
});

test('delegated Tasks wait for parent confirmation, not user acceptance or mine filtering', () => {
  const child = { ...task, task_kind: 'child', integration: 'none', reservation: null };
  const panel = render(child);
  expect(statusOf(child).label).toBe('待父确认');
  expect(deepText(panel)).toContain('等待父 Task #1');
  expect(buttonOf(panel, '验收完成')).toBeUndefined();
  expect(matchTask(child, { mine: true })).toBe(false);
  expect(matchTask(child, { mine: true, openNoticeIds: [child.id] })).toBe(true);
  ui.overviewKey = null;
  renderOverview({ tasks: [child], notices: [], status: { agents: [] } });
  expect(deepText(dom.node('detail'))).toContain('等待父 Agent 确认');
  const acceptance = dom.node('detail').querySelectorAll('.metric').find(node => deepText(node).includes('待验收'));
  expect(acceptance.querySelector('.metric-value').textContent).toBe('0');
  renderDetail(child, null, null, null);
  expect(buttonOf(dom.node('detail'), '验收完成')).toBeUndefined();
  activateDetailView({ view: 'task-graph' });
  renderTaskGraph({ total: 1, nodes: [child], edges: [] });
  expect(buttonOf(dom.node('detail'), '验收完成')).toBeUndefined();
});

test('overview counts acceptance separately, and latest result remains readable while awaiting acceptance', () => {
  ui.overviewKey = null;
  renderOverview({ tasks: [task], notices: [], status: { agents: [] } });
  const panel = dom.node('detail');
  expect(deepText(panel)).toContain('1 个 Task 等待验收');
  const metrics = panel.querySelectorAll('.metric');
  const acceptance = metrics.find(node => deepText(node).includes('待验收'));
  const active = metrics.find(node => deepText(node).includes('进行中'));
  expect(deepText(acceptance)).toContain('1'); expect(deepText(active)).toContain('0');
  renderDetail({ ...task, result: '本轮已测试并交付', runs: [] }, null, null, null);
  expect(deepText(dom.node('detail').querySelector('.result-panel'))).toContain('本轮已测试并交付');
});
