import { test, expect, afterAll } from 'bun:test';
import { installDom, dialogText, answerDialog, deepText } from '../dom-stub.js';
import { makeWorld } from './dom-world.js';

const world = makeWorld();
const dom = installDom({ fetch: world.fetchImpl });
const { boot } = await import('../../src/ui/web/assets/app.js');
const { renderDetail } = await import('../../src/ui/web/assets/render-detail.js');
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
  deps: [], dependents: [], children: [], messages: [], notices: [], reservation: null };
const buttonOf = (root, label) => root.querySelectorAll('button').find(node => node.textContent === label);
const graphFor = (reservation, { done = false, status = null } = {}) => ({ total: 1, nodes: [
  { kind: 'task', id: say.id, role: 'agent', task_kind: 'say', parent_id: 1, parent_task_kind: 'main',
    title: say.goal, goal: say.goal, branch, target_branch: 'main',
    status: status ?? (reservation?.status === 'requested' ? 'completed' : 'waiting'),
    integration: 'pending', reservation, base_commit: baseline, head_commit: commit,
    has_result: done, workspace: '/tmp/lush-new-say' },
], edges: [] });

function sourceRow() {
  return dom.node('detail').querySelector(`[data-task-id="${say.id}"]`);
}

test('Task detail offers an Agent merge request and showcase booking', async () => {
  renderDetail(say, null, null, null);
  const detail = dom.node('detail');
  const merge = buttonOf(detail, '合并到父 Task'), showcase = buttonOf(detail, '预约展示');
  // 两条都是 Agent 入口：合并请求交给父 Task 的 merge 子任务，展示会启动展示子 Agent。
  expect(merge.classList.contains('agent-call')).toBe(true);
  expect(merge.getAttribute('data-help')).toContain('消耗 token');
  expect(showcase.classList.contains('agent-call')).toBe(true);
  expect(showcase.getAttribute('data-help')).toContain('消耗 token');
  const pending = merge.onclick();
  expect(dialogText(dom)).toContain('merge 子任务');
  expect(world.state.actions.some(action => action.method === 'task.reserve')).toBe(false);
  await answerDialog(dom, '请求合并'); await pending;
  expect(world.state.actions).toContainEqual({ method: 'task.reserve', params: { id: say.id, kind: 'merge' } });

  renderDetail(say, null, null, null);
  await buttonOf(dom.node('detail'), '预约展示').onclick();
  expect(world.state.actions).toContainEqual({ method: 'task.reserve', params: { id: say.id, kind: 'showcase' } });
});

test('idle say with committed changes requests a merge; v2 reservations expose recheck and withdraw', async () => {
  const done = { ...say, calls: 1, result: '已提交并测试', base_commit: baseline, head_commit: commit };
  renderDetail(done, null, null, null);
  let panel = dom.node('detail');
  const request = buttonOf(panel, '合并到父 Task');
  expect(request).toBeTruthy();
  const pending = request.onclick();
  expect(dialogText(dom)).toContain('merge 子任务');
  await answerDialog(dom, '请求合并'); await pending;
  expect(world.state.actions.at(-1)).toEqual({ method: 'task.reserve', params: { id: say.id, kind: 'merge' } });

  // 新模型 reservation 是 version 2：pending 显示等待徽标与撤销，requested 显示冻结与复查。
  renderDetail({ ...done, reservation: { version: 2, kind: 'merge', status: 'pending' } }, null, null, null);
  panel = dom.node('detail');
  expect(deepText(panel)).toContain('已预约合并');
  expect(buttonOf(panel, '撤销预约')).toBeTruthy();
  renderDetail({ ...done, reservation: { version: 2, kind: 'merge', status: 'requested', commit, baseline } }, null, null, null);
  panel = dom.node('detail');
  expect(deepText(panel)).toContain('冻结');
  expect(buttonOf(panel, '复查合并队列')).toBeTruthy();
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
  expect(world.state.actions.some(action => action.method === 'task.approve_merge')).toBe(false);
  await answerDialog(dom, `批准 ${commit.slice(0, 12)}`); await pending;
  expect(world.state.actions).toContainEqual({ method: 'task.approve_merge', params: { id: say.id, commit, baseline } });

  renderGraph(graphFor({ version: 1, kind: 'merge', status: 'pending', blocked_reason: 'parent diverged' }), { force: true });
  const recheck = buttonOf(sourceRow(), '复查预约');
  expect(recheck.classList.contains('agent-call')).toBe(false);
  expect(recheck.getAttribute('data-help')).toContain('不会直接推进父分支');
  await recheck.onclick();
  expect(world.state.actions.at(-1)).toEqual({ method: 'task.reserve', params: { id: say.id, kind: 'merge' } });

  renderGraph(graphFor(null), { force: true });
  const reserve = buttonOf(sourceRow(), '预约展示');
  expect(reserve).toBeTruthy();
  expect(reserve.classList.contains('agent-call')).toBe(true);
  expect(buttonOf(sourceRow(), '预约效果展示')).toBeUndefined();
});

