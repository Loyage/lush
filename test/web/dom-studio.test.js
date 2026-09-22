import { test, expect, afterAll } from 'bun:test';
import { installDom, deepText } from '../dom-stub.js';
import { makeWorld, iso, NOW } from './dom-world.js';
import { ui } from '../../src/ui/web/assets/state.js';
import { renderOverview } from '../../src/ui/web/assets/render-overview.js';
import { fetchGraph } from '../../src/ui/web/assets/render-graph.js';
import { renderDetail } from '../../src/ui/web/assets/render-detail.js';

const world = makeWorld();
const dom = installDom({ fetch: world.fetchImpl });
const { boot } = await import('../../src/ui/web/assets/app.js');
dom.node('side-nav').replaceChildren();
await boot();
afterAll(() => dom.restore());

test('概览：指标以 Intent 为主，Git 诊断退居次级且折叠跨重画保留', () => {
  const data = ui.lastSnapshot;
  data.notices = [{ id: 23, task_id: 1, status: 'open', title: '确认兼容方案' }];
  ui.selected = null; ui.graphOpen = false; ui.docsOpen = false;
  ui.overviewKey = null;
  renderOverview(data);
  const panel = dom.node('detail');
  expect(panel.dataset.view).toBe('overview');
  // 产品指标以 Intent / 效果展示为中心，Branch 留在诊断折叠区。
  expect(panel.querySelectorAll('.metric').length).toBe(4);
  const text = deepText(panel);
  expect(text).toContain('Intent');
  expect(text).toContain('效果展示');
  expect(text).not.toContain('开始验收');
  expect(text).toContain('需要你决定');
  expect(text).toContain('验证 unknown'); // 兼容旧 Candidate：没有结构化证据时明确显示未知。
  // 旧结构不再出现：按任务 status 的分布 chips 与按目标分支分组的交付队列。
  expect(text).not.toContain('任务状态');
  expect(text).not.toContain('交付队列');
  // Intent 成果先于 Git 诊断，Git 诊断仍先于运行 / 维护信息。
  expect(text.indexOf('Intent 与最新成果')).toBeLessThan(text.indexOf('Git 交付诊断'));
  expect(text.indexOf('Git 交付诊断')).toBeLessThan(text.indexOf('运行中的 agent'));
  const runtime = panel.querySelector('[data-fold="runtime"]');
  expect(runtime.open).toBe(false);
  runtime.open = true;
  ui.overviewKey = null;
  renderOverview(data);
  expect(panel.querySelector('[data-fold="runtime"]').open).toBe(true);
  expect(panel.querySelector('[data-fold="maintenance"]').open).toBe(false);
});

