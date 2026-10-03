import { test, expect, afterAll } from 'bun:test';
import { installDom, dialogText, answerDialog, deepText } from '../dom-stub.js';
import { makeWorld } from './dom-world.js';

const world = makeWorld();
let syncResult;
let failedMethod = null;
let acceptGate = null;
const calls = [];
const dom = installDom({ fetch: async (url, options) => {
  if (String(url).endsWith('/api/action') && options?.body) {
    const request = JSON.parse(options.body);
    if (['worker.accept', 'worker.reopen', 'worker.sync_parent', 'worker.resolve_sync', 'branch.archive'].includes(request.method)) {
      calls.push(request);
      if (request.method === 'worker.accept' && acceptGate) await acceptGate;
      if (request.method === failedMethod) return new Response(JSON.stringify({ error: '安全检查拒绝' }), { status: 409 });
      return new Response(JSON.stringify(request.method === 'worker.sync_parent' ? syncResult : task));
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
ui.taskGraphMinimal = false; // 验证详情模式中的迭代操作。
afterAll(() => dom.restore());
const task = { id: 70, task_kind: 'order', role: 'agent', status: 'awaiting_acceptance', integration: 'merged',
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

const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

test('acceptance happens immediately; retaining the branch never undoes acceptance or starts Agent', async () => {
  let panel = render(task);
  const accept = buttonOf(panel, '验收完成');
  expect(accept.classList.contains('agent-call')).toBe(false);
  const pending = accept.onclick();
  expect(calls.at(-1)).toEqual({ method: 'worker.accept', params: { id: 70 } });
  expect(dialogText(dom)).not.toContain('验收 Worker');
  await flush();
  expect(dialogText(dom)).toContain('验收完成，是不是要直接归档？');
  expect(dialogText(dom)).toContain('不影响已完成的验收');
  await answerDialog(dom, '保留'); await pending;
  expect(calls.at(-1)).toEqual({ method: 'worker.accept', params: { id: 70 } });
  expect(calls.some(call => call.method === 'branch.archive' || call.method === 'worker.cleanup')).toBe(false);
  panel = render({ ...task, status: 'completed' });
  const reopen = buttonOf(panel, '继续开发'); expect(reopen.classList.contains('agent-call')).toBe(false);
  const reopening = reopen.onclick(); expect(dialogText(dom)).toContain('不会调用 Agent');
  await answerDialog(dom, '恢复待验收'); await reopening;
  expect(calls.at(-1)).toEqual({ method: 'worker.reopen', params: { id: 70 } });
  expect(iterationControls({ ...task, status: 'completed', accepted: true })).toBeNull();
  expect(iterationControls({ ...task, status: 'completed' }, { events: [{ type: 'task.accepted' }] })).toBeNull();
});

test('acceptance waits for success and suppresses duplicate clicks, then archives with one confirmation', async () => {
  let release;
  acceptGate = new Promise(resolve => { release = resolve; });
  const sequence = [];
  const panel = iterationControls({ ...task, branch_archive: { subtree_branches: 2 } },
    { refresh: () => { sequence.push(calls.at(-1).method); } });
  dom.node('detail').replaceChildren(panel);
  const accept = buttonOf(panel, '验收完成');
  const before = calls.length;
  const pending = accept.onclick();
  expect(accept.disabled).toBe(true);
  await accept.onclick(); await flush();
  expect(calls.slice(before)).toEqual([{ method: 'worker.accept', params: { id: 70 } }]);
  expect(dom.node('modal').hidden).toBe(true);
  release(); acceptGate = null; await flush();
  expect(sequence).toEqual(['worker.accept']);
  expect(dialogText(dom)).toContain('2 条后代分支');
  expect(dialogText(dom)).toContain('未提交改动会被丢弃');
  const archive = buttonOf(dom.node('modal'), '直接归档');
  expect(archive.classList.contains('agent-call')).toBe(false);
  expect(archive.getAttribute('data-help')).toContain('删除 worktree 与本地 ref');
  await answerDialog(dom, '直接归档'); await pending;
  expect(calls.slice(before)).toEqual([
    { method: 'worker.accept', params: { id: 70 } },
    { method: 'branch.archive', params: { branch: task.branch, discard: true } },
  ]);
  expect(sequence).toEqual(['worker.accept', 'branch.archive']);
  expect(dom.node('modal').hidden).toBe(true);
});

test('failed acceptance does not ask about archive; failed archive does not repeat or undo acceptance', async () => {
  const accept = buttonOf(render(task), '验收完成');
  failedMethod = 'worker.accept';
  let before = calls.length;
  await accept.onclick();
  expect(dom.node('modal').hidden).toBe(true);
  expect(accept.disabled).toBe(false);
  expect(calls.slice(before).map(call => call.method)).toEqual(['worker.accept']);
  expect(dom.node('error').textContent).toContain('安全检查拒绝');
  failedMethod = 'branch.archive'; before = calls.length;
  const pending = accept.onclick(); await flush();
  await answerDialog(dom, '直接归档'); await pending;
  expect(calls.slice(before).map(call => call.method)).toEqual(['worker.accept', 'branch.archive']);
  expect(dom.node('error').textContent).toContain('安全检查拒绝');
  await accept.onclick();
  expect(calls.slice(before).map(call => call.method)).toEqual(['worker.accept', 'branch.archive']);
  failedMethod = null;
});

test('refresh failure after successful acceptance still offers archive and never retries acceptance', async () => {
  const panel = iterationControls(task, { refresh: () => { throw new Error('刷新失败'); } });
  dom.node('detail').replaceChildren(panel);
  const accept = buttonOf(panel, '验收完成');
  const before = calls.length;
  const pending = accept.onclick(); await flush();
  expect(dom.node('error').textContent).toContain('刷新失败');
  expect(dialogText(dom)).toContain('验收完成，是不是要直接归档？');
  await answerDialog(dom, '保留'); await pending;
  await accept.onclick();
  expect(calls.slice(before).map(call => call.method)).toEqual(['worker.accept']);
});

test('detail and graph both accept first; closing the archive question retains the accepted task', async () => {
  for (const view of ['detail', 'graph']) {
    ui.lastSnapshot = null;
    if (view === 'detail') renderDetail(task, null, null, null);
    else {
      activateDetailView({ view: 'task-graph' });
      renderTaskGraph({ total: 1, nodes: [{ ...task, branch_info: { subtree_branches: 1 } }], edges: [] });
    }
    const before = calls.length;
    const pending = buttonOf(dom.node('detail'), '验收完成').onclick();
    await flush();
    expect(dialogText(dom)).toContain('是不是要直接归档');
    if (view === 'graph') expect(dialogText(dom)).toContain('1 条后代分支');
    dom.node('modal').onkeydown({ key: 'Escape', preventDefault() {} });
    await pending;
    expect(calls.slice(before).map(call => call.method)).toEqual(['worker.accept']);
  }
});

test('safe sync returns conflict diagnostics without Agent; conflict resolution is separately confirmed and purple', async () => {
  const row = { ...task };
  const panel = render(row); const sync = buttonOf(panel, '同步父分支');
  expect(sync.classList.contains('agent-call')).toBe(false);
  syncResult = { task, synced: false, conflict: true, source_commit: 'fixed-source', parent_commit: 'fixed-parent', reason: '文件冲突' };
  const count = calls.length;
  await sync.onclick();
  expect(calls.slice(count)).toEqual([{ method: 'worker.sync_parent', params: { id: 70 } }]);
  expect(deepText(panel)).toContain('fixed-parent'); expect(deepText(panel)).toContain('文件冲突');
  const solve = buttonOf(panel, 'Agent 解决同步冲突');
  expect(solve.classList.contains('agent-call')).toBe(true); expect(solve.getAttribute('data-help')).toContain('消耗 token');
  const solving = solve.onclick(); expect(dialogText(dom)).toContain('漂移');
  await answerDialog(dom, '调用 Agent'); await solving;
  expect(calls.at(-1)).toEqual({ method: 'worker.resolve_sync', params: { id: 70 } });
  syncResult = { task, synced: true, conflict: false, source_commit: 'source', parent_commit: 'parent' };
  await buttonOf(render(task), '同步父分支').onclick();
  expect(calls.at(-1).method).toBe('worker.sync_parent');
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
  expect(buttonOf(panel, '只回收 worktree（保留分支）')).toBeUndefined();
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
  expect(buttonOf(panel, '向此 Worker 输入').classList.contains('agent-call')).toBe(true);
  renderDetail({ ...task, status: 'waiting', integration: 'pending', head_commit: 'c'.repeat(40),
    merge_readiness: { ready: true, reason: null } }, null, null, null);
  expect(buttonOf(dom.node('detail'), '合并')).toBeTruthy();
  renderDetail({ ...task, status: 'completed', accepted: true }, null, null, null);
  expect(buttonOf(dom.node('detail'), '继续开发')).toBeUndefined();
});

test('completed task detail uses archive as its only worktree and branch reclamation action', () => {
  ui.lastSnapshot = null;
  for (const integration of ['merged', 'none', 'superseded']) {
    for (const archivable of [true, false]) {
      renderDetail({ ...task, status: 'completed', accepted: true, integration,
        branch_archive: { archivable, archived: false, subtree_branches: 0 } }, null, null, null);
      const panel = dom.node('detail');
      expect(buttonOf(panel, '回收工作区与分支')).toBeUndefined();
      expect(buttonOf(panel, '只回收 worktree（保留分支）')).toBeUndefined();
      const archive = buttonOf(panel, '归档');
      if (archivable) {
        expect(archive).toBeTruthy();
        expect(archive.getAttribute('data-help')).toContain('删除 worktree 与本地 ref');
        expect(archive.classList.contains('agent-call')).toBe(false);
      } else expect(archive).toBeUndefined();
    }
  }
});

test('delegated Tasks wait for parent confirmation, not user acceptance or mine filtering', () => {
  const child = { ...task, task_kind: 'child', integration: 'none', reservation: null };
  const panel = render(child);
  expect(statusOf(child).label).toBe('待父确认');
  expect(deepText(panel)).toContain('等待父 Worker #1');
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
  expect(deepText(panel)).toContain('1 个 Worker 等待验收');
  const metrics = panel.querySelectorAll('.metric');
  const acceptance = metrics.find(node => deepText(node).includes('待验收'));
  const active = metrics.find(node => deepText(node).includes('进行中'));
  expect(deepText(acceptance)).toContain('1'); expect(deepText(active)).toContain('0');
  renderDetail({ ...task, result: '本轮已测试并交付', runs: [] }, null, null, null);
  expect(deepText(dom.node('detail').querySelector('.result-panel'))).toContain('本轮已测试并交付');
});
