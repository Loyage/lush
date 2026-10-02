import { test, expect, afterAll } from 'bun:test';
import { installDom, dialogText, answerDialog, deepText } from '../dom-stub.js';
import { makeWorld } from './dom-world.js';

const world = makeWorld();
const dom = installDom({ fetch: world.fetchImpl });
const { boot } = await import('../../src/ui/web/assets/app.js');
const { renderDetail } = await import('../../src/ui/web/assets/render-detail.js');
const { deliveryControls } = await import('../../src/ui/web/assets/render-delivery.js');
const { showHelp, hideHelp } = await import('../../src/ui/web/assets/help.js');
const { renderTaskGraph } = await import('../../src/ui/web/assets/render-task-graph.js');
const { activateDetailView } = await import('../../src/ui/web/assets/sidebar-ui.js');
const { ui } = await import('../../src/ui/web/assets/state.js');
function renderGraph(graph) {
  activateDetailView({ view: 'task-graph' });
  renderTaskGraph(graph);
}
dom.node('side-nav').replaceChildren();
await boot();
afterAll(() => dom.restore());

const commit = 'a'.repeat(40), baseline = 'b'.repeat(40), branch = 'feature/new-say';
const say = { id: 70, role: 'agent', task_kind: 'say', parent_id: 1, parent_task_kind: 'main',
  goal: 'ship a view', status: 'waiting', integration: 'pending', calls: 0, branch, target_branch: 'main',
  deps: [], dependents: [], children: [], messages: [], notices: [], reservation: null,
  auto_merge: { enabled: false, locked: false, editable: true, reason: null } };
const buttonOf = (root, label) => root.querySelectorAll('button').find(node => node.textContent === label);
const graphFor = (reservation, { done = false, status = null } = {}) => ({ total: 1, nodes: [
  { kind: 'task', id: say.id, role: 'agent', task_kind: 'say', parent_id: 1, parent_task_kind: 'main',
    title: say.goal, goal: say.goal, branch, target_branch: 'main',
    status: status ?? (reservation?.status === 'requested' ? 'completed' : 'waiting'),
    integration: 'pending', reservation, auto_merge: say.auto_merge, base_commit: baseline, head_commit: commit,
    has_result: done, workspace: '/tmp/lush-new-say' },
], edges: [] });

function sourceRow() {
  return dom.node('detail').querySelector(`[data-task-id="${say.id}"]`);
}

test('Task detail offers an auto-merge checkbox instead of booking buttons', async () => {
  renderDetail(say, null, null, null);
  const detail = dom.node('detail');
  const toggle = detail.querySelector('.auto-merge-toggle');
  const input = toggle.querySelector('input');
  expect(toggle.classList.contains('agent-call')).toBe(true);
  expect(toggle.parentNode.getAttribute('data-help')).toContain('消耗 token');
  expect(input.checked).toBe(false); expect(input.disabled).toBe(false);
  expect(buttonOf(detail, '预约合并')).toBeUndefined();
  expect(buttonOf(detail, '预约展示')).toBeUndefined();
  input.checked = true; await input.onchange();
  expect(world.state.actions).toContainEqual({ method: 'worker.auto_merge', params: { id: say.id, enabled: true } });
  expect(world.state.actions.some(action => action.method === 'worker.reserve')).toBe(false);
  expect(world.state.actions.some(action => action.params?.kind === 'showcase')).toBe(false);
});

test('ready say uses only 合并 even with a pending intent; requested delivery shows queue progress', async () => {
  const done = { ...say, calls: 1, result: '已提交并测试', base_commit: baseline, head_commit: commit,
    merge_readiness: { ready: true, reason: null } };
  for (const reservation of [null, { version: 2, kind: 'merge', status: 'pending' }]) {
    renderDetail({ ...done, reservation }, null, null, null);
    const panel = dom.node('detail');
    expect(panel.querySelector('.auto-merge-toggle')).toBeNull();
    expect(buttonOf(panel, '撤销预约')).toBeUndefined();
    expect(buttonOf(panel, '复查预约')).toBeUndefined();
    const request = buttonOf(panel, '合并');
    expect(request.classList.contains('agent-call')).toBe(true);
    expect(request.getAttribute('data-help')).toContain('消耗 token');
    const pending = request.onclick();
    expect(dialogText(dom)).toContain('父 Worker 自有队列的 runtime');
    expect(dialogText(dom)).toContain('不创建 merge Worker、不改变父子关系');
    expect(dialogText(dom)).toContain('不额外调用父 Agent');
    expect(dialogText(dom)).toContain('挂起释放执行位');
    expect(dialogText(dom)).toContain('成功后进入待验收');
    expect(dialogText(dom)).not.toContain('归还原父');
    expect(dialogText(dom)).toContain('不会改变跨轮保留的自动合并设置');
    await answerDialog(dom, '合并'); await pending;
    expect(world.state.actions.at(-1)).toEqual({ method: 'worker.reserve', params: { id: say.id, kind: 'merge' } });
  }
  renderDetail({ ...done, reservation: { version: 2, kind: 'merge', status: 'requested', commit, baseline } }, null, null, null);
  const panel = dom.node('detail');
  expect(deepText(panel)).toContain('冻结');
  expect(buttonOf(panel, '复查合并队列')).toBeTruthy();
  expect(buttonOf(panel, '合并')).toBeUndefined();
  expect(panel.querySelector('.auto-merge-toggle')).toBeNull();
});

