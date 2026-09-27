import { test, expect, afterAll } from 'bun:test';
import { installDom, deepText, dialogText, answerDialog } from '../dom-stub.js';
import { makeWorld } from './dom-world.js';

const world = makeWorld();
const graph = { nodes: [
  { id: 1, parent_id: null, task_kind: 'main', role: 'agent', status: 'waiting', title: 'main', branch: 'main', children: [] },
  { id: 2, parent_id: 1, task_kind: 'say', role: 'agent', status: 'waiting', title: '实现功能', branch: 'lush/task-2', workspace: '/tmp/task-2', has_rule: true },
], total: 2, truncated: false };
let requests = 0;
const dom = installDom({ fetch: (url, options) => {
  if (String(url) === '/api/task-graph') { requests++; return { ok: true, json: async () => graph }; }
  return world.fetchImpl(url, options);
} });
const { boot } = await import('../../src/ui/web/assets/app.js');
const { ui } = await import('../../src/ui/web/assets/state.js');
await boot();
afterAll(() => dom.restore());

test('Task 图以 Task 为节点；原分支图仍可切换，折叠与刷新不丢失', async () => {
  await dom.node('task-graph-open').onclick();
  expect(dom.location.hash).toBe('#task-graph');
  const text = deepText(dom.node('detail'));
  expect(text).toContain('实现功能');
  expect(text).toContain('lush/task-2');
  expect(text).toContain('/tmp/task-2');
  expect(text).toContain('固定输入规则');
  expect(requests).toBeGreaterThan(0);
  await dom.node('graph-open').onclick();
  expect(dom.location.hash).toBe('#graph');
  await dom.node('task-graph-open').onclick();
  expect(deepText(dom.node('detail'))).toContain('实现功能');
});

test('Task 图默认隐藏已归档 Task，可用「显示已归档」开关就地查看', async () => {
  const archived = { id: 99, parent_id: 1, task_kind: 'say', role: 'agent', status: 'completed',
    title: '已归档的工作', branch: 'lush/task-99', workspace: null, integration: 'merged',
    branch_info: { parent: 'main', archived: true, current_head: null, diagnostics: null, subtree_say: 0, merge_run: null },
    children: [] };
  graph.nodes.push(archived); graph.total += 1;
  try {
    await dom.node('task-graph-open').onclick();
    expect(dom.node('detail').querySelector('[data-task-id="99"]')).toBeNull();
    expect(deepText(dom.node('detail'))).not.toContain('已归档的工作');
    const toggle = dom.node('detail').querySelector('.task-graph-archived-toggle');
    expect(toggle).toBeTruthy();
    expect(toggle.textContent).toContain('显示已归档（1）');
    expect(toggle.getAttribute('data-help')).toContain('默认隐藏');
    toggle.onclick();
    const card = dom.node('detail').querySelector('[data-task-id="99"]');
    expect(card).toBeTruthy();
    expect(deepText(card)).toContain('分支已归档');
    expect(dom.node('detail').querySelector('.task-graph-archived-toggle').textContent).toContain('隐藏已归档（1）');
    // 再点一次收回，保持默认视图。
    dom.node('detail').querySelector('.task-graph-archived-toggle').onclick();
    expect(dom.node('detail').querySelector('[data-task-id="99"]')).toBeNull();
  } finally {
    graph.nodes.pop(); graph.total -= 1;
    ui.taskGraphShowArchived = false;
    await dom.node('task-graph-open').onclick();
  }
});

test('Task 图：效果展示子 Task 的隔离检出显式标注 detached worktree，普通分支仍写 worktree', async () => {
  const showcase = { id: 3, parent_id: 2, task_kind: 'showcase', role: 'showcase', status: 'waiting', title: '展示效果',
    branch: null, workspace: '/tmp/showcase-3', children: [] };
  graph.nodes.push(showcase);
  try {
    await dom.node('task-graph-open').onclick();
    const showcaseCard = dom.node('detail').querySelector('[data-task-id="3"]');
    expect(deepText(showcaseCard)).toContain('detached worktree：/tmp/showcase-3');
    // 普通有分支的 Task 不应被误标。
    const sayCard = dom.node('detail').querySelector('[data-task-id="2"]');
    expect(deepText(sayCard)).toContain('worktree：/tmp/task-2');
    expect(deepText(sayCard)).not.toContain('detached worktree');
  } finally {
    graph.nodes.pop();
    await dom.node('task-graph-open').onclick();
  }
});

