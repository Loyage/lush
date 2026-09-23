import { test, expect, afterAll } from 'bun:test';
import { installDom, findByText, deepText } from '../dom-stub.js';
import { until } from '../helpers.js';
import { makeWorld, NOW, iso } from './dom-world.js';

// 概览入口与后退、详情头部意图编号、热任务自己变新、折叠执行过程。
// 每个 DOM 测试文件都自给自足：bun test 在文件之间共享模块注册表，只有本进程里第一个 dom 文件会走到
// app.js 顶部那次 boot()，其余文件 import 到的是缓存模块。所以这里自己建 world、装 stub，再显式装配
// 一次当前 DOM。
const world = makeWorld();
const dom = installDom({ fetch: world.fetchImpl });
const { boot } = await import('../../src/ui/web/assets/app.js');
// app.js 被加载时会自己 await boot() 一次：只有本进程里第一个 dom 文件会命中那次调用，而且它是对着
// 本文件的 stub 跑的。boot() 里 initSidebar() 是「追加」导航项（其余区块都是 replaceChildren，重复
// 装配无残留），所以再 boot() 一次之前先把左栏清空，保证每个文件都恰好装配一次。
dom.node('side-nav').replaceChildren();
await boot();

afterAll(() => dom.restore());

test('概览入口与后退：点左上角 Lush 回概览，后退到无 hash 也一样', async () => {
  const load = () => dom.intervalFor(1500)();
  await load();
  const detail = dom.node('detail');
  // Intent 成果区只在概览出现；回不去概览等于工作台入口消失。
  const onOverview = () => findByText(detail, 'Intent 与最新成果');
  expect(deepText(detail)).toContain('Intent 工作台');
  expect(onOverview()).toBeTruthy();

  // 从任务树点进详情（真实的入口）：概览标题随之消失，回概览只能靠左上角的 Lush，
  // 并且这次要压栈，否则浏览器后退无处可退。
  const pushedBefore = dom.pushed();
  await dom.node('tasks').querySelector('[data-id="1"]').onclick();
  await until(() => findByText(detail, '追加说明'), 2000);
  expect(dom.location.hash).toBe('#task-1');
  expect(dom.pushed()).toBeGreaterThan(pushedBefore);
  expect(onOverview()).toBeNull();

  await dom.node('home').onclick();
  await until(onOverview, 2000);
  // hash 一起清掉，刷新页面不会又跳回详情。
  expect(dom.location.hash).toBe('');

  // 浏览器后退到无 hash 的地址：也是回概览，不是停在一个点不到概览的详情上。
  dom.location.hash = '#task-1';
  await dom.fire('hashchange');
  await until(() => findByText(detail, '追加说明'), 2000);
  dom.location.hash = '';
  await dom.fire('hashchange');
  await until(onOverview, 2000);
});

test('详情头部显示对应意图编号，能点开那条意图，input_id 为空时不乱显示', async () => {
  const detail = dom.node('detail');
  const head = () => detail.querySelector('.head');
  dom.location.hash = '#task-1';
  await dom.fire('hashchange');
  await until(() => head() && findByText(head(), '意图 #1'), 2000);

  // 头部写着「意图 #1」而不是「输入 #1」，hover 能看到意图原文，并且是可点的。
  const intent = findByText(head(), '意图 #1');
  expect(intent.title).toContain('demo');
  expect(intent.classList.contains('intent-link')).toBe(true);

  // 点击跳到这条意图的 planner 任务 #9（fixture 里 intents[0].task_id = 9）。
  await intent.onclick();
  expect(dom.location.hash).toBe('#task-9');

  // scheduler #4 的 input_id 是 null：头部不该出现「意图 #null」。
  dom.location.hash = '#task-4';
  await dom.fire('hashchange');
  await until(() => head() && deepText(head()).includes('#4'), 2000);
  expect(deepText(head())).not.toContain('意图 #');
});

test('运行中 task 在任务树和详情显示计划完成度与当前步骤', async () => {
  await dom.intervalFor(1500)();
  const task = dom.node('tasks').querySelector('[data-id="1"]');
  const compact = task.querySelector('.task-progress-compact');
  expect(deepText(compact)).toContain('1/3');
  expect(deepText(compact)).toContain('当前：实现功能');

  dom.location.hash = '#task-1';
  await dom.fire('hashchange');
  const detail = dom.node('detail');
  await until(() => findByText(detail, '任务计划'), 2000);
  const panel = detail.querySelector('.task-progress-panel');
  expect(deepText(panel)).toContain('1/3');
  expect(deepText(panel)).toContain('确认现状');
  expect(deepText(panel)).toContain('实现功能');
  expect(panel.querySelector('.is-complete')).toBeTruthy();
  expect(panel.querySelector('.is-current')).toBeTruthy();
  const completedDuration = panel.querySelector('.is-complete-duration');
  const runningDuration = panel.querySelector('.is-running-duration');
  expect(completedDuration.textContent).toContain('用时 7 秒');
  expect(runningDuration.textContent).toContain('已执行 1 分');
  expect(completedDuration.className).not.toBe(runningDuration.className);
  // 不重画整块计划，live tick 也会推进正在执行步骤的计时文字。
  runningDuration.dataset.progressStartedAt = new Date(Date.now() - 125000).toISOString();
  const { refreshProgressDurations } = await import('../../src/ui/web/assets/render-progress.js');
  refreshProgressDurations(panel);
  expect(runningDuration.textContent).toContain('已执行 2 分');
});

