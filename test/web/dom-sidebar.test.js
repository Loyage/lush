import { test, expect, afterAll } from 'bun:test';
import { installDom, findByText, deepText } from '../dom-stub.js';
import { makeWorld, NOW, iso } from './dom-world.js';

// 左栏导航计数、折叠、全局排序控件、行动任务筛选。
// 每个 DOM 测试文件都自给自足：bun test 在文件之间共享模块注册表，只有本进程里第一个 dom 文件会走到
// app.js 顶部那次 boot()，其余文件 import 到的是缓存模块。所以这里自己建 world、装 stub，再显式装配
// 一次当前 DOM。
const world = makeWorld();
let intercept = null;
const dom = installDom({ fetch: (url, options) => intercept?.(url, options) ?? world.fetchImpl(url, options) });
const { boot } = await import('../../src/ui/web/assets/app.js');
// app.js 被加载时会自己 await boot() 一次：只有本进程里第一个 dom 文件会命中那次调用，而且它是对着
// 本文件的 stub 跑的。boot() 里 initSidebar() 是「追加」导航项（其余区块都是 replaceChildren，重复
// 装配无残留），所以再 boot() 一次之前先把左栏清空，保证每个文件都恰好装配一次。
dom.node('side-nav').replaceChildren();
await boot();
const { ui } = await import('../../src/ui/web/assets/state.js');
const { renderTree } = await import('../../src/ui/web/assets/render-tree.js');
const { refresh } = await import('../../src/ui/web/assets/refresh.js');

// 原用例排在其他用例之后，那时拆解队列已被清空；把这一行准备内联进来，断言不变。
world.state.specs = [];

afterAll(() => dom.restore());

test('当前项目身份不误称 Host，侧栏不装配跨项目列表轮询', async () => {
  const id = 'a1b2c3d4e5f60718';
  const calls = [], before = dom.intervals.length;
  intercept = (url, options) => {
    calls.push(url);
    if (url === '/api/host') return Response.json({ mode: 'host', projects: [{ id, name: 'demo', project: '/tmp/demo' }] });
    return world.fetchImpl(String(url).replace(`/p/${id}`, ''), options);
  };
  dom.location.pathname = `/p/${id}/`; dom.location.hash = '';
  try {
    await boot();
    expect(dom.node('host-context').textContent).toBe('当前项目');
    expect(dom.node('project').textContent).toBe('demo');
    expect(dom.node('project').title).toBe('/tmp/demo');
    expect(dom.intervals.slice(before).some(timer => timer.ms === 20000)).toBe(false);
    await dom.fire('visibilitychange');
    expect(calls).not.toContain('/api/host/projects');
    dom.location.pathname = '/'; dom.location.hash = '';
    await boot();
    expect(dom.node('host-context').textContent).toBe('工作台');
    expect(dom.node('project').textContent).toBe('未打开项目');
  } finally {
    intercept = null; dom.location.pathname = '/'; dom.location.hash = ''; await boot();
  }
});