test('Task 卡片同屏展示工作状态、进度、结果、Git 诊断、待决与交付入口', async () => {
  graph.nodes[0].freeze = { kind: 'resolution', task_id: 2, reason: '正在固定源 Task 与父分支' };
  Object.assign(graph.nodes[1], {
    resolves_task_id: 7,
    goal_preview: '实现功能\n附带验收条件', waiting_reason: '静息 · 等待新输入或子 Task 信号',
    result_preview: '已完成初步实现', calls: 2, children_total: 1, children_active: 0,
    integration: 'pending', target_branch: 'main', head_commit: 'abc456', base_commit: 'abc123', has_result: true,
    progress: { completed: 1, total: 3, current: { label: '实现接口', started_at: '2026-01-01T00:00:00Z' } },
    notice: { id: 42, kind: 'question', title: '是否继续？', body: '先决定接口名称' }, notice_count: 1,
    branch_info: { current_head: 'abc456', archived: false, diagnostics: {
      changes: { status: 'ok', files_total: 2, added: 12, deleted: 3, binary_files: 0,
        base_commit: 'abc123', head_commit: 'abc456', files: [{ path: 'src/api.js', added: 12, deleted: 3 }], truncated: false },
      latest_commit: { subject: 'implement API', committed_at: '2026-01-01T00:00:00Z' },
      working_tree: { status: 'dirty', path: '/tmp/task-2', files_total: 1, staged: 0, unstaged: 1, untracked: 0, conflicts: 0 },
    } },
  });
  await dom.node('task-graph-open').onclick();
  const text = deepText(dom.node('detail'));
  for (const word of ['验收条件', '等待新输入', '已完成初步实现', '实现接口', '1/3',
    '已提交：2 个文件', '未提交：1 个文件', 'implement API', '是否继续？', '合并到父 Task',
    '正在解决 Task #7', '冻结']) {
    expect(text).toContain(word);
  }
  const card = dom.node('detail').querySelector('[data-task-id="2"]');
  const decision = card.querySelector('.graph-decision-input');
  decision.value = '继续';
  await dom.intervalFor(1500)();
  expect(dom.node('detail').querySelector('.graph-decision-input')).toBe(decision);
  await card.querySelector('.graph-decision').querySelectorAll('button')
    .find(node => node.textContent === '回复并继续任务').onclick();
  expect(world.state.actions.at(-1)).toMatchObject({ method: 'notice.answer', params: { id: 42 } });
  // Snapshot revision unchanged: Git data is still refreshed after the max age.
  graph.nodes[1].branch_info.diagnostics.working_tree.files_total = 3;
  const previousRequests = requests;
  ui.taskGraphFetchedAt = Date.now() - 11000;
  await dom.intervalFor(1500)();
  expect(requests).toBeGreaterThan(previousRequests);
  expect(deepText(dom.node('detail'))).toContain('未提交：3 个文件');

  // 静息待合并的 say 给的是 v2 交付入口：确认框说明由父 Task 的 merge 子任务串行处理，确认后才请求。
  const delivery = dom.node('detail').querySelector('[data-task-id="2"]')
    .querySelectorAll('button').find(node => node.textContent === '合并到父 Task');
  expect(delivery).toBeTruthy();
  expect(delivery.classList.contains('agent-call')).toBe(true);
  const requesting = delivery.onclick();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(dialogText(dom)).toContain('由父 Task 的 merge 子任务串行处理');
  await answerDialog(dom, '请求合并');
  await requesting;
  expect(world.state.actions.at(-1)).toEqual({ method: 'task.reserve', params: { id: 2, kind: 'merge' } });
});

test('Task 图：卡片按真实状态配色，一键编排入口已下线', async () => {
  const main = graph.nodes[0];
  const saved = { freeze: main.freeze, status: graph.nodes[1].status };
  try {
    main.freeze = null;
    graph.nodes[1].status = 'running';
    await dom.node('task-graph-open').onclick();

    // 颜色按真实状态分开：主 Task 在等、子 Task 在跑，一眼可辨。
    const mainCard = dom.node('detail').querySelector('[data-task-id="1"]');
    const sayCard = dom.node('detail').querySelector('[data-task-id="2"]');
    expect(mainCard.classList.contains('task-graph-waiting')).toBe(true);
    expect(sayCard.classList.contains('task-graph-running')).toBe(true);
    expect(sayCard.querySelector('.badge.b-running')).toBeTruthy();

    // 旧 `branch.orchestrate_plan` / `branch.orchestrate` 一键编排卡片已下线，不再给任何编排按钮。
    expect(mainCard.querySelectorAll('button').some(node => node.textContent.includes('编排'))).toBe(false);
  } finally {
    main.freeze = saved.freeze;
    graph.nodes[1].status = saved.status;
    await dom.node('task-graph-open').onclick();
  }
});