test('概览：待收口 / 正在工作 / 提醒各归其位，info 提醒不进「需要你的决定」', async () => {
  const saved = world.state.graph;
  world.state.graph = {
    generated_at: iso(NOW), current_branch: 'main', truncated: false, git: true, error: null,
    nodes: [
      { kind: 'branch', id: 'branch:main', name: 'main', head_commit: 'aaa', current: true, tracked: false, placeholder: false, created_at: iso(NOW - 60000) },
      { kind: 'branch', id: 'branch:lush/demo/1-one', name: 'lush/demo/1-one', head_commit: 'bbb', current: false, tracked: true, placeholder: false,
        status: 'active', origin: 'task', title: '正在改点什么', source_id: 1, created_at: iso(NOW - 50000) },
      { kind: 'branch', id: 'branch:lush/demo/2-two', name: 'lush/demo/2-two', head_commit: 'ccc', current: false, tracked: true, placeholder: false,
        status: 'ready', origin: 'task', title: '合并我', source_id: 2, created_at: iso(NOW - 40000) },
      { kind: 'branch', id: 'branch:lush/demo/3-three', name: 'lush/demo/3-three', head_commit: 'ddd', current: false, tracked: true, placeholder: false,
        status: 'ready', origin: 'task', title: '另一个待合的', source_id: 3, created_at: iso(NOW - 30000) },
      { kind: 'branch', id: 'branch:lush/demo/behind', name: 'lush/demo/behind', head_commit: 'eee', current: false, tracked: true, placeholder: false,
        status: 'ready', created_at: iso(NOW - 20000) },
      { kind: 'branch', id: 'branch:lush/demo/blocked', name: 'lush/demo/blocked', head_commit: 'fff', current: false, tracked: true, placeholder: false,
        status: 'ready', created_at: iso(NOW - 10000) },
      { kind: 'task', id: 1, role: 'worker', name: 'one', goal: '正在改点什么', status: 'running', integration: 'none',
        branch: 'lush/demo/1-one', workspace: '/tmp/wt/1', workspace_state: 'present', branch_state: 'present',
        target_branch: 'main', ahead: 1, behind: 0, merged: false, current: false },
    ],
    edges: [
      { kind: 'fork', from: 'branch:main', to: 'branch:lush/demo/1-one', status: 'integrated', ahead: 0, behind: 0, blockers: [], can_merge: false, can_sync: false },
      { kind: 'fork', from: 'branch:main', to: 'branch:lush/demo/2-two', status: 'fast_forward', ahead: 1, behind: 0, blockers: [], can_merge: true, can_sync: false },
      { kind: 'fork', from: 'branch:main', to: 'branch:lush/demo/3-three', status: 'diverged', ahead: 1, behind: 2, blockers: [], can_merge: false, can_sync: true },
      { kind: 'fork', from: 'branch:main', to: 'branch:lush/demo/behind', status: 'integrated', ahead: 0, behind: 3, blockers: [], can_merge: false, can_sync: false, can_catchup: true },
      { kind: 'fork', from: 'branch:main', to: 'branch:lush/demo/blocked', status: 'fast_forward', ahead: 1, behind: 0, blockers: ['lush/demo/2-two'], can_merge: false, can_sync: false },
    ],
  };
  try {
    ui.selected = null; ui.graphOpen = false; ui.docsOpen = false;
    await fetchGraph();
    const data = ui.lastSnapshot;
    data.notices = [
      { id: 900, task_id: 1, kind: 'info', status: 'sent', title: '分支 lush/demo/1-one 有需要注意的变化', created_at: iso(NOW - 1000) },
      { id: 901, task_id: 1, kind: 'question', status: 'open', title: '确认兼容方案', created_at: iso(NOW - 2000) },
      { id: 902, task_id: 2, kind: 'plan', status: 'open', title: '计划待批准', created_at: iso(NOW - 3000) },
    ];
    ui.overviewKey = null;
    renderOverview(data);
    const panel = dom.node('detail');
    expect(panel.dataset.view).toBe('overview');
    expect(panel.querySelectorAll('.metric').length).toBe(4);

    // ① 待收口分支按 can_merge / can_sync / can_catchup / blocker 分类出现。
    const closing = panel.querySelector('.closing-branches');
    const closingRow = name => closing.querySelector(`[data-branch="${name}"]`);
    expect(deepText(closingRow('lush/demo/2-two'))).toContain('待合入父分支');
    expect(deepText(closingRow('lush/demo/3-three'))).toContain('父子已分歧');
    expect(deepText(closingRow('lush/demo/behind'))).toContain('落后父分支');
    expect(deepText(closingRow('lush/demo/blocked'))).toContain('先收拢子分支：lush/demo/2-two');
    // 已与父分支一致、只在跑的 1-one 不在待收口清单里。
    expect(closingRow('lush/demo/1-one')).toBeNull();

    // ② 正在工作的分支：分支名、标题、活跃任务数与任务链接。
    const working = panel.querySelector('.working-branches').querySelector('[data-branch="lush/demo/1-one"]');
    expect(working).toBeTruthy();
    const workingText = deepText(working);
    expect(workingText).toContain('lush/demo/1-one');
    expect(workingText).toContain('正在改点什么');
    expect(workingText).toContain('1 个活跃任务');
    expect(working.querySelectorAll('button').some(node => node.textContent === '#1')).toBe(true);

    // ③ kind==='info' 的提醒只进「最近提醒」；待决口径仍是 open 且非 plan。
    const reminderText = deepText(panel.querySelector('.reminder-panel'));
    expect(reminderText).toContain('分支 lush/demo/1-one 有需要注意的变化');
    expect(reminderText).toContain('lush/demo/1-one');
    const attentionText = deepText(panel.querySelector('.attention-panel'));
    expect(attentionText).toContain('确认兼容方案');
    expect(attentionText).not.toContain('分支 lush/demo/1-one 有需要注意的变化');
    expect(attentionText).not.toContain('计划待批准');

    // ④ 待收口分支的入口切到分支图（概览本身不给写动作）。
    const entry = panel.querySelector('.closing-branches').querySelectorAll('button').find(node => node.textContent === '去分支图处理');
    expect(entry).toBeTruthy();
    await entry.onclick();
    expect(dom.location.hash).toBe('#graph');
    expect(ui.graphOpen).toBe(true);
  } finally {
    world.state.graph = saved;
    ui.graphOpen = false; ui.selected = null; ui.docsOpen = false; ui.overviewKey = null; ui.lastGraph = null;
    dom.location.hash = '';
    await fetchGraph().catch(() => {});
    ui.overviewKey = null;
  }
});

