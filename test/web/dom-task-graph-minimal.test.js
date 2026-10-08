import { test, expect, beforeEach, afterAll } from 'bun:test';
import { installDom, deepText, answerDialog, dialogText } from '../dom-stub.js';
import { makeWorld } from './dom-world.js';

const world = makeWorld();
let graph;
const dom = installDom({ fetch: (url, options) => String(url).split('?')[0] === '/api/worker-graph'
  ? { ok: true, json: async () => graph } : world.fetchImpl(url, options) });
const { boot } = await import('../../src/ui/web/assets/app.js');
const { ui } = await import('../../src/ui/web/assets/state.js');
const { showHelp, hideHelp } = await import('../../src/ui/web/assets/help.js');
const { renderTaskGraph, loadTaskGraph } = await import('../../src/ui/web/assets/render-task-graph.js');
const { readPref, setPref, resetPrefs } = await import('../../src/ui/web/assets/prefs.js');
const { resourceSummary } = await import('../../src/ui/web/assets/task-graph-usage.js');
const card = id => dom.node('detail').querySelector(`[data-task-id="${id}"]`);
const mode = () => dom.node('detail').querySelector('[data-graph-focus="detail-mode"]');
const enable = () => { mode().checked = false; mode().onchange(); };
const enableDetails = () => { mode().checked = true; mode().onchange(); };
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
  dom.location.pathname = '/';
  localStorage.removeItem('lush.taskGraph.collapsed');
  dom.node('detail').replaceChildren(); document.activeElement = null;
  resetPrefs(); graph = fixture();
  await boot(); await dom.node('task-graph-open').onclick();
});
afterAll(() => dom.restore());

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
  // 极简模式：消耗在第二行，紧接合并状态标签之前。
  const placed = card(2).querySelector('.task-graph-minimal-summary').querySelector('.task-graph-usage');
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
  enableDetails();
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

test('Worker 树时长省略前导零单位，最高单位以下全量显示且数字与单位间有空格', () => {
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
  enableDetails();
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
  enable();
  expect(mode().checked).toBe(false);
  expect(readPref('taskGraphMinimal')).toBe(true);
  expect(deepText(card(2))).not.toContain('完整结果正文');
  await boot(); await dom.node('task-graph-open').onclick();
  expect(mode().checked).toBe(false);
  expect(dom.node('detail').querySelector('.task-graph-minimal')).toBeTruthy();
  expect(world.state.actions.length).toBe(count);
});

test('极简与完整视图共用折叠、状态筛选和归档开关', async () => {
  enable();
  const fold = card(1).querySelector('button');
  fold.focus(); await fold.onclick();
  expect(card(2)).toBeNull();
  expect(document.activeElement.dataset.graphFocus).toBe('fold-1');
  await card(1).querySelector('button').onclick();
  await dom.node('detail').querySelector('[data-status="running"]').onclick();
  expect(card(2)).toBeNull(); expect(card(3)).toBeTruthy();
  enableDetails();
  expect(card(2)).toBeNull(); expect(card(3)).toBeTruthy();
  enable();
  graph.nodes[2].archived = true;
  renderTaskGraph(graph);
  expect(card(3)).toBeNull();
  const archived = dom.node('detail').querySelector('.task-graph-archived-toggle').querySelector('input');
  archived.checked = true; archived.onchange();
  expect(deepText(card(3))).toContain('已归档');
  expect(document.activeElement.dataset.graphFocus).toBe('show-archived');
  enableDetails();
  expect(document.activeElement).toBe(mode());
  expect(dom.node('detail').querySelector('.task-graph-archived-toggle').querySelector('input').checked).toBe(true);
  expect(card(3)).toBeTruthy();
});

