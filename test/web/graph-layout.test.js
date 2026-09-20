import { test, expect } from 'bun:test';
import { graphLayout } from '../../src/ui/web/assets/graph-layout.js';

// graphLayout 的纯逻辑：同一层级的迭代方向必须统一为「新的在前」——
// 兄弟分支按 created_at 从新到旧（未知时间排在已知时间之后），同一分支下同 level 的任务按 id 降序；
// level 不同的仍按 level 升序（上游 stack 靠前）。这里不碰 DOM，直接断言布局结果的顺序。

const branch = (name, extra = {}) => ({
  kind: 'branch', id: `branch:${name}`, name, head_commit: 'aaa',
  current: false, tracked: true, placeholder: false, created_at: null, ...extra,
});
const task = (id, branchName, extra = {}) => ({
  kind: 'task', id, role: 'worker', name: `t${id}`, goal: `任务 ${id}`,
  status: 'completed', integration: 'none', branch: branchName, target_branch: 'main', ...extra,
});
const fork = (from, to) => ({ kind: 'fork', from: `branch:${from}`, to: `branch:${to}` });
const code = (from, to) => ({ kind: 'code', from, to });
const names = items => items.map(item => item.name);

test('兄弟分支按创建时间从新到旧；当前检出仍第一；没有创建时间的排在已知时间之后', () => {
  const graph = {
    current_branch: 'main',
    nodes: [
      branch('main', { current: true, created_at: '2026-01-01T00:00:00.000Z' }),
      branch('lush/x/old', { created_at: '2026-02-01T00:00:00.000Z' }),
      branch('lush/x/mid', { created_at: '2026-03-01T00:00:00.000Z' }),
      branch('lush/x/new', { created_at: '2026-04-01T00:00:00.000Z' }),
      branch('lush/x/undated'),
      // 另一棵根：时间介于 old 与 mid 之间，root 层也应新在前。
      branch('other-root', { created_at: '2026-02-15T00:00:00.000Z' }),
    ],
    edges: [
      fork('main', 'lush/x/old'), fork('main', 'lush/x/mid'),
      fork('main', 'lush/x/new'), fork('main', 'lush/x/undated'),
    ],
  };
  const layout = graphLayout(graph);
  // 根层：当前检出最前，其余按创建时间降序；没有时间的根排在后面并靠分支名兜底。
  expect(names(layout.forest)).toEqual(['main', 'other-root']);
  // 同一父分支下：new → mid → old → undated（未知时间排在已知时间之后）。
  expect(names(layout.forest[0].children)).toEqual(['lush/x/new', 'lush/x/mid', 'lush/x/old', 'lush/x/undated']);
  // 可重复：同一份数据每次渲染顺序一致。
  expect(names(graphLayout(graph).forest[0].children)).toEqual(names(layout.forest[0].children));
});

test('未知创建时间的兄弟分支排在已知时间之后，并按分支名升序兜底', () => {
  const graph = {
    current_branch: 'main',
    nodes: [
      branch('main', { current: true, created_at: '2026-01-01T00:00:00.000Z' }),
      branch('z-undated'),
      branch('a-undated'),
      branch('dated', { created_at: '2026-02-01T00:00:00.000Z' }),
    ],
    edges: [fork('main', 'z-undated'), fork('main', 'a-undated'), fork('main', 'dated')],
  };
  const layout = graphLayout(graph);
  expect(names(layout.forest[0].children)).toEqual(['dated', 'a-undated', 'z-undated']);
});

test('同一分支下同 level 的任务按 id 降序（新在前），level 更高的仍排在后面', () => {
  const graph = {
    current_branch: 'main',
    nodes: [
      branch('main', { current: true, created_at: '2026-01-01T00:00:00.000Z' }),
      branch('lush/x/a', { created_at: '2026-02-01T00:00:00.000Z' }),
      task(1, 'lush/x/a'), task(2, 'lush/x/a'), task(3, 'lush/x/a'),
      // #4 依赖 #1：level 1，必须排在三个 level 0 的任务之后。
      task(4, 'lush/x/a'),
    ],
    edges: [fork('main', 'lush/x/a'), code(1, 4)],
  };
  const layout = graphLayout(graph);
  const tasks = layout.forest[0].children[0].tasks;
  expect(tasks.map(node => node.id)).toEqual([3, 2, 1, 4]);
  // level / 上游 / 标记等信息不因为排序改变而丢失。
  expect(tasks.map(node => node.level)).toEqual([0, 0, 0, 1]);
  expect(tasks.find(node => node.id === 4).upstreams).toEqual([1]);
  expect(tasks.find(node => node.id === 4).marks).toBeArray();
});

test('unplaced 分组内同样 level 升序 + id 降序', () => {
  const graph = {
    current_branch: 'main',
    nodes: [
      branch('main', { current: true, created_at: '2026-01-01T00:00:00.000Z' }),
      // 目标分支在图上没有节点：这两个任务落进 unplaced。
      task(1, null, { target_branch: 'ghost' }), task(2, null, { target_branch: 'ghost' }), task(3, null, { target_branch: 'ghost' }),
    ],
    edges: [],
  };
  const layout = graphLayout(graph);
  expect(layout.unplaced).toHaveLength(1);
  expect(layout.unplaced[0].target_branch).toBe('ghost');
  expect(layout.unplaced[0].items.map(node => node.id)).toEqual([3, 2, 1]);
});
