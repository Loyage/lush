import { test, expect } from 'bun:test';
import { graphLayout, graphRenderKey, emphasisClasses, isBranchCollapsed, isWorkingTask, workingState } from '../../src/ui/web/assets/graph-layout.js';

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
const forkEdge = (from, to, status, extra = {}) => ({ kind: 'fork', from: `branch:${from}`, to: `branch:${to}`, status, ahead: 0, behind: 0, ...extra });
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

// 「没合进父分支」「正在工作中」的纯判断：强调 class、默认展开、用户显式切换的优先级都只在这里算，
// DOM 只消费结果（见 test/web/dom-graph.test.js）。
const layoutIndex = layout => {
  const byName = new Map();
  const visit = entry => { byName.set(entry.name, entry); for (const child of entry.children) visit(child); };
  for (const root of layout.forest) visit(root);
  return byName;
};

const emphasisGraph = () => ({
  current_branch: 'main',
  nodes: [
    // 当前检出：自己没任务，下面挂着四种关系的子分支。
    branch('main', { current: true, status: 'active', tasks: { total: 2, active: 1, failed: 0, completed: 1 } }),
    // 已合进父分支、任务都结束：不强调，默认收起。
    branch('lush/x/done', { status: 'ready' }), task(1, 'lush/x/done', { merged: true }),
    // 没合进父分支：强调 + 默认展开。
    branch('lush/x/ahead', { status: 'ready' }), task(2, 'lush/x/ahead', { merged: false }),
    branch('lush/x/diverged', { status: 'ready' }), task(3, 'lush/x/diverged', { merged: false }),
    // 在跑（汇总 active + running 任务）：强调 + 默认展开。
    branch('lush/x/busy', { status: 'active', tasks: { total: 1, active: 1, failed: 0, completed: 0 } }),
    task(4, 'lush/x/busy', { status: 'running', merged: false }),
    // 另一棵根：自己既没未合并也没在跑，但后代没合进父分支——也要默认展开。
    branch('feature'), branch('feature/legacy'), task(5, 'feature/legacy', { merged: false }),
  ],
  edges: [
    forkEdge('main', 'lush/x/done', 'integrated'),
    forkEdge('main', 'lush/x/ahead', 'fast_forward', { ahead: 1 }),
    forkEdge('main', 'lush/x/diverged', 'diverged', { ahead: 1, behind: 2 }),
    forkEdge('main', 'lush/x/busy', 'integrated'),
    forkEdge('feature', 'feature/legacy', 'diverged', { ahead: 1, behind: 1 }),
  ],
});

test('归档的分支不占分支树：自己与名下任务都不画，后代接到最近的可见祖先上', () => {
  const graph = {
    current_branch: 'main',
    nodes: [
      branch('main', { current: true }),
      // 归档：ref 是归档时按预期删掉的；这条分支与它名下的任务都不再画在分支树上。
      branch('lush/x/archived', { head_commit: null, archived: true, archived_at: '2026-09-20T12:39:43.503Z', status: 'archived' }),
      task(7, 'lush/x/archived'),
      // 归档分支的后代还活着（历史遗留：归档曾经只删自己一条）：升到最近的非归档祖先下，不跟着消失。
      branch('lush/x/orphan', { head_commit: 'bbb' }),
      branch('lush/x/orphan-gone', { head_commit: null }),
      // 真·缺失：谁都没归档，子分支的 ref 不见了——这种才是要用户去查的。
      branch('lush/x/broken', { head_commit: null }),
    ],
    edges: [
      { kind: 'fork', from: 'branch:main', to: 'branch:lush/x/archived', status: 'missing', ahead: null, behind: null },
      { kind: 'fork', from: 'branch:lush/x/archived', to: 'branch:lush/x/orphan', status: 'missing', ahead: null, behind: null },
      { kind: 'fork', from: 'branch:lush/x/archived', to: 'branch:lush/x/orphan-gone', status: 'missing', ahead: null, behind: null },
      { kind: 'fork', from: 'branch:main', to: 'branch:lush/x/broken', status: 'missing', ahead: null, behind: null },
    ],
  };
  const layout = graphLayout(graph);
  const byName = layoutIndex(layout);
  // 归档节点自己不在森林里，它名下的任务也不画。
  expect(byName.has('lush/x/archived')).toBe(false);
  const taskIds = [];
  const collect = entry => { taskIds.push(...entry.tasks.map(node => node.id)); entry.children.forEach(collect); };
  layout.forest.forEach(collect);
  expect(taskIds).not.toContain(7);
  // 后代升到 main 下，并带着中性的「父分支已归档」，不是红色的「分支缺失」。
  expect(names(layout.forest[0].children)).toContain('lush/x/orphan');
  expect(byName.get('lush/x/orphan').relation).toEqual({ key: 'parent_archived', label: '父分支已归档' });
  expect(byName.get('lush/x/orphan-gone').relation).toEqual({ key: 'parent_archived', label: '父分支已归档' });
  // 没有可合的对象，就不算「未合进父分支」——强调与默认展开都不该被它触发。
  expect([byName.get('lush/x/orphan').unmerged, byName.get('lush/x/orphan').defaultExpanded]).toEqual([false, false]);
  // 谁都没归档、ref 真的不见：保持原来的「分支缺失」。
  expect(byName.get('lush/x/broken').relation).toEqual({ key: 'missing', label: '分支缺失' });
  expect(byName.get('lush/x/broken').unmerged).toBe(true);
});

