import { test, expect } from 'bun:test';
import { repo } from '../helpers.js';
import { PARAMS, USER_ONLY, AGENT_ONLY } from '../../src/rpc/registry.js';
import { graphLayout, nodeMarks } from '../../src/ui/web/assets/graph-layout.js';
import { fetch, pageSource, setup } from './harness.js';

// graph.get 的权限、/api/graph 的形状，以及页面确实带上了分支图入口与模块。

test('graph.get is read-only and readable by both user and agent', async () => {
  expect(PARAMS['graph.get']).toEqual([]);
  expect(USER_ONLY.has('graph.get')).toBe(false);
  expect(AGENT_ONLY.has('graph.get')).toBe(false);
  expect(PARAMS['branch.merge']).toEqual(['branch']);
  expect(PARAMS['branch.sync']).toEqual(['branch']);
  expect(PARAMS['branch.catchup']).toEqual(['branch']);
  expect(USER_ONLY.has('branch.merge')).toBe(true);
  expect(USER_ONLY.has('branch.sync')).toBe(true);
  expect(USER_ONLY.has('branch.catchup')).toBe(true);
  expect(PARAMS['branch.archive']).toEqual(['branch', 'discard']);
  expect(USER_ONLY.has('branch.archive')).toBe(true);
  expect(AGENT_ONLY.has('branch.archive')).toBe(false);
  const f = await setup();
  try {
    await repo(f.root);
    const response = await fetch(f.url + '/api/graph');
    expect(response.status).toBe(200);
    const graph = await response.json();
    expect(Object.keys(graph).sort()).toEqual(['current_branch', 'edges', 'error', 'generated_at', 'git', 'nodes', 'truncated'].sort());
    expect(graph.git).toBe(true);
    expect(graph.error).toBeNull();
    expect(graph.current_branch).toBe('main');
    expect(graph.truncated).toBe(false);
    expect(Array.isArray(graph.nodes)).toBe(true);
    expect(Array.isArray(graph.edges)).toBe(true);
  } finally { await f.close(); }
});

test('web serves the branch-graph modules and wires the header entry', async () => {
  const f = await setup();
  try {
    const html = await (await fetch(f.url)).text();
    expect(html).toContain('id="graph-open"');
    expect(html).toContain('分支图');
    for (const file of ['/graph-layout.js', '/render-graph.js']) {
      const response = await fetch(f.url + file);
      expect(response.status).toBe(200);
    }
    expect(await (await fetch(f.url + '/graph-layout.js')).text()).toContain('export function graphLayout');
    const app = await pageSource(f.url);
    expect(app).toContain("from './render-graph.js'");
    expect(app).toContain("from './graph-layout.js'");
  } finally { await f.close(); }
});

// 纯函数：归档状态透传与 archivable 判断（不碰 DOM、不拉数据）。
const branchNode = (name, extra = {}) => ({ kind: 'branch', id: `branch:${name}`, name, tracked: true, current: false, placeholder: false, ...extra });

const layoutOf = nodes => graphLayout({ current_branch: 'main', nodes, edges: [] });
const entryOf = (nodes, name) => layoutOf(nodes).forest.find(entry => entry.name === name);

test('graphLayout 只画没归档的分支：归档记录还在 graph.js 的返回里，但不占分支树', () => {
  const nodes = [
    branchNode('lush/x/6-old', { archived: true, archived_at: '2024-01-01T00:00:00.000Z', status: 'archived', head_commit: null }),
    branchNode('lush/x/1-fresh', { status: 'ready', head_commit: 'aaa' }),
  ];
  const layout = layoutOf(nodes);
  // 归档的分支不画（记录在 branch show / 事件 / 任务详情里）。
  expect(layout.forest.map(entry => entry.name)).toEqual(['lush/x/1-fresh']);
  // 没归档的分支照旧带 archived: false，渲染器不再需要特判归档。
  expect(layout.forest[0]).toMatchObject({ archived: false, archived_at: null });
});

test('graphLayout marks a branch archivable only when nothing blocks the archive', () => {
  const nodes = [
    // 当前检出：不能把自己归档掉。
    branchNode('main', { current: true, head_commit: 'aaa' }),
    // 已登记、任务都结束、ref 还在：可归档。
    branchNode('lush/x/1-done', { status: 'ready', head_commit: 'bbb', tasks: { total: 1, active: 0, failed: 0, completed: 1 } }),
    // 自己或后代还有活动任务：先收活。
    branchNode('lush/x/2-busy', { status: 'active', head_commit: 'ccc', tasks: { total: 2, active: 1, failed: 0, completed: 1 } }),
    // ref 与 worktree 都已经不在：没什么可归档的。
    branchNode('lush/x/3-gone', { status: 'ready', head_commit: null, worktree_state: 'missing' }),
    // ref 没了但 worktree 还在：仍然有东西可删。
    branchNode('lush/x/4-worktree', { status: 'ready', head_commit: null, worktree_state: 'present' }),
    // 只有本地 ref、branches 表里没有记录：先 import 才谈得上归档。
    branchNode('lush/x/5-local', { tracked: false, head_commit: 'ddd' }),
    // 已归档：不再给归档动作。
    branchNode('lush/x/6-old', { archived: true, status: 'archived', head_commit: null }),
  ];
  const layout = layoutOf(nodes);
  const byName = new Map(layout.forest.map(entry => [entry.name, entry]));
  expect(byName.get('lush/x/1-done').archivable).toBe(true);
  expect(byName.get('lush/x/4-worktree').archivable).toBe(true);
  expect(byName.get('main').archivable).toBe(false);
  expect(byName.get('lush/x/2-busy').archivable).toBe(false);
  expect(byName.get('lush/x/3-gone').archivable).toBe(false);
  expect(byName.get('lush/x/5-local').archivable).toBe(false);
  // 已归档：它根本不会画进分支树，所以也谈不上「可归档」。
  expect(byName.has('lush/x/6-old')).toBe(false);
});

test('nodeMarks reports an archived task instead of a missing branch', () => {
  expect(nodeMarks({ archived: true, branch: 'lush/x/1-one', branch_state: 'missing', merged: false }))
    .toEqual([{ text: '未合并', className: '' }, { text: '已归档', className: '' }]);
  // 没有归档字段的任务照旧报缺失分支。
  expect(nodeMarks({ branch: 'lush/x/1-one', branch_state: 'missing' }))
    .toEqual([{ text: '⚠ 缺失分支', className: 'warn' }]);
});

// 「已合并」是常态，分支图里不再有它的标签；只有「未合并」还留着。
test('nodeMarks 不再输出「已合并」，未合并标记保留', () => {
  expect(nodeMarks({ merged: true, branch: 'lush/x/1-one' })).toEqual([]);
  expect(nodeMarks({ merged: true, current: true, branch: 'lush/x/1-one' }))
    .toEqual([{ text: '当前检出', className: '' }]);
  expect(nodeMarks({ merged: false, branch: 'lush/x/1-one' })).toEqual([{ text: '未合并', className: '' }]);
  // 整张图的标记文本集合里不再有这四个字。
  const all = [{ merged: true }, { merged: false }, { archived: true }].flatMap(node => nodeMarks(node));
  expect(all.some(mark => mark.text.includes('已合并'))).toBe(false);
});
