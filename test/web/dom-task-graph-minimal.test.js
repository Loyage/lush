import { test, expect, beforeEach, afterAll } from 'bun:test';
import fs from 'node:fs';
import { installDom, deepText, dialogText } from './project-dom.js';
import { until } from '../helpers.js';
import { makeWorld } from './dom-world.js';

const world = makeWorld();
let graph, completionWrite;
const json = value => ({ ok: true, json: async () => value });
const dom = installDom({ fetch: (url, options) => {
  if (String(url).split('?')[0] === '/api/worker-graph') return json(graph);
  if (String(url).endsWith('/api/action')) {
    const call = JSON.parse(options.body);
    if (call.method === 'worker.completion' && completionWrite) return completionWrite(call);
  }
  return world.fetchImpl(url, options);
} });
const { boot } = await import('../../src/ui/web/assets/app.js');
const { ui } = await import('../../src/ui/web/assets/state.js');
const { closeDialog } = await import('../../src/ui/web/assets/dialog.js');
const { showHelp, hideHelp } = await import('../../src/ui/web/assets/help.js');
const { renderTaskGraph, loadTaskGraph } = await import('../../src/ui/web/assets/render-task-graph.js');
const { readPref, setPref, resetPrefs, resetDevicePreferences, refreshDevicePreferences, saveDevicePreference } = await import('../../src/ui/web/assets/prefs.js');
const { resourceSummary } = await import('../../src/ui/web/assets/task-graph-usage.js');
const card = id => dom.node('detail').querySelector(`[data-task-id="${id}"]`);
const mode = () => dom.node('detail').querySelector('[data-graph-focus="detail-mode"]');
const enable = async () => { mode().checked = false; await mode().onchange(); };
const enableDetails = async () => { mode().checked = true; await mode().onchange(); };
const fixture = () => ({ total: 3, truncated: false, nodes: [
  { id: 1, parent_id: null, task_kind: 'main', role: 'agent', title: 'main', status: 'waiting', branch: 'main' },
  { id: 2, parent_id: 1, task_kind: 'order', role: 'agent', title: '极简任务树'.repeat(20), status: 'running',
    branch: 'lush/task-2', integration: 'pending', goal_preview: '完整目标正文', result_preview: '完整结果正文',
    waiting_reason: '旧的等待原因', progress: { total: 3, completed: 1, current: { label: '实现双行' } } },
  { id: 3, parent_id: 1, task_kind: 'child', role: 'agent', title: '确认接口', status: 'awaiting',
    waiting_reason: '等待用户确认 API', notice_count: 1,
    notice: { id: 42, kind: 'question', title: '是否继续？', body: '保留接口吗？' },
    progress: { total: 2, completed: 1, current: { label: '实现接口' } } },
] });
beforeEach(async () => {
  dom.location.pathname = '/p/aaaaaaaaaaaaaaaa/';
  localStorage.removeItem('lush.taskGraph.collapsed');
  dom.node('detail').replaceChildren(); document.activeElement = null;
  closeDialog(); dom.node('modal').hidden = true; completionWrite = null;
  resetPrefs(); world.state.devicePreferences.values.taskGraphMinimal = true; graph = fixture();
  await boot(); await dom.node('task-graph-open').onclick();
});
afterAll(() => dom.restore());

const bulkControl = key => dom.node('detail').querySelector(`[data-graph-focus="${key}"]`);
const nestedFixture = () => {
  graph.nodes.push(
    { id: 4, parent_id: 2, task_kind: 'child', role: 'agent', title: '第二层', status: 'waiting' },
    { id: 5, parent_id: 4, task_kind: 'child', role: 'agent', title: '第三层', status: 'waiting' });
  graph.total = graph.nodes.length; renderTaskGraph(graph);
};

for (const details of [false, true]) test(`全部展开／折叠覆盖隐藏的深层分支，保留焦点、刷新和显示模式（详情=${details}）`, async () => {
  if (details) await enableDetails();
  nestedFixture(); const requests = dom.requests.length, writes = world.state.actions.length;
  const collapse = bulkControl('collapse-all'); collapse.focus(); await collapse.onclick();
  expect(dom.node('detail').querySelectorAll('.task-graph-card')).toHaveLength(1);
  expect([...readPref('taskGraphCollapsed')].sort()).toEqual([1, 2, 4]);
  expect(document.activeElement).toBe(bulkControl('collapse-all'));
  expect(card(1).querySelector('[data-graph-focus="fold-1"]').getAttribute('aria-expanded')).toBe('false');
  expect(mode().checked).toBe(details); expect(dom.requests).toHaveLength(requests); expect(world.state.actions).toHaveLength(writes);
  await loadTaskGraph(); expect(dom.node('detail').querySelectorAll('.task-graph-card')).toHaveLength(1);
  const expand = bulkControl('expand-all'); expand.focus(); await expand.onclick();
  expect(dom.node('detail').querySelectorAll('.task-graph-card')).toHaveLength(5);
  expect([...readPref('taskGraphCollapsed')]).toEqual([]); expect(document.activeElement).toBe(bulkControl('expand-all'));
  for (const id of [1, 2, 4]) expect(card(id).querySelector(`[data-graph-focus="fold-${id}"]`).getAttribute('aria-expanded')).toBe('true');
  await bulkControl('collapse-all').onclick(); await boot(); await dom.node('task-graph-open').onclick();
  expect(dom.node('detail').querySelectorAll('.task-graph-card')).toHaveLength(1);
  await bulkControl('expand-all').onclick(); expect(card(5)).toBeTruthy();
  expect(mode().checked).toBe(details); expect(world.state.actions).toHaveLength(writes);
});

