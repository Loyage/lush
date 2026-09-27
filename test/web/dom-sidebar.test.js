import { test, expect, afterAll } from 'bun:test';
import { installDom, findByText, deepText } from '../dom-stub.js';
import { makeWorld, NOW, iso } from './dom-world.js';

// 左栏导航计数、折叠、全局排序控件、行动 AP 筛选。
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

// 原用例排在其他用例之后，那时拆解队列已被清空；把这一行准备内联进来，断言不变。
world.state.specs = [];

afterAll(() => dom.restore());

test('左栏：四个区块的导航计数与索引、折叠开关、行动 AP 筛选在真 DOM 上都生效', async () => {
  await dom.intervalFor(1500)();
  const nav = dom.node('side-nav');
  const items = nav.querySelectorAll('.nav-item');
  // 四个区块的导航（待定事项 / 历史输入 / 规划 AP / 行动 AP），计数取自各列表
  expect(items).toHaveLength(4);
  expect(items.map(node => node.querySelector('.nav-count').textContent)).toEqual(['0', '2', '0', '3']);
  // 索引顺序就是区块顺序：第三个是「规划 AP」
  await items[2].onclick();
  expect(items[2].classList.contains('selected')).toBe(true);
  // 筛选条与列表容器分离：控件建一次，轮询只重画列表
  const filters = dom.node('ap-filters');
  const selects = filters.querySelectorAll('.filter-select');
  expect(selects).toHaveLength(3);
  const aps = dom.node('aps');
  expect(aps.querySelector('[data-id="1"]')).toBeTruthy();
  // 状态=已完成：running 的 #1 消失，#2 / #3 留着，计数变成「匹配 N / 共 M」
  selects[0].value = 'completed';
  await selects[0].listeners.change[0]();
  expect(aps.querySelector('[data-id="1"]')).toBeFalsy();
  expect(aps.querySelector('[data-id="2"]')).toBeTruthy();
  expect(dom.node('ap-count').textContent).toContain('匹配 2 / 共 3');
  // 关键字筛不到东西时给空态，不残留旧节点
  const keyword = filters.querySelector('.filter-input');
  keyword.value = '不存在的关键字';
  await keyword.listeners.input[0]();
  expect(aps.querySelectorAll('.ap')).toHaveLength(0);
  expect(deepText(aps)).toContain('没有符合筛选的条目');
  // 还原筛选，证明「取消条件 = 回到改造前的列表」
  keyword.value = '';
  await keyword.listeners.input[0]();
  selects[0].value = 'all';
  await selects[0].listeners.change[0]();
  expect(aps.querySelector('[data-id="1"]')).toBeTruthy();
  expect(dom.node('ap-count').textContent).toContain('3 个');
  // 折叠：点标题切换 collapsed 类、aria-expanded 与 localStorage
  const sideAPs = dom.node('side-aps');
  const headAPs = dom.node('side-head-aps');
  expect(headAPs.getAttribute('aria-expanded')).toBe('true');
  await headAPs.listeners.click[0]();
  expect(sideAPs.classList.contains('collapsed')).toBe(true);
  expect(headAPs.getAttribute('aria-expanded')).toBe('false');
  expect(JSON.parse(globalThis.localStorage.getItem('lush.sidebar.collapsed'))).toEqual(['aps']);
  // 「全部展开」把所有区块一次收起状态清掉
  await findByText(nav, '全部展开').onclick();
  expect(sideAPs.classList.contains('collapsed')).toBe(false);
  expect(JSON.parse(globalThis.localStorage.getItem('lush.sidebar.collapsed'))).toEqual([]);
});

test('排序是左栏顶部的全局控件，不再是行动 AP 区块里的下拉', async () => {
  const sort = dom.node('sidebar-sort');
  // 控件是全局的：挂在左栏顶部，四个列表共用一个；带说明性 title
  expect(sort.title).toContain('四个列表共用');
  expect(sort.querySelectorAll('option').map(node => node.textContent)).toEqual(['智能排序', '按最近更新', '按编号（新在前）']);
  expect(sort.value).toBe('smart');
  // 区块标题里不再自带排序下拉
  expect(dom.node('side-aps').querySelector('#tree-sort')).toBeFalsy();
  // 切换后写进新 key，并立刻重画（这里只验证偏好落盘与默认值）
  sort.value = 'updated';
  await sort.listeners.change[0]();
  expect(globalThis.localStorage.getItem('lush.sidebarSort')).toBe('updated');
  sort.value = 'smart';
  await sort.listeners.change[0]();
  expect(globalThis.localStorage.getItem('lush.sidebarSort')).toBe('smart');
});