test('终态 task 冻结未完成步骤，不再挂持续上涨的 live tick', async () => {
  const { renderTaskProgress, renderGraphProgress } = await import('../../src/ui/web/assets/render-progress.js');
  const progress = { version: 1, items: [
    { key: 'inspect', label: '确认现状', status: 'completed', started_at: iso(NOW - 9000), completed_at: iso(NOW - 2000), duration_ms: 7000 },
    { key: 'report', label: '交付报告', status: 'pending', started_at: iso(NOW - 65000), completed_at: null, duration_ms: null },
    { key: 'finish', label: '最终答复', status: 'pending', started_at: null, completed_at: null, duration_ms: null },
  ] };
  const panel = renderTaskProgress(progress, { status: 'failed', endedAt: iso(NOW - 5000) });
  expect(deepText(panel)).toContain('失败时中止 · 已执行 1 分 0 秒');
  expect(deepText(panel)).toContain('未执行');
  expect(panel.querySelector('.is-interrupted')).toBeTruthy();
  expect(panel.querySelector('.is-running-duration')).toBeNull();

  const graph = renderGraphProgress(progress, { status: 'failed', running: false });
  expect(deepText(graph)).toContain('交付报告 · 失败时中止');
  expect(graph.querySelector('.is-running-duration')).toBeNull();
});

test('Agent 的模型与用量直接可见：没有折叠开关，也没有可点的「模型、用量与会话信息」标题', async () => {
  const detail = dom.node('detail');
  dom.location.hash = '#task-1';
  await dom.fire('hashchange');
  await until(() => findByText(detail, '会话记录'), 2000);

  const blockByTitle = title => [...detail.querySelectorAll('.block')].find(node => node.querySelector('h2')?.textContent === title);
  const agent = blockByTitle('Agent');
  // 模型用量仍直接可见；执行正文自身可有来源折叠，不包住信息网格。
  expect([...agent.children].filter(node => node.tagName === 'DETAILS')).toHaveLength(0);
  expect(findByText(agent, '模型、用量与会话信息')).toBeNull();
  // agent 身份与唤醒、模型、思考用量、请求、会话记录一次性直接可读。
  for (const label of ['agent', '唤醒', '模型', '上下文占用', '累计 token', '预计花费', '模型请求', '会话记录']) {
    expect(findByText(agent, label)).toBeTruthy();
  }
  expect(findByText(agent, 'mock/mock-1')).toBeTruthy();
  // 悬停提示保留（title 挂在整张 kv 上，不是标签上）。
  const context = [...agent.querySelectorAll('.kv')].find(node => node.querySelector('b')?.textContent === '上下文占用');
  expect(context.title).toContain('最近一次模型请求');
  // 执行过程无需额外点击，已加载正文与搜索直接可读。
  const process = blockByTitle('执行过程');
  expect(process.querySelector('[data-live="transcript-steps"]')).toBeTruthy();
  expect(process.querySelector('.transcript-search')).toBeTruthy();
  expect(findByText(process, '查看执行过程')).toBeNull();
});

test('热任务自动加载执行正文，轮询增量续读并保留阅读节点', async () => {
  dom.location.hash = '#task-1';
  await dom.fire('hashchange');
  const detail = dom.node('detail');
  const list = () => detail.querySelector('[data-live="transcript-steps"]');
  await until(() => list() && list().children.length === 5, 2000);
  expect(world.state.transcriptAfter.every(after => after === 0)).toBe(true);
  const initialReads = [...world.state.transcriptAfter];
  const originalList = list();
  const search = detail.querySelector('.transcript-search');
  search.querySelector('input').value = '保留搜索内容';
  // 同一个任务的慢刷新也复用实际阅读节点，不只保存几枚布尔开关。
  await dom.fire('hashchange');
  await until(() => detail.querySelector('.transcript-search'), 2000);
  expect(list()).toBe(originalList);
  expect(detail.querySelector('.transcript-search')).toBe(search);
  expect(search.querySelector('input').value).toBe('保留搜索内容');

  // 每一步的 token chip：只认组的首步，同一条回复的第二个 step 不重复；估算带 + 前缀。
  const rendered = list().children;
  const chipOf = node => node.querySelector('.step-tokens');
  expect(chipOf(rendered[0])).toBeNull();                       // 首个请求之前没有可比对的上下文
  expect(chipOf(rendered[1]).textContent).toBe('上下文 9.9k');   // assistant 步：精确
  expect(chipOf(rendered[2])).toBeNull();                       // 同一次回复的第二个 step 不重复
  expect(chipOf(rendered[3]).textContent).toBe('+1.2k');        // 工具输出批：估算
  expect(chipOf(rendered[3]).title).toContain('估算');
  expect(chipOf(rendered[4])).toBeNull();                       // 同一批的后续步不重复
  expect(list().querySelectorAll('.step-tokens').length).toBe(2);
  // chip 插在标题与时间之间，标题被截断时它和时间仍完整可见（flex:none 在样式里）。
  const head = rendered[1].querySelector('.step-head');
  const order = [...head.children].map(node => node.className);
  expect(order.indexOf('step-title')).toBeLessThan(order.indexOf('step-tokens'));
  expect(order.indexOf('step-tokens')).toBeLessThan(order.indexOf('when'));

  // 续读到的步骤即使属于同一批（没有 first），也不能把已经印过的 chip 再印一遍。
  world.state.transcriptSteps.push({ seq: 6, kind: 'result', title: 'edit', at: iso(NOW), body: '测试通过',
    tokens: { context_added: 1200, estimated: true, batch: true } });
  await dom.intervalFor(3000)();
  expect(list().children.length).toBe(6);
  expect(deepText(list())).toContain('测试通过');
  expect(list().querySelectorAll('.step-tokens').length).toBe(2);
  // 第二个 tick 用的是游标 5，不是从头再读一遍。
  expect(world.state.transcriptAfter).toEqual([...initialReads, 5]);
});