test('批量操作不取消状态／归档筛选，不改隐藏和图外分支的偏好，折叠按项目隔离', async () => {
  graph.nodes.push(
    { id: 7, parent_id: 1, task_kind: 'order', role: 'agent', title: '筛掉的父节点', status: 'completed' },
    { id: 8, parent_id: 7, task_kind: 'child', role: 'agent', title: '筛掉的子节点', status: 'completed' },
    { id: 9, parent_id: 1, task_kind: 'order', role: 'agent', title: '已归档', status: 'waiting', archived: true },
    { id: 10, parent_id: 9, task_kind: 'child', role: 'agent', title: '已归档子节点', status: 'waiting', archived: true });
  graph.total = graph.nodes.length;
  setPref('taskGraphStatuses', new Set(['completed'])); setPref('taskGraphCollapsed', new Set([7, 999]));
  renderTaskGraph(graph); await bulkControl('collapse-all').onclick();
  expect([...readPref('taskGraphCollapsed')].sort((a, b) => a - b)).toEqual([1, 7, 999]);
  await bulkControl('expand-all').onclick();
  expect([...readPref('taskGraphCollapsed')].sort((a, b) => a - b)).toEqual([7, 999]);
  expect([...readPref('taskGraphStatuses')]).toEqual(['completed']); expect(ui.taskGraphShowArchived).toBe(false);
  for (const id of [7, 8, 9, 10]) expect(card(id)).toBeNull();
  await bulkControl('show-archived').onclick();
  expect(card(9)).toBeTruthy(); expect(card(10)).toBeTruthy();
  await bulkControl('collapse-all').onclick();
  expect([...readPref('taskGraphCollapsed')].sort((a, b) => a - b)).toEqual([1, 7, 9, 999]);
  expect(bulkControl('show-archived').getAttribute('aria-pressed')).toBe('true');
  await bulkControl('expand-all').onclick();
  expect(card(10)).toBeTruthy(); expect([...readPref('taskGraphCollapsed')].sort((a, b) => a - b)).toEqual([7, 999]);
  expect(ui.taskGraphShowArchived).toBe(true); expect([...readPref('taskGraphStatuses')]).toEqual(['completed']);
  await bulkControl('show-archived').onclick(); expect(card(9)).toBeNull(); expect(card(10)).toBeNull();
  await bulkControl('collapse-all').onclick();
  dom.location.pathname = '/p/bbbbbbbbbbbbbbbb/'; renderTaskGraph(graph);
  expect(card(2)).toBeTruthy(); expect([...readPref('taskGraphCollapsed')]).toEqual([]);
  await bulkControl('expand-all').onclick();
  dom.location.pathname = '/p/aaaaaaaaaaaaaaaa/'; renderTaskGraph(graph);
  expect(card(2)).toBeNull(); expect([...readPref('taskGraphCollapsed')]).toContain(1);
});

test('正在编辑的待决答复阻止批量操作，不丢草稿、不写偏好或调用 Agent', async () => {
  await enableDetails(); const input = card(3).querySelector('textarea');
  input.value = '尚未提交的答复'; const tree = dom.node('detail').querySelector('.task-graph'), writes = world.state.actions.length;
  for (const key of ['collapse-all', 'expand-all']) {
    bulkControl(key).onclick();
    expect(dom.node('error').textContent).toContain('待决答复');
    expect(dom.node('detail').querySelector('.task-graph')).toBe(tree); expect(card(3).querySelector('textarea')).toBe(input);
    expect(input.value).toBe('尚未提交的答复'); expect([...readPref('taskGraphCollapsed')]).toEqual([]);
  }
  expect(world.state.actions).toHaveLength(writes);
});

