import { test, expect, afterAll } from 'bun:test';
import { installDom, deepText } from '../dom-stub.js';
import { makeWorld, iso, NOW } from './dom-world.js';
import { ui } from '../../src/ui/web/assets/state.js';
import { renderOverview } from '../../src/ui/web/assets/render-overview.js';
import { renderDetail } from '../../src/ui/web/assets/render-detail.js';

const world = makeWorld();
const dom = installDom({ fetch: world.fetchImpl });
const { boot } = await import('../../src/ui/web/assets/app.js');
dom.node('side-nav').replaceChildren();
await boot();
afterAll(() => dom.restore());

test('概览：Task 指标、最近任务、待决与运行时折叠跨重画保留', () => {
  const data = { ...ui.lastSnapshot,
    tasks: [
      { id: 1, task_kind: 'main', role: 'agent', goal: '管理 main 分支及子任务合并请求', status: 'waiting', integration: 'none', branch: 'main' },
      { id: 7, task_kind: 'order', role: 'agent', goal: '正在改点什么', status: 'running', integration: 'none', branch: 'lush/demo/7' },
    ],
    notices: [
      { id: 900, task_id: 7, kind: 'info', status: 'sent', title: '分支 lush/demo/7 有变化' },
      { id: 901, task_id: 7, kind: 'question', status: 'open', title: '确认兼容方案' },
    ],
    status: { ...ui.lastSnapshot.status, agents: [], concurrency: 2 } };
  ui.selected = null; ui.graphOpen = false; ui.docsOpen = false; ui.overviewKey = null;
  renderOverview(data);
  const panel = dom.node('detail');
  expect(panel.dataset.view).toBe('overview');
  expect(panel.querySelectorAll('.metric').length).toBe(4);
  expect([...panel.querySelectorAll('.metric-label')].map(node => node.textContent)).toEqual(['Worker', '进行中', '待验收', '待我处理']);
  const text = deepText(panel);
  expect(text).toContain('正在改点什么');
  expect(text).toContain('需要你的决定');
  expect(text).toContain('确认兼容方案');
  // info 提醒只进「最近提醒」之外：新概览只投影 open 且非 info 的待决，info 不在这里渲染。
  expect(text).not.toContain('分支 lush/demo/7 有变化');
  // 运行时折叠跨重画保留。
  const runtime = panel.querySelector('[data-fold="runtime"]');
  expect(runtime.open).toBe(false);
  runtime.open = true;
  ui.overviewKey = null;
  renderOverview(data);
  expect(panel.querySelector('[data-fold="runtime"]').open).toBe(true);
});

test('概览：不再有分支视图入口，运行中 Agent 列出', async () => {
  const data = { ...ui.lastSnapshot, tasks: [], notices: [],
    status: { ...ui.lastSnapshot.status, agents: [{ task_id: 7, pid: 1234 }], concurrency: 2 } };
  ui.selected = null; ui.graphOpen = false; ui.docsOpen = false; ui.overviewKey = null;
  renderOverview(data);
  const panel = dom.node('detail');
  const text = deepText(panel);
  expect(text).toContain('还没有 Worker');
  expect(text).toContain('查看 Worker #7');
  expect(text).not.toContain('分支与合并');
  expect([...panel.querySelectorAll('button')].some(node => node.textContent === '打开分支图')).toBe(false);
});

test('概览：没有 Task 与待决时给空态并展示运行时信息', () => {
  const data = { ...ui.lastSnapshot, tasks: [], notices: [],
    status: { ...ui.lastSnapshot.status, project: '/tmp/demo', agents: [], concurrency: 2 } };
  ui.selected = null; ui.overviewKey = null;
  renderOverview(data);
  const text = deepText(dom.node('detail'));
  expect(text).toContain('还没有 Worker');
  expect(text).toContain('暂时没有待决问题');
  expect(text).toContain('当前没有 Agent 调用');
  expect(text).toContain('/tmp/demo');
});

test('task goal becomes the page heading and results precede implementation metadata', () => {
  renderDetail({ id: 42, role: 'worker', status: 'completed', integration: 'none', calls: 0,
    goal: '更清晰的项目工作台', result: '已完成主题切换', deps: [], dependents: [] }, null, null, null);
  const panel = dom.node('detail');
  expect(panel.dataset.view).toBe('task');
  // hero 的 h1 只放一句话短标题。
  expect(panel.querySelector('h1').textContent).toBe('更清晰的项目工作台');
  // 完整 goal 落在正文的「任务目标」块里，且排在「结果」之前。
  const goalPanel = panel.querySelector('.goal-panel');
  expect(goalPanel).toBeTruthy();
  expect(deepText(goalPanel)).toContain('Worker 目标');
  expect(deepText(goalPanel)).toContain('更清晰的项目工作台');
  const text = deepText(panel);
  expect(text.indexOf('Worker 目标')).toBeLessThan(text.indexOf('已完成主题切换'));
  expect(text.indexOf('已完成主题切换')).toBeLessThan(text.indexOf('调用次数'));
  expect(panel.querySelector('.breadcrumb')).toBeTruthy();
});

test('详情头部：角色胶囊按类型着色，快速路由任务另带徽章', () => {
  renderDetail({ id: 44, role: 'research', status: 'completed', integration: 'none', calls: 0, route: true,
    goal: '解释快速路由', result: '已解释', deps: [], dependents: [] }, null, null, null);
  const panel = dom.node('detail');
  expect(panel.querySelector('.role-badge').className).toContain('role-research');
  expect(panel.querySelector('.route-badge').textContent).toContain('快速路由');

  renderDetail({ id: 45, role: 'merger', status: 'completed', integration: 'none', calls: 0, route: false,
    goal: '解一个冲突', result: '已解决', deps: [], dependents: [] }, null, null, null);
  expect(panel.querySelector('.role-badge').className).toContain('role-merger');
  expect(panel.querySelector('.route-badge')).toBeNull();
});

test('多行 / 超长 goal：hero 只显示首行截断，完整 goal 留在正文块里', () => {
  const goal = `一句话标题\n\n目标：${'很长的验收标准'.repeat(12)}`;
  renderDetail({ id: 43, role: 'worker', status: 'completed', integration: 'none', calls: 0,
    goal, result: '已完成主题切换', deps: [], dependents: [] }, null, null, null);
  const panel = dom.node('detail');
  const title = panel.querySelector('h1').textContent;
  expect(title).toBe('一句话标题');
  expect(title).not.toContain('很长的验收标准');
  // 正文块保留完整 goal（markdown 开启时按段落渲染，文字不丢）。
  const goalPanel = panel.querySelector('.goal-panel');
  expect(goalPanel).toBeTruthy();
  const body = deepText(goalPanel).replace(/\s+/g, '');
  expect(body).toContain('目标：');
  expect(body).toContain('很长的验收标准'.repeat(12));
});

test('mobile index toggle exposes its expanded state and is reversible', async () => {
  const toggle = dom.node('sidebar-toggle');
  await toggle.onclick();
  expect(toggle.getAttribute('aria-expanded')).toBe('true');
  expect(dom.node('sidebar').classList.contains('mobile-open')).toBe(true);
  await toggle.onclick();
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  expect(dom.node('sidebar').classList.contains('mobile-open')).toBe(false);
});