test('parent-owned queue states explain the slot and offer only suspended resume or blocked inspection', async () => {
  const states = {
    requested: '冻结 · 等待父队列', executing: '自动合并中 · 占用父执行位',
    resolving: '源侧修复中 · 保留父执行位', suspended: '交付已挂起 · 父执行位已释放',
    blocked: '交付阻塞 · 保留父侧现场',
  };
  for (const [status, label] of Object.entries(states)) {
    const reservation = { version: 2, queue_protocol: 1, kind: 'merge', status,
      blocked_reason: '等待固定尝试核验', commit, parent_id: 1 };
    const graph = graphFor(reservation, { status: 'waiting' });
    for (const render of [() => renderDetail({ ...say, reservation }, null, null, null),
      () => renderGraph(graph)]) {
      render();
      const panel = dom.node('detail');
      expect(deepText(panel)).toContain(label);
      expect(deepText(panel)).toContain('等待固定尝试核验');
      expect(buttonOf(panel, '合并')).toBeUndefined();
      expect(panel.querySelector('.auto-merge-toggle')).toBeNull();
      expect(buttonOf(panel, '批准固定提交合入父分支')).toBeUndefined();
      const recovery = buttonOf(panel, status === 'suspended' ? '恢复交付' : '受检复查落地');
      if (['suspended','blocked'].includes(status)) {
        expect(recovery.classList.contains('agent-call')).toBe(true);
        expect(recovery.getAttribute('data-help')).toContain('消耗 token');
        await recovery.onclick();
        expect(world.state.actions.at(-1)).toEqual({ method: 'worker.reserve', params: { id: say.id, kind: 'merge' } });
      } else expect(recovery).toBeUndefined();
    }
  }
  const legacy = deliveryControls({ ...say, reservation: { version: 2, kind: 'merge', status: 'resolving' } });
  expect(deepText(legacy)).toContain('历史源侧解分歧');
  expect(deepText(legacy)).not.toContain('保留父执行位');
});

test('failed v2 delivery cannot bypass explicit retry through a checkbox or booking recheck', () => {
  renderDetail({ ...say, status: 'failed', reservation: { version: 2, kind: 'merge', status: 'pending' } }, null, null, null);
  const panel = dom.node('detail');
  expect(buttonOf(panel, '复查预约')).toBeUndefined();
  expect(buttonOf(panel, '撤销预约')).toBeUndefined();
  expect(panel.querySelector('.auto-merge-toggle').querySelector('input').disabled).toBe(true);
});

test('waiting for child work or unread messages shows the shared auto-merge toggle in detail and graph', async () => {
  for (const reason of ['等待子 Task #71 结算', '还有未处理的消息或子任务信号，需先交给 Agent']) {
    // A previous result and commit do not prove the current invocation is delivered.
    const waiting = { ...say, calls: 2, result: '上一轮已提交', head_commit: commit, base_commit: baseline,
      merge_readiness: { ready: false, reason } };
    renderDetail(waiting, null, null, null);
    let panel = dom.node('detail');
    expect(buttonOf(panel, '合并')).toBeUndefined();
    expect(buttonOf(panel, '预约合并')).toBeUndefined();
    expect(deepText(panel)).toContain(reason);
    const toggle = panel.querySelector('.auto-merge-toggle').querySelector('input');
    toggle.checked = true; await toggle.onchange();
    expect(world.state.actions.at(-1)).toEqual({ method: 'worker.auto_merge', params: { id: say.id, enabled: true } });
    const graph = graphFor(null, { done: true });
    graph.nodes[0].merge_readiness = waiting.merge_readiness;
    renderGraph(graph);
    panel = dom.node('detail');
    expect(buttonOf(panel, '合并')).toBeUndefined();
    expect(buttonOf(panel, '预约合并')).toBeUndefined();
    expect(panel.querySelector('.auto-merge-toggle').querySelector('input').disabled).toBe(false);
    expect(deepText(panel)).toContain(reason);
    graph.nodes[0].reservation = { version: 2, kind: 'merge', status: 'pending' };
    graph.nodes[0].auto_merge = { ...say.auto_merge, enabled: true };
    renderGraph(graph);
    panel = dom.node('detail');
    expect(buttonOf(panel, '合并')).toBeUndefined();
    expect(buttonOf(panel, '预约合并')).toBeUndefined();
    expect(buttonOf(panel, '复查预约')).toBeUndefined();
    expect(buttonOf(panel, '撤销预约')).toBeUndefined();
    const enabled = panel.querySelector('.auto-merge-toggle').querySelector('input');
    expect(enabled.checked).toBe(true);
    enabled.checked = false; await enabled.onchange();
    expect(world.state.actions.at(-1)).toEqual({ method: 'worker.auto_merge', params: { id: say.id, enabled: false } });
    expect(deepText(panel)).toContain(reason);
  }
  const graph = graphFor(null, { done: true });
  graph.nodes[0].merge_readiness = { ready: true, reason: null };
  renderGraph(graph);
  expect(buttonOf(dom.node('detail'), '合并')).toBeTruthy();
});