test('空图或无子层级禁用批量按钮并提供外层帮助；截断图仍可操作已加载层级', async () => {
  for (const nodes of [[], [graph.nodes[1]]]) {
    renderTaskGraph({ nodes, total: nodes.length, truncated: false });
    for (const key of ['expand-all', 'collapse-all']) {
      const control = bulkControl(key); expect(control.disabled).toBe(true);
      expect(control.parentNode.classList.contains('help-host')).toBe(true);
      expect(control.parentNode.getAttribute('data-help')).toContain('没有可展开或折叠');
      expect(control.classList.contains('agent-call')).toBe(false);
    }
  }
  graph.truncated = true; graph.total = 500; renderTaskGraph(graph);
  expect(bulkControl('collapse-all').disabled).toBe(false);
  expect(bulkControl('collapse-all').getAttribute('data-help')).toContain('当前已加载');
  await bulkControl('collapse-all').onclick(); expect(card(2)).toBeNull();
  await bulkControl('expand-all').onclick(); expect(card(2)).toBeTruthy();
  expect(deepText(dom.node('detail'))).toContain('500');
});

test('两种模式的工作树表头只保留实时摘要与操作，不常驻静态规则说明', async () => {
  for (const details of [false, true]) {
    if (details) await enableDetails();
    const hero = dom.node('detail').querySelector('.task-graph-hero');
    expect(hero.querySelector('h1').textContent).toBe('工作树');
    expect(hero.querySelectorAll('p')).toHaveLength(1);
    expect(hero.querySelector('p').classList.contains('task-graph-load-status')).toBe(true);
    expect(deepText(hero)).not.toContain('连线表示');
    expect(deepText(hero)).not.toContain('关注度排序');
    expect(deepText(hero.querySelector('.task-graph-summary'))).toContain('图中 3 / 3 Worker');
    expect(deepText(hero.querySelector('.task-graph-summary'))).toContain('1 待决');
    expect(hero.querySelector('[data-status="running"]')).toBeTruthy();
    expect(mode()).toBeTruthy();
    expect([...hero.querySelectorAll('button')].some(button => button.textContent === '刷新')).toBe(true);
  }
});

test('资源消耗在两种模式显示自身，折叠显示后端完整子树合计并只为运行中的统计闪烁', async () => {
  const own = { input: 121000, output: 18000, cost: 2.24, run_ms: 3661000, running: false };
  graph.nodes[0].children_total = 20;
  graph.nodes[0].resources = { own, subtree: { ...own, input: 242000, cost: 4.48, run_ms: 7322000, running: true } };
  graph.nodes[1].resources = { own: { ...own, run_ms: 61000, running: true } };
  renderTaskGraph(graph);
  let summary = card(1).querySelector('.task-graph-usage');
  expect(summary.children[0].className).toContain('task-graph-usage-runtime');
  expect(summary.children[0].textContent).toBe('1 h 1 m 1 s');
  expect(deepText(summary)).toContain('↑121.0k');
  expect(deepText(summary)).toContain('↓18.0k');
  expect(deepText(summary)).toContain('$2.24');
  expect(summary.classList.contains('is-live')).toBe(false);
  // 极简模式：独立的元数据组让手机分行；桌面仍与进度同行，消耗紧接合并状态前。
  const summaryLine = card(2).querySelector('.task-graph-minimal-summary');
  const placed = summaryLine.querySelector('.task-graph-usage');
  expect(placed.parentNode.className).toBe('task-graph-minimal-meta');
  expect(summaryLine.children[0].className).toBe('task-graph-minimal-progress');
  expect(summaryLine.querySelector('.task-graph-minimal-note').textContent).toContain('1/3 · 实现双行');
  expect(placed.parentNode.querySelector('.task-graph-minimal-note')).toBeNull();
  expect(placed).toBeTruthy();
  const siblings = placed.parentNode.children;
  expect(siblings[siblings.indexOf(placed) + 1].textContent).toContain('待合并');
  expect(card(2).querySelector('.task-graph-head').querySelector('.task-graph-usage')).toBeNull();
  expect(card(2).querySelector('.task-graph-usage').classList.contains('is-live')).toBe(true);
  expect(card(3).querySelector('.task-graph-usage-runtime').textContent).toBe('—');
  expect(deepText(card(3).querySelector('.task-graph-usage'))).toContain('↑—');
  await card(1).querySelector('button').onclick();
  summary = card(1).querySelector('.task-graph-usage');
  expect(summary.classList.contains('is-aggregate')).toBe(true);
  expect(summary.classList.contains('is-live')).toBe(true);
  expect(summary.querySelector('.task-graph-usage-runtime').textContent).toBe('2 h 2 m 2 s');
  expect(deepText(summary)).toContain('$4.48');
  expect(summary.getAttribute('data-help')).toContain('图外节点');
  await enableDetails();
  expect(deepText(card(1).querySelector('.task-graph-usage'))).toContain('$4.48');
  await card(1).querySelector('button').onclick();
  // 详情模式：消耗排在首行状态标签之后、合并状态标签之前。
  const detailUsage = card(2).querySelector('.task-graph-head').querySelector('.task-graph-usage');
  const headSiblings = detailUsage.parentNode.children;
  expect(headSiblings[headSiblings.indexOf(detailUsage) + 1].textContent).toContain('待合并');
  expect(deepText(card(1).querySelector('.task-graph-usage'))).toContain('$2.24');
  graph.nodes[1].resources.own.unknown_cost = 1;
  graph.nodes[1].resources.own.running = false;
  renderTaskGraph(graph);
  expect(card(2).querySelector('.task-graph-usage-cost').textContent).toBe('—');
  expect(card(2).querySelector('.task-graph-usage').classList.contains('is-live')).toBe(false);
});