test('概览：打开期间不会每 1.5s 打 /api/graph', async () => {
  // 先让上一轮取图落地，计数基线才稳定。
  await new Promise(resolve => setTimeout(resolve, 0));
  ui.selected = null; ui.graphOpen = false; ui.docsOpen = false;
  const before = world.state.graphFetches;
  // 把陈旧时间推远：下一次轮询会补拉一次图。
  ui.graphFetchedAt = Date.now() - 20000;
  ui.graphFingerprint = null;
  await dom.intervalFor(1500)();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(world.state.graphFetches).toBe(before + 1);
  // 指纹没变、距上次拉图不满 3 秒：后续轮询不再打 git。
  await dom.intervalFor(1500)();
  await dom.intervalFor(1500)();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(world.state.graphFetches).toBe(before + 1);
});

test('概览：图未到 / 读图失败时给占位与降级提示，提醒与待决仍可用；空图给空态', async () => {
  const saved = world.state.graph;
  const savedGraph = ui.lastGraph;
  try {
    ui.selected = null; ui.graphOpen = false; ui.docsOpen = false;
    const data = ui.lastSnapshot;
    data.notices = [
      { id: 910, task_id: 1, kind: 'info', status: 'sent', title: '提醒仍然可见', created_at: iso(NOW - 1000) },
      { id: 911, task_id: 1, kind: 'question', status: 'open', title: '问题仍然可见' },
    ];
    // ① 还没拿到图：占位文案，快照撑得住的提醒与待决照画。
    ui.lastGraph = null; ui.overviewKey = null;
    renderOverview(data);
    let text = deepText(dom.node('detail'));
    expect(text).toContain('正在读取分支…');
    expect(text).toContain('提醒仍然可见');
    expect(text).toContain('问题仍然可见');

    // ② 读 git 失败：明确提示，不白屏，也不抛错。
    world.state.graph = { generated_at: iso(NOW), current_branch: null, truncated: false, git: false, error: 'not a git repository', nodes: [], edges: [] };
    await fetchGraph();
    ui.overviewKey = null;
    renderOverview(ui.lastSnapshot);
    text = deepText(dom.node('detail'));
    expect(text).toContain('读取 git');
    expect(text).toContain('提醒仍然可见');
    expect(text).toContain('问题仍然可见');

    // ③ 空图：给空态文案而不是留白。
    world.state.graph = { generated_at: iso(NOW), current_branch: 'main', truncated: false, git: true, error: null, nodes: [], edges: [] };
    await fetchGraph();
    ui.overviewKey = null;
    renderOverview(ui.lastSnapshot);
    expect(deepText(dom.node('detail'))).toContain('还没有任何分支或 worktree。');
  } finally {
    world.state.graph = saved;
    ui.lastGraph = savedGraph; ui.overviewKey = null;
  }
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
  expect(deepText(goalPanel)).toContain('任务目标');
  expect(deepText(goalPanel)).toContain('更清晰的项目工作台');
  const text = deepText(panel);
  expect(text.indexOf('任务目标')).toBeLessThan(text.indexOf('已完成主题切换'));
  expect(text.indexOf('已完成主题切换')).toBeLessThan(text.indexOf('调用次数'));
  expect(panel.querySelector('.breadcrumb')).toBeTruthy();
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