test('强调判断：没合进父分支 / 正在工作的分支强调，根分支与已合进的不强调', () => {
  const byName = layoutIndex(graphLayout(emphasisGraph()));
  // 没合进父分支（fast_forward / diverged）强调；integrated 与根分支不强调。
  expect([byName.get('lush/x/done').unmerged, byName.get('lush/x/done').working]).toEqual([false, false]);
  expect([byName.get('lush/x/ahead').unmerged, byName.get('lush/x/ahead').working]).toEqual([true, false]);
  expect([byName.get('lush/x/diverged').unmerged, byName.get('lush/x/diverged').working]).toEqual([true, false]);
  // 已合进父分支但在跑：只有工作态强调。
  expect([byName.get('lush/x/busy').unmerged, byName.get('lush/x/busy').working]).toEqual([false, true]);
  // 根分支没有父分支可合，永远不算「没合进父分支」；但有在跑的后代就是「工作中」。
  expect([byName.get('main').unmerged, byName.get('main').working]).toEqual([false, true]);
  expect([byName.get('feature').unmerged, byName.get('feature').working]).toEqual([false, false]);
  expect(byName.get('feature/legacy').unmerged).toBe(true);

  // 强调 class：可同时命中，顺序固定。
  expect(emphasisClasses(byName.get('lush/x/done'))).toEqual([]);
  expect(emphasisClasses(byName.get('lush/x/ahead'))).toEqual(['graph-emphasis-unmerged']);
  expect(emphasisClasses(byName.get('lush/x/busy'))).toEqual(['graph-emphasis-working']);
  expect(emphasisClasses(byName.get('main'))).toEqual(['graph-emphasis-working']);
  // 同时命中：没合进父分支 + 自己就有在跑的任务。
  expect(emphasisClasses({ unmerged: true, working: true })).toEqual(['graph-emphasis-unmerged', 'graph-emphasis-working']);
});

test('默认折叠：自己或后代命中强调就默认展开，其余默认收起；用户显式切换优先', () => {
  const byName = layoutIndex(graphLayout(emphasisGraph()));
  const collapsed = (name, expanded = new Set(), explicit = new Set()) =>
    isBranchCollapsed(byName.get(name), expanded, explicit);
  // 已合进父分支、任务都结束：默认收起。
  expect(collapsed('lush/x/done')).toBe(true);
  // 没合进父分支 / 在跑：默认展开。
  expect(collapsed('lush/x/ahead')).toBe(false);
  expect(collapsed('lush/x/busy')).toBe(false);
  // 自己不强调，但后代没合进父分支：也不许收起（否则会把未合并的子树一起藏掉）。
  expect(collapsed('feature')).toBe(false);
  expect(byName.get('feature').defaultExpanded).toBe(true);
  expect(byName.get('lush/x/done').defaultExpanded).toBe(false);
  // 显式展开一个默认收起的分支：重画后仍然展开。
  expect(collapsed('lush/x/done', new Set(['lush/x/done']))).toBe(false);
  // 显式收起一个默认展开的分支：重画后仍然收起。
  expect(collapsed('lush/x/ahead', new Set(), new Set(['lush/x/ahead']))).toBe(true);
  // 两个集合同时有时，显式展开优先（最近一次操作会同时维护两个集合）。
  expect(collapsed('lush/x/ahead', new Set(['lush/x/ahead']), new Set(['lush/x/ahead']))).toBe(false);
});

test('工作态判定只认 running / queued / waiting / awaiting', () => {
  for (const status of ['running', 'queued', 'waiting', 'awaiting']) expect(isWorkingTask({ status })).toBe(true);
  for (const status of ['completed', 'failed', 'cancelled', undefined]) expect(isWorkingTask({ status })).toBe(false);
});

// workingState 只回答「这条分支怎么显示工作态」，不改 working / defaultExpanded / emphasisClasses 的语义。
const workGraph = () => ({
  current_branch: 'main',
  nodes: [
    branch('main', { current: true, status: 'active' }),
    // 自己就在跑：最直接的「现在真的在动」。
    branch('lush/x/run', { status: 'active' }),
    task(1, 'lush/x/run', { status: 'running' }), task(2, 'lush/x/run', { status: 'running' }),
    // 自己在等（awaiting + queued）：标签取优先级最高的「等你决定」。
    branch('lush/x/pending', { status: 'active' }),
    task(3, 'lush/x/pending', { status: 'awaiting' }), task(4, 'lush/x/pending', { status: 'queued' }),
    // 自己的任务都结束了，只有子树里的后代在跑。
    branch('lush/x/parent', { status: 'ready' }),
    task(5, 'lush/x/parent', { status: 'completed' }),
    branch('lush/x/parent/sub', { status: 'active' }),
    task(6, 'lush/x/parent/sub', { status: 'running' }),
    // 真正停下来的分支：自己与后代都没有工作态任务。
    branch('lush/x/idle', { status: 'merged' }),
    task(7, 'lush/x/idle', { status: 'completed' }),
  ],
  edges: [
    forkEdge('main', 'lush/x/run', 'integrated', { ahead: 0 }),
    forkEdge('main', 'lush/x/pending', 'integrated', { ahead: 0 }),
    forkEdge('main', 'lush/x/parent', 'integrated', { ahead: 0 }),
    forkEdge('lush/x/parent', 'lush/x/parent/sub', 'integrated', { ahead: 0 }),
    forkEdge('main', 'lush/x/idle', 'integrated', { ahead: 0 }),
  ],
});