test('两种树模式展开显示自身、折叠显示后台已知子树小计，不以可见后代补零', async () => {
  graph.nodes[0].children_total = 50;
  graph.nodes[0].resources = {
    own: { input: 1200, output: 300, cost: 0.24, run_ms: 1000 },
    subtree: { input: 121000, output: 18000, cost: 2.24, run_ms: 61000,
      incomplete: true, unknown_tokens: 1, unknown_cost: 2, known_tokens: 3, known_cost: 0, pending_files: 2, running: true },
  };
  for (const details of [false, true]) {
    if (details) await enableDetails();
    renderTaskGraph(graph);
    let summary = card(1).querySelector('.task-graph-usage');
    expect(deepText(summary)).toContain('↑1.2k');
    expect(deepText(summary)).toContain('$0.24');
    expect(deepText(summary)).not.toContain('统计不完整');
    await card(1).querySelector('[data-graph-focus="fold-1"]').onclick();
    summary = card(1).querySelector('.task-graph-usage');
    expect(summary.classList.contains('is-aggregate')).toBe(true);
    expect(summary.classList.contains('is-live')).toBe(true);
    expect(summary.querySelector('.task-graph-usage-incomplete').textContent).toBe('统计不完整');
    expect(summary.querySelector('.task-graph-usage-input').textContent).toBe('已知 ↑121.0k');
    expect(summary.querySelector('.task-graph-usage-output').textContent).toBe('已知 ↓18.0k');
    expect(summary.querySelector('.task-graph-usage-cost').textContent).toBe('—');
    expect(summary.getAttribute('data-help')).toContain('后台补齐中');
    expect(summary.getAttribute('data-help')).toContain('隐藏、归档及图外节点');
    expect(summary.getAttribute('aria-label')).toContain('子树合计，统计不完整');
    expect(card(2)).toBeNull();
    expect(summary.parentNode.className).toBe(details ? 'task-graph-head' : 'task-graph-minimal-meta');
    // No third row, action or layout wrapper is introduced for partial coverage.
    expect(card(1).querySelectorAll('.task-graph-usage')).toHaveLength(1);
    await loadTaskGraph();
    expect(card(1).querySelector('.task-graph-usage-input').textContent).toBe('已知 ↑121.0k');
    await card(1).querySelector('[data-graph-focus="fold-1"]').onclick();
    expect(card(1).querySelector('.task-graph-usage-cost').textContent).toBe('$0.24');
  }
});

test('Git 相对进度在第二排计划前，刷新、折叠和交付状态不改变真实含义', async () => {
  const node = graph.nodes[1];
  node.parent_relation = { ahead: 3, behind: 2 };
  node.branch_info = { diagnostics: { working_tree: { status: 'dirty' } } };
  node.integration = 'merged';
  node.input_queue = { buffered: 2, reason: '冻结，等待安全点' };
  renderTaskGraph(graph);
  const queue = card(2).querySelector('.worker-input-queue');
  expect(queue.textContent).toBe('待交付追加 2 条');
  expect(queue.getAttribute('data-help')).toContain('已入箱 2 条追加指令，待交付给 Agent');
  const progress = card(2).querySelector('.task-graph-minimal-progress');
  expect(progress.children[0].classList.contains('task-graph-git-status')).toBe(true);
  expect(progress.children[1].classList.contains('task-graph-minimal-note')).toBe(true);
  expect(deepText(progress.children[0])).toBe('* +3 -2');
  expect(progress.querySelector('.task-graph-git-pending').classList.contains('is-dirty')).toBe(true);
  expect(progress.querySelector('.task-graph-git-pending').classList.contains('is-clean')).toBe(false);
  expect(progress.querySelector('.parent-commit-ahead').textContent).toBe('+3');
  expect(progress.querySelector('.parent-commit-behind').textContent).toBe('-2');
  expect(progress.children[0].getAttribute('aria-label')).toContain('不代表是否已交付');
  expect(progress.children[1].textContent).toContain('实现双行');
  node.parent_relation = { ahead: 0, behind: 0 };
  node.branch_info.diagnostics.working_tree.status = 'clean';
  await loadTaskGraph();
  expect(deepText(card(2).querySelector('.task-graph-git-status'))).toBe('\u00a0 +0 -0');
  expect(card(2).querySelector('.task-graph-git-pending').classList.contains('is-clean')).toBe(true);
  expect(card(2).querySelector('.task-graph-git-pending').classList.contains('is-dirty')).toBe(false);
  await card(1).querySelector('button').onclick();
  await card(1).querySelector('button').onclick();
  expect(deepText(card(2).querySelector('.task-graph-git-status'))).toBe('\u00a0 +0 -0');
});

