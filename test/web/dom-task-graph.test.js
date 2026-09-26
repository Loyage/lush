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
    '已提交：2 个文件', '未提交：1 个文件', 'implement API', '是否继续？', '请求合并',
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
});

test('Task 图：主 Task 给子 Task 合并编排入口，运行中改显进度与取消；卡片按状态配色', async () => {
  const main = graph.nodes[0];
  const saved = { branch_info: main.branch_info, freeze: main.freeze, status: graph.nodes[1].status };
  try {
    main.branch_info = { parent: null, archived: false, subtree_say: 2, merge_run: null };
    main.freeze = null;
    graph.nodes[1].status = 'running';
    await dom.node('task-graph-open').onclick();

    // 颜色按真实状态分开：主 Task 在等、子 Task 在跑，一眼可辨。
    const mainCard = dom.node('detail').querySelector('[data-task-id="1"]');
    const sayCard = dom.node('detail').querySelector('[data-task-id="2"]');
    expect(mainCard.classList.contains('task-graph-waiting')).toBe(true);
    expect(sayCard.classList.contains('task-graph-running')).toBe(true);
    expect(sayCard.querySelector('.badge.b-running')).toBeTruthy();

    const orchestrate = mainCard.querySelectorAll('button').find(node => node.textContent === '编排合并全部子 Task');
    expect(orchestrate).toBeTruthy();
    expect(orchestrate.classList.contains('agent-call')).toBe(true);
    expect(orchestrate.getAttribute('data-help')).toContain('消耗 token');

    // 点击先拉只读计划，确认前不执行；确认框里把固定提交与动作列清楚。
    const pending = orchestrate.onclick();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(world.state.actions.at(-1)).toMatchObject({ method: 'branch.orchestrate_plan', params: { branch: 'main' } });
    expect(dialogText(dom)).toContain('编排合并 Task #1 的全部 子 Task');
    expect(dialogText(dom)).toContain('固定 bbbbbbbbbbbb');
    await answerDialog(dom, '取消');
    await pending;

    // 运行中：入口换成进度 + 取消，不再重复给开始按钮。
    main.branch_info.merge_run = { mode: 'orchestrate', status: 'paused', done: 1, total: 2, task_id: 93 };
    await dom.node('task-graph-open').onclick();
    const running = dom.node('detail').querySelector('[data-task-id="1"]');
    expect(deepText(running)).toContain('合并编排中 · 1/2');
    expect(running.querySelectorAll('button').some(node => node.textContent === '取消合并编排')).toBe(true);
    expect(running.querySelectorAll('button').some(node => node.textContent === '编排合并全部子 Task')).toBe(false);
  } finally {
    main.branch_info = saved.branch_info;
    main.freeze = saved.freeze;
    graph.nodes[1].status = saved.status;
    await dom.node('task-graph-open').onclick();
  }
});
