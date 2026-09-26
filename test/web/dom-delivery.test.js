import { test, expect, afterAll } from 'bun:test';
import { installDom, dialogText, answerDialog, deepText } from '../dom-stub.js';
import { makeWorld } from './dom-world.js';

const world = makeWorld();
const dom = installDom({ fetch: world.fetchImpl });
const { boot } = await import('../../src/ui/web/assets/app.js');
const { renderDetail } = await import('../../src/ui/web/assets/render-detail.js');
const { renderGraph } = await import('../../src/ui/web/assets/render-graph.js');
dom.node('side-nav').replaceChildren();
await boot();
afterAll(() => dom.restore());

const commit = 'a'.repeat(40), baseline = 'b'.repeat(40), branch = 'feature/new-say';
const say = { id: 70, role: 'agent', task_kind: 'say', parent_id: 1, parent_task_kind: 'main',
  goal: 'ship a view', status: 'waiting', integration: 'pending', calls: 0, branch, target_branch: 'main',
  deps: [], dependents: [], children: [], messages: [], notices: [], reservation: null };
const buttonOf = (root, label) => root.querySelectorAll('button').find(node => node.textContent === label);
const graphFor = (reservation, { done = false } = {}) => ({ git: true, current_branch: 'main', nodes: [
  { kind: 'branch', id: 'branch:main', name: 'main', head_commit: baseline, current: true, tracked: true },
  { kind: 'branch', id: `branch:${branch}`, name: branch, head_commit: commit, tracked: true,
    showcase: { reserved: false, reserve_allowed: true } },
  { kind: 'task', id: say.id, role: 'agent', task_kind: 'say', parent_id: 1, parent_task_kind: 'main',
    goal: say.goal, branch, target_branch: 'main', status: reservation?.status === 'requested' ? 'completed' : 'waiting',
    integration: 'pending', reservation, base_commit: baseline, head_commit: commit,
    has_result: done, workspace: '/tmp/lush-new-say' },
], edges: [{ kind: 'fork', from: 'branch:main', to: `branch:${branch}`,
  status: 'fast_forward', ahead: 1, behind: 0, blockers: [], can_merge: true }] });

function sourceRow() {
  return dom.node('detail').querySelectorAll('div.graph-branch')
    .find(row => row.querySelector('.graph-branch-name')?.textContent.includes(branch));
}

test('Task detail offers mutually exclusive booking; only showcase marks the Agent cost', async () => {
  renderDetail(say, null, null, null);
  const detail = dom.node('detail');
  const showcase = buttonOf(detail, '预约展示'), merge = buttonOf(detail, '预约合并请求');
  expect(showcase.classList.contains('agent-call')).toBe(true);
  expect(showcase.getAttribute('data-help')).toContain('消耗 token');
  expect(merge.classList.contains('agent-call')).toBe(false);
  const pending = showcase.onclick();
  expect(dialogText(dom)).toContain('原 Task 在展示结束前不会终结');
  expect(buttonOf(dom.node('modal'), '预约展示').classList.contains('agent-call')).toBe(true);
  expect(world.state.actions.some(action => action.method === 'task.reserve')).toBe(false);
  await answerDialog(dom, '预约展示'); await pending;
  expect(world.state.actions).toContainEqual({ method: 'task.reserve', params: { id: say.id, kind: 'showcase' } });

  renderDetail({ ...say, reservation: { version: 1, kind: 'showcase', status: 'pending', blocked_reason: '工作区有未提交改动' } }, null, null, null);
  expect(deepText(dom.node('detail'))).toContain('上次检查未满足：工作区有未提交改动');
  expect(buttonOf(dom.node('detail'), '预约合并请求')).toBeUndefined();
  const recheck = buttonOf(dom.node('detail'), '复查预约');
  expect(recheck.classList.contains('agent-call')).toBe(true);
  const retry = recheck.onclick();
  expect(dialogText(dom)).toContain('若已满足条件，会立即创建并启动展示子 Agent');
  expect(world.state.actions.filter(action => action.method === 'task.reserve')).toHaveLength(1);
  await answerDialog(dom, '复查展示'); await retry;
  expect(world.state.actions.filter(action => action.method === 'task.reserve')).toHaveLength(2);
  expect(world.state.actions.at(-1)).toEqual({ method: 'task.reserve', params: { id: say.id, kind: 'showcase' } });
  renderDetail({ ...say, reservation: { version: 1, kind: 'showcase', status: 'pending', blocked_reason: '工作区有未提交改动' } }, null, null, null);
  await buttonOf(dom.node('detail'), '撤销预约').onclick();
  expect(world.state.actions).toContainEqual({ method: 'task.unreserve', params: { id: say.id } });
});

test('idle say with a completed invocation and committed changes offers a merge request, not a future booking', async () => {
  const done = { ...say, calls: 1, result: '已提交并测试', base_commit: baseline, head_commit: commit };
  renderDetail(done, null, null, null);
  let panel = dom.node('detail');
  expect(buttonOf(panel, '预约展示')).toBeUndefined();
  expect(buttonOf(panel, '预约合并请求')).toBeUndefined();
  const request = buttonOf(panel, '请求合并');
  expect(request).toBeTruthy();
  const pending = request.onclick();
  expect(dialogText(dom)).toContain('不会自动推进父分支');
  expect(world.state.actions.some(action => action.method === 'task.approve_merge')).toBe(false);
  await answerDialog(dom, '发起请求'); await pending;
  expect(world.state.actions.at(-1)).toEqual({ method: 'task.reserve', params: { id: say.id, kind: 'merge' } });

  renderGraph(graphFor(null, { done: true }), { force: true });
  expect(buttonOf(sourceRow(), '请求合并')).toBeTruthy();
  expect(buttonOf(sourceRow(), '预约展示')).toBeUndefined();
  renderDetail({ ...done, reservation: { kind: 'merge', status: 'pending', blocked_reason: '工作区有未提交改动' } }, null, null, null);
  panel = dom.node('detail');
  expect(deepText(panel)).toContain('合并请求待就绪');
  expect(buttonOf(panel, '复查合并请求')).toBeTruthy();
  expect(buttonOf(panel, '撤销合并请求意图')).toBeTruthy();
  renderDetail({ ...done, head_commit: baseline }, null, null, null);
  expect(buttonOf(dom.node('detail'), '请求合并')).toBeUndefined();
  renderDetail({ ...done, status: 'running' }, null, null, null);
  expect(buttonOf(dom.node('detail'), '请求合并')).toBeUndefined();
});

test('branch graph uses the same fixed approval, never legacy branch.merge or branch showcase for new say', async () => {
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