test('Git 干净状态保留一个空白位置，脏状态显示星号', () => {
  for (const status of ['clean', 'dirty', 'clean']) {
    for (const node of graph.nodes.slice(0, 2)) {
      node.branch_info = { diagnostics: { working_tree: { status } } };
      if (node.parent_id != null) node.parent_relation = { ahead: 3, behind: 2 };
    }
    renderTaskGraph(graph);
    for (const id of [1, 2]) {
      const indicator = card(id).querySelector('.task-graph-git-status');
      expect(indicator.querySelector('.task-graph-git-pending').textContent).toBe(status === 'clean' ? '\u00a0' : '*');
      expect(indicator.getAttribute('aria-label')).toContain(status === 'clean' ? '无未提交更改' : '有未提交更改');
      expect(indicator.getAttribute('data-help')).toContain(status === 'clean' ? '无未提交更改' : '有未提交更改');
    }
    expect(card(2).querySelector('.parent-commit-ahead').textContent).toBe('+3');
    expect(card(2).querySelector('.parent-commit-behind').textContent).toBe('-2');
  }
});

test('Git 未知不冒充干净或零距离；根、无分支和归档 Worker 不伪造父距离', async () => {
  const { graphGitStatus } = await import('../../src/ui/web/assets/task-graph-git.js');
  const node = graph.nodes[1];
  for (const status of [undefined, 'unknown', 'not_checked_out']) {
    node.branch_info = { diagnostics: { working_tree: { status } } };
    for (const parent_relation of [null, { ahead: -1, behind: NaN }, { ahead: 0.5, behind: Infinity }]) {
      node.parent_relation = parent_relation;
      const indicator = graphGitStatus(node);
      expect(deepText(indicator)).toBe('? +? -?');
      expect(indicator.querySelector('.task-graph-git-pending').classList.contains('is-unknown')).toBe(true);
      expect(indicator.querySelector('.task-graph-git-pending').classList.contains('is-clean')).toBe(false);
      expect(indicator.querySelector('.task-graph-git-pending').classList.contains('is-dirty')).toBe(false);
      expect(indicator.getAttribute('data-help')).toContain('未知');
    }
  }
  const root = { ...graph.nodes[0], branch_info: { diagnostics: { working_tree: { status: 'clean' } } } };
  expect(deepText(graphGitStatus(root))).toBe('\u00a0');
  expect(graphGitStatus(root).querySelector('.parent-commit-ahead')).toBeNull();
  expect(graphGitStatus({ ...node, branch: null })).toBeNull();
  expect(graphGitStatus({ ...node, archived: true })).toBeNull();
  expect(graphGitStatus({ ...node, branch_info: { archived: true } })).toBeNull();
  expect(graphGitStatus({ ...node, details_pending: true }).getAttribute('data-help')).toContain('加载中');
});

test('Git 脏净标记分别使用主题红绿，未知保持中性灰色', () => {
  const css = fs.readFileSync(new URL('../../src/ui/web/assets/styles.css', import.meta.url), 'utf8');
  expect(css).toContain('.task-graph-git-pending.is-dirty{color:var(--failed)}');
  expect(css).toContain('.task-graph-git-pending.is-clean{color:var(--completed)}');
  expect(css).toContain('.task-graph-git-pending.is-unknown{color:var(--muted)}');
});

test('工作树时长省略前导零单位，最高单位以下全量显示且数字与单位间有空格', () => {
  const cases = [
    [0, '0 s'], [-1000, '0 s'], [999, '0 s'], [1000, '1 s'], [59999, '59 s'],
    [60000, '1 m 0 s'], [61000, '1 m 1 s'], [3599999, '59 m 59 s'],
    [3600000, '1 h 0 m 0 s'], [3605000, '1 h 0 m 5 s'],
    [3661000, '1 h 1 m 1 s'], [86399999, '23 h 59 m 59 s'],
    [86400000, '1 d 0 h 0 m 0 s'], [86401000, '1 d 0 h 0 m 1 s'],
    [93784000, '1 d 2 h 3 m 4 s'], [900000000, '10 d 10 h 0 m 0 s'],
    [NaN, '—'], [Infinity, '—'], [undefined, '—'],
  ];
  for (const [run_ms, expected] of cases) {
    const own = { run_ms, input: 0, output: 0, cost: 0 };
    const summary = resourceSummary({ resources: { own } }, false);
    expect(summary.querySelector('.task-graph-usage-runtime').textContent).toBe(expected);
    expect(summary.getAttribute('aria-label')).toContain(`运行 ${expected}`);
    expect(summary.getAttribute('data-help')).toContain('不含等待');
  }
});

