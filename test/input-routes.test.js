import { test, expect } from 'bun:test';
import { normalizeInputRoutes } from '../src/core/input-routes.js';

// 快速路由匹配已下线；旧 settings.json 仍读取此结构，保留格式与隔离校验。

test('normalizeInputRoutes validates the shape and returns a fresh copy', () => {
  const input = [{ prefix: 'Build', target: 'worker' }];
  const normalized = normalizeInputRoutes(input);
  expect(normalized).toEqual(input);
  expect(normalized).not.toBe(input);
  expect(normalized[0]).not.toBe(input[0]);

  expect(normalizeInputRoutes([])).toEqual([]);
  const many = Array.from({ length: 32 }, (_, index) => ({ prefix: `p${index}`, target: 'worker' }));
  expect(normalizeInputRoutes(many)).toHaveLength(32);
});

test('normalizeInputRoutes rejects malformed tables', () => {
  const invalid = [
    'nope',
    Array.from({ length: 33 }, (_, index) => ({ prefix: `p${index}`, target: 'worker' })),
    [{ prefix: 'x', target: 'nope' }],
    [{ prefix: 'Dup', target: 'worker' }, { prefix: 'dup', target: 'research' }],
    [{ prefix: '', target: 'worker' }],
    [{ prefix: 'a b', target: 'worker' }],
    [{ prefix: 'x'.repeat(33), target: 'worker' }],
    [{ prefix: 'x' }],
    [{ prefix: 'x', target: 'worker', extra: 1 }],
    [null],
  ];
  for (const value of invalid) expect(() => normalizeInputRoutes(value)).toThrow();
});