test('Task 图：分支合并状态进卡片首行标签，facts 行不再重复', async () => {
  const saved = { integration: graph.nodes[1].integration };
  const headBadges = card => [...card.querySelector('.task-graph-head').querySelectorAll('.badge')]
    .map(node => node.textContent);
  try {
    // 待合并：和任务状态一起出现在卡片最上面一行。
    graph.nodes[1].integration = 'pending';
    await dom.node('task-graph-open').onclick();
    let card = dom.node('detail').querySelector('[data-task-id="2"]');
    expect(headBadges(card)).toContain('待合并');
    // 原来的「集成：…」从下方 facts 行移除，不在两处重复。
    expect(deepText(card.querySelector('.task-graph-facts'))).not.toContain('集成：');
    expect(deepText(card.querySelector('.task-graph-facts'))).not.toContain('待合并');

    // 配色与任务详情同源：已合并用完成色，其余用待处理色。
    graph.nodes[1].integration = 'merged';
    await dom.node('task-graph-open').onclick();
    card = dom.node('detail').querySelector('[data-task-id="2"]');
    expect(headBadges(card)).toContain('已合并');
    const mergedBadge = [...card.querySelector('.task-graph-head').querySelectorAll('.badge')]
      .find(node => node.textContent === '已合并');
    expect(mergedBadge.classList.contains('b-completed')).toBe(true);

    // none（没有独有提交）不占位，也不再以「集成：none」的形式出现在 facts 行。
    graph.nodes[1].integration = 'none';
    await dom.node('task-graph-open').onclick();
    card = dom.node('detail').querySelector('[data-task-id="2"]');
    expect(headBadges(card)).not.toContain('待合并');
    expect(deepText(card)).not.toContain('集成：');
    expect(deepText(card)).not.toContain('集成：none');
  } finally {
    graph.nodes[1].integration = saved.integration;
    await dom.node('task-graph-open').onclick();
  }
});

test('Task 图：merge 卡片与其它 Task 一样按状态开关显示，不再空闲就整层收起', async () => {
  const merge = { id: 5, parent_id: 1, task_kind: 'merge', role: 'agent', status: 'waiting',
    title: '串行处理 Task #1 的合并请求', branch: null, workspace: null, target_branch: 'main' };
  const child = { id: 6, parent_id: 5, task_kind: 'say', role: 'agent', status: 'running', title: '等待合并的工作',
    branch: 'lush/task-6', workspace: '/tmp/task-6', target_branch: 'main', integration: 'pending',
    reservation: { version: 2, kind: 'merge', status: 'requested' } };
  const roots = () => [...dom.node('detail').querySelector('.task-graph').children]
    .filter(node => node.classList.contains('task-graph-node'));
  const card = id => dom.node('detail').querySelector(`[data-task-id="${id}"]`);
  const wrapOf = id => {
    for (let at = card(id); at; at = at.parentNode) if (at.classList.contains('task-graph-node')) return at;
    return null;
  };
  graph.nodes.push(merge, child); graph.total += 2;
  try {
    await dom.node('task-graph-open').onclick();
    // 队列在动：merge 卡在图上，子 Task 嵌在它下面，而不是变成「父 Task 不在当前图中」的根。
    expect(deepText(card(5))).toContain('merge');
    expect(deepText(card(5))).toContain('合并队列：1 条已发请求待落地（正在处理 #6）');
    expect(wrapOf(5).querySelector('[data-task-id="6"]')).toBeTruthy();
    expect(deepText(card(6))).not.toContain('不在当前图中');
    expect(roots()).toHaveLength(1);

    // 队列空闲：merge 是常驻的合并队列身份，卡片照旧显示（隐藏与否交给表头的状态开关）。
    merge.status = 'completed';
    child.status = 'completed'; child.reservation = { ...child.reservation, status: 'integrated' };
    await dom.node('task-graph-open').onclick();
    expect(card(5)).toBeTruthy();
    expect(wrapOf(5).querySelector('[data-task-id="6"]')).toBeTruthy();
    expect(roots()).toHaveLength(1);

    // 用状态开关关掉「已完成」：merge 卡片与名下已完成的子 Task 一起消失，
    // 剩下的树不受影响，也不会误报「父 Task 不在当前图中」。
    dom.node('detail').querySelector('.task-graph-status-toggle[data-status="completed"]').onclick();
    expect(card(5)).toBeNull();
    expect(card(6)).toBeNull();
    expect(deepText(dom.node('detail'))).not.toContain('合并队列');
    expect(wrapOf(1).querySelector('[data-task-id="2"]')).toBeTruthy();
    expect(deepText(dom.node('detail'))).not.toContain('不在当前图中');
  } finally {
    graph.nodes = graph.nodes.filter(node => ![5, 6].includes(node.id)); graph.total -= 2;
    globalThis.localStorage.removeItem('lush.taskGraph.hiddenStatuses');
    await dom.node('task-graph-open').onclick();
  }
});