test('默认极简且详情开关未勾选；主动开启详情，取消后回到双行摘要，不发业务请求', async () => {
  expect(mode().checked).toBe(false);
  expect(deepText(mode().parentNode)).toContain('详情模式');
  expect(mode().parentNode.getAttribute('data-help')).toContain('默认的极简');
  const count = world.state.actions.length;
  expect(readPref('taskGraphMinimal')).toBe(true);
  expect(dom.node('detail').querySelector('.task-graph-minimal')).toBeTruthy();
  expect(deepText(card(2))).toContain('1/3 · 实现双行');
  expect(deepText(card(2))).toContain('待合并');
  expect(deepText(card(2))).not.toContain('旧的等待原因');
  expect(deepText(card(2))).not.toContain('完整结果正文');
  expect(card(2).querySelector('.task-graph-facts')).toBeNull();
  expect(card(2).querySelector('.delivery-controls')).toBeNull();
  expect(deepText(card(3))).toContain('1 条待决');
  expect(deepText(card(3))).toContain('1/2 · 等待用户确认 API');
  expect(card(3).querySelector('textarea')).toBeNull();
  expect(card(1).querySelector('.task-graph-minimal-summary')).toBeTruthy();
  expect(world.state.actions.length).toBe(count);
  await enableDetails();
  expect(mode().checked).toBe(true);
  expect(readPref('taskGraphMinimal')).toBe(false);
  expect(deepText(card(2))).toContain('完整结果正文');
  expect(dom.node('detail').querySelector('.task-graph-minimal')).toBeNull();
  expect(document.activeElement).toBe(mode());
  await loadTaskGraph();
  expect(mode().checked).toBe(true);
  expect(document.activeElement).toBe(mode());
  await boot(); await dom.node('task-graph-open').onclick();
  expect(mode().checked).toBe(true);
  await enable();
  expect(mode().checked).toBe(false);
  expect(readPref('taskGraphMinimal')).toBe(true);
  expect(deepText(card(2))).not.toContain('完整结果正文');
  await boot(); await dom.node('task-graph-open').onclick();
  expect(mode().checked).toBe(false);
  expect(dom.node('detail').querySelector('.task-graph-minimal')).toBeTruthy();
  expect(world.state.actions.length).toBe(count);
});

test('极简与完整视图共用折叠、状态筛选和归档开关', async () => {
  await enable();
  const fold = card(1).querySelector('button');
  fold.focus(); await fold.onclick();
  expect(card(2)).toBeNull();
  expect(document.activeElement.dataset.graphFocus).toBe('fold-1');
  await card(1).querySelector('button').onclick();
  await dom.node('detail').querySelector('[data-status="running"]').onclick();
  expect(card(2)).toBeNull(); expect(card(3)).toBeTruthy();
  await enableDetails();
  expect(card(2)).toBeNull(); expect(card(3)).toBeTruthy();
  await enable();
  graph.nodes[2].archived = true;
  renderTaskGraph(graph);
  expect(card(3)).toBeNull();
  const archived = dom.node('detail').querySelector('.task-graph-archived-toggle');
  await archived.onclick();
  expect(deepText(card(3))).toContain('已归档');
  expect(document.activeElement.dataset.graphFocus).toBe('show-archived');
  await enableDetails();
  expect(document.activeElement).toBe(mode());
  expect(dom.node('detail').querySelector('.task-graph-archived-toggle').getAttribute('aria-pressed')).toBe('true');
  expect(card(3)).toBeTruthy();
});

test('等待行不增加进度总数，终态不伪装仍在执行，无进度运行态明确说明未知', async () => {
  await enable();
  graph.nodes[1].progress = { items: [
    { key: 'a', label: '调查', status: 'completed' },
    { key: 'wait', label: '等待子任务', kind: 'wait', status: 'pending' },
    { key: 'b', label: '测试', status: 'pending' },
  ] };
  renderTaskGraph(graph);
  expect(deepText(card(2))).toContain('1/2 · 等待子任务');
  graph.nodes[1].status = 'failed'; renderTaskGraph(graph);
  expect(deepText(card(2))).toContain('失败时中止');
  graph.nodes[1].progress = null; graph.nodes[1].status = 'running'; renderTaskGraph(graph);
  expect(deepText(card(2))).toContain('等待 Agent 汇报计划');
  expect(deepText(card(2))).not.toContain('0/0');
});