test('左栏：两个区块的导航计数与索引、折叠开关、行动任务筛选在真 DOM 上都生效', async () => {
  await dom.intervalFor(1500)();
  const nav = dom.node('side-nav');
  const items = nav.querySelectorAll('.nav-item');
  // 两个区块的导航（待我处理 / 任务列表），计数取自各列表
  expect(items).toHaveLength(2);
  expect(items.map(node => node.querySelector('.nav-count').textContent)).toEqual(['0', '3']);
  // 索引顺序就是区块顺序：第二个是「任务列表」
  await items[1].onclick();
  expect(items[1].classList.contains('selected')).toBe(true);
  // 筛选条与列表容器分离：控件建一次，轮询只重画列表
  const filters = dom.node('task-filters');
  expect(filters.querySelectorAll('.filter-select')).toHaveLength(1);
  const groups = filters.querySelectorAll('.filter-multi');
  expect(groups).toHaveLength(2);
  const completed = groups[0].querySelector('[data-value="completed"]').querySelector('input');
  const allStatuses = groups[0].querySelector('[data-value="all"]').querySelector('input');
  const tasks = dom.node('tasks');
  expect(tasks.querySelector('[data-id="1"]')).toBeTruthy();
  // 状态=已完成：running 的 #1 消失，#2 / #3 留着，计数变成「匹配 N / 共 M」
  completed.checked = true;
  await completed.listeners.change[0]();
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
  allStatuses.checked = true;
  await allStatuses.listeners.change[0]();
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

test('平铺列表即时多选、搜索、轮询与偏好重载：不补祖先，没有层级和兄弟链', async () => {
  const snapshot = ui.lastSnapshot;
  const sortMode = ui.sidebarSortMode;
  const saved = globalThis.localStorage.getItem('lush.sidebar.filters');
  const make = (id, parent_id, status, role) => ({ id, parent_id, status, role, integration: 'none',
    goal: `目标 ${id}`, updated_at: iso(NOW + id) });
  ui.lastSnapshot = { ...snapshot, tasks: [make(10, null, 'completed', 'agent'), make(11, 10, 'running', 'agent'),
    make(12, 10, 'failed', 'future-role'), make(13, 11, 'completed', 'worker')] };
  ui.sidebarSortMode = 'id';
  const rows = () => dom.node('tasks').querySelectorAll('.task');
  const ids = () => rows().map(node => Number(node.dataset.id));
  const groups = dom.node('task-filters').querySelectorAll('.filter-multi');
  const box = (group, value) => groups[group].querySelector(`[data-value="${value}"]`).querySelector('input');
  const change = async (group, value, checked) => { const input = box(group, value); input.checked = checked; await input.listeners.change[0](); };
  try {
    renderTree(ui.lastSnapshot);
    expect(ids()).toEqual([13, 12, 11, 10]);
    expect(rows().every(node => !/\bd\d\b/.test(node.className))).toBe(true);
    expect(dom.node('tasks').querySelectorAll('.band')).toHaveLength(0);
    await change(0, 'running', true);
    expect(ids()).toEqual([11]);
    await change(0, 'failed', true);
    expect(ids()).toEqual([12, 11]);
    await change(1, 'agent', true);
    expect(ids()).toEqual([11]);
    await change(1, 'future-role', true);
    expect(ids()).toEqual([12, 11]);
    expect(dom.node('task-count').textContent).toContain('匹配 2 / 共 4');
    expect(dom.node('task-count').textContent).not.toContain('父级');
    const input = box(1, 'agent'); input.focus();
    renderTree(ui.lastSnapshot);
    expect(box(1, 'agent')).toBe(input);
    expect(document.activeElement).toBe(input);
    expect(input.checked).toBe(true);
    const persisted = JSON.parse(globalThis.localStorage.getItem('lush.sidebar.filters'));
    expect(persisted.tasks.status).toEqual(['running', 'failed']);
    expect(persisted.tasks.role).toEqual(['agent', 'future-role']);
    await change(0, 'running', false);
    expect(ids()).toEqual([12]);
    await change(0, 'failed', false);
    expect(box(0, 'all').checked).toBe(true);
    expect(ids()).toEqual([12, 11, 10]);
    const keyword = dom.node('task-filters').querySelector('.filter-input');
    keyword.value = '#11'; await keyword.listeners.input[0]();
    expect(ids()).toEqual([11]);
    keyword.value = ''; await keyword.listeners.input[0]();
    await change(1, 'all', true);
    expect(ids()).toEqual([13, 12, 11, 10]);
    // 页面重新装配仍保留多选，不把历史类型或未知类型重置成 all。
    await change(1, 'worker', true); await change(1, 'future-role', true);
    await boot();
    expect(ui.filters.tasks.role).toEqual(['worker', 'future-role']);
    const reloaded = dom.node('task-filters').querySelectorAll('.filter-multi')[1];
    expect(reloaded.querySelector('[data-value="worker"]').querySelector('input').checked).toBe(true);
    expect(reloaded.querySelector('[data-value="future-role"]').querySelector('input').checked).toBe(true);
  } finally {
    if (saved === null) globalThis.localStorage.removeItem('lush.sidebar.filters');
    else globalThis.localStorage.setItem('lush.sidebar.filters', saved);
    await boot();
    ui.lastSnapshot = snapshot; ui.sidebarSortMode = sortMode; renderTree(snapshot);
  }
});

test('历史分页保留全类型记录和多选条件，空态明确提示尚未加载的记录', async () => {
  const snapshot = ui.lastSnapshot, filters = ui.filters.tasks;
  const older = { id: 50, parent_id: 1, role: 'research', status: 'failed', integration: 'none',
    goal: '历史调研', updated_at: iso(NOW - 10000) };
  const data = { ...snapshot, tasks: [...snapshot.tasks], task_page: { active: 1, shown: 2, historical: 3,
    total: 4, cursor: 51, has_more: true, truncated: true } };
  ui.lastSnapshot = data;
  ui.filters.tasks = { status: ['failed'], role: ['research'], integration: 'all', mine: false, text: '' };
  const calls = [];
  intercept = url => {
    calls.push(url);
    if (url.startsWith('/api/workers?')) return Promise.resolve(new Response(JSON.stringify({ tasks: [older], cursor: 50, has_more: false })));
    return null;
  };
  try {
    renderTree(data);
    expect(deepText(dom.node('tasks'))).toContain('更早记录尚未加载');
    await findByText(dom.node('tasks'), '加载更早 50 个').onclick();
    expect(calls).toContain('/api/workers?scope=all&before=51&limit=50');
    expect(dom.node('tasks').querySelectorAll('.task').map(node => Number(node.dataset.id))).toEqual([50]);
    expect(ui.filters.tasks.role).toEqual(['research']);
    // 有界轮询不丢掉显式加载的旧类型 Task（它没有新式 task_kind）。
    await refresh();
    expect(dom.node('tasks').querySelector('[data-id="50"]')).toBeTruthy();
    expect(dom.node('tasks').querySelector('[data-id="1"]')).toBeNull();
  } finally {
    intercept = null; ui.taskHistory = []; ui.taskHistoryPage = null;
    ui.lastSnapshot = snapshot; ui.filters.tasks = filters; renderTree(snapshot);
  }
});

test('排序是左栏顶部的全局控件，不再是行动任务区块里的下拉', async () => {
  const sort = dom.node('sidebar-sort');
  // 控件是全局的：挂在左栏顶部，两个列表共用一个；带说明性 title
  expect(sort.title).toContain('列表共用');
  expect(sort.querySelectorAll('option').map(node => node.textContent)).toEqual(['智能排序', '按最近更新', '按编号（新在前）']);
  expect(sort.value).toBe('smart');
  // 区块标题里不再自带排序下拉
  expect(dom.node('side-tasks').querySelector('#tree-sort')).toBeFalsy();
  // 切换后写进新 key，并立刻重画（这里只验证偏好落盘与默认值）
  sort.value = 'updated';
  await sort.listeners.change[0]();
  expect(globalThis.localStorage.getItem('lush.sidebarSort')).toBe('updated');
  sort.value = 'smart';
  await sort.listeners.change[0]();
  expect(globalThis.localStorage.getItem('lush.sidebarSort')).toBe('smart');
});
