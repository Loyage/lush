import { test, expect } from 'bun:test';
import { SORT_MODES, treeParent, rankTasks, orderSiblings, orderList } from '../src/ui/web/assets/tree-order.js';

// 扁平任务表：字段与 store.summaries() 一致（id/parent_id/verifies_task_id/status/integration/updated_at）。
const task = (id, extra = {}) => ({
  id, parent_id: null, verifies_task_id: null, status: 'queued', integration: 'none',
  updated_at: '2026-01-01T00:00:00.000Z', ...extra,
});
const at = seconds => new Date(Date.UTC(2026, 0, 1, 0, 0, seconds)).toISOString();
const ids = list => list.map(row => row.id);

test('SORT_MODES 顺序即下拉框顺序，智能排序是第一个', () => {
  expect(SORT_MODES.map(mode => mode.id)).toEqual(['smart', 'updated', 'id']);
  expect(SORT_MODES[0]).toEqual({ id: 'smart', label: '智能排序' });
});

test('treeParent 与界面分组同规则：verifier 挂被检验任务，父不在列表里当根', () => {
  const known = new Set([1, 2]);
  expect(treeParent(task(3, { parent_id: 1 }), known)).toBe(1);
  expect(treeParent(task(3, { verifies_task_id: 2 }), known)).toBe(2);
  expect(treeParent(task(3, { parent_id: 1, verifies_task_id: 2 }), known)).toBe(1);   // parent_id 优先
  expect(treeParent(task(3, { parent_id: 9 }), known)).toBe(0);                        // 父不在列表里
  expect(treeParent(task(3), known)).toBe(0);
});

test('有未答复 notice 的任务排最前，已合并的沉到最后', () => {
  const tasks = [
    task(1, { status: 'completed', integration: 'merged', updated_at: at(5) }),
    task(2, { status: 'completed', integration: 'none', updated_at: at(9) }),
    task(3, { status: 'running', updated_at: at(1) }),
    task(4, { status: 'awaiting', updated_at: at(2) }),
    task(5, { status: 'completed', integration: 'pending', updated_at: at(3) }),
  ];
  const ranks = rankTasks(tasks, new Set([4]));
  expect(ranks.get(4).rank).toBe(0);
  expect(ranks.get(3).rank).toBe(1);
  expect(ranks.get(5).rank).toBe(2);
  expect(ranks.get(1).rank).toBe(3);
  expect(ranks.get(2).rank).toBe(3);
  expect(ids(orderSiblings(tasks, { mode: 'smart', ranks }))).toEqual([4, 3, 5, 2, 1]);   // 档位 3 内 activity 降序
});

test('failed / cancelled 与已合并同档，排在需要人工处理的终态之后', () => {
  const tasks = [
    task(1, { status: 'failed', updated_at: at(9) }),
    task(2, { status: 'cancelled', updated_at: at(8) }),
    task(3, { status: 'completed', integration: 'review', updated_at: at(1) }),
  ];
  const ranks = rankTasks(tasks, []);
  expect(ranks.get(1).rank).toBe(3);
  expect(ranks.get(2).rank).toBe(3);
  expect(ids(orderSiblings(tasks, { mode: 'smart', ranks }))).toEqual([3, 1, 2]);
});

test('rankTasks 接受数组形式的 openNoticeIds，活跃排在已合并之前', () => {
  const tasks = [
    task(1, { status: 'completed', integration: 'merged' }),
    task(2, { status: 'waiting' }),
    task(3, { status: 'queued' }),
  ];
  const ranks = rankTasks(tasks, []);
  expect(ranks.get(1).rank).toBe(3);
  expect(ids(orderSiblings(tasks, { mode: 'smart', ranks }))).toEqual([2, 3, 1]);
  // 数组与 Set 等价：把某条 notice 挂到已合并任务上，它立刻翻到最前
  const withNotice = rankTasks(tasks, [1]);
  expect(withNotice.get(1).rank).toBe(0);
  expect(ids(orderSiblings(tasks, { mode: 'smart', ranks: withNotice }))).toEqual([1, 2, 3]);
  // 也接受 notice 行对象（取 task_id），方便调用方直接传筛选结果
  const viaRows = rankTasks(tasks, [{ id: 99, task_id: 1, status: 'open' }]);
  expect(viaRows.get(1).rank).toBe(0);
});

test('子树 roll-up：父已合并但子 running 时，父的 effectiveRank 跟着子走', () => {
  const tasks = [
    task(1, { status: 'completed', integration: 'merged', updated_at: at(1) }),
    task(2, { parent_id: 1, status: 'running', updated_at: at(30) }),
    task(3, { status: 'completed', integration: 'merged', updated_at: at(50) }),
  ];
  const ranks = rankTasks(tasks, new Set());
  expect(ranks.get(1).rank).toBe(3);
  expect(ranks.get(1).effectiveRank).toBe(1);          // 子 #2 在跑，父不能沉底
  expect(ranks.get(1).activity).toBe(Date.parse(at(30)));   // activity 也 roll-up
  // 根层兄弟里 #1 因为活跃子树排在 #3 前面
  const roots = orderSiblings([tasks[0], tasks[2]], { mode: 'smart', ranks });
  expect(ids(roots)).toEqual([1, 3]);
  // 树结构不变：祖先仍在子孙之前渲染（这里只断言兄弟序列，嵌套由 renderTree 的 walk 保证）
  expect(ids(orderSiblings([tasks[1]], { mode: 'smart', ranks }))).toEqual([2]);
});