test('locked child and unavailable settings are accessible read-only controls, never inferred editable', async () => {
  const before = world.state.actions.length;
  for (const auto_merge of [null, undefined, { enabled: true, locked: true, editable: false,
    reason: '由父任务派生，自动合并不可关闭。' }, { enabled: false, locked: false, editable: false, reason: '等待安全点' }]) {
    const panel = deliveryControls({ ...say, task_kind: 'child', auto_merge });
    const label = panel.querySelector('.auto-merge-toggle');
    const input = label.querySelector('input'), host = label.parentNode;
    expect(input.disabled).toBe(true);
    expect(input.checked).toBe(auto_merge?.enabled === true);
    expect(input.getAttribute('aria-label')).toContain('自动合并');
    expect(host.classList.contains('help-host')).toBe(true); expect(host.tabIndex).toBe(0);
    expect(host.getAttribute('data-help')).toContain(auto_merge?.reason || '暂不可用');
    showHelp(host);
    expect(host.getAttribute('aria-describedby')).toBe('help-tip');
    expect(dom.node('help-tip').textContent).toContain(auto_merge?.reason || '暂不可用');
    hideHelp();
    input.checked = !input.checked; await input.onchange();
    expect(input.checked).toBe(auto_merge?.enabled === true);
  }
  expect(world.state.actions.length).toBe(before);
});

test('auto-merge mutation is single-flight across rerenders and restores checked state on failure', async () => {
  const previousFetch = globalThis.fetch;
  let release, requests = 0;
  globalThis.fetch = async (url, options) => {
    if (String(url).endsWith('/api/action') && JSON.parse(options.body).method === 'worker.auto_merge') {
      requests++;
      return new Promise(resolve => { release = () => resolve({ ok: false, status: 400,
        json: async () => ({ error: '任务已经就绪，不可修改自动合并' }) }); });
    }
    return previousFetch(url, options);
  };
  try {
    const panel = deliveryControls(say), input = panel.querySelector('input');
    input.checked = true;
    const saving = input.onchange();
    expect(input.disabled).toBe(true);
    await input.onchange(); expect(requests).toBe(1);
    const rerendered = deliveryControls(say).querySelector('input');
    expect(rerendered.disabled).toBe(true);
    rerendered.checked = true; await rerendered.onchange(); expect(requests).toBe(1);
    release(); await saving;
    expect(input.disabled).toBe(false); expect(input.checked).toBe(false);
    expect(dom.node('error').textContent).toContain('任务已经就绪');
    expect(deliveryControls(say).querySelector('input').disabled).toBe(false);
  } finally { globalThis.fetch = previousFetch; }
});

test('successful updates apply the returned setting and editability before the next view refresh', async () => {
  const previousFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async (url, options) => {
    if (String(url).endsWith('/api/action') && JSON.parse(options.body).method === 'worker.auto_merge') {
      requests++;
      return { ok: true, status: 200, json: async () => ({ task_id: say.id, changed: true,
        auto_merge: { enabled: true, locked: false, editable: false, reason: '已经交付就绪，请合并' } }) };
    }
    return previousFetch(url, options);
  };
  try {
    const input = deliveryControls(say).querySelector('input');
    input.checked = true; await input.onchange();
    expect(input.checked).toBe(true); expect(input.disabled).toBe(true);
    const host = input.parentNode.parentNode;
    expect(host.tabIndex).toBe(0); expect(host.getAttribute('data-help')).toContain('已经交付就绪');
    input.checked = false; await input.onchange();
    expect(input.checked).toBe(true); expect(requests).toBe(1);
  } finally { globalThis.fetch = previousFetch; }
});

