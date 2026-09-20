import { test, expect } from 'bun:test';
import { buildForest, parentOf, childrenOf, ancestorsOf, descendantsOf, rootOf, chainOf } from '../src/core/genealogy.js';

const rows = [
  { branch: 'main', parent: null },
  { branch: 'task/a', parent: 'main', created_at: '2024-01-01T00:00:00.000Z' },
  { branch: 'task/b', parent: 'task/a', created_at: '2024-01-02T00:00:00.000Z' },
  { branch: 'task/c', parent: 'task/a', created_at: '2024-01-03T00:00:00.000Z' },
  { branch: 'task/d', parent: 'task/b', created_at: '2024-01-04T00:00:00.000Z' },
];

test('parent / children / ancestors / descendants / root are plain pointer walks', () => {
  expect(parentOf(rows, 'task/b')).toBe('task/a');
  expect(parentOf(rows, 'main')).toBeNull();
  expect(childrenOf(rows, 'task/a')).toEqual(['task/b', 'task/c']);
  expect(ancestorsOf(rows, 'task/d')).toEqual(['main', 'task/a', 'task/b']);
  expect(descendantsOf(rows, 'task/a')).toEqual(['task/b', 'task/c', 'task/d']);
  expect(rootOf(rows, 'task/d')).toBe('main');
  expect(chainOf(rows, 'task/d')).toEqual(['main', 'task/a', 'task/b', 'task/d']);
  // 顺序是稳定的：兄弟按 created_at。
  expect(childrenOf(rows, 'task/a')).toEqual(['task/b', 'task/c']);
});

test('the forest keeps default branches first and nests children in order', () => {
  const roots = buildForest([...rows, { branch: 'side', parent: null, created_at: '2023-01-01T00:00:00.000Z' }]);
  expect(roots.map(node => node.branch)).toEqual(['main', 'side']);
  expect(roots[0].children.map(node => node.branch)).toEqual(['task/a']);
  expect(roots[0].children[0].children.map(node => node.branch)).toEqual(['task/b', 'task/c']);
});

test('a parent with no row becomes a placeholder instead of dropping its children', () => {
  const roots = buildForest([{ branch: 'lush/h/9-child', parent: 'lush/h/8-parent' }]);
  expect(roots).toHaveLength(1);
  expect(roots[0]).toMatchObject({ branch: 'lush/h/8-parent', placeholder: true, children: [{ branch: 'lush/h/9-child' }] });
  expect(ancestorsOf([{ branch: 'a', parent: 'gone' }], 'a')).toEqual(['gone']);
});

test('cycles and self-parents are broken instead of recursing forever', () => {
  const cycle = buildForest([{ branch: 'a', parent: 'b' }, { branch: 'b', parent: 'a' }]);
  expect(cycle.map(node => node.branch).sort()).toEqual(['a', 'b']);
  expect(cycle.every(node => node.children.length <= 1)).toBe(true);
  const self = buildForest([{ branch: 'solo', parent: 'solo' }]);
  expect(self.map(node => node.branch)).toEqual(['solo']);
  expect(ancestorsOf([{ branch: 'solo', parent: 'solo' }], 'solo')).toEqual([]);
});