test('notice 沿祖先上浮：父下有带 notice 的子任务时父也靠前', () => {
  const tasks = [
    task(1, { parent_id: 2, status: 'awaiting' }),
    task(2, { status: 'completed', integration: 'merged' }),
    task(3, { status: 'completed', integration: 'merged' }),
  ];
  const ranks = rankTasks(tasks, new Set([1]));
  expect(ranks.get(2).effectiveRank).toBe(0);
  expect(ids(orderSiblings([tasks[1], tasks[2]], { mode: 'smart', ranks }))).toEqual([2, 3]);
});

test('updated 模式按更新时间降序，id 兜底；id 模式新在前', () => {
  const tasks = [
    task(1, { updated_at: at(1) }),
    task(2, { updated_at: at(9) }),
    task(3, { updated_at: at(5) }),
    task(4, { updated_at: 'not a date' }),   // 解析不出当 0
  ];
  expect(ids(orderSiblings(tasks, { mode: 'updated' }))).toEqual([2, 3, 1, 4]);
  expect(ids(orderSiblings(tasks, { mode: 'id' }))).toEqual([4, 3, 2, 1]);
  // 同一时间戳时 id 升序兜底，保证确定性
  expect(ids(orderSiblings([task(7, { updated_at: at(5) }), task(2, { updated_at: at(5) })], { mode: 'updated' }))).toEqual([2, 7]);
});

test('未知 mode 回落 smart，ranks 缺项不抛异常', () => {
  const tasks = [
    task(1, { status: 'completed', integration: 'merged' }),
    task(2, { status: 'running' }),
  ];
  const ranks = rankTasks(tasks, new Set());
  const fallback = orderSiblings(tasks, { mode: 'nonsense', ranks });
  expect(ids(fallback)).toEqual(ids(orderSiblings(tasks, { mode: 'smart', ranks })));
  expect(ids(orderSiblings(tasks, { mode: 'smart' }))).toEqual([2, 1]);       // ranks 全缺，按自身档位兜底
  expect(ids(orderSiblings(tasks, { mode: 'smart', ranks: new Map() }))).toEqual([2, 1]);
  expect(orderSiblings(undefined, { mode: 'smart' })).toEqual([]);
});

test('排序不修改入参，也不修改 ranks', () => {
  const tasks = [
    task(1, { status: 'completed', integration: 'merged' }),
    task(2, { status: 'running' }),
  ];
  const ranks = rankTasks(tasks, new Set());
  const before = ids(tasks), ranksBefore = ranks.get(2).effectiveRank;
  const out = orderSiblings(tasks, { mode: 'smart', ranks });
  expect(ids(tasks)).toEqual(before);
  expect(out).not.toBe(tasks);
  expect(ranks.get(2).effectiveRank).toBe(ranksBefore);
  expect(ids(out)).toEqual([2, 1]);
});

test('防环：parent 互指时不无限递归', () => {
  const tasks = [
    task(1, { parent_id: 2, status: 'running' }),
    task(2, { parent_id: 1, status: 'completed', integration: 'merged' }),
  ];
  const ranks = rankTasks(tasks, new Set());
  expect(ranks.size).toBe(2);
  expect(ranks.get(1).rank).toBe(1);
  expect(ranks.get(2).rank).toBe(3);
});

// orderList 是历史输入 / 规划任务 / 待定事项共用的排序；三种模式的口径必须固定住。
const row = (id, extra = {}) => ({ id, created_at: at(id), updated_at: at(id), ...extra });

test('orderList：smart 与未知 mode 原样返回入参数组本身', () => {
  const rows = [row(3), row(1), row(2)];
  expect(orderList(rows, { mode: 'smart' })).toBe(rows);
  expect(orderList(rows, { mode: 'nonsense' })).toBe(rows);
  expect(ids(orderList(rows, { mode: 'smart' }))).toEqual([3, 1, 2]);
  expect(orderList(undefined, { mode: 'smart' })).toEqual([]);
});

test('orderList：updated 按 timeOf 倒序，时间相同按 id 升序兜底', () => {
  const rows = [row(1, { planner_updated_at: at(1) }), row(2, { planner_updated_at: at(9) }), row(3, { planner_updated_at: at(5) })];
  const timeOf = entry => entry.planner_updated_at;
  expect(ids(orderList(rows, { mode: 'updated', timeOf }))).toEqual([2, 3, 1]);
  expect(ids(orderList([row(7, { planner_updated_at: at(5) }), row(2, { planner_updated_at: at(5) })], { mode: 'updated', timeOf }))).toEqual([2, 7]);
  // 不提供 timeOf 时退回 updated_at
  expect(ids(orderList([row(1), row(3)], { mode: 'updated' }))).toEqual([3, 1]);
});

test('orderList：id 新在前；缺时间字段当 0，次序仍确定', () => {
  const rows = [row(1), row(2), row(3), row(4)];
  expect(ids(orderList(rows, { mode: 'id' }))).toEqual([4, 3, 2, 1]);
  // 一条字段缺失、一条坏数据、一条合法：解析不出的都当 0，再按 id 升序固定住次序，不抛异常
  const mixed = [row(9, { updated_at: undefined }), row(5, { updated_at: 'not a date' }), row(7, { updated_at: at(3) })];
  expect(ids(orderList(mixed, { mode: 'updated' }))).toEqual([7, 5, 9]);
});

test('orderList：两种活动 mode 返回新数组，不修改入参', () => {
  const rows = [row(1), row(2)];
  const before = ids(rows);
  const out = orderList(rows, { mode: 'updated' });
  expect(ids(rows)).toEqual(before);
  expect(out).not.toBe(rows);
  expect(orderList(rows, { mode: 'smart' })).toBe(rows);
});