test('persisted settings survive continued work without deriving them from the reservation slot', () => {
  const automatic = { enabled: true, locked: false, editable: true, reason: null };
  const working = deliveryControls({ ...say, status: 'running', auto_merge: automatic, reservation: null });
  expect(working.querySelector('input').checked).toBe(true);
  const manual = deliveryControls({ ...say, auto_merge: say.auto_merge,
    reservation: { version: 2, kind: 'merge', status: 'pending' } });
  expect(manual.querySelector('input').checked).toBe(false);
  for (const state of ['requested', 'resolving', 'integrated']) {
    const panel = deliveryControls({ ...say, status: state === 'integrated' ? 'awaiting_acceptance' : 'waiting',
      auto_merge: automatic, integration_error: '等待父队列复核',
      reservation: { version: 2, kind: 'merge', status: state } });
    expect(panel.querySelector('input')).toBeNull(); expect(buttonOf(panel, '合并')).toBeUndefined();
    expect(deepText(panel)).toContain('等待父队列复核');
  }
});

test('detail and graph distinguish independent one-shot intents from automatic pending requests', () => {
  for (const enabled of [true, false]) for (const marker of [undefined, false, true]) {
    const reservation = { version: 2, kind: 'merge', status: 'pending',
      ...(marker === undefined ? {} : { auto_merge: marker }) };
    const auto_merge = { ...say.auto_merge, enabled };
    const graph = graphFor(reservation);
    graph.nodes[0].auto_merge = auto_merge;
    for (const render of [() => renderDetail({ ...say, reservation, auto_merge }, null, null, null),
      () => renderGraph(graph)]) {
      render();
      const panel = dom.node('detail');
      const hint = panel.querySelector('.single-merge-intent');
      if (marker !== true) {
        expect(hint).toBeTruthy();
        expect(hint.textContent).toContain('关闭自动合并不会撤销');
        expect(hint.textContent).toContain('条件满足后仍会合并');
      } else expect(hint).toBeNull();
      expect(panel.querySelector('.auto-merge-toggle').querySelector('input').checked).toBe(enabled);
      expect(buttonOf(panel, '撤销预约')).toBeUndefined();
      expect(buttonOf(panel, '预约合并')).toBeUndefined();
    }
  }
  for (const status of ['requested', 'resolving', 'integrated']) {
    const panel = deliveryControls({ ...say, reservation: { version: 2, kind: 'merge', status } });
    expect(panel.querySelector('.single-merge-intent')).toBeNull();
  }
});

test('failed resolving withdrawal matches locked and enabled automatic-intent protection', async () => {
  for (const status of ['failed', 'cancelled']) for (const enabled of [false, true])
    for (const automatic of [undefined, false, true]) for (const locked of [false, true]) {
      const task = { ...say, status, auto_merge: { enabled, locked, editable: false, reason: '本轮已结束' },
        reservation: { version: 2, kind: 'merge', status: 'resolving',
          ...(automatic === undefined ? {} : { auto_merge: automatic }) } };
      const graph = graphFor(task.reservation, { status });
      graph.nodes[0].auto_merge = task.auto_merge;
      for (const render of [() => renderDetail(task, null, null, null), () => renderGraph(graph)]) {
        render();
        const withdraw = buttonOf(dom.node('detail'), '放弃解分歧请求');
        if (locked || (enabled && automatic === true)) expect(withdraw).toBeUndefined();
        else expect(withdraw).toBeTruthy();
      }
    }
  const panel = deliveryControls({ ...say, status: 'failed', auto_merge: { ...say.auto_merge, enabled: true },
    reservation: { version: 2, kind: 'merge', status: 'resolving' } });
  await buttonOf(panel, '放弃解分歧请求').onclick();
  expect(world.state.actions.at(-1)).toEqual({ method: 'worker.unreserve', params: { id: say.id } });
});

