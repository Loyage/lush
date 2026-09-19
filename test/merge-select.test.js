import { test, expect } from 'bun:test';
import {
  MERGEABLE_INTEGRATION, freezeBlocker, mergeCandidates, isMergeable, previewMergeOrder, ladderEdges,
} from '../src/ui/web/assets/merge-select.js';

/** 扁平任务表：字段与 store.summaries() 一致（含 status/integration/resolves_task_id/goal）。 */
const task = (id, extra = {}) => ({
  id, parent_id: null, verifies_task_id: null, resolves_task_id: null, goal: `任务 ${id}`,
  status: 'completed', integration: 'pending', ...extra,
});
const node = (id, extra = {}) => ({ id, level: 0, target_branch: 'main', covered_by: [], deps: [], ...extra });

test('可合并候选＝completed 且 integration 在 pending/review/conflict；其余一律排除', () => {
  const tasks = [
    task(1),
    task(2, { integration: 'review' }),
    task(3, { integration: 'conflict' }),
    task(4, { integration: 'merged' }),      // 已经合了
    task(5, { status: 'running' }),          // 还没干完
    task(6, { status: 'failed', integration: 'pending' }),
    task(7, { integration: 'none' }),
  ];
  const candidates = mergeCandidates(tasks, { nodes: tasks.map(row => node(row.id)) });
  expect(candidates.map(candidate => candidate.id)).toEqual([1, 2, 3]);
  expect([...MERGEABLE_INTEGRATION].sort()).toEqual(['conflict', 'pending', 'review']);
  expect(candidates.every(isMergeable)).toBe(true);
});

test('新交付队列直接采用后端的唯一来源、阶段与 blockers', () => {
  const groups = [{ target_branch: 'main', items: [
    { id: 8, source_task_id: 13, goal: '冲突改动', target_branch: 'main', phase: 'resolution_ready', ready: true, blockers: [] },
    { id: 9, source_task_id: 9, goal: '代码下游', target_branch: 'main', phase: 'awaiting_review', ready: false, selectable: true,
      blockers: [{ code: 'code_upstream', task_id: 7, message: '先把基线任务 #7 落地' }] },
  ] }];
  const candidates = mergeCandidates([], { groups });
  expect(candidates.map(row => [row.id, row.merge_id, row.phase, isMergeable(row)])).toEqual([
    [8, 13, 'resolution_ready', true], [9, 9, 'awaiting_review', true],
  ]);
});

test('冻结规则与运行时 approveMerge 一致：别的未解决冲突冻结同一目标分支', () => {
  // status.merge_freeze 的行同时有 id 与 task_id（都是冲突任务的 id）。
  const freeze = [{ id: 9, task_id: 9, target_branch: 'main', resolves_task_id: 12 }];
  // 同一分支上的普通任务被 #9 冻结。
  expect(freezeBlocker('main', task(1), freeze)).toMatchObject({ task_id: 9 });
  // 冲突就是我自己（重试）、我是它的解冲突任务、它为我这次落地服务：三种都不算冻结自己。
  expect(freezeBlocker('main', task(9), freeze)).toBeNull();
  expect(freezeBlocker('main', task(12), freeze)).toBeNull();
  expect(freezeBlocker('main', task(1, { resolves_task_id: 9 }), freeze)).toBeNull();
  // 不同目标分支互不影响。
  expect(freezeBlocker('release', task(1), freeze)).toBeNull();
  expect(freezeBlocker(null, task(1), freeze)).toBeNull();
});

test('候选带上目标分支、层级与被覆盖关系，冻结的标出是谁冻的', () => {
  const tasks = [task(1), task(2), task(3)];
  const nodes = [
    node(1, { level: 0, covered_by: [2] }),
    node(2, { level: 1, deps: [{ id: 1, kind: 'code' }] }),
    node(3, { level: 0, target_branch: 'release' }),
  ];
  const freeze = [{ id: 3, task_id: 3, target_branch: 'main', resolves_task_id: null }];
  const candidates = mergeCandidates(tasks, { nodes, freeze });
  expect(candidates.map(candidate => [candidate.id, candidate.level, candidate.target_branch, candidate.covered_by, candidate.frozen_by]))
    .toEqual([[1, 0, 'main', [2], 3], [2, 1, 'main', [], 3], [3, 0, 'release', [], null]]);
  expect(candidates.filter(isMergeable).map(candidate => candidate.id)).toEqual([3]);
});

test('候选按 id 升序，阶梯里没有的候选目标分支未知但不被当成冻结', () => {
  const candidates = mergeCandidates([task(5), task(1)], { nodes: [node(1)], freeze: [{ task_id: 9, target_branch: 'main' }] });
  expect(candidates.map(candidate => candidate.id)).toEqual([1, 5]);
  expect(candidates[1]).toMatchObject({ target_branch: null, frozen_by: null });
});

test('顺序预览与运行时 mergeOrder 同规则：只按 code 上游、并列按 id 升序', () => {
  // 3 的代码基线是 1；5 对 3 只是执行依赖，不改变交付顺序。
  const edges = [
    { task_id: 3, depends_on: 1, kind: 'code' },
    { task_id: 5, depends_on: 3, kind: 'order' },
  ];
  expect(previewMergeOrder([5, 3, 1, 2], edges)).toEqual([1, 2, 3, 5]);
  // 依赖优先于 id：下游 id 更小也要排后面
  expect(previewMergeOrder([1, 3], [{ task_id: 1, depends_on: 3, kind: 'code' }])).toEqual([3, 1]);
  // 集合外的上游不参与排序
  expect(previewMergeOrder([3, 1], [{ task_id: 3, depends_on: 9, kind: 'code' }])).toEqual([1, 3]);
  // 去重且确定性
  expect(previewMergeOrder([4, 4, 2, 6], [])).toEqual([2, 4, 6]);
  expect(previewMergeOrder([9, 1], [{ task_id: 1, depends_on: 9, kind: 'order' }])).toEqual([1, 9]);
  expect(previewMergeOrder([], [])).toEqual([]);
});

test('ladderEdges 把阶梯节点的依赖展成预览用的边', () => {
  const nodes = [node(2, { deps: [{ id: 1, kind: 'code' }, { id: 3, kind: 'order', merged: true }] }), node(4)];
  expect(ladderEdges(nodes)).toEqual([
    { task_id: 2, depends_on: 1, kind: 'code' },
    { task_id: 2, depends_on: 3, kind: 'order' },
  ]);
  expect(ladderEdges()).toEqual([]);
});

test('阶梯依赖与运行时一起呈现出 code 链的合并顺序', () => {
  const nodes = [
    node(1, { level: 0 }),
    node(2, { level: 1, deps: [{ id: 1, kind: 'code' }] }),
    node(3, { level: 2, deps: [{ id: 2, kind: 'code' }] }),
  ];
  const selected = [3, 1, 2];
  expect(previewMergeOrder(selected, ladderEdges(nodes))).toEqual([1, 2, 3]);
});