test('切换极简模式不丢弃未提交的待决答复', async () => {
  await enableDetails();
  const input = card(3).querySelector('textarea');
  input.value = '我还在写'; await enable();
  expect(mode().checked).toBe(true);
  expect(readPref('taskGraphMinimal')).toBe(false);
  expect(card(3).querySelector('textarea')).toBe(input);
  expect(input.value).toBe('我还在写');
});

test('切换归档显示不丢弃未提交的待决答复，也不提前改变开关状态', async () => {
  await enableDetails();
  graph.nodes[1].archived = true;
  renderTaskGraph(graph);
  const input = card(3).querySelector('textarea');
  input.value = '我还在写';
  const archived = dom.node('detail').querySelector('.task-graph-archived-toggle');
  await archived.onclick();
  expect(archived.getAttribute('aria-pressed')).toBe('false');
  expect(archived.classList.contains('is-off')).toBe(true);
  expect(archived.disabled).toBe(false);
  expect(ui.taskGraphShowArchived).toBe(false);
  expect(card(2)).toBeNull();
  expect(card(3).querySelector('textarea')).toBe(input);
  expect(input.value).toBe('我还在写');
});

test('更多操作惰性创建，追加输入定向到底部且保留正文，展开期间轮询不卸载菜单', async () => {
  await enable();
  const trigger = card(2).querySelector('.task-graph-more-trigger');
  const panel = card(2).querySelector('.task-graph-actions-popover');
  expect(trigger.getAttribute('aria-label')).toContain('#2');
  expect(trigger.getAttribute('popovertarget')).toBe(panel.id);
  expect(panel.children.length).toBe(0);
  trigger.onclick();
  const beforetoggle = panel.listeners.beforetoggle[0];
  beforetoggle({ newState: 'open' });
  expect(trigger.getAttribute('aria-expanded')).toBe('true');
  graph.nodes[1].title = '新标题'; await loadTaskGraph();
  expect(card(2).querySelector('.task-graph-actions-popover')).toBe(panel);
  const input = panel.querySelectorAll('button').find(button => button.textContent === '追加输入');
  expect(input.classList.contains('agent-call')).toBe(false);
  expect(input.getAttribute('data-help')).toContain('Agent');
  showHelp(input);
  expect(dom.node('help-tip').parentNode).toBe(panel);
  expect(dom.node('help-tip').textContent).toContain('Agent');
  hideHelp();
  expect(dom.node('help-tip').parentNode).toBe(document.body);
  // Stub 不实现 top layer；原生 Esc/点击外部/焦点顺序由真实浏览器回归覆盖。
  beforetoggle({ newState: 'closed' });
  expect(document.activeElement).toBe(trigger);
  const count = world.state.actions.length;
  dom.node('input').value = '继续实现'; await input.onclick();
  expect(dom.node('modal').hidden).toBe(true);
  expect(world.state.actions.length).toBe(count);
  expect(document.activeElement).toBe(dom.node('input'));
  expect(ui.composerAppendTarget).toEqual({ id: 2 });
  expect(dom.node('input-form').dataset.mode).toBe('append');
  expect(dom.node('input').value).toBe('继续实现');
  expect(dom.node('draft-commit').classList.contains('agent-call')).toBe(true);
  await dom.node('input-form').onsubmit({ preventDefault() {} });
  await loadTaskGraph();
  expect(deepText(card(2))).toContain('新标题');
  expect(world.state.actions.at(-1)).toMatchObject({ method: 'input.emit', params: { mode: 'append', target_id: 2, content: '继续实现' } });
  expect(ui.view.id).toBe('task-graph');
  expect(dom.node('input-form').dataset.mode).toBe('create');
});

test('极简菜单复用合并、待决入口且冻结时可追加，不内嵌待决表单', async () => {
  await enable();
  card(1).querySelector('.task-graph-more-trigger').onclick();
  expect(deepText(card(1).querySelector('.task-graph-actions-popover'))).toContain('合并所有');
  card(3).querySelector('.task-graph-more-trigger').onclick();
  expect(deepText(card(3).querySelector('.task-graph-actions-popover'))).toContain('打开待决事项');
  expect(card(3).querySelector('textarea')).toBeNull();
  graph.nodes[1].freeze = { task_id: 99, reason: '固定提交冻结' }; renderTaskGraph(graph);
  expect(deepText(card(2))).toContain('冻结');
  card(2).querySelector('.task-graph-more-trigger').onclick();
  const input = card(2).querySelectorAll('button').find(button => button.textContent === '追加输入');
  expect(input.disabled).toBe(false);
  expect(input.classList.contains('agent-call')).toBe(false);
  expect(input.getAttribute('data-help')).toContain('冻结期间提交的追加指令可靠入箱');
});