test('integrated merge says 待归档 only while a branch is still left to archive', () => {
  const reservation = { version: 2, kind: 'merge', status: 'integrated', commit, baseline, parent_id: 1 };
  const done = { ...say, calls: 1, status: 'completed', integration: 'merged', result: '已提交并测试',
    base_commit: baseline, head_commit: commit, reservation };
  renderDetail(done, null, null, null);
  expect(deepText(dom.node('detail'))).toContain('已合并 · 待归档');
  // 分支记录已归档（ref / worktree 都没了）：已经没有东西可归档，标签必须落地成「已归档」。
  renderDetail({ ...done, branch_archive: { archivable: false, archived: true, tracked: true } }, null, null, null);
  let panel = dom.node('detail');
  expect(deepText(panel)).toContain('已合并 · 已归档');
  expect(deepText(panel)).not.toContain('待归档');
  // 回收工作区与分支 / 旧版落地即归档会把 tasks.branch 清成 null；inspect 这时不再带 branch_archive。
  renderDetail({ ...done, branch: null }, null, null, null);
  panel = dom.node('detail');
  expect(deepText(panel)).toContain('已合并 · 已归档');
  expect(deepText(panel)).not.toContain('待归档');
  // Task 图节点给的是 branch_info（没有 branch_archive）：判据必须同时认这一份。
  const graph = graphFor(reservation, { done: true, status: 'completed' });
  graph.nodes.find(node => node.id === say.id).branch_info = { archived: true, archivable: false };
  ui.taskGraphShowArchived = true;
  renderGraph(graph);
  expect(deepText(sourceRow())).toContain('已合并 · 已归档');
  expect(deepText(sourceRow())).not.toContain('待归档');
  ui.taskGraphShowArchived = false;
});

test('Task graph uses the same fixed approval, never legacy branch.merge or branch showcase for new say', async () => {
  const reservation = { version: 1, kind: 'merge', status: 'requested', commit, baseline, parent_id: 1 };
  renderGraph(graphFor(reservation), { force: true });
  const row = sourceRow();
  expect(row).toBeTruthy();
  expect(buttonOf(row, '合入父分支')).toBeUndefined();
  expect(buttonOf(row, '预约效果展示')).toBeUndefined();
  const approve = buttonOf(row, '批准固定提交合入父分支');
  expect(approve).toBeTruthy(); expect(approve.getAttribute('data-help')).toContain('固定');
  expect(deepText(row)).toContain(commit);
  const pending = approve.onclick();
  expect(dialogText(dom)).toContain(`源提交：${commit}`);
  expect(dialogText(dom)).toContain(`父分支基线：${baseline}`);
  expect(world.state.actions.some(action => action.method === 'worker.approve_merge')).toBe(false);
  await answerDialog(dom, `批准 ${commit.slice(0, 12)}`); await pending;
  expect(world.state.actions).toContainEqual({ method: 'worker.approve_merge', params: { id: say.id, commit, baseline } });

  renderGraph(graphFor({ version: 1, kind: 'merge', status: 'pending', blocked_reason: 'parent diverged' }), { force: true });
  const recheck = buttonOf(sourceRow(), '复查预约');
  expect(recheck.classList.contains('agent-call')).toBe(false);
  expect(recheck.getAttribute('data-help')).toContain('不会直接推进父分支');
  await recheck.onclick();
  expect(world.state.actions.at(-1)).toEqual({ method: 'worker.reserve', params: { id: say.id, kind: 'merge' } });

  renderGraph(graphFor(null), { force: true });
  expect(sourceRow().querySelector('.auto-merge-toggle')).toBeTruthy();
  expect(buttonOf(sourceRow(), '预约展示')).toBeUndefined();
  expect(buttonOf(sourceRow(), '预约效果展示')).toBeUndefined();
});

test('historical showcase reservations are read-only in detail and graph for every state', () => {
  const actions = world.state.actions.length;
  for (const status of ['pending', 'preparing', 'started', 'completed', 'failed', 'cancelled']) {
    const reservation = { version: 1, kind: 'showcase', status, child_id: 5, commit, baseline };
    renderDetail({ ...say, status: status === 'failed' ? 'failed' : 'waiting', reservation,
      result: '历史交付记录', head_commit: commit, base_commit: baseline }, null, null, null);
    const panel = dom.node('detail');
    expect(deepText(panel)).toContain('历史交付记录');
    expect(panel.querySelector('.delivery-controls')).toBeNull();
    expect(panel.querySelector('.iteration-controls')).toBeNull();
    for (const label of ['预约展示', '预约合并', '请求合并', '检查后重试', '追加输入', '中断', '已解决'])
      expect(buttonOf(panel, label)).toBeUndefined();
    const graph = graphFor(reservation, { done: true, status: 'waiting' });
    graph.nodes[0].branch_info = { archivable: true };
    renderGraph(graph);
    const row = sourceRow();
    expect(row.querySelector('.delivery-controls')).toBeNull();
    expect(row.querySelector('.iteration-controls')).toBeNull();
    expect(buttonOf(row, '向此 Worker 输入')).toBeUndefined();
    expect(buttonOf(row, '归档')).toBeUndefined();
    expect(buttonOf(row, '请求合并')).toBeUndefined();
  }
  expect(world.state.actions.length).toBe(actions);
});