test('a delivered showcase leaves the completed say a fixed merge request in the graph, never legacy branch.merge', async () => {
  const reservation = { version: 1, kind: 'showcase', status: 'completed', child_id: 5, commit, baseline };
  renderGraph(graphFor(reservation, { done: true, status: 'completed' }), { force: true });
  const row = sourceRow();
  expect(buttonOf(row, '合入父分支')).toBeUndefined();
  expect(deepText(row)).toContain('展示已交付');
  const request = buttonOf(row, '请求合并');
  expect(request).toBeTruthy();
  expect(request.classList.contains('agent-call')).toBe(true);
  const pending = request.onclick();
  expect(dialogText(dom)).toContain('原 Task');
  await answerDialog(dom, '发起请求'); await pending;
  expect(world.state.actions.at(-1)).toEqual({ method: 'task.reserve', params: { id: say.id, kind: 'merge' } });
});

test('a diverged merge offers a source-side Agent child, but does not call legacy sync or approve the parent', async () => {
  renderGraph(graphFor({ version: 1, kind: 'merge', status: 'pending', blocked_code: 'diverged',
    blocked_reason: 'cannot request a merge from a diverged branch; resolve it first' }), { force: true });
  const row = sourceRow();
  const resolve = buttonOf(row, '派子任务解决分歧');
  expect(resolve.classList.contains('agent-call')).toBe(true);
  expect(resolve.getAttribute('data-help')).toContain('消耗 token');
  const start = resolve.onclick();
  expect(dialogText(dom)).toContain('不会直接推进 say 或父分支');
  expect(world.state.actions.some(action => action.method === 'task.resolve_divergence')).toBe(false);
  await answerDialog(dom, '派解分歧子任务'); await start;
  expect(world.state.actions.at(-1)).toEqual({ method: 'task.resolve_divergence', params: { id: say.id } });
  expect(world.state.actions.some(action => action.method === 'branch.sync')).toBe(false);
  renderDetail({ ...say, reservation: { version: 1, kind: 'merge', status: 'pending',
    blocked_reason: '等待解分歧子 Task #92 完成', blocked_code: 'resolving', resolution_child_id: 92 } }, null, null, null);
  expect(buttonOf(dom.node('detail'), '派子任务解决分歧')).toBeUndefined();
  expect(buttonOf(dom.node('detail'), '查看解分歧 #92')).toBeTruthy();
  world.state.resolveOutcome = { status: 'needs_review', task: { id: 92 },
    reason: '子任务 #92 尚未集成；检查后显式归档旧分支再派任务' };
  renderDetail({ ...say, reservation: { version: 1, kind: 'merge', status: 'pending', blocked_code: 'diverged',
    resolution_child_id: 92 } }, null, null, null);
  const again = buttonOf(dom.node('detail'), '派子任务解决分歧').onclick();
  await answerDialog(dom, '派解分歧子任务'); await again;
  expect(dom.node('error').textContent).toContain('显式归档旧分支');
  world.state.resolveOutcome = null;
});