test('Task 图：表头状态图例即开关，按状态隐藏后可一键恢复，偏好写进受管 localStorage 键', async () => {
  graph.nodes.push({ id: 7, parent_id: 2, task_kind: 'say', role: 'agent', status: 'completed', title: '已经收尾的工作',
    branch: 'lush/task-7', workspace: null, integration: 'merged' });
  graph.total += 1;
  const chip = status => dom.node('detail').querySelector(`.task-graph-status-toggle[data-status="${status}"]`);
  const card = id => dom.node('detail').querySelector(`[data-task-id="${id}"]`);
  try {
    await dom.node('task-graph-open').onclick();
    expect(chip('completed').textContent).toContain('已完成 1');
    expect(chip('completed').getAttribute('aria-pressed')).toBe('true');
    expect(card(7)).toBeTruthy();
    chip('completed').onclick();
    expect(card(7)).toBeNull();
    expect(chip('completed').getAttribute('aria-pressed')).toBe('false');
    expect(JSON.parse(globalThis.localStorage.getItem('lush.taskGraph.hiddenStatuses'))).toEqual(['completed']);
    // 只按状态筛：不同状态的兄弟 Task 不受影响。
    expect(card(2)).toBeTruthy();
    // 关掉的状态仍留在表头上，点回来即可恢复；「全部状态」一次清空筛选。
    chip('completed').onclick();
    expect(card(7)).toBeTruthy();
    chip('completed').onclick();
    dom.node('detail').querySelector('.task-graph-status-reset').onclick();
    expect(card(7)).toBeTruthy();
    expect(globalThis.localStorage.getItem('lush.taskGraph.hiddenStatuses')).toBe('[]');
    // 隐藏父 Task 的状态：子 Task 顶成根（与归档筛选同一口径），不会跟着消失也不会误报父不在图里。
    chip('waiting').onclick();
    expect(card(1)).toBeNull();
    expect(card(2)).toBeNull();
    expect(card(7)).toBeTruthy();
    expect(deepText(card(7))).not.toContain('不在当前图中');
  } finally {
    graph.nodes = graph.nodes.filter(node => node.id !== 7); graph.total -= 1;
    globalThis.localStorage.removeItem('lush.taskGraph.hiddenStatuses');
    await dom.node('task-graph-open').onclick();
  }
});

test('Task 图：可归档分支给「归档」按钮，帮助说清含义，确认后才走 branch.archive', async () => {
  const saved = graph.nodes[1].branch_info;
  graph.nodes[1].branch_info = { ...(saved || {}), archived: false, current_head: 'abc456', archivable: true, subtree_branches: 0 };
  try {
    await dom.node('task-graph-open').onclick();
    const card = dom.node('detail').querySelector('[data-task-id="2"]');
    const archive = card.querySelectorAll('button').find(node => node.textContent === '归档');
    expect(archive).toBeTruthy();
    // 按钮说明归档的含义：删 worktree/ref、未提交改动会丢、Task 与会话保留、不等于删除 Task。
    const help = archive.getAttribute('data-help');
    expect(help).toContain('worktree 与本地 ref');
    expect(help).toContain('未提交改动');
    expect(help).toContain('不等于删除 Task');

    const pending = archive.onclick();
    expect(dialogText(dom)).toContain('保留任务、会话与分支记录');
    expect(world.state.actions.some(entry => entry.method === 'branch.archive')).toBe(false);
    await answerDialog(dom, '归档');
    await pending;
    expect(world.state.actions).toContainEqual({ method: 'branch.archive', params: { branch: 'lush/task-2', discard: true } });

    // 不可归档（还有活动任务 / 当前检出等）时不给按钮。
    graph.nodes[1].branch_info = { ...(saved || {}), archived: false, current_head: 'abc456', archivable: false, subtree_branches: 0 };
    await dom.node('task-graph-open').onclick();
    expect(dom.node('detail').querySelector('[data-task-id="2"]')
      .querySelectorAll('button').some(node => node.textContent === '归档')).toBe(false);
  } finally {
    graph.nodes[1].branch_info = saved;
    await dom.node('task-graph-open').onclick();
  }
});