test('historical showcase Tasks retain generic results without reports, previews or retry operations', () => {
  const historical = { ...say, id: 81, task_kind: 'showcase', role: 'showcase', status: 'failed',
    branch: null, workspace: '/tmp/legacy-view', result: '历史任务结果', error: '中断原因',
    showcase: { report: { href: '/api/worker/81/report' }, preview: { url: 'http://localhost:9000' } } };
  renderDetail(historical, null, null, null);
  const panel = dom.node('detail');
  expect(deepText(panel)).toContain('历史任务结果');
  expect(deepText(panel)).toContain('中断原因');
  expect(deepText(panel)).toContain('detached worktree：/tmp/legacy-view');
  expect(panel.querySelector('iframe')).toBeNull();
  expect(panel.querySelector('.role-showcase')).toBeNull();
  expect(panel.querySelector('.showcase-panel')).toBeNull();
  expect(buttonOf(panel, '检查后重试')).toBeUndefined();
  expect(buttonOf(panel, '停止预览')).toBeUndefined();
  for (const status of ['waiting', 'paused', 'completed', 'failed', 'cancelled']) {
    renderDetail({ ...historical, status, integration: 'none', notices: [{ id: 91, kind: 'questionnaire', status: 'open',
      title: '历史问题', body: JSON.stringify({ version: 1, questions: [{ question: '继续？', header: '历史',
        options: [{ label: '是', description: '继续' }, { label: '否', description: '停止' }] }] }) }] }, null, null, null);
    expect(panel.querySelector('.task-actions').querySelectorAll('button').map(node => node.textContent)).toEqual(['刷新详情']);
    expect(panel.querySelector('.questionnaire')).toBeNull();
    expect(deepText(panel)).toContain('历史待决 · 只读');
  }
});

test('a diverged merge offers a source-side Agent child, but does not call legacy sync or approve the parent', async () => {
  renderGraph(graphFor({ version: 1, kind: 'merge', status: 'pending', blocked_code: 'diverged',
    blocked_reason: 'cannot request a merge from a diverged branch; resolve it first' }), { force: true });
  const row = sourceRow();
  const resolve = buttonOf(row, '派子 Worker 解决分歧');
  expect(resolve.classList.contains('agent-call')).toBe(true);
  expect(resolve.getAttribute('data-help')).toContain('消耗 token');
  const start = resolve.onclick();
  expect(dialogText(dom)).toContain('不会直接推进 say 或父分支');
  expect(world.state.actions.some(action => action.method === 'worker.resolve_divergence')).toBe(false);
  await answerDialog(dom, '派解分歧子 Worker'); await start;
  expect(world.state.actions.at(-1)).toEqual({ method: 'worker.resolve_divergence', params: { id: say.id } });
  expect(world.state.actions.some(action => action.method === 'branch.sync')).toBe(false);
  renderDetail({ ...say, reservation: { version: 1, kind: 'merge', status: 'pending',
    blocked_reason: '等待解分歧子 Task #92 完成', blocked_code: 'resolving', resolution_child_id: 92 } }, null, null, null);
  expect(buttonOf(dom.node('detail'), '派子 Worker 解决分歧')).toBeUndefined();
  expect(buttonOf(dom.node('detail'), '查看解分歧 #92')).toBeTruthy();
  world.state.resolveOutcome = { status: 'needs_review', task: { id: 92 },
    reason: '子任务 #92 尚未集成；检查后显式归档旧分支再派任务' };
  renderDetail({ ...say, reservation: { version: 1, kind: 'merge', status: 'pending', blocked_code: 'diverged',
    resolution_child_id: 92 } }, null, null, null);
  const again = buttonOf(dom.node('detail'), '派子 Worker 解决分歧').onclick();
  await answerDialog(dom, '派解分歧子 Worker'); await again;
  expect(dom.node('error').textContent).toContain('显式归档旧分支');
  world.state.resolveOutcome = null;
});

test('a terminal say with a diverged merge reservation still offers the standalone divergence child', async () => {
  renderGraph(graphFor({ version: 1, kind: 'merge', status: 'pending', blocked_code: 'diverged',
    blocked_reason: '分支与直接父分支已分歧；先派独立解分歧子 Task 吸收固定的父提交，再重新发合并请求。' },
  { status: 'completed' }), { force: true });
  const row = sourceRow();
  expect(deepText(row)).not.toContain('不能直接复查预约');
  const resolve = buttonOf(row, '派子 Worker 解决分歧');
  expect(resolve).toBeTruthy();
  expect(resolve.classList.contains('agent-call')).toBe(true);
  const start = resolve.onclick();
  expect(dialogText(dom)).toContain('由 runtime 快进推进 say 分支');
  await answerDialog(dom, '派解分歧子 Worker'); await start;
  expect(world.state.actions.at(-1)).toEqual({ method: 'worker.resolve_divergence', params: { id: say.id } });
});

