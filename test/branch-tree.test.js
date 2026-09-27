import { test, expect } from 'bun:test';
import { buildForest, parentOf, childrenOf, ancestorsOf, descendantsOf, rootOf, chainOf, pruneHidden } from '../src/core/genealogy.js';

const rows = [
  { branch: 'main', parent: null },
  { branch: 'ap/a', parent: 'main', created_at: '2024-01-01T00:00:00.000Z' },
  { branch: 'ap/b', parent: 'ap/a', created_at: '2024-01-02T00:00:00.000Z' },
  { branch: 'ap/c', parent: 'ap/a', created_at: '2024-01-03T00:00:00.000Z' },
  { branch: 'ap/d', parent: 'ap/b', created_at: '2024-01-04T00:00:00.000Z' },
];

test('parent / children / ancestors / descendants / root are plain pointer walks', () => {
  expect(parentOf(rows, 'ap/b')).toBe('ap/a');
  expect(parentOf(rows, 'main')).toBeNull();
  expect(childrenOf(rows, 'ap/a')).toEqual(['ap/b', 'ap/c']);
  expect(ancestorsOf(rows, 'ap/d')).toEqual(['main', 'ap/a', 'ap/b']);
  expect(descendantsOf(rows, 'ap/a')).toEqual(['ap/b', 'ap/c', 'ap/d']);
  expect(rootOf(rows, 'ap/d')).toBe('main');
  expect(chainOf(rows, 'ap/d')).toEqual(['main', 'ap/a', 'ap/b', 'ap/d']);
  // 顺序是稳定的：兄弟按 created_at。
  expect(childrenOf(rows, 'ap/a')).toEqual(['ap/b', 'ap/c']);
});

test('the forest keeps default branches first and nests children in order', () => {
  const roots = buildForest([...rows, { branch: 'side', parent: null, created_at: '2023-01-01T00:00:00.000Z' }]);
  expect(roots.map(node => node.branch)).toEqual(['main', 'side']);
  expect(roots[0].children.map(node => node.branch)).toEqual(['ap/a']);
  expect(roots[0].children[0].children.map(node => node.branch)).toEqual(['ap/b', 'ap/c']);
});

test('a parent with no row becomes a placeholder instead of dropping its children', () => {
  const roots = buildForest([{ branch: 'lush/h/9-child', parent: 'lush/h/8-parent' }]);
  expect(roots).toHaveLength(1);
  expect(roots[0]).toMatchObject({ branch: 'lush/h/8-parent', placeholder: true, children: [{ branch: 'lush/h/9-child' }] });
  expect(ancestorsOf([{ branch: 'a', parent: 'gone' }], 'a')).toEqual(['gone']);
});

test('pruneHidden 去掉归档节点，但把它还活着的后代接到最近的可见祖先上', () => {
  const rows2 = [
    { branch: 'main', parent: null },
    { branch: 'input-1', parent: 'main', status: 'archived' },
    { branch: 'ap/a', parent: 'input-1' },
    { branch: 'input-2', parent: 'main', status: 'archived' },
    { branch: 'ap/b', parent: 'input-2' },
    { branch: 'ap/c', parent: 'ap/b' },
  ];
  const pruned = pruneHidden(rows2, row => row.status === 'archived');
  // 归档的节点自己不在了；后代没有被连带藏掉，而是接到最近的非归档祖先（这里就是 main）上。
  expect(pruned.map(row => row.branch)).toEqual(['main', 'ap/a', 'ap/b', 'ap/c']);
  expect(pruned.find(row => row.branch === 'ap/a').parent).toBe('main');
  expect(pruned.find(row => row.branch === 'ap/b').parent).toBe('main');
  // 链在可见节点下面的后代照旧挂在原来的父分支上。
  expect(pruned.find(row => row.branch === 'ap/c').parent).toBe('ap/b');
  const roots = buildForest(pruned);
  expect(roots.map(node => node.branch)).toEqual(['main']);
  expect(roots[0].children.map(node => node.branch).sort()).toEqual(['ap/a', 'ap/b']);
  // 没有要隐藏的就不动原数组（避免每次渲染都重建一份）。
  expect(pruneHidden(rows, () => false)).toBe(rows);
});

test('cycles and self-parents are broken instead of recursing forever', () => {
  const cycle = buildForest([{ branch: 'a', parent: 'b' }, { branch: 'b', parent: 'a' }]);
  expect(cycle.map(node => node.branch).sort()).toEqual(['a', 'b']);
  expect(cycle.every(node => node.children.length <= 1)).toBe(true);
  const self = buildForest([{ branch: 'solo', parent: 'solo' }]);
  expect(self.map(node => node.branch)).toEqual(['solo']);
  expect(ancestorsOf([{ branch: 'solo', parent: 'solo' }], 'solo')).toEqual([]);
});