test('workingState：自己 running / 自己在等 / 只有子树在跑 / 停下来了', () => {
  const byName = layoutIndex(graphLayout(workGraph()));
  // ① 本分支自己的任务里有 running：label「工作中」，count 是 running 任务数。
  expect(workingState(byName.get('lush/x/run'))).toEqual({ key: 'running', label: '工作中', count: 2 });
  // ② 自己没有 running 但在等：label 取优先级最高者，count 是自己的工作态任务数。
  expect(workingState(byName.get('lush/x/pending'))).toEqual({ key: 'pending', label: '等你决定', count: 2 });
  // ③ 自己什么都没有、后代子树里有：count 是后代子树里的工作态任务数。
  expect(workingState(byName.get('lush/x/parent'))).toEqual({ key: 'subtree', label: '子树工作中', count: 1 });
  // ④ 都没有：null，说明这条分支停下来了。
  expect(workingState(byName.get('lush/x/idle'))).toBeNull();
  // 根分支自己没有任务，后代在跑：按子树口径显示。
  expect(workingState(byName.get('main'))).toEqual({ key: 'subtree', label: '子树工作中', count: 5 });
  // 原有语义不变：working 仍是「自己或后代有工作态任务」，强调 class 顺序不变。
  expect(byName.get('lush/x/idle').working).toBe(false);
  expect(emphasisClasses(byName.get('lush/x/idle'))).toEqual([]);
  expect(byName.get('lush/x/run').working).toBe(true);
  expect(emphasisClasses(byName.get('lush/x/run'))).toEqual(['graph-emphasis-working']);
});

test('workingState：running 优先于在等，在等内部按 等你决定 > 等子任务 > 排队中 取标签', () => {
  const of = tasks => workingState({ tasks });
  expect(of([{ status: 'awaiting' }, { status: 'running' }])).toEqual({ key: 'running', label: '工作中', count: 1 });
  expect(of([{ status: 'awaiting' }, { status: 'waiting' }, { status: 'queued' }])).toEqual({ key: 'pending', label: '等你决定', count: 3 });
  expect(of([{ status: 'waiting' }, { status: 'queued' }])).toEqual({ key: 'pending', label: '等子任务', count: 2 });
  expect(of([{ status: 'queued' }])).toEqual({ key: 'pending', label: '排队中', count: 1 });
  // 停下来的状态一个都不算工作态。
  expect(of([{ status: 'completed' }, { status: 'failed' }, { status: 'cancelled' }])).toBeNull();
  // 坏数据不炸：没有 tasks 字段的分支当作停下来。
  expect(workingState({})).toBeNull();
});

// 强调与默认折叠都从这几个字段派生：它们一变就必须重画，否则 1.5s 轮询会把旧强调留在页面上。
test('graphRenderKey 覆盖 incoming status / 分支汇总 status / 任务 status', () => {
  const build = ({ edgeStatus = 'integrated', branchStatus = 'ready', taskStatus = 'completed' } = {}) => ({
    nodes: [
      branch('main', { current: true }),
      branch('lush/x/a', { status: branchStatus }),
      task(1, 'lush/x/a', { status: taskStatus }),
    ],
    edges: [forkEdge('main', 'lush/x/a', edgeStatus)],
  });
  const key = graphRenderKey(build());
  // 同一份数据指纹相同：重画幂等。
  expect(graphRenderKey(build())).toBe(key);
  // fork 边从 integrated 变成 fast_forward：未合并强调与默认展开都要跟着变。
  expect(graphRenderKey(build({ edgeStatus: 'fast_forward' }))).not.toBe(key);
  // 分支汇总从 ready 变成 active：工作态强调要跟着变。
  expect(graphRenderKey(build({ branchStatus: 'active' }))).not.toBe(key);
  // 任务从 completed 变成 running：任务行与所在分支的工作态强调都要跟着变。
  expect(graphRenderKey(build({ taskStatus: 'running' }))).not.toBe(key);
  // 任务在 awaiting 与 queued 之间切换：工作态文案（等你决定 / 排队中）也要跟着变，不能沿用上一张图。
  expect(graphRenderKey(build({ taskStatus: 'awaiting' }))).not.toBe(graphRenderKey(build({ taskStatus: 'queued' })));
});
