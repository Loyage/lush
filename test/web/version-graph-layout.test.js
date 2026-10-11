import { test, expect } from 'bun:test';
import { versionGraphLayout, versionGraphPath } from '../../src/ui/web/assets/version-graph-layout.js';

const row = (commit, parents = []) => ({ commit, parents });
const graph = () => [row('merge', ['left', 'right']), row('right', ['root']), row('left', ['root']), row('root')];

test('Git 分叉与汇合严格沿 parents 而不是相邻行', () => {
  const layout = versionGraphLayout(graph());
  expect(layout.edges.map(edge => [edge.child, edge.parent])).toEqual([
    ['merge', 'left'], ['merge', 'right'], ['right', 'root'], ['left', 'root'],
  ]);
  expect(layout.rows.map(row => row.lane)).toEqual([0, 1, 0, 1]);
  expect(layout.rows[1].segments.some(segment => segment.parent === 'left' && segment.from.anchor === 'top' && segment.to.anchor === 'bottom')).toBe(true);
  expect(layout.rows[2].segments.some(segment => segment.parent === 'root' && segment.from.lane !== segment.to.lane)).toBe(true);
  expect(layout.boundaries).toHaveLength(0); expect(layout.lanes).toBe(2);
});

test('拓扑分页的已读泳道稳定，未知父边延伸到明确边界', () => {
  const full = versionGraphLayout(graph()), first = versionGraphLayout(graph().slice(0, 2));
  expect(first.rows).toEqual(full.rows.slice(0, 2));
  expect(first.boundaries).toEqual([{ parent: 'left', lane: 0 }, { parent: 'root', lane: 1 }]);
  expect(first.edges.filter(edge => edge.boundary).map(edge => edge.parent)).toEqual(['left', 'root']);
  expect(first.edges.find(edge => edge.parent === 'right').boundary).toBe(false);
  expect(full.edges.every(edge => edge.to.row > edge.from.row)).toBe(true);
});

test('范围外的共同父只占一条泳道；不会造一个 Git 提交节点', () => {
  const layout = versionGraphLayout([row('a', ['outside']), row('b', ['outside'])]);
  expect(layout.rows).toHaveLength(2);
  expect(layout.boundaries).toEqual([{ parent: 'outside', lane: 0 }]);
  expect(layout.edges).toHaveLength(2);
  expect(layout.edges.every(edge => edge.to.row === null && edge.boundary)).toBe(true);
});

test('线性图、独立根提交和空图不伪造邻接连线', () => {
  const linear = versionGraphLayout([row('a', ['b']), row('b', ['c']), row('c')]);
  expect(linear.lanes).toBe(1); expect(linear.boundaries).toHaveLength(0);
  expect(linear.rows[0].segments[0]).toMatchObject({ parent: 'b', from: { anchor: 'node' }, to: { anchor: 'bottom' } });
  expect(linear.rows[2].segments[0]).toMatchObject({ parent: 'c', from: { anchor: 'top' }, to: { anchor: 'node' } });
  expect(versionGraphLayout([row('x'), row('y')]).edges).toHaveLength(0);
  expect(versionGraphLayout([])).toEqual({ rows: [], edges: [], boundaries: [], lanes: 1, width: 32 });
});

test('多父合并保留所有真实边，复用空槽但不移动活动泳道', () => {
  const layout = versionGraphLayout([row('octopus', ['a', 'b', 'c']), row('b'), row('a', ['root']), row('c', ['root']), row('root')]);
  expect(layout.edges.filter(edge => edge.child === 'octopus')).toHaveLength(3);
  expect(layout.rows.map(row => row.lane)).toEqual([0, 1, 0, 2, 0]);
  expect(layout.boundaries).toHaveLength(0); expect(layout.lanes).toBe(3);
});

test('不依赖 Worker 标签、编号或 SHA 字符长度生成结构', () => {
  const a = 'a'.repeat(64), b = 'b'.repeat(64);
  const commits = [{ ...row(a, [b]), worker_number: 'W888-3' }, { ...row(b), worker_number: 'W999' }];
  expect(versionGraphLayout(commits).edges[0]).toMatchObject({ child: a, parent: b, boundary: false });
  expect(versionGraphLayout(commits).rows.map(row => row.lane)).toEqual([0, 0]);
  expect(commits[0].parents).toEqual([b]);
});

test('重复节点、循环与父先子后的数据明确拒绝', () => {
  expect(() => versionGraphLayout([row('a'), row('a')])).toThrow('重复提交');
  expect(() => versionGraphLayout([row('a', ['a'])])).toThrow('拓扑顺序');
  expect(() => versionGraphLayout([row('a'), row('b', ['a'])])).toThrow('拓扑顺序');
});

test('SVG线段坐标有界、直线与弯线只由泳道/锚点计算', () => {
  expect(versionGraphPath({ from: { lane: 0, anchor: 'top' }, to: { lane: 0, anchor: 'bottom' } })).toBe('M 16 0 L 16 100');
  expect(versionGraphPath({ from: { lane: 0, anchor: 'node' }, to: { lane: 1, anchor: 'bottom' } })).toBe('M 16 50 C 16 75 38 75 38 100');
});
