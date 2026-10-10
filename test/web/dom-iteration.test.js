import { test, expect, afterAll } from 'bun:test';
import { installDom, dialogText, answerDialog, deepText } from '../dom-stub.js';
import { makeWorld } from './dom-world.js';

const world = makeWorld();
let syncResult;
let failedMethod = null;
let acceptGate = null;
let acceptResponse = null;
const calls = [];
const dom = installDom({ fetch: async (url, options) => {
  if (String(url).endsWith('/api/action') && options?.body) {
    const request = JSON.parse(options.body);
    if (['worker.accept', 'worker.reopen', 'worker.sync_parent', 'worker.resolve_sync', 'branch.archive'].includes(request.method)) {
      calls.push(request);
      if (request.method === 'worker.accept' && acceptGate) await acceptGate;
      if (request.method === failedMethod) return new Response(JSON.stringify({ error: '安全检查拒绝' }), { status: 409 });
      return new Response(JSON.stringify(request.method === 'worker.sync_parent' ? syncResult
        : request.method === 'worker.accept' ? acceptResponse || { ...task, status: 'completed', workspace: null } : task));
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
dom.node('modal').hidden = true;
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

test('one acceptance immediately authorizes reclamation without extra RPC or Agent call', async () => {
  const panel = render(task), accept = buttonOf(panel, '验收');
  expect(buttonOf(panel, '仅验收')).toBeUndefined(); expect(buttonOf(panel, '验收并归档')).toBeUndefined();
  expect(accept.classList.contains('agent-call')).toBe(false);
  expect(accept.getAttribute('data-help')).toContain('不再有异议');
  expect(accept.getAttribute('data-help')).toContain('worktree 与本地 ref');
  expect(accept.getAttribute('data-help')).toContain('脏工作区');
  const before = calls.length;
  await accept.onclick(); await accept.onclick();
  expect(calls.slice(before)).toEqual([{ method: 'worker.accept', params: { id: 70 } }]);
  expect(dom.node('modal').hidden).toBe(true);
  expect(iterationControls({ ...task, status: 'completed', accepted: true, archived: true })).toBeNull();
  const historical = render({ ...task, status: 'completed' });
  const reopening = buttonOf(historical, '继续开发').onclick();
  expect(dialogText(dom)).toContain('不会调用 Agent'); await answerDialog(dom, '恢复待验收'); await reopening;
  expect(calls.at(-1)).toEqual({ method: 'worker.reopen', params: { id: 70 } });
  const recovery = render({ ...task, status: 'completed', accepted: true });
  expect(deepText(recovery)).toContain('再次验收补办'); expect(buttonOf(recovery, '同步父分支')).toBeUndefined();
});

test('acceptance in flight suppresses repeated clicks and never requests a separate archive', async () => {
  let release; acceptGate = new Promise(resolve => { release = resolve; });
  let refreshed = 0;
  const panel = iterationControls(task, { refresh: () => { refreshed++; } });
  dom.node('detail').replaceChildren(panel);
  const accept = buttonOf(panel, '验收'), before = calls.length;
  const pending = accept.onclick();
  expect(accept.disabled).toBe(true); await accept.onclick(); await flush();
  expect(calls.slice(before)).toEqual([{ method: 'worker.accept', params: { id: 70 } }]);
  release(); acceptGate = null; await pending;
  expect(refreshed).toBe(1);
  expect(calls.slice(before).map(call => call.method)).toEqual(['worker.accept']);
});

test('failed unified acceptance stays retryable and does not claim success or separately delete resources', async () => {
  const accept = buttonOf(render(task), '验收'), before = calls.length;
  failedMethod = 'worker.accept'; await accept.onclick();
  expect(accept.disabled).toBe(false); expect(dom.node('error').textContent).toContain('安全检查拒绝');
  expect(calls.slice(before).map(call => call.method)).toEqual(['worker.accept']);
  failedMethod = null; await accept.onclick(); await accept.onclick();
  expect(calls.slice(before).map(call => call.method)).toEqual(['worker.accept', 'worker.accept']);
});

test('refresh failure after successful acceptance cannot repeat the destructive mutation', async () => {
  const panel = iterationControls(task, { refresh: () => { throw new Error('刷新失败'); } });
  dom.node('detail').replaceChildren(panel);
  const accept = buttonOf(panel, '验收'), before = calls.length;
  await accept.onclick(); await accept.onclick();
  expect(dom.node('error').textContent).toContain('验收请求已处理，但刷新失败');
  expect(calls.slice(before).map(call => call.method)).toEqual(['worker.accept']);
});

test('detail and full/minimal graph expose one identical authoritative acceptance action', async () => {
  for (const view of ['detail', 'graph', 'minimal-graph']) {
    ui.lastSnapshot = null; ui.taskGraphMinimal = view === 'minimal-graph';
    dom.node('detail').replaceChildren();
    if (view === 'detail') renderDetail(task, null, null, null);
    else { activateDetailView({ view: 'task-graph' });
      renderTaskGraph({ total: 1, nodes: [{ ...task, branch_info: { subtree_branches: 1 } }], edges: [] }); }
    const panel = dom.node('detail');
    if (view === 'minimal-graph') panel.querySelector('.task-graph-more-trigger').onclick();
    expect(buttonOf(panel, '仅验收')).toBeUndefined(); expect(buttonOf(panel, '验收并归档')).toBeUndefined();
    const before = calls.length; await buttonOf(panel, '验收').onclick();
    expect(calls.slice(before)).toEqual([{ method: 'worker.accept', params: { id: task.id } }]);
    expect(dom.node('modal').hidden).toBe(true);
  }
  ui.taskGraphMinimal = false;
});

test('old or malformed acceptance response does not claim resources deleted or repeat the request', async () => {
  acceptResponse = { ...task, status: 'completed' };
  try {
    const accept = buttonOf(render(task), '验收'), before = calls.length;
    await accept.onclick(); await accept.onclick();
    expect(dom.node('error').textContent).toContain('资源回收结果未确认');
    expect(calls.slice(before).map(call => call.method)).toEqual(['worker.accept']);
  } finally { acceptResponse = null; }
});

test('late acceptance cannot refresh or toast a different project or page', async () => {
  for (const changeProject of [false, true]) {
    let release, refreshed = 0;
    dom.location.pathname = '/p/1111111111111111/';
    activateDetailView({ view: 'task', key: 'task-70' });
    acceptGate = new Promise(resolve => { release = resolve; });
    const panel = iterationControls(task, { refresh: () => { refreshed++; } });
    dom.node('detail').replaceChildren(panel);
    const pending = buttonOf(panel, '验收').onclick();
    if (changeProject) dom.location.pathname = '/p/2222222222222222/';
    else activateDetailView({ view: 'overview' });
    dom.node('error').textContent = 'new page';
    release(); acceptGate = null; await pending;
    expect(refreshed).toBe(0); expect(dom.node('error').textContent).toBe('new page');
  }
  dom.location.pathname = '/';
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

test('detail shows red ahead and green behind counts beside sync, including zero and disabled sync', () => {
  for (const [ahead, behind, status] of [[0, 0, 'waiting'], [3, 0, 'awaiting_acceptance'],
    [0, 5, 'waiting'], [2, 4, 'running']]) {
    dom.node('detail').replaceChildren();
    renderDetail({ ...task, status, parent_relation: { ahead, behind } }, null, null, null);
    const panel = dom.node('detail');
    const distance = panel.querySelector('.parent-commit-distance');
    expect(deepText(distance).replace(/\s+/g, ' ')).toBe(`领先 ${ahead} / 落后 ${behind} 个 commit`);
    expect(distance.querySelector('.parent-commit-ahead').textContent).toBe(`领先 ${ahead}`);
    expect(distance.querySelector('.parent-commit-behind').textContent).toBe(`落后 ${behind}`);
    const siblings = [...distance.parentNode.children], sync = buttonOf(panel, '同步父分支');
    expect(siblings[siblings.indexOf(distance) - 1]).toBe(sync.disabled ? sync.parentNode : sync);
    expect(sync.classList.contains('agent-call')).toBe(false);
  }
});

test('parent distance colors use theme-aware red for ahead and green for behind', async () => {
  const css = await Bun.file(new URL('../../src/ui/web/assets/styles.css', import.meta.url)).text();
  expect(css).toContain('.parent-commit-ahead{color:var(--failed)}');
  expect(css).toContain('.parent-commit-behind{color:var(--completed)}');
});

test('old or invalid relation data is unknown, and re-render updates counts', () => {
  for (const parent_relation of [undefined, null, { ahead: null, behind: null },
    { ahead: 1, behind: null }, { ahead: -1, behind: 0 }, { ahead: '1', behind: 0 }]) {
    dom.node('detail').replaceChildren();
    renderDetail({ ...task, parent_relation }, null, null, null);
    expect(dom.node('detail').querySelector('.parent-commit-distance').textContent).toBe('父分支 commit 距离未知');
  }
  for (const behind of [5, 0, 1]) {
    renderDetail({ ...task, parent_relation: { ahead: 2, behind } }, null, null, null);
    expect(deepText(dom.node('detail').querySelector('.parent-commit-distance')).replace(/\s+/g, ' ')).toBe(`领先 2 / 落后 ${behind} 个 commit`);
    expect(dom.node('detail').querySelectorAll('.parent-commit-distance')).toHaveLength(1);
  }
});

test('sync conflict diagnosis preserves the detail distance display without starting Agent', async () => {
  const panel = iterationControls({ ...task, parent_relation: { ahead: 2, behind: 3 } }, { showParentDistance: true });
  dom.node('detail').replaceChildren(panel);
  syncResult = { task, synced: false, conflict: true, source_commit: 'source', parent_commit: 'parent', reason: '冲突' };
  const before = calls.length;
  await buttonOf(panel, '同步父分支').onclick();
  expect(deepText(panel.querySelector('.parent-commit-distance')).replace(/\s+/g, ' ')).toBe('领先 2 / 落后 3 个 commit');
  expect(calls.slice(before).map(call => call.method)).toEqual(['worker.sync_parent']);
  // Graph actions keep their existing separate Git relation diagnostic.
  expect(iterationControls(task).querySelector('.parent-commit-distance')).toBeNull();
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
  for (const label of ['验收']) {
    const accept = buttonOf(parent, label);
    expect(accept.disabled).toBe(true); expect(accept.parentNode.getAttribute('data-help')).toContain('后代');
  }
  for (const row of [{ ...task, branch_info: { archived: true } }, { ...task, freeze: { task_id: 99 } },
    { ...task, agent: { active: true } }]) {
    for (const label of ['验收']) {
      const accept = buttonOf(render(row), label);
      expect(accept.disabled).toBe(true); expect(accept.parentNode.classList.contains('help-host')).toBe(true);
    }
  }
});

test('detail and graph expose the same awaiting acceptance actions and continuing delivery', () => {
  ui.lastSnapshot = null;
  renderDetail({ ...task, branch_archive: { archivable: true } }, null, null, null);
  let panel = dom.node('detail');
  expect(buttonOf(panel, '归档')).toBeUndefined();
  expect(buttonOf(panel, '回收工作区与分支')).toBeUndefined();
  expect(buttonOf(panel, '只回收 worktree（保留分支）')).toBeUndefined();
  expect(deepText(panel)).toContain('无需你逐个验收');
  expect(buttonOf(panel, '向该 Worker 追加输入').classList.contains('agent-call')).toBe(false);
  expect(buttonOf(panel, '验收')).toBeTruthy(); expect(buttonOf(panel, '验收并归档')).toBeUndefined();
  expect(buttonOf(panel, '同步父分支')).toBeTruthy();
  expect(buttonOf(panel, '中断')).toBeUndefined(); expect(buttonOf(panel, '已解决')).toBeUndefined();
  activateDetailView({ view: 'task-graph' });
  renderTaskGraph({ total: 1, nodes: [{ ...task, branch_info: { archivable: true } }], edges: [] });
  panel = dom.node('detail').querySelector('[data-task-id="70"]');
  expect(panel.classList.contains('task-graph-awaiting_acceptance')).toBe(true);
  expect(buttonOf(panel, '清理资源')).toBeUndefined();
  expect(buttonOf(panel, '验收')).toBeTruthy(); expect(buttonOf(panel, '验收并归档')).toBeUndefined();
  expect(buttonOf(panel, '同步父分支')).toBeTruthy();
  expect(buttonOf(panel, '向此 Worker 输入').classList.contains('agent-call')).toBe(true);
  renderDetail({ ...task, status: 'waiting', integration: 'pending', head_commit: 'c'.repeat(40),
    merge_readiness: { ready: true, reason: null } }, null, null, null);
  expect(buttonOf(dom.node('detail'), '合并')).toBeTruthy();
  renderDetail({ ...task, status: 'completed', accepted: true }, null, null, null);
  expect(buttonOf(dom.node('detail'), '继续开发')).toBeUndefined();
});

test('unchanged returned answers share acceptance in detail and graph, including minimal mode', async () => {
  ui.lastSnapshot = null;
  const answer = { ...task, status: 'waiting', integration: 'none', reservation: null,
    base_commit: task.head_commit, iteration_base_commit: null, result: 'answer only' };
  const renderers = [
    () => renderDetail(answer, null, null, null),
    ...[false, true].map(minimal => () => {
      activateDetailView({ view: 'task-graph' }); ui.taskGraphMinimal = minimal;
      const { result, ...node } = answer;
      renderTaskGraph({ total: 1, nodes: [{ ...node, has_result: true }], edges: [] });
    }),
  ];
  try {
    for (const paint of renderers) for (const label of ['验收']) {
      ui.lastSnapshot = null;
      dom.node('detail').replaceChildren();
      paint();
      const panel = dom.node('detail');
      if (panel.querySelector('.task-graph-more-trigger')) panel.querySelector('.task-graph-more-trigger').onclick();
      expect(buttonOf(panel, '已解决')).toBeUndefined();
      expect(deepText(panel)).toContain('无需先请求合并');
      const before = calls.length;
      await buttonOf(panel, label).onclick();
      expect(calls.slice(before).map(call => call.method)).toEqual(['worker.accept']);
      expect(dom.node('modal').hidden).toBe(true);
    }
  } finally { ui.taskGraphMinimal = false; }
});

test('answer acceptance requires known unchanged iteration and idle state, with guarded blockers', () => {
  const answer = { ...task, status: 'waiting', integration: 'none', reservation: null, result: 'answer only' };
  // Previously delivered commits do not make an unchanged current round ineligible.
  expect(buttonOf(render(answer), '验收')).toBeTruthy();
  for (const override of [{ result: null }, { base_commit: null, iteration_base_commit: null },
    { head_commit: null }, { head_commit: 'c'.repeat(40) }, { task_kind: 'child' },
    ...['queued', 'running', 'paused', 'failed', 'cancelled'].map(status => ({ status, accepted: true }))]) {
    const panel = iterationControls({ ...answer, ...override });
    expect(panel && buttonOf(panel, '验收')).toBeFalsy();
  }
  for (const override of [{ workspace: null }, { workspace_state: 'missing' },
    { branch_info: { archived: true } }, { agent: { active: true } },
    { children: [{ id: 71, status: 'awaiting_acceptance' }] },
    ...['pending', 'requested', 'executing', 'resolving', 'suspended', 'blocked'].map(status => ({
      reservation: { version: 2, kind: 'merge', status },
    }))]) {
    for (const label of ['验收']) {
      const button = buttonOf(render({ ...answer, ...override }), label);
      expect(button.disabled).toBe(true);
      expect(button.parentNode.classList.contains('help-host')).toBe(true);
    }
  }
});

test('historically accepted task offers acceptance to finish reclamation, not independent cleanup', () => {
  ui.lastSnapshot = null;
  for (const integration of ['merged', 'none', 'superseded']) {
    for (const archivable of [true, false]) {
      renderDetail({ ...task, status: 'completed', accepted: true, integration,
        branch_archive: { archivable, archived: false, subtree_branches: 0 } }, null, null, null);
      const panel = dom.node('detail');
      expect(buttonOf(panel, '回收工作区与分支')).toBeUndefined();
      expect(buttonOf(panel, '只回收 worktree（保留分支）')).toBeUndefined();
      expect(buttonOf(panel, '清理资源')).toBeUndefined();
      const accept = buttonOf(panel, '验收');
      expect(accept).toBeTruthy(); expect(accept.classList.contains('agent-call')).toBe(false);
      expect(accept.getAttribute('data-help')).toContain('worktree 与本地 ref');
    }
  }
});

test('delegated Tasks wait for parent confirmation, not user acceptance or mine filtering', () => {
  const child = { ...task, task_kind: 'child', integration: 'none', reservation: null };
  const panel = render(child);
  expect(statusOf(child).label).toBe('待父确认');
  expect(deepText(panel)).toContain('等待父 Worker #1');
  expect(buttonOf(panel, '验收')).toBeUndefined();
  expect(deepText(panel)).toContain('父 Agent 验收也会归档并回收');
  expect(matchTask(child, { mine: true })).toBe(false);
  expect(matchTask(child, { mine: true, openNoticeIds: [child.id] })).toBe(true);
  ui.overviewKey = null;
  renderOverview({ tasks: [child], notices: [], status: { agents: [] } });
  expect(deepText(dom.node('detail'))).toContain('等待父 Agent 确认');
  const acceptance = dom.node('detail').querySelectorAll('.metric').find(node => deepText(node).includes('待验收'));
  expect(acceptance.querySelector('.metric-value').textContent).toBe('0');
  renderDetail(child, null, null, null);
  expect(buttonOf(dom.node('detail'), '验收')).toBeUndefined();
  expect(buttonOf(dom.node('detail'), '验收并归档')).toBeUndefined();
  activateDetailView({ view: 'task-graph' });
  renderTaskGraph({ total: 1, nodes: [child], edges: [] });
  expect(buttonOf(dom.node('detail'), '验收')).toBeUndefined();
  expect(buttonOf(dom.node('detail'), '验收并归档')).toBeUndefined();
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
  expect(deepText(dom.node('detail').querySelector('.conversation-panel'))).toContain('本轮已测试并交付');
});
