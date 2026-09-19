import { test, expect, afterAll } from 'bun:test';
import { installDom } from '../dom-stub.js';
import { makeWorld, NOW, iso } from './dom-world.js';

// 左栏全局排序：smart / updated / id 三个模式同时作用于四个列表，且切换后立刻就地重画。
// 每个 DOM 测试文件都自给自足：bun test 在文件之间共享模块注册表，只有本进程里第一个 dom 文件会走到
// app.js 顶部那次 boot()，其余文件 import 到的是缓存模块。所以这里自己建 world、装 stub，再显式装配
// 一次当前 DOM。
const world = makeWorld();
const dom = installDom({ fetch: world.fetchImpl });

// 预置成三种顺序互不相同，才看得出「哪个模式真的生效」：
// 历史输入 smart 按接口顺序（id 升序），updated 按 planner 最近动过的时间倒序；
// 规划任务 smart 组内编号升序，updated / id 只翻组内次序；待定事项同理；行动任务 id 倒序最直观。
world.state.intents = [
  { id: 1, content: '老输入', flow: 'develop', task_id: 9, status: 'completed', plan_gate: 'approved', plan_notice_id: null,
    specs_pending: 0, specs_planned: 1, specs_dropped: 0, scheduler_id: null, scheduler_status: null, work_tasks: 1,
    draft_count: 0, created_at: iso(NOW - 9000), planner_updated_at: iso(NOW - 9000) },
  { id: 2, content: '新输入', flow: 'develop', task_id: 11, status: 'completed', plan_gate: 'approved', plan_notice_id: null,
    specs_pending: 0, specs_planned: 1, specs_dropped: 0, scheduler_id: null, scheduler_status: null, work_tasks: 1,
    draft_count: 0, created_at: iso(NOW - 9500), planner_updated_at: iso(NOW - 1000) },
];
world.state.specs = [
  { id: 1, input_id: 1, planner_task_id: 9, batch_id: 4, seq: 1, goal: '老规划', role: 'worker', name: 'old-spec', deps: [],
    status: 'planned', task_id: null, note: null, created_at: iso(NOW - 9000), updated_at: iso(NOW - 9000) },
  { id: 2, input_id: 1, planner_task_id: 9, batch_id: 4, seq: 2, goal: '新规划', role: 'worker', name: 'new-spec', deps: [],
    status: 'planned', task_id: null, note: null, created_at: iso(NOW - 1000), updated_at: iso(NOW - 1000) },
];
world.state.notices = [
  { id: 5, task_id: 4, kind: 'question', title: '老问题', body: '', status: 'open', created_at: iso(NOW - 9000) },
  { id: 6, task_id: 4, kind: 'question', title: '新问题', body: '', status: 'open', created_at: iso(NOW - 1000) },
];

const { boot } = await import('../../src/ui/web/assets/app.js');
dom.node('side-nav').replaceChildren();
await boot();

afterAll(() => dom.restore());

/** 一个列表里当前的条目文本顺序；selector 默认取卡片正文。 */
const texts = (container, selector) => dom.node(container).querySelectorAll(selector).map(node => node.textContent);
const intents = () => texts('intents', '.intent-goal');
const specs = () => texts('specs', '.spec-goal');
const notices = () => texts('notices', '.goal');
const tasks = () => texts('tasks', '.goal');

test('排序：一个左栏全局控件同时作用于四个列表，切换后不等轮询就重画', async () => {
  await dom.intervalFor(1500)();
  const sort = dom.node('sidebar-sort');
  // 默认智能排序：历史输入保持接口顺序，规划任务组内编号升序，待定事项保持返回顺序
  expect(intents()).toEqual(['老输入', '新输入']);
  expect(specs()).toEqual(['老规划', '新规划']);
  expect(notices()).toEqual(['老问题', '新问题']);
  expect(tasks()).toEqual(['正在改点什么', '合并我', '另一个待合的']);

  // 按最近更新：四个列表一起翻过来（都在同一份快照上重排，没有 interval）
  sort.value = 'updated';
  await sort.listeners.change[0]();
  expect(intents()).toEqual(['新输入', '老输入']);       // planner 最近动过的在前
  expect(specs()).toEqual(['新规划', '老规划']);         // 组内按 updated_at 倒序
  expect(notices()).toEqual(['新问题', '老问题']);       // created_at 倒序
  expect(tasks()).toEqual(['正在改点什么', '合并我', '另一个待合的']);   // 行动任务仍只重排兄弟

  // 按编号（新在前）：四个列表都用 id 倒序
  sort.value = 'id';
  await sort.listeners.change[0]();
  expect(intents()).toEqual(['新输入', '老输入']);
  expect(specs()).toEqual(['新规划', '老规划']);
  expect(notices()).toEqual(['新问题', '老问题']);
  expect(tasks()).toEqual(['另一个待合的', '合并我', '正在改点什么']);
});

test('排序偏好存进 lush.sidebarSort，读取时回落旧 key lush.treeSort', async () => {
  const { readSidebarSortPref, SIDEBAR_SORT_KEY, LEGACY_TREE_SORT_KEY } = await import('../../src/ui/web/assets/state.js');
  expect(SIDEBAR_SORT_KEY).toBe('lush.sidebarSort');
  globalThis.localStorage.setItem(SIDEBAR_SORT_KEY, 'id');
  expect(readSidebarSortPref()).toBe('id');
  // 新 key 缺失（升级前写下的偏好）时仍认旧 key；坏值一律回落 smart
  globalThis.localStorage.removeItem(SIDEBAR_SORT_KEY);
  globalThis.localStorage.setItem(LEGACY_TREE_SORT_KEY, 'updated');
  expect(readSidebarSortPref()).toBe('updated');
  globalThis.localStorage.setItem(SIDEBAR_SORT_KEY, 'nonsense');
  expect(readSidebarSortPref()).toBe('smart');
  globalThis.localStorage.removeItem(SIDEBAR_SORT_KEY);
  globalThis.localStorage.removeItem(LEGACY_TREE_SORT_KEY);
});
