import { test, expect } from 'bun:test';
import { versionLineageLayout } from '../../src/ui/web/assets/version-lineage-layout.js';
import { lineageMappingPath } from '../../src/ui/web/assets/version-lineage-mappings.js';
const node = (commit, parents = []) => ({ commit, parents });
const mapping = (delivery_id, source_commit, commit, delivery_available = true) => ({ delivery_id, source_commit, commit, delivery_available });
const data = extra => ({ origin: node('origin'), commits: [node('c3', ['c2', 'external']), node('c2', ['c1']), node('c1', ['origin'])],
  deliveries: [mapping(3, 'c2', 'p1'), mapping(2, 'c2', 'p1'), mapping(4, 'c3', 'p1'), mapping(1, 'origin', 'p0'), mapping(5, 'c3', 'bad', false)], has_more: false, ...extra });

test('旧到新完整自身来源链，origin独立；同source/共享落点Event不丢、不制造节点', () => {
  const result = versionLineageLayout(data());
  expect(result.rows.map(r => r.commit.commit)).toEqual(['c1', 'c2', 'c3']);
  expect(result.origin.landings).toEqual(['p0']);
  expect(result.rows.map(r => r.landings)).toEqual([[], ['p1'], []]);
  expect(result.rows[1].deliveries.map(m => m.delivery_id)).toEqual([2, 3]);
  expect(result.rows[2].deliveries.map(m => m.delivery_id)).toEqual([4, 5]);
  expect(result.connections).toEqual([{ source: 'c2', landing: 'p1', events: [2, 3] }, { source: 'c3', landing: 'p1', events: [4] }, { source: 'origin', landing: 'p0', events: [1] }]);
  expect(result.rows[0].edges).toEqual([{ child: 'c1', parent: 'origin', boundary: false, external: false }]);
  expect(result.rows[2].edges[1]).toEqual({ child: 'c3', parent: 'external', boundary: true, external: true });
});
test('部分页不跨省略范围伪造origin实线；second parent外部信息不展开', () => {
  const result = versionLineageLayout(data({ commits: [node('c3', ['c2', 'external'])], has_more: true, deliveries: [] }));
  expect(result.omitted).toBe(true); expect(result.rows).toHaveLength(1);
  expect(result.rows[0].edges.every(e => e.boundary)).toBe(true); expect(result.origin.edges).toEqual([]);
});
test('多个落点、跨行共享与origin目标都有独立pair，缺证据不伪造连线', () => {
  const result = versionLineageLayout(data({ deliveries: [mapping(1, 'c2', 'p1'), mapping(2, 'c2', 'p2'),
    mapping(3, 'c3', 'p1'), mapping(4, 'c3', 'origin'), mapping(5, 'c3', 'bad', false)] }));
  expect(result.rows.flatMap(r => r.landings)).toEqual(['p1', 'p2']);
  expect(result.connections.map(c => [c.source, c.landing])).toEqual([['c2', 'p1'], ['c2', 'p2'], ['c3', 'p1'], ['c3', 'origin']]);
});
test('实际节点坐标驱动跨轨/跨行路径，origin自映射是非零收据loop而不造commit', () => {
  expect(lineageMappingPath({ x: 280, y: 800 }, { x: 12, y: 300 }, 250)).toBe('M 280 800 H 250 V 300 H 12');
  expect(lineageMappingPath({ x: 12, y: 24 }, { x: 12, y: 24 }, 4)).toBe('M 12 24 C 22 8 2 8 12 24');
});
test('origin无开发和无新landing均保留锚点但不造重复父节点', () => {
  const result = versionLineageLayout(data({ commits: [], deliveries: [mapping(1, 'origin', 'origin'), mapping(2, 'origin', 'origin')] }));
  expect(result.origin.landings).toEqual([]); expect(result.origin.deliveries).toHaveLength(2); expect(result.rows).toEqual([]);
  expect(result.connections).toEqual([{ source: 'origin', landing: 'origin', events: [1, 2] }]);
});