test('failed resolution child links back to say and explains archive rather than offering replay', () => {
  const child = { ...say, id: 92, task_kind: 'child', parent_id: 70, parent_task_kind: 'say',
    branch: 'lush/resolution/92', target_branch: branch, status: 'failed', error: 'conflict not resolved',
    reservation: null, divergence_resolution: { source_task_id: 70, source_commit: commit, parent_commit: baseline, branch_status: 'active' } };
  renderDetail(child, null, null, null);
  const panel = dom.node('detail');
  expect(buttonOf(panel, '检查后重试')).toBeUndefined();
  expect(buttonOf(panel, '查看源 say #70')).toBeTruthy();
  expect(deepText(panel)).toContain('显式归档这条子分支');
  renderDetail({ ...child, divergence_resolution: { ...child.divergence_resolution, branch_status: 'archived' } }, null, null, null);
  expect(deepText(panel)).toContain('Worker、固定提交记录和会话仍保留');
  expect(deepText(panel)).toContain('返回源 say');
  // 修复已完子任务固定提交的解分歧子任务：重试由直接父 Agent 驱动，不是返回 say。
  renderDetail({ ...child, divergence_resolution: { ...child.divergence_resolution, source_task_id: 91 } }, null, null, null);
  expect(deepText(panel)).toContain('再派一个以同一固定提交为基线的解分歧子 Worker');
  expect(deepText(panel)).not.toContain('返回源 say');
});

test('an outstanding request shows its diagnosis and can be withdrawn to release the parent lock', async () => {
  const reservation = { version: 1, kind: 'merge', status: 'requested', commit, baseline, parent_id: 1,
    blocked_code: 'parent_moved', blocked_reason: '父分支 main 在本请求发出后被推进到 deadbee，固定提交 abcdef 已不能快进：撤销这个请求（任务、分支与提交保留）' };
  renderDetail({ ...say, status: 'completed', reservation }, null, null, null);
  const panel = dom.node('detail');
  expect(deepText(panel)).toContain('请求状态：父分支 main');
  expect(buttonOf(panel, '批准固定提交合入父分支')).toBeTruthy();
  const withdraw = buttonOf(panel, '撤销请求');
  expect(withdraw.getAttribute('data-help')).toContain('解除父分支的交付锁');
  const pending = withdraw.onclick();
  expect(dialogText(dom)).toContain('父分支随即解除交付锁');
  const beforeWithdraw = world.state.actions.length;
  expect(world.state.actions.slice(beforeWithdraw).some(action => action.method === 'worker.unreserve')).toBe(false);
  await answerDialog(dom, '撤销请求'); await pending;
  expect(world.state.actions.at(-1)).toEqual({ method: 'worker.unreserve', params: { id: say.id } });
  // 已发出的请求也给一条只读「复查请求」：点完会重画详情，所以重新取节点再断言。
  renderDetail({ ...say, status: 'completed', reservation }, null, null, null);
  const fresh = dom.node('detail');
  const recheck = buttonOf(fresh, '复查请求');
  expect(recheck.classList.contains('agent-call')).toBe(false);
  const beforeRecheck = world.state.actions.length;
  await recheck.onclick();
  expect(world.state.actions.at(-1)).toEqual({ method: 'worker.reserve', params: { id: say.id, kind: 'merge' } });
  expect(world.state.actions.length).toBe(beforeRecheck + 1);

  renderDetail({ ...say, status: 'waiting', reservation: { version: 1, kind: 'merge', status: 'pending',
    blocked_code: 'parent_locked', blocked_reason: '父分支 main 已被 say #68 的合并请求 abcdef 已固定基线，等待集成或撤销' } }, null, null, null);
  expect(deepText(panel)).toContain('上次检查未满足：父分支 main 已被 say #68');
  expect(buttonOf(panel, '撤销请求')).toBeUndefined();
  expect(buttonOf(panel, '撤销预约')).toBeTruthy();
});

