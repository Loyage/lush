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

test('交付队列只长在概览里：点左上角 Lush 回概览，后退到无 hash 也一样', async () => {
  const load = () => dom.intervalFor(1500)();
  await load();
  const detail = dom.node('detail');
  // 批量合并按钮只在概览里，所以「回不去概览」等于功能消失。
  expect(deepText(detail)).toContain('交付队列');
  expect(findByText(detail, '合并本分支全部可交付 (1)')).toBeTruthy();

  // 从任务树点进详情（真实的入口）：批量按钮随之消失，回概览只能靠左上角的 Lush，
  // 并且这次要压栈，否则浏览器后退无处可退。
  const pushedBefore = dom.pushed();
  await dom.node('tasks').querySelector('[data-id="1"]').onclick();
  await until(() => findByText(detail, '追加说明'), 2000);
  expect(dom.location.hash).toBe('#task-1');
  expect(dom.pushed()).toBeGreaterThan(pushedBefore);
  expect(findByText(detail, '合并本分支全部可交付 (1)')).toBeNull();

  await dom.node('home').onclick();
  await until(() => findByText(detail, '合并本分支全部可交付 (1)'), 2000);
  // hash 一起清掉，刷新页面不会又跳回详情。
  expect(dom.location.hash).toBe('');

  // 浏览器后退到无 hash 的地址：也是回概览，不是停在一个点不到合并按钮的详情上。
  dom.location.hash = '#task-1';
  await dom.fire('hashchange');
  await until(() => findByText(detail, '追加说明'), 2000);
  dom.location.hash = '';
  await dom.fire('hashchange');
  await until(() => findByText(detail, '合并本分支全部可交付 (1)'), 2000);
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

test('热任务的详情会自己变新：折叠的执行过程只显示最近一条步骤，展开后随轮询推进', async () => {
  dom.location.hash = '#task-1';
  await dom.fire('hashchange');
  const detail = dom.node('detail');
  await until(() => detail.querySelector('[data-live="last"]'), 2000);

  const blockByTitle = title => [...detail.querySelectorAll('.block')].find(node => node.querySelector('h2')?.textContent === title);
  // 用户要求：最近一次执行不要在 Agent 信息的方格区，而是放进执行过程区块。
  expect(blockByTitle('Agent').querySelector('.grid').querySelector('[data-live="last"]')).toBeFalsy();
  const process = blockByTitle('执行过程');
  const lastRow = process.querySelector('[data-live="last"]');
  expect(lastRow).toBeTruthy();
  expect(lastRow.querySelector('span').textContent).toContain('bash');
  expect(lastRow.querySelector('span').textContent).toContain('刚刚');
  expect(lastRow.querySelector('span').textContent).toContain('ls -la');
  // 折叠态是单行预览，全文放 title，并保留「查看执行过程」按钮。
  expect(lastRow.title).toContain('ls -la');
  expect(findByText(process, '查看执行过程')).toBeTruthy();

  // 模拟浏览器里每 3 秒跑一次的 liveRefresh：agent 又推进一步，折叠态那一行不用手点就变新。
  world.state.usageLast = { at: iso(NOW), kind: 'text', title: '回答', body: '改好了，正在跑测试' };
  await dom.intervalFor(3000)();
  const updated = process.querySelector('[data-live="last"]').querySelector('span').textContent;
  expect(updated).toContain('改好了，正在跑测试');
  expect(updated).toContain('回答');

  // 展开执行过程：首次全量读，之后按 after=next 增量续读。
  const expand = findByText(detail, '查看执行过程');
  await expand.onclick();
  const list = () => detail.querySelector('[data-live="transcript-steps"]');
  await until(() => list() && list().children.length === 2, 2000);
  expect(world.state.transcriptAfter).toEqual([0]);
  // 展开后折叠态那一行让位给完整步骤列表。
  expect(blockByTitle('执行过程').querySelector('[data-live="last"]')).toBeFalsy();

  world.state.transcriptSteps.push({ seq: 3, kind: 'text', title: '回答', at: iso(NOW), body: '测试通过' });
  await dom.intervalFor(3000)();
  expect(list().children.length).toBe(3);
  expect(deepText(list())).toContain('测试通过');
  // 第二个 tick 用的是游标 2，不是从头再读一遍。
  expect(world.state.transcriptAfter).toEqual([0, 2]);
});