test('树菜单直接展开自动链，revision 写入单飞且在途轮询不卸载控件', async () => {
  graph.nodes[1].hooks = { revision: 'chain-1', mounts: [], completion: { level: 'off', min_level: 'off', editable: true, state: 'idle' } };
  renderTaskGraph(graph);
  const panel = card(2).querySelector('.task-graph-actions-popover');
  card(2).querySelector('.task-graph-more-trigger').onclick();
  const chain = panel.querySelector('.hook-compact');
  expect(deepText(chain)).toContain('自动化'); expect(deepText(chain)).not.toContain('Hooks');
  expect(chain.getAttribute('aria-label')).toBe('Worker 自动化');
  const choice = level => chain.querySelectorAll('.hook-completion-level').find(button => button.dataset.level === level);
  expect(choice('off').getAttribute('aria-pressed')).toBe('true');
  expect(choice('merge').classList.contains('agent-call')).toBe(true);
  const writes = []; let finish;
  completionWrite = call => { writes.push(call); return new Promise(resolve => { finish = resolve; }); };
  const saving = choice('merge').onclick(); await until(() => finish);
  expect(writes).toEqual([{ method: 'worker.completion', params: { id: 2, level: 'merge', expected_revision: 'chain-1' } }]);
  expect(choice('accept').disabled).toBe(true); await choice('merge').onclick();
  await loadTaskGraph();
  expect(card(2).querySelector('.task-graph-actions-popover')).toBe(panel);
  expect(writes).toHaveLength(1);
  graph.nodes[1].hooks = { ...graph.nodes[1].hooks, revision: 'chain-2', completion: { level: 'merge', min_level: 'off', editable: true, state: 'idle' } };
  finish(json({ ...graph.nodes[1].hooks, worker_id: 2 })); await saving;
  card(2).querySelector('.task-graph-more-trigger').onclick();
  const updated = card(2).querySelector('.hook-compact');
  expect(updated.querySelectorAll('.hook-completion-level').find(button => button.dataset.level === 'merge').getAttribute('aria-pressed')).toBe('true');
  const accepting = updated.querySelectorAll('.hook-completion-level').find(button => button.dataset.level === 'accept').onclick();
  expect(dialogText(dom)).toContain('worktree/ref');
  closeDialog(); await accepting; expect(writes).toHaveLength(1);
});

test('两种树模式的自动链保留 child 只读、冻结与版本缺失门禁', async () => {
  for (const details of [false, true]) {
    if (details) await enableDetails();
    for (const change of [{ task_kind: 'child' }, { reservation: { status: 'requested' } }, { missingRevision: true }]) {
      graph.nodes[1] = { ...fixture().nodes[1], ...change, hooks: { mounts: [],
        ...(change.missingRevision ? {} : { revision: 'chain-1' }),
        completion: { level: 'merge', min_level: 'off', editable: true, locked: false, state: 'idle' } } };
      renderTaskGraph(graph);
      card(2).querySelector('.task-graph-more-trigger').onclick();
      const levels = card(2).querySelector('.hook-compact').querySelectorAll('.hook-completion-level');
      expect(levels).toHaveLength(3);
      for (const control of levels) {
        expect(control.disabled).toBe(true);
        expect(control.parentNode.getAttribute('data-help')).toBeTruthy();
        expect(control.parentNode.tabIndex).toBe(0);
      }
    }
  }
});

test('图模式是权威设备偏好，旧项目cache不覆盖它；无localStorage仍可保存', async () => {
  await saveDevicePreference('taskGraphMinimal', false);
  dom.location.pathname = '/p/bbbbbbbbbbbbbbbb/';
  expect(readPref('taskGraphMinimal')).toBe(false);
  localStorage.setItem('lush.taskGraph.minimal:bbbbbbbbbbbbbbbb', '1');
  expect(readPref('taskGraphMinimal')).toBe(false);
  localStorage.setItem('lush.taskGraph.minimal', 'broken');
  await refreshDevicePreferences(); expect(readPref('taskGraphMinimal')).toBe(false);
  dom.location.pathname = '/p/aaaaaaaaaaaaaaaa/';
  await resetDevicePreferences(); expect(readPref('taskGraphMinimal')).toBe(true);
  expect(localStorage.getItem('lush.taskGraph.minimal:bbbbbbbbbbbbbbbb')).toBe('1');
  const storage = globalThis.localStorage;
  try {
    globalThis.localStorage = { getItem() { throw Error('denied'); }, setItem() { throw Error('denied'); } };
    await refreshDevicePreferences(); await enable(); renderTaskGraph(graph);
    expect(mode().checked).toBe(false);
    await enableDetails(); expect(mode().checked).toBe(true); expect(readPref('taskGraphMinimal')).toBe(false);
  } finally {
    globalThis.localStorage = storage;
    // Reconcile through writable storage so the module's privacy-mode fallback
    // cannot leak device preference values into a subsequent DOM fixture.
    await refreshDevicePreferences();
  }
});