test('a terminal say with a diverged merge reservation still offers the standalone divergence child', async () => {
  renderGraph(graphFor({ version: 1, kind: 'merge', status: 'pending', blocked_code: 'diverged',
    blocked_reason: '分支与直接父分支已分歧；先派独立解分歧子 Task 吸收固定的父提交，再重新发合并请求。' },
  { status: 'completed' }), { force: true });
  const row = sourceRow();
  expect(deepText(row)).not.toContain('不能直接复查预约');
  const resolve = buttonOf(row, '派子任务解决分歧');
  expect(resolve).toBeTruthy();
  expect(resolve.classList.contains('agent-call')).toBe(true);
  const start = resolve.onclick();
  expect(dialogText(dom)).toContain('由 runtime 快进推进 say 分支');
  await answerDialog(dom, '派解分歧子任务'); await start;
  expect(world.state.actions.at(-1)).toEqual({ method: 'task.resolve_divergence', params: { id: say.id } });
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
  expect(deepText(panel)).toContain('Task、固定提交记录和会话仍保留');
  expect(deepText(panel)).toContain('返回源 say');
  // 修复已完子任务固定提交的解分歧子任务：重试由直接父 Agent 驱动，不是返回 say。
  renderDetail({ ...child, divergence_resolution: { ...child.divergence_resolution, source_task_id: 91 } }, null, null, null);
  expect(deepText(panel)).toContain('再派一个以同一固定提交为基线的解分歧子任务');
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
  expect(world.state.actions.slice(beforeWithdraw).some(action => action.method === 'task.unreserve')).toBe(false);
  await answerDialog(dom, '撤销请求'); await pending;
  expect(world.state.actions.at(-1)).toEqual({ method: 'task.unreserve', params: { id: say.id } });
  // 已发出的请求也给一条只读「复查请求」：点完会重画详情，所以重新取节点再断言。
  renderDetail({ ...say, status: 'completed', reservation }, null, null, null);
  const fresh = dom.node('detail');
  const recheck = buttonOf(fresh, '复查请求');
  expect(recheck.classList.contains('agent-call')).toBe(false);
  const beforeRecheck = world.state.actions.length;
  await recheck.onclick();
  expect(world.state.actions.at(-1)).toEqual({ method: 'task.reserve', params: { id: say.id, kind: 'merge' } });
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

test('nested say requests await the parent Agent; failed showcase offers a report link but no retry', () => {
  renderDetail({ ...say, status: 'completed', parent_task_kind: 'say', reservation:
    { version: 1, kind: 'merge', status: 'requested', commit, baseline, parent_id: 12 } }, null, null, null);
  expect(buttonOf(dom.node('detail'), '批准固定提交合入父分支')).toBeUndefined();
  expect(deepText(dom.node('detail'))).toContain('等待直接父 Agent');
  renderDetail({ ...say, status: 'failed', reservation:
    { version: 1, kind: 'showcase', status: 'failed', child_id: 81 } }, null, null, null);
  expect(buttonOf(dom.node('detail'), '检查后重试')).toBeUndefined();
  expect(buttonOf(dom.node('detail'), '查看展示 #81')).toBeTruthy();
});

test('no-change say gets an 已解决 button distinct from cancel; committed or showcase work does not', async () => {
  renderDetail({ ...say, head_commit: null, base_commit: baseline, integration: 'none' }, null, null, null);
  const panel = dom.node('detail');
  const resolve = buttonOf(panel, '已解决');
  expect(resolve).toBeDefined();
  // 语义不直观但不调用 Agent：只带 data-help，不带 agent-call。
  expect(resolve.classList.contains('agent-call')).toBe(false);
  expect(resolve.getAttribute('data-help')).toContain('放弃任务');
  const pending = resolve.onclick();
  expect(dialogText(dom)).toContain('已解决');
  await answerDialog(dom, '标记已解决'); await pending;
  expect(world.state.actions).toContainEqual({ method: 'task.resolve', params: { id: say.id } });

  renderDetail({ ...say, head_commit: commit, base_commit: baseline, integration: 'pending' }, null, null, null);
  expect(buttonOf(dom.node('detail'), '已解决')).toBeUndefined();
  renderDetail({ ...say, head_commit: null, base_commit: baseline,
    reservation: { version: 1, kind: 'showcase', status: 'preparing', child_id: 5 } }, null, null, null);
  expect(buttonOf(dom.node('detail'), '已解决')).toBeUndefined();
});

test('non-terminal say offers 中断 instead of direct cancel; paused offers 继续 / 调整运行设置 / 放弃任务', async () => {
  renderDetail({ ...say, status: 'running' }, null, null, null);
  let panel = dom.node('detail');
  expect(buttonOf(panel, '取消任务树')).toBeUndefined();
  const interrupt = buttonOf(panel, '中断');
  expect(interrupt).toBeTruthy();
  // 中断只是可恢复的停顿，不调用 Agent：带 data-help，但不带 agent-call。
  expect(interrupt.classList.contains('agent-call')).toBe(false);
  const pending = interrupt.onclick();
  expect(dialogText(dom)).toContain('保留现场');
  await answerDialog(dom, '中断'); await pending;
  expect(world.state.actions).toContainEqual({ method: 'task.interrupt', params: { id: say.id } });

  renderDetail({ ...say, status: 'paused', agent_wakes: 1 }, null, null, null);
  panel = dom.node('detail');
  expect(buttonOf(panel, '中断')).toBeUndefined();
  expect(buttonOf(panel, '取消任务树')).toBeUndefined();
  const resume = buttonOf(panel, '继续');
  expect(resume).toBeTruthy();
  expect(resume.classList.contains('agent-call')).toBe(true);
  expect(resume.getAttribute('data-help')).toContain('消耗 token');
  expect(buttonOf(panel, '调整运行设置')).toBeTruthy();
  const giveUp = buttonOf(panel, '放弃任务');
  expect(giveUp).toBeTruthy();
  expect(giveUp.classList.contains('agent-call')).toBe(false);

  await resume.onclick();
  expect(world.state.actions).toContainEqual({ method: 'task.resume', params: { id: say.id } });

  renderDetail({ ...say, status: 'paused', agent_wakes: 1 }, null, null, null);
  const abandoning = buttonOf(dom.node('detail'), '放弃任务').onclick();
  expect(dialogText(dom)).toContain('放弃这条 Task');
  await answerDialog(dom, '放弃任务'); await abandoning;
  expect(world.state.actions).toContainEqual({ method: 'task.cancel', params: { id: say.id } });
});
