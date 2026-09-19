import { test, expect, afterAll } from 'bun:test';
import { installDom, findByText, deepText } from '../dom-stub.js';
import { makeWorld, NOW, iso } from './dom-world.js';

// 左栏导航计数、折叠、任务树筛选。
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

// 原用例排在其他用例之后，那时缓存里还剩一条、拆解队列已被清空；把这两行准备内联进来，断言不变。
world.state.drafts = [{ id: 12, content: '第二条（改过）', created_at: iso(NOW - 4000) }];
world.state.specs = [];

afterAll(() => dom.restore());

test('左侧栏：导航计数、折叠开关、任务树筛选在真 DOM 上都生效', async () => {
  await dom.intervalFor(1500)();
  const nav = dom.node('side-nav');
  const items = nav.querySelectorAll('.nav-item');
  // 五个区块的导航（缓存 / 意图 / 任务树 / 队列 / 待决），计数取自各列表
  expect(items).toHaveLength(5);
  expect(items.map(node => node.querySelector('.nav-count').textContent)).toEqual(['1', '2', '3', '0', '0']);
  await items[2].onclick();
  expect(items[2].classList.contains('selected')).toBe(true);
  // 筛选条与列表容器分离：控件建一次，轮询只重画列表
  const filters = dom.node('task-filters');
  const selects = filters.querySelectorAll('.filter-select');
  expect(selects).toHaveLength(3);
  const tasks = dom.node('tasks');
  expect(tasks.querySelector('[data-id="1"]')).toBeTruthy();
  // 状态=已完成：running 的 #1 消失，#2 / #3 留着，计数变成「匹配 N / 共 M」
  selects[0].value = 'completed';
  await selects[0].listeners.change[0]();
  expect(tasks.querySelector('[data-id="1"]')).toBeFalsy();
  expect(tasks.querySelector('[data-id="2"]')).toBeTruthy();
  expect(dom.node('task-count').textContent).toContain('匹配 2 / 共 3');
  // 关键字筛不到东西时给空态，不残留旧节点
  const keyword = filters.querySelector('.filter-input');
  keyword.value = '不存在的关键字';
  await keyword.listeners.input[0]();
  expect(tasks.querySelectorAll('.task')).toHaveLength(0);
  expect(deepText(tasks)).toContain('没有符合筛选的条目');
  // 还原筛选，证明「取消条件 = 回到改造前的列表」
  keyword.value = '';
  await keyword.listeners.input[0]();
  selects[0].value = 'all';
  await selects[0].listeners.change[0]();
  expect(tasks.querySelector('[data-id="1"]')).toBeTruthy();
  expect(dom.node('task-count').textContent).toContain('3 个');
  // 折叠：点标题切换 collapsed 类、aria-expanded 与 localStorage
  const sideTasks = dom.node('side-tasks');
  const headTasks = dom.node('side-head-tasks');
  expect(headTasks.getAttribute('aria-expanded')).toBe('true');
  await headTasks.listeners.click[0]();
  expect(sideTasks.classList.contains('collapsed')).toBe(true);
  expect(headTasks.getAttribute('aria-expanded')).toBe('false');
  expect(JSON.parse(globalThis.localStorage.getItem('lush.sidebar.collapsed'))).toEqual(['tasks']);
  // 「全部展开」把所有区块一次收起状态清掉
  await findByText(nav, '全部展开').onclick();
  expect(sideTasks.classList.contains('collapsed')).toBe(false);
  expect(JSON.parse(globalThis.localStorage.getItem('lush.sidebar.collapsed'))).toEqual([]);
});