test('a failed Task with pending delivery cannot bypass explicit Task inspection by rechecking a terminal reservation', () => {
  renderDetail({ ...say, status: 'failed', error: 'Agent crashed', reservation:
    { version: 1, kind: 'merge', status: 'pending', blocked_reason: 'Agent 正在调用' } }, null, null, null);
  const panel = dom.node('detail');
  expect(buttonOf(panel, '复查预约')).toBeUndefined();
  expect(buttonOf(panel, '检查后重试')).toBeTruthy();
  expect(deepText(panel)).toContain('先检查失败现场');
});

test('nested say requests await the parent Agent; failed historical delivery has no report action or retry', () => {
  renderDetail({ ...say, status: 'completed', parent_task_kind: 'say', reservation:
    { version: 1, kind: 'merge', status: 'requested', commit, baseline, parent_id: 12 } }, null, null, null);
  expect(buttonOf(dom.node('detail'), '批准固定提交合入父分支')).toBeUndefined();
  expect(deepText(dom.node('detail'))).toContain('等待直接父 Agent');
  renderDetail({ ...say, status: 'failed', reservation:
    { version: 1, kind: 'showcase', status: 'failed', child_id: 81 } }, null, null, null);
  expect(buttonOf(dom.node('detail'), '检查后重试')).toBeUndefined();
  expect(buttonOf(dom.node('detail'), '查看展示 #81')).toBeUndefined();
});

test('no-change say gets an 已解决 button distinct from cancel; committed or showcase work does not', async () => {
  renderDetail({ ...say, head_commit: null, base_commit: baseline, integration: 'none' }, null, null, null);
  const panel = dom.node('detail');
  const resolve = buttonOf(panel, '已解决');
  expect(resolve).toBeDefined();
  // 语义不直观但不调用 Agent：只带 data-help，不带 agent-call。
  expect(resolve.classList.contains('agent-call')).toBe(false);
  expect(resolve.getAttribute('data-help')).toContain('放弃 Worker');
  const pending = resolve.onclick();
  expect(dialogText(dom)).toContain('已解决');
  await answerDialog(dom, '标记已解决'); await pending;
  expect(world.state.actions).toContainEqual({ method: 'worker.resolve', params: { id: say.id } });

  renderDetail({ ...say, head_commit: commit, base_commit: baseline, integration: 'pending' }, null, null, null);
  expect(buttonOf(dom.node('detail'), '已解决')).toBeUndefined();
  renderDetail({ ...say, head_commit: null, base_commit: baseline,
    reservation: { version: 1, kind: 'showcase', status: 'preparing', child_id: 5 } }, null, null, null);
  expect(buttonOf(dom.node('detail'), '已解决')).toBeUndefined();
});

test('non-terminal say offers 中断 instead of direct cancel; paused offers 继续 / 调整运行设置 / 放弃任务', async () => {
  renderDetail({ ...say, status: 'running' }, null, null, null);
  let panel = dom.node('detail');
  expect(buttonOf(panel, '取消 Worker 树')).toBeUndefined();
  const interrupt = buttonOf(panel, '中断');
  expect(interrupt).toBeTruthy();
  // 中断只是可恢复的停顿，不调用 Agent：带 data-help，但不带 agent-call。
  expect(interrupt.classList.contains('agent-call')).toBe(false);
  const pending = interrupt.onclick();
  expect(dialogText(dom)).toContain('保留现场');
  await answerDialog(dom, '中断'); await pending;
  expect(world.state.actions).toContainEqual({ method: 'worker.interrupt', params: { id: say.id } });

  renderDetail({ ...say, status: 'paused', agent_wakes: 1 }, null, null, null);
  panel = dom.node('detail');
  expect(buttonOf(panel, '中断')).toBeUndefined();
  expect(buttonOf(panel, '取消 Worker 树')).toBeUndefined();
  const resume = buttonOf(panel, '继续');
  expect(resume).toBeTruthy();
  expect(resume.classList.contains('agent-call')).toBe(true);
  expect(resume.getAttribute('data-help')).toContain('消耗 token');
  expect(buttonOf(panel, '调整运行设置')).toBeTruthy();
  const giveUp = buttonOf(panel, '放弃 Worker');
  expect(giveUp).toBeTruthy();
  expect(giveUp.classList.contains('agent-call')).toBe(false);

  await resume.onclick();
  expect(world.state.actions).toContainEqual({ method: 'worker.resume', params: { id: say.id } });

  renderDetail({ ...say, status: 'paused', agent_wakes: 1 }, null, null, null);
  const abandoning = buttonOf(dom.node('detail'), '放弃 Worker').onclick();
  expect(dialogText(dom)).toContain('放弃这条 Worker');
  await answerDialog(dom, '放弃 Worker'); await abandoning;
  expect(world.state.actions).toContainEqual({ method: 'worker.cancel', params: { id: say.id } });
});