test('等待行不增加进度总数，终态不伪装仍在执行，无进度运行态明确说明未知', () => {
  enable();
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

test('切换极简模式不丢弃未提交的待决答复', () => {
  enableDetails();
  const input = card(3).querySelector('textarea');
  input.value = '我还在写'; enable();
  expect(mode().checked).toBe(true);
  expect(readPref('taskGraphMinimal')).toBe(false);
  expect(card(3).querySelector('textarea')).toBe(input);
  expect(input.value).toBe('我还在写');
});

test('切换归档显示不丢弃未提交的待决答复，也不提前改变开关状态', () => {
  enableDetails();
  graph.nodes[1].archived = true;
  renderTaskGraph(graph);
  const input = card(3).querySelector('textarea');
  input.value = '我还在写';
  const archived = dom.node('detail').querySelector('.task-graph-archived-toggle').querySelector('input');
  archived.checked = true; archived.onchange();
  expect(archived.checked).toBe(false);
  expect(ui.taskGraphShowArchived).toBe(false);
  expect(card(2)).toBeNull();
  expect(card(3).querySelector('textarea')).toBe(input);
  expect(input.value).toBe('我还在写');
});

test('更多操作惰性创建、沿用 Agent 帮助与原有输入弹窗，展开期间轮询不卸载菜单', async () => {
  enable();
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
  const input = panel.querySelectorAll('button').find(button => button.textContent === '向此 Worker 输入');
  expect(input.classList.contains('agent-call')).toBe(true);
  expect(input.getAttribute('data-help')).toContain('Agent');
  showHelp(input);
  expect(dom.node('help-tip').parentNode).toBe(panel);
  expect(dom.node('help-tip').textContent).toContain('Agent');
  hideHelp();
  expect(dom.node('help-tip').parentNode).toBe(document.body);
  // Stub 不实现 top layer；原生 Esc/点击外部/焦点顺序由真实浏览器回归覆盖。
  beforetoggle({ newState: 'closed' });
  expect(document.activeElement).toBe(trigger);
  const sending = input.onclick();
  expect(dialogText(dom)).toContain('发给 Worker #2');
  await answerDialog(dom, '发送消息', '继续实现'); await sending;
  expect(world.state.actions.at(-1)).toEqual({ method: 'worker.message', params: { id: 2, body: '继续实现' } });
  expect(deepText(card(2))).toContain('新标题');
});

test('极简菜单复用合并、待决入口及冻结禁用，不内嵌待决表单', () => {
  enable();
  card(1).querySelector('.task-graph-more-trigger').onclick();
  expect(deepText(card(1).querySelector('.task-graph-actions-popover'))).toContain('合并所有');
  card(3).querySelector('.task-graph-more-trigger').onclick();
  expect(deepText(card(3).querySelector('.task-graph-actions-popover'))).toContain('打开待决事项');
  expect(card(3).querySelector('textarea')).toBeNull();
  graph.nodes[1].freeze = { task_id: 99, reason: '固定提交冻结' }; renderTaskGraph(graph);
  expect(deepText(card(2))).toContain('冻结');
  card(2).querySelector('.task-graph-more-trigger').onclick();
  const input = card(2).querySelectorAll('button').find(button => button.textContent === '向此 Worker 输入');
  expect(input.disabled).toBe(true);
  expect(input.parentNode.classList.contains('help-host')).toBe(true);
});

test('偏好按项目隔离，旧选择保留，坏值和重置回落极简；存储不可用时会话内仍可切换', () => {
  dom.location.pathname = '/p/aaaaaaaaaaaaaaaa/';
  expect(readPref('taskGraphMinimal')).toBe(true);
  setPref('taskGraphMinimal', false);
  dom.location.pathname = '/p/bbbbbbbbbbbbbbbb/';
  expect(readPref('taskGraphMinimal')).toBe(true);
  localStorage.setItem('lush.taskGraph.minimal:bbbbbbbbbbbbbbbb', 'broken');
  expect(readPref('taskGraphMinimal')).toBe(true);
  localStorage.setItem('lush.taskGraph.minimal:bbbbbbbbbbbbbbbb', '1');
  expect(readPref('taskGraphMinimal')).toBe(true);
  localStorage.setItem('lush.taskGraph.minimal:bbbbbbbbbbbbbbbb', '0');
  expect(readPref('taskGraphMinimal')).toBe(false);
  dom.location.pathname = '/p/aaaaaaaaaaaaaaaa/';
  expect(readPref('taskGraphMinimal')).toBe(false);
  resetPrefs(); expect(ui.taskGraphMinimal).toBe(true);
  dom.location.pathname = '/';
  const storage = globalThis.localStorage;
  try {
    globalThis.localStorage = { getItem() { throw Error('denied'); }, setItem() { throw Error('denied'); } };
    enable(); renderTaskGraph(graph);
    expect(mode().checked).toBe(false);
    enableDetails();
    expect(mode().checked).toBe(true);
    expect(readPref('taskGraphMinimal')).toBe(false);
  } finally { globalThis.localStorage = storage; }
});
